// Graph assembly, deterministic serialization, subject resolution, freshness
// validation, and atomic replacement.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AgentDocError, CODES } from "./codes.mjs";
import { assertNoSecretsInText } from "./secrets.mjs";
import { assertDeterministic, structuralProjection } from "./determinism.mjs";
import { sha256Hex } from "./fsx.mjs";

export const COMPILER_NAME = "agentdoc-compiler";
export const COMPILER_VERSION = "1.0.0";
export const GRAPH_SCHEMA_VERSION = "agentdoc.dev/graph/v1";

// Resolve symbolic provenance subjects to RFC 6901 pointers into the graph.
export function subjectResolver(graph) {
  const entIdx = new Map(graph.entities.map((e, i) => [e.ref, i]));
  const relIdx = new Map(graph.relations.map((r, i) => [r.type + "|" + r.sourceRef + "|" + r.targetRef + "|" + JSON.stringify(r.attributes), i]));
  const evtIdx = new Map(graph.interfaces.events.map((e, i) => [e.pattern, i]));
  const extIdx = new Map(graph.externalDependencies.map((e, i) => [e.componentRef + "|" + e.name, i]));
  const capIdx = new Map(graph.capabilities.map((e, i) => [e.componentRef + "|" + e.name, i]));
  const verIdx = new Map(graph.verification.map((e, i) => [e.id, i]));
  const jouIdx = new Map(graph.journeys.map((e, i) => [e.id, i]));
  const assIdx = new Map(graph.assertions.map((a, i) => [a.id, i]));
  const conIdx = new Map(graph.conflicts.map((c, i) => [c.id, i]));
  const obsIdx = new Map(graph.observations.map((o, i) => [o.id, i]));
  const ctrIdx = new Map(graph.contracts.map((c, i) => [c.apiRef, i]));
  const gateIdx = new Map(graph.gates.map((g, i) => [g.id, i]));

  return (sym) => {
    const splitAt = sym.indexOf(":/");
    const head = splitAt >= 0 ? sym.slice(0, splitAt) : sym;
    const tail = splitAt >= 0 ? sym.slice(splitAt + 1) : null;
    const idx = (m, key, what) => {
      const i = m.get(key);
      if (i === undefined) throw new AgentDocError(CODES.PROVENANCE, "dangling provenance subject " + sym + " (" + what + ")");
      return i;
    };
    if (sym.startsWith("entf:")) return "/entities/" + idx(entIdx, sym.slice(5, splitAt), "entity") + "/entity" + tail;
    if (sym.startsWith("ent:")) return "/entities/" + idx(entIdx, sym.slice(4), "entity");
    if (sym.startsWith("der:")) return "/entities/" + idx(entIdx, sym.slice(4, splitAt), "entity") + "/derived" + tail;
    if (sym.startsWith("rel:")) return "/relations/" + idx(relIdx, sym.slice(4), "relation");
    if (sym.startsWith("evt:")) return "/interfaces/events/" + idx(evtIdx, sym.slice(4), "event");
    if (sym.startsWith("ext:")) return "/externalDependencies/" + idx(extIdx, sym.slice(4), "external dependency");
    if (sym.startsWith("cap:")) return "/capabilities/" + idx(capIdx, sym.slice(4), "capability");
    if (sym.startsWith("ver:")) return "/verification/" + idx(verIdx, sym.slice(4), "verification");
    if (sym.startsWith("jou:")) return "/journeys/" + idx(jouIdx, sym.slice(4), "journey");
    if (sym.startsWith("ass:")) return "/assertions/" + idx(assIdx, sym.slice(4), "assertion");
    if (sym.startsWith("con:")) return "/conflicts/" + idx(conIdx, sym.slice("con:".length), "conflict");
    if (sym.startsWith("ctr:")) return "/contracts/" + idx(ctrIdx, sym.slice("ctr:".length), "contract");
    if (sym.startsWith("obs:")) return "/observations/" + idx(obsIdx, sym.slice(4), "observation");
    if (sym.startsWith("gate:")) return "/gates/" + idx(gateIdx, sym.slice("gate:".length), "gate");
    throw new AgentDocError(CODES.PROVENANCE, "unknown provenance subject " + sym);
  };
}

