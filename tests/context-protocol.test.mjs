import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Repo } from '../core/fsx.mjs';
import { loadSchemaBundle } from '../core/descriptors.mjs';
import { baseFixture, read, write } from './helpers.mjs';
import { prepare, expand, refresh, serializePacket, countTokens, validateRequest, forget } from '../core/context/index.mjs';

test('task context accounts exact serialized tokens, preserves critical facts and rejects stale continuation', t => {
  const dir = baseFixture(t);
  const request = { task: 'Change service safely', paths: ['service/src/index.ts'], budget: { tokens: 20000, encoding: 'o200k_base' } };
  const p = prepare(dir, request);
  assert.equal(loadSchemaBundle().bundle.validator('agentdoc.dev/schema/context.schema.json').validate(p), null);
  assert.equal(p.budget.used, countTokens(serializePacket(p)));
  assert.ok(p.records.some(r => r.kind === 'check'));
  assert.ok(p.records.some(r => r.kind === 'requirement'));
  assert.ok(p.budget.used <= 20000);
  write(dir, 'service/src/index.ts', 'export const changed = true;');
  assert.throws(() => expand(dir, { packet: p.packet }), /snapshot changed/);
  const next = refresh(dir, { packet: p.packet, acknowledged: p.records.map(r => r.id) });
  assert.notEqual(next.snapshot.inputHash, p.snapshot.inputHash);
  assert.ok(next.records.some(r => r.critical));
  forget(dir, p.packet);
  assert.throws(() => expand(dir, { packet: p.packet }), /unavailable/);
});

test('pagination reconstructs the complete packet without silently omitting checks', t => {
  const dir = baseFixture(t);
  for (let i = 0; i < 25; i++) write(dir, 'service/src/file' + i + '.ts', 'export const n = ' + i);
  const request = { task: 'Review service', paths: ['service'], budget: { tokens: 1200 } };
  const first = prepare(dir, request);
  const seen = [...first.records];
  let p = first;
  while (p.continuation) {
    assert.equal(p.delivery.partial, true);
    p = expand(dir, { ...p.continuation, tokens: 20000 });
    seen.push(...p.records);
    assert.equal(p.budget.used, countTokens(serializePacket(p)));
  }
  const full = prepare(dir, { ...request, budget: { tokens: 20000 } });
  assert.deepEqual(seen, full.records);
  assert.equal(new Set(seen.map(r => r.id)).size, seen.length);
});

test('protocol requests reject unknown fields, escaping paths, encoders and invalid acknowledgement', t => {
  assert.throws(() => validateRequest({ task: 'x', paths: ['../outside'] }), /paths/);
  assert.throws(() => validateRequest({ task: 'x', paths: ['service'], typo: true }), /unknown/);
  assert.throws(() => validateRequest({ task: 'x', paths: ['service'], budget: { encoding: 'guess' } }), /encodings/);
  const dir = baseFixture(t), p = prepare(dir, { task: 'x', paths: ['service'] });
  assert.throws(() => refresh(dir, { packet: p.packet, acknowledged: ['invented'] }), /not in/);
  assert.throws(() => prepare(dir, { task: 'x', paths: ['service'], budget: { tokens: 256 } }), /budget/);
});

test('successive deltas retain the full logical state and retract removed records', t => {
  const dir = baseFixture(t);
  write(dir, 'service/README.md', '# Service documentation');
  const p = prepare(dir, { task: 'Review service', paths: ['service'], budget: { tokens: 20000 } });
  const ack = p.records.map(r => r.id);
  const first = refresh(dir, { packet: p.packet, acknowledged: ack });
  const second = refresh(dir, { packet: first.packet, acknowledged: ack });
  assert.ok(second.records.every(r => r.critical));
  const doc = p.records.find(r => r.kind === 'document');
  assert.ok(doc);
  fs.unlinkSync(path.join(dir, doc.key));
  const third = refresh(dir, { packet: second.packet, acknowledged: ack });
  assert.ok(third.records.some(r => r.kind === 'retraction' && r.value.id === doc.id));
});

test('cached evidence uses captured bytes even when a constraint changes during packet selection', t => {
  const dir = baseFixture(t), absolute = path.join(dir, 'service/CONSTRAINTS.md');
  const original = fs.readFileSync(absolute, 'utf8');
  const input = { task: 'Review service', paths: ['service'], budget: { tokens: 20000 } };
  prepare(dir, input);
  const readBytes = Repo.prototype.readBytes;
  let injected = false;
  Repo.prototype.readBytes = function (rel, options) {
    if (!injected && this.root === dir && rel === 'service/CONSTRAINTS.md' && new Error().stack.includes('collect')) {
      injected = true;
      fs.writeFileSync(absolute, 'Transient ungoverned constraint');
      try { return readBytes.call(this, rel, options); }
      finally { fs.writeFileSync(absolute, original); }
    }
    return readBytes.call(this, rel, options);
  };
  let packet;
  try { packet = prepare(dir, input); } finally { Repo.prototype.readBytes = readBytes; }
  assert.ok(injected);
  assert.equal(packet.records.find(r => r.kind === 'requirement').value.text, original);
  assert.equal(expand(dir, { packet: packet.packet, tokens: 20000 }).snapshot.graphHash, packet.snapshot.graphHash);
});


test('more than twelve documents per category survive compilation and paginated delivery', t => {
  const dir = baseFixture(t);
  const expected = new Map();
  const context = ['docs', 'constraints', 'runbooks'].map(kind => {
    const paths = Array.from({ length: 15 }, (_, i) => `docs/${kind}-${i}.md`);
    for (const p of paths) {
      const text = `# ${p}\nUnique obligation for ${p}.\n`;
      write(dir, p, text);
      expected.set(p, { text: read(dir, p), critical: kind === 'constraints' });
    }
    return `    ${kind}: [${paths.join(', ')}]`;
  }).join('\n');
  const descriptor = 'service/agentdoc.yaml';
  write(dir, descriptor, read(dir, descriptor).replace(/  context:[\s\S]*/, '') + '  context:\n' + context + '\n');
  const request = { task: 'Review all applicable obligations', paths: ['service/src/index.ts'] };
  let packet = prepare(dir, { ...request, budget: { tokens: 2000 } });
  assert.ok(packet.delivery.partial);
  assert.ok(packet.delivery.criticalOmitted > 0);
  const records = [];
  let pages = 0;
  while (true) {
    assert.ok(++pages < 100, 'pagination must terminate');
    assert.ok(packet.budget.used <= 2000);
    assert.equal(packet.budget.used, countTokens(serializePacket(packet)));
    records.push(...packet.records);
    if (!packet.continuation) break;
    packet = expand(dir, { ...packet.continuation, tokens: 2000 });
  }
  const full = prepare(dir, { ...request, budget: { tokens: 100000 } });
  assert.equal(full.delivery.partial, false);
  assert.deepEqual(records, full.records);
  assert.equal(new Set(records.map(r => r.id)).size, records.length);
  for (const [p, value] of expected) {
    const record = records.find(r => r.key === p);
    assert.ok(record, `${p} must be delivered`);
    assert.equal(record.value.text, value.text);
    assert.equal(record.critical, value.critical);
  }
});
