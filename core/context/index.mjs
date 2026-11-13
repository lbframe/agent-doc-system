import { CODES } from "../codes.mjs";
// Task context protocol. Graph authority stays in the compiler; this module
// selects and transports facts without turning an interpretation into a fact.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { compileSnapshot } from '../snapshot.mjs';
import { ContextIndex, queryContext } from '../query.mjs';
import { impact } from '../impact.mjs';
import { canonicalPath } from '../paths.mjs';
import { observationFreshness } from '../observations.mjs';
import { assertNoSecretsInText } from '../secrets.mjs';

const VERSION = 'agentdoc.dev/context/v1';
const INTENTS = ['implement', 'change-contract', 'debug-runtime', 'review'];
const ENCODERS = new Map();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function error(code, message) { throw Object.assign(new Error(message), { code }); }
function closed(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) error(CODES.CONTEXT_REQUEST, name + ' must be an object');
  for (const k of Object.keys(value)) if (!keys.includes(k)) error(CODES.CONTEXT_REQUEST, 'unknown ' + name + ' field: ' + k);
}
export function validateRequest(request) {
  closed(request, ['task', 'paths', 'intent', 'budget', 'cache'], 'request');
  if (typeof request.task !== 'string' || !request.task.trim()) error(CODES.CONTEXT_REQUEST, 'task must be a nonempty string');
  if (!Array.isArray(request.paths) || !request.paths.length || request.paths.some(p => typeof p !== 'string' || !p || (!/^[a-z]+:[a-z0-9-]+\//.test(p) && canonicalPath(p) === null))) error(CODES.CONTEXT_REQUEST, 'paths must be repository paths or entity refs');
  if (request.intent !== undefined && !INTENTS.includes(request.intent)) error(CODES.CONTEXT_REQUEST, 'unsupported intent');
  if (request.cache !== undefined && typeof request.cache !== 'boolean') error(CODES.CONTEXT_REQUEST, 'cache must be boolean');
  if (request.budget !== undefined) closed(request.budget, ['tokens', 'encoding'], 'budget');
  const budget = { tokens: 4096, encoding: 'o200k_base', ...request.budget };
  if (!Number.isSafeInteger(budget.tokens) || budget.tokens < 256 || budget.tokens > 1000000) error(CODES.CONTEXT_BUDGET, 'tokens must be an integer from 256 to 1000000');
  if (!['o200k_base', 'cl100k_base'].includes(budget.encoding)) error(CODES.CONTEXT_TOKENIZER, 'supported pinned encodings: o200k_base, cl100k_base');
  return { task: request.task.trim(), paths: [...new Set(request.paths)].sort(), intent: request.intent || 'implement', budget, cache: request.cache !== false };
}
export function countTokens(text, encoding = 'o200k_base') {
  if (!ENCODERS.has(encoding)) ENCODERS.set(encoding, getEncoding(encoding));
  return ENCODERS.get(encoding).encode(text, [], []).length;
}
export function serializePacket(packet) { return JSON.stringify(packet) + '\n'; }
function record(kind, subject, key, value, evidence = [], critical = false) {
  const id = hash([kind, subject, key]).slice(0, 24);
  return JSON.parse(JSON.stringify({ id, version: hash([value, evidence]), kind, subject, key, value, evidence: [...evidence].sort(), critical }));
}
function collect(res, request) {
  const g = res.graph, idx = new ContextIndex(g), refs = new Set(), records = new Map();
  const im = impact(g, request.paths);
  const put = r => records.set(r.id, r);
  for (const p of request.paths) { const e = idx.resolve(p); if (e) refs.add(e.ref); }
  for (const e of im.affectedComponents) refs.add(e.ref);
  // Unlimited selection here: the single serialized token budget controls delivery.
  const unlimited = Object.fromEntries(['relations','events','externals','capabilities','verification','journeys','conflicts','assertions','provenance','contracts'].map(k => [k, Number.MAX_SAFE_INTEGER]));
  for (const ref of [...refs].sort()) {
    const ctx = queryContext(g, ref, { budget: unlimited, index: idx });
    put(record('entity', ref, 'identity', { description: ctx.entity.description, derived: ctx.entity.derived }, ctx.entity.sourcePaths));
    for (const r of ctx.relations.items) put(record('relation', ref, r.type + ':' + r.direction + ':' + r.other, r, r.provenanceIds));
    for (const a of ctx.authority.assertions.items) put(record('assertion', ref, a.key + ':' + a.id, a, [], a.key.startsWith('requirement.')));
    for (const c of ctx.authority.conflicts.items) put(record('conflict', ref, c.id, c, [], true));
    for (const [kind, paths] of Object.entries(ctx.constraints)) for (const p of paths) {
      const bytes = res.repo.readBytes(p);
      const expected = res.graph.provenance.filter(x => x.path === p).map(x => x.contentHash.replace(/^sha256:/, ''));
      if (!expected.includes(createHash('sha256').update(bytes).digest('hex'))) error(CODES.CONTEXT_STALE, 'document is not pinned by this snapshot: ' + p);
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
      put(record(kind === 'constraints' ? 'requirement' : 'document', ref, p,
        { path: p, sha256: createHash('sha256').update(bytes).digest('hex'), text: source }, [p], kind === 'constraints'));
    }
    for (const c of ctx.contracts.items) put(record('contract', ref, c.id || c.ref, c, c.provenanceIds));
    for (const o of ctx.authority.observations) put(record('observation', ref, o.id, o, o.evidenceBundle ? [o.evidenceBundle] : [], true));
    for (const r of ctx.reviewCommitments.filter(r => !r.subject || refs.has(r.subject))) put(record('review', r.subject || 'repository', r.key || r.kind, r, [], true));
    for (const j of ctx.journeys.items) put(record('journey', ref, j.id, j));
    for (const e of ctx.events.items) put(record('event', ref, e.pattern, e, [], true));
  }
  const checks = new Map();
  for (const p of [...refs]) {
    const ctx = queryContext(g, p, { budget: unlimited, index: idx });
    for (const v of [...ctx.verification.items, ...ctx.globalGates]) checks.set(v.id, v);
  }
  for (const v of im.recommendedVerification) checks.set(v.id, v);
  for (const v of checks.values()) {
    const original = [...g.verification, ...g.gates].find(x => x.id === v.id);
    const owners = original?.componentRefs || [];
    // Command text alone cannot prove a working directory; keep that unknown.
    put(record('check', 'repository', v.id, { ...v, componentRefs: owners, execution: { kind: 'shell', cwd: null, status: 'requires-context' }, status: 'recommended' }, original?.provenanceIds, true));
  }
  for (const f of observationFreshness(g.observations)) if (f.stale) put(record('freshness', 'repository', f.id, f, [], true));
  const sort = (a, b) => Number(b.critical) - Number(a.critical) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
  return { records: [...records.values()].sort(sort), scope: [...refs].sort(), coverage: { unmatched: im.unmatchedFiles, limitations: ['component-level analysis; dynamic and unsupported relationships may be absent'], staleObservations: observationFreshness(g.observations).filter(f => f.stale).map(f => f.id) } };
}
function storeDir(root) { return path.join(root, '.agentdoc', 'context'); }
function save(root, id, data) {
  const dir = storeDir(root); fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, id + '.' + randomUUID() + '.tmp');
  fs.writeFileSync(temp, JSON.stringify({ identity: data.identity }), { mode: 0o600 });
  fs.renameSync(temp, path.join(dir, id + '.json'));
  const retained = fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => ({ n, time: fs.statSync(path.join(dir,n)).mtimeMs })).sort((a,b) => b.time-a.time || a.n.localeCompare(b.n));
  for (const old of retained.slice(64)) if (old.n !== id + '.json') fs.rmSync(path.join(dir,old.n), { force: true });
}
function load(root, id) {
  if (!/^[a-f0-9]{64}$/.test(id || '')) error(CODES.CONTEXT_REFERENCE, 'invalid packet reference');
  try { const x = JSON.parse(fs.readFileSync(path.join(storeDir(root), id + '.json'), 'utf8')); if (hash(x.identity) !== id) throw new Error(); return { ...x.identity, id };  }
  catch { error(CODES.CONTEXT_REFERENCE, 'packet unavailable; run prepare again'); }
}
function packetPage(state, offset, limit) {
  const p = { schemaVersion: VERSION, packet: state.id, snapshot: state.snapshot, task: state.request.task, intent: state.request.intent, scope: state.scope, coverage: state.coverage,
    records: [], delivery: { offset, total: state.records.length, omitted: state.records.length - offset, criticalOmitted: 0, partial: true },
    continuation: { packet: state.id, offset }, budget: { limit, used: 0, encoding: state.request.budget.encoding, tokenizerVersion: 'js-tiktoken@1.0.21' } };
  const measure = () => {
    // Digit count feeds back into encoding; converge to the exact final size.
    for (let i = 0; i < 12; i++) { const n = countTokens(serializePacket(p), p.budget.encoding); if (n === p.budget.used) return n; p.budget.used = n; }
    error(CODES.CONTEXT_BUDGET, 'token accounting did not converge');
  };
  const update = () => {
    const next = offset + p.records.length;
    p.delivery.omitted = state.records.length - next;
    p.delivery.criticalOmitted = state.records.slice(next).filter(r => r.critical).length;
    p.delivery.partial = next < state.records.length;
    p.continuation = next < state.records.length ? { packet: state.id, offset: next } : null;
    return measure();
  };
  if (update() > limit) error(CODES.CONTEXT_BUDGET, 'budget cannot hold the minimum envelope');
  for (const r of state.records.slice(offset)) {
    p.records.push(r);
    if (update() > limit) { p.records.pop(); update(); break; }
  }
  if (!p.records.length && offset < state.records.length) error(CODES.CONTEXT_BUDGET, 'next record exceeds budget; expand with a larger token limit');
  assertNoSecretsInText(serializePacket(p), 'context packet');
  return p;
}
export function prepare(root, input, options = {}) {
  const request = validateRequest(input);
  const res = compileSnapshot(root, { cache: request.cache, ...options });
  if (res.errors.length) error(CODES.CONTEXT_COMPILE, res.errors.map(e => e.message).join('\n'));
  const selected = collect(res, request);
  const snapshot = { inputHash: res.stats.inputHash, compiler: res.graph.compiler, graphHash: hash(res.graph) };
  const identity = { snapshot, request, records: selected.records, logicalRecords: selected.records, scope: selected.scope, coverage: selected.coverage };
  assertNoSecretsInText(JSON.stringify(identity), 'context state');
  const id = hash(identity);
  const state = { identity, id, snapshot, request, ...selected };
  const packet = packetPage(state, 0, request.budget.tokens);
  save(root, id, state);
  return packet;
}
export function expand(root, request) {
  closed(request, ['packet', 'offset', 'tokens'], 'expand');
  const state = load(root, request.packet);
  const offset = request.offset ?? 0, tokens = request.tokens ?? state.request.budget.tokens;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > state.records.length || !Number.isSafeInteger(tokens) || tokens < 256 || tokens > 1000000) error(CODES.CONTEXT_REQUEST, 'invalid offset or token limit');
  const res = compileSnapshot(root, { cache: state.request.cache });
  if (res.errors.length || hash(res.graph) !== state.snapshot.graphHash || JSON.stringify(observationFreshness(res.graph.observations).filter(f => f.stale).map(f => f.id)) !== JSON.stringify(state.coverage.staleObservations)) error(CODES.CONTEXT_STALE, 'snapshot changed; use refresh or prepare');
  return packetPage(state, offset, tokens);
}
export function refresh(root, request) {
  closed(request, ['packet', 'acknowledged', 'reset'], 'refresh');
  const previous = load(root, request.packet);
  if (request.reset !== undefined && typeof request.reset !== 'boolean') error(CODES.CONTEXT_REQUEST, 'reset must be boolean');
  if (request.acknowledged !== undefined && (!Array.isArray(request.acknowledged) || request.acknowledged.some(x => typeof x !== 'string'))) error(CODES.CONTEXT_REQUEST, 'acknowledged must be record IDs');
  const known = new Set(request.reset ? [] : request.acknowledged || []);
  for (const id of known) if (!(previous.logicalRecords || previous.records).some(r => r.id === id)) error(CODES.CONTEXT_REQUEST, 'acknowledged ID is not in the previous packet');
  const initial = prepare(root, previous.request);
  const current = load(root, initial.packet);
  const old = new Map((previous.logicalRecords || previous.records).filter(r => known.has(r.id)).map(r => [r.id, r]));
  const currentIds = new Set(current.records.map(r => r.id));
  const records = current.records.filter(r => r.critical || !old.has(r.id) || old.get(r.id).version !== r.version);
  for (const [id, r] of old) if (!currentIds.has(id)) records.push(record('retraction', r.subject, id, { id, previousVersion: r.version }, [], true));
  const state = { ...current, records };
  // A delta is itself addressed and can be paged; acknowledge only IDs delivered.
  state.identity = { base: previous.id, snapshot: current.snapshot, request: current.request, records, logicalRecords: current.logicalRecords || current.records, scope: current.scope, coverage: current.coverage };
  state.id = hash(state.identity); save(root, state.id, state);
  return packetPage(state, 0, current.request.budget.tokens);
}
export function forget(root, packet) {
  load(root, packet); fs.unlinkSync(path.join(storeDir(root), packet + '.json'));
}