export function assembleGraph(sources, rel, indexes, derivedMap, facts, conflicts, observations, provFinal, diagnostics) {
  const entities = sources.entities
    .map((e) => {
      const rec = {
        ref: e.ref,
        kind: e.kind,
        name: e.name,
        entity: e.doc,
        source: "authored",
        sourcePaths: [e.file],
      };
      const d = derivedMap.get(e.ref);
      if (d && Object.keys(d).length) rec.derived = d;
      return rec;
    })
    .sort((a, b) => (a.ref < b.ref ? -1 : 1));

  const relations = rel.relations.map((r) => ({
    type: r.type,
    sourceRef: r.sourceRef,
    targetRef: r.targetRef,
    evidenceClass: r.evidenceClass,
    attributes: r.attributes || {},
    provenanceIds: [...r.provs].map((p) => provFinal.idOf.get(p)).filter(Boolean).sort(),
  }));

  const strip = (arr, extra) =>
    arr.map((r) => {
      const { provs, _provs, ...rest } = r;
      const add = extra ? extra(r) : {};
      const out = { ...add, ...rest };
      if (add && add._drop) {
        delete out._drop;
        delete out.provenanceIds;
        return out;
      }
      out.provenanceIds = [...(provs || _provs || [])].map((p) => provFinal.idOf.get(p)).filter(Boolean).sort();
      if (Array.isArray(out.provenanceIds) && out.provenanceIds.length === 0) delete out.provenanceIds;
      for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
      return out;
    });

  const assertions = facts.facts
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((a) => {
      const out = {
        id: a.id,
        subject: a.subject,
        key: a.key,
        value: a.value,
        evidenceClass: a.evidenceClass,
        confidence: a.confidence,
        status: a.status,
        provenanceIds: [...a.provRecs].map((p) => provFinal.idOf.get(p)).filter(Boolean).sort(),
      };
      if (a.semantics) out.semantics = a.semantics;
      if (a.observed) out.observed = a.observed;
      if (a.review) out.review = a.review;
      return out;
    });

  // A conflict is corroborated by the evidence of the assertions it holds apart:
  // that is exactly the evidence a reviewer needs in order to settle it.
  const provByAssertion = new Map(
    facts.facts.map((a) => [a.id, [...a.provRecs].map((p) => provFinal.idOf.get(p)).filter(Boolean).sort()])
  );
  const idsBySubjectKey = new Map();
  for (const a of facts.facts) {
    const k = a.subject + "|" + a.key;
    if (!idsBySubjectKey.has(k)) idsBySubjectKey.set(k, []);
    idsBySubjectKey.get(k).push(a.id);
  }
  const conflictOut = conflicts.map((c, i) => {
    const out = {
      id: "c-" + String(i + 1).padStart(4, "0"),
      subject: c.subject,
      key: c.key,
      kind: c.kind,
      status: c.status,
      assertionIds: c.assertionIds,
      election: {
        electedAssertionId: c.election.elected ? c.election.elected.id : null,
        basis: c.election.basis,
        ruleId: c.election.ruleId,
      },
    };
    if (c.election.rationale) out.election.rationale = c.election.rationale;
    // Carried explicitly, including when it is null, so a consumer can tell
    // "this decision has a review condition" from "no rule governs this key".
    out.election.reviewWhen = c.election.reviewWhen ?? null;
    if (c.election.contradicted && c.election.contradicted.length) out.election.contradictedAssertionIds = c.election.contradicted;
    if (c.detail) out.detail = c.detail;
    if (c.acceptance) out.acceptance = c.acceptance;
    out.provenanceIds = (idsBySubjectKey.get(c.subject + "|" + c.key) || [])
      .flatMap((id) => provByAssertion.get(id) || [])
      .filter(Boolean)
      .sort();
    return out;
  });

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    source: { commit: "0000000", dirty: false, inputHash: "sha256:" + "0".repeat(64) },
    compiler: { name: COMPILER_NAME, version: COMPILER_VERSION, adapters: [] },
    entities,
    relations,
    interfaces: { events: strip(indexes.events) },
    externalDependencies: strip(indexes.externalDependencies),
    capabilities: strip(indexes.capabilities),
    verification: strip(indexes.verification, () => ({})),
    journeys: strip(indexes.journeys, () => ({})),
    gates: strip(indexes.gates || [], () => ({})),
    contracts: strip(indexes.contracts || []),
    assertions,
    conflicts: conflictOut,
    observations: strip(observations),
    provenance: provFinal.list,
    diagnostics,
  };
}

