// Observation ingestion.
//
// An ObservationSet is a committed, secret-free record of what an external
// system actually said at a known time. Ingesting it produces
// OBSERVED_RUNTIME assertions. It can never overwrite an authored fact: it is
// added to the same (subject, key) group and the authority engine decides what
// happens. Freshness is evaluated at gate time (check/query), never at compile
// time, so a compile stays a pure function of the checkout.
import { CODES, AgentDocError } from "./codes.mjs";

export function ingestObservations(ctx) {
  const out = [];
  const { sets } = ctx.observations;
  const byName = new Map();
  for (const s of sets) {
    if (byName.has(s.meta.name)) {
      throw new AgentDocError(
        CODES.DUPLICATE_IDENTITY,
        "duplicate observation set name '" + s.meta.name + "' (also in " + byName.get(s.meta.name).file + ")",
        { path: s.file }
      );
    }
    byName.set(s.meta.name, s);
  }
  for (const s of sets) {
    const m = s.meta;
    if (m.supersedes && !byName.has(m.supersedes)) {
      throw new AgentDocError(
        CODES.REF_UNRESOLVED,
        "observation set '" + m.name + "' supersedes unknown set '" + m.supersedes + "'",
        { path: s.file }
      );
    }
    const bundleProv = ctx.prov.add(
      "runtime",
      m.evidenceBundle,
      "observation:" + m.collector.replace(/\s+/g, "-").toLowerCase(),
      ["obs:" + m.name],
      { jsonPointer: "/facts" }
    );
    const observed = {
      at: m.capturedAt,
      environment: m.environment,
      sourceSystem: m.sourceSystem,
      collector: m.collector,
      evidenceBundle: m.evidenceBundle,
      retrievalMethod: m.collector,
      supersedes: m.supersedes || null,
    };
    const facts = [];
    for (const f of s.facts) {
      const fact = ctx.facts.add({
        subject: f.subject,
        key: f.key,
        value: f.value,
        evidenceClass: "OBSERVED_RUNTIME",
        confidence: "direct",
        provRecs: [bundleProv],
        semantics: f.semantics,
        observed,
        source: s.file,
      });
      facts.push({
        id: f.id,
        subject: f.subject,
        key: f.key,
        value: f.value,
        semantics: f.semantics,
        assertionId: fact.id,
        observedRefs: [...(f.observedRefs || [])].sort(),
      });
    }
    out.push({
      id: m.name,
      name: m.name,
      description: m.description,
      environment: m.environment,
      sourceSystem: m.sourceSystem,
      collector: m.collector,
      capturedAt: m.capturedAt,
      maxAgeDays: m.maxAgeDays,
      evidenceBundle: m.evidenceBundle,
      supersedes: m.supersedes || null,
      facts,
      provenanceIds: null,
      provs: new Set([bundleProv]),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

// Freshness of an observation is a time-dependent judgement and therefore lives
// outside the compiled graph. `now` is injected so tests and CI are hermetic.
export function observationFreshness(observations, now = new Date()) {
  const out = [];
  for (const o of observations) {
    const captured = Date.parse(o.capturedAt);
    const ageDays = Math.floor((now.getTime() - captured) / 86400000);
    out.push({
      id: o.id,
      environment: o.environment,
      capturedAt: o.capturedAt,
      ageDays,
      maxAgeDays: o.maxAgeDays,
      stale: !Number.isFinite(ageDays) || ageDays > o.maxAgeDays,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function stalenessDiagnostics(freshness) {
  return freshness
    .filter((f) => f.stale)
    .map((f) => ({
      severity: "error",
      code: CODES.OBSERVATION_STALE,
      subject: f.id,
      message:
        "observation set '" + f.id + "' (" + f.environment + ") was captured " + f.capturedAt +
        " and exceeds its declared maxAgeDays of " + f.maxAgeDays + " — re-observe the source system or restate the fact",
      paths: [],
    }));
}