export function serializeGraph(graph) {
  // Objects are constructed in schema order, arrays are pre-sorted, and no
  // wall-clock value, host path, username or random id is introduced anywhere.
  return JSON.stringify(graph, null, 2) + "\n";
}

export function finalizeSerialization(text, graph, { allowedTimestamps = [] } = {}) {
  assertNoSecretsInText(text, "compiled graph");
  assertDeterministic(text, { allowedTimestamps, what: "graph", structural: structuralProjection(graph) });
  return text;
}

export function writeGraphAtomic(repo, relPath, content) {
  const abs = repo.abs(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
}

// Freshness: a consumer MUST refuse a graph whose provenance does not match the
// current checkout. No silent fallback, ever.
// Freshness deliberately does NOT compare the recorded commit with HEAD.
//
// The graph is often committed alongside the change that produced it, and
// committing a file changes HEAD — so a commit-equality gate can never be
// satisfied, and a graph produced by an agent mid-task would always look stale.
// What actually determines whether the graph still describes the repository is
// the input hash (every byte the compiler read) and the dirty flag (whether a
// compiler input differs from HEAD). The commit is kept as provenance so a
// reader can see which checkout produced the graph, not as a gate.
export function assertFresh(graph, { inputHash, dirty, compilerVersion = COMPILER_VERSION, schemaVersion = GRAPH_SCHEMA_VERSION }) {
  if (graph.schemaVersion !== schemaVersion) {
    throw new AgentDocError(CODES.GRAPH_SCHEMA, "unsupported graph schemaVersion '" + graph.schemaVersion + "' (expected " + schemaVersion + ")");
  }
  if (graph.compiler?.name !== COMPILER_NAME || graph.compiler?.version !== compilerVersion) {
    throw new AgentDocError(
      CODES.COMPILER_MISMATCH,
      "graph was compiled by " + JSON.stringify(graph.compiler) + ", this compiler is " + COMPILER_NAME + "@" + compilerVersion + " — recompile"
    );
  }
  if (graph.source?.inputHash !== inputHash) {
    throw new AgentDocError(
      CODES.GRAPH_FRESHNESS,
      "graph inputHash differs from current inputs — rebuild the graph"
    );
  }
  if (graph.source?.dirty !== dirty) {
    throw new AgentDocError(
      CODES.GRAPH_FRESHNESS,
      "graph dirty flag (" + graph.source?.dirty + ") differs from the current input state (" + dirty + ") — rebuild the graph"
    );
  }
}

export function readGraph(repo, relPath) {
  const abs = repo.abs(relPath);
  if (!fs.existsSync(abs)) {
    throw new AgentDocError(
      CODES.GRAPH_MISSING,
      "no compiled graph at " + relPath + " — run `agentdoc compile` first",
      { path: relPath }
    );
  }
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    throw new AgentDocError(CODES.GRAPH_SCHEMA, "compiled graph is not readable — rebuild it");
  }
  try {
    return { graph: JSON.parse(text), text };
  } catch {
    throw new AgentDocError(CODES.GRAPH_SCHEMA, "compiled graph is not valid JSON — rebuild the graph", { path: relPath });
  }
}

export function hashText(t) {
  return "sha256:" + sha256Hex(Buffer.from(t, "utf8"));
}

export { createHash };
