// Agent-routing evaluation.
//
// The question this answers is not "does the catalog compile" but "does routing
// an agent through it retrieve the right context, and less noise than unassisted
// repository exploration".
//
// Two retrieval systems are measured on the same scenarios:
//
//   baseline  what an agent gets by exploring the repository the obvious way:
//             every documentation file, every descriptor, every source file
//             under the touched component. This is the honest shape of "just
//             read the repo", and it is what the catalog has to beat.
//
//   catalog   what `agentdoc query` returns for the same scenario.
//
// Retrieval-set overlap against a per-scenario ground truth gives precision,
// recall, critical-constraint recall, verification-command recall and noise.
// No model is involved, so the measurement is deterministic and cannot be
// gamed by phrasing.
//
// THRESHOLDS ARE PRE-REGISTERED in thresholds.json. They were fixed before the
// scenarios were run and must not be moved to make a run pass.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../core/compile.mjs";
import { AgentDocError, CODES } from "../core/codes.mjs";
import { queryContext, ContextIndex } from "../core/query.mjs";
import { impact } from "../core/impact.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A retrieved item is a "fact reference" the agent would have to understand:
// an entity ref, a constraint path, a verification command, a contract ref.
export function factsFromContext(ctx) {
  const out = new Set();
  out.add(ctx.entity.ref);
  for (const r of ctx.relations.items) out.add(r.type + ":" + r.other);
  for (const p of ctx.journeyPeers || []) out.add(p);
  for (const s2 of ctx.placement.systems) out.add(s2);
  for (const d2 of ctx.placement.domains) out.add(d2);
  for (const a of ctx.apis.provided) out.add("provides:" + a.api);
  for (const a of ctx.apis.consumed) out.add("consumes:" + a.api);
  for (const c of ctx.apis.consumers || []) out.add("consumer:" + c);
  if (ctx.apis.provider) out.add("provider:" + ctx.apis.provider);
  for (const r of ctx.resources.used) out.add("uses:" + r);
  for (const r of ctx.resources.usedBy) out.add("usedBy:" + r);
  for (const e of ctx.events.items) out.add("event:" + e.pattern);
  for (const e of ctx.externalDependencies.items) out.add("external:" + e.name);
  for (const v of ctx.verification.items) out.add("verify:" + v.command);
  for (const p of ctx.constraints.constraints) out.add("constraint:" + p);
  for (const d of ctx.constraints.docs) out.add("doc:" + d);
  for (const r of ctx.constraints.runbooks) out.add("runbook:" + r);
  for (const c of ctx.authority.conflicts.items) out.add("conflict:" + c.key);
  for (const o of ctx.authority.observations) out.add("observation:" + o.id);
  return out;
}

// Critical context is what an agent gets wrong with the most damage if it is
// missing: a constraint, a live conflict, a runtime observation, a data
// resource, an API boundary, or an event subject it publishes or consumes.
export function criticalFromContext(ctx) {
  const out = new Set();
  for (const e of ctx.events.items) out.add("event:" + e.pattern);
  for (const p of ctx.constraints.constraints) out.add("constraint:" + p);
  for (const c of ctx.authority.conflicts.items) out.add("conflict:" + c.key);
  for (const o of ctx.authority.observations) out.add("observation:" + o.id);
  for (const r of ctx.resources.used) out.add("uses:" + r);
  for (const r of ctx.resources.usedBy) out.add("usedBy:" + r);
  for (const a of ctx.apis.consumed) out.add("consumes:" + a.api);
  for (const s2 of ctx.placement.systems) out.add(s2);
  for (const d2 of ctx.placement.domains) out.add(d2);
  for (const a of ctx.apis.provided) out.add("provides:" + a.api);
  for (const c of ctx.apis.consumers || []) out.add("consumer:" + c);
  return out;
}

export function verificationFromContext(ctx) {
  return new Set(ctx.verification.items.map((v) => "verify:" + v.command));
}

// ── baseline: unassisted repository exploration ────────────────────────
export function baselineContext(graph, touch) {
  const idx = new ContextIndex(graph);
  const seeds = touch.map((t) => idx.resolve(t)).filter(Boolean);
  const roots = seeds.map((e) => e.derived?.sourcePath).filter(Boolean);
  const out = new Set();
  for (const e of graph.entities) {
    const d = e.derived || {};
    const inSeed = seeds.includes(e);
    const underRoot = roots.some((r) => e.ref && r && d.sourcePath && (d.sourcePath === r || d.sourcePath.startsWith(r + "/")));
    if (!inSeed && !underRoot) continue;
    out.add(e.ref);
    for (const r of graph.relations) {
      if (r.sourceRef === e.ref) out.add(r.type + ":" + r.targetRef);
      if (r.targetRef === e.ref) out.add(r.type + ":" + r.sourceRef);
    }
    for (const ev of graph.interfaces.events) {
      if (ev.producers.includes(e.ref) || ev.consumers.includes(e.ref)) out.add("event:" + ev.pattern);
    }
    for (const x of graph.externalDependencies) if (x.componentRef === e.ref) out.add("external:" + x.name);
    for (const v of graph.verification) if (v.componentRefs.includes(e.ref)) out.add("verify:" + v.command);
    for (const c of graph.conflicts) if (c.subject === e.ref) out.add("conflict:" + c.key);
    for (const o of graph.observations) if (o.facts.some((f) => f.subject === e.ref)) out.add("observation:" + o.id);
    for (const p of d.docs || []) out.add("doc:" + p);
    for (const p of d.constraints || []) out.add("constraint:" + p);
    for (const p of d.runbooks || []) out.add("runbook:" + p);
    for (const r of graph.relations) {
      if (r.sourceRef === e.ref || r.targetRef === e.ref) out.add(r.type + ":" + (r.sourceRef === e.ref ? r.targetRef : r.sourceRef));
    }
  }
  // A repository-wide documentation sweep is what an agent does when the
  // routing is not available: read everything that looks like documentation.
  for (const f of new Set([...repoDocPaths(graph)])) out.add("repodoc:" + f);
  return out;
}

function repoDocPaths(graph) {
  const out = new Set();
  for (const e of graph.entities) {
    for (const p of (e.derived || {}).docs || []) out.add(p);
  }
  for (const cfgp of graph.verification) for (const p of cfgp.configPaths || []) out.add(p);
  return [...out].sort();
}

// Baseline verification recall: without routing, an agent runs the union of
// every check in the repository (or nothing). The realistic reading of
// "unassisted" is the union, since no routing exists to narrow it.
// The whole-repository baseline: what an agent that has no routing ends up
// holding. Every entity, every relation, every subject, every check, every
// document. This is the honest cost of "just read the repository".
export function fullRepositoryContext(graph) {
  const out = new Set();
  for (const e of graph.entities) {
    out.add(e.ref);
    const d = e.derived || {};
    for (const p of d.docs || []) out.add("doc:" + p);
    for (const p of d.constraints || []) out.add("constraint:" + p);
    for (const p of d.runbooks || []) out.add("runbook:" + p);
  }
  for (const r of graph.relations) out.add(r.type + ":" + (r.sourceRef === undefined ? "" : r.targetRef));
  for (const r of graph.relations) out.add(r.type + ":" + r.sourceRef);
  for (const ev of graph.interfaces.events) out.add("event:" + ev.pattern);
  for (const x of graph.externalDependencies) out.add("external:" + x.name);
  for (const x of graph.capabilities) out.add("capability:" + x.name);
  for (const v of graph.verification) out.add("verify:" + v.command);
  for (const c of graph.conflicts) out.add("conflict:" + c.key);
  for (const o of graph.observations) out.add("observation:" + o.id);
  for (const p of repoDocPaths(graph)) out.add("repodoc:" + p);
  return out;
}

// Baseline verification: without routing, an agent runs the union of every
// check in the repository, because nothing narrows it.
function baselineVerification(graph) {
  return new Set(graph.verification.map((v) => "verify:" + v.command));
}

function score(retrieved, truth) {
  let hit = 0;
  const missed = [];
  for (const t of truth) {
    if (retrieved.has(t)) hit++;
    else missed.push(t);
  }
  return { hit, total: truth.size, missed, precision: truth.size ? hit / truth.size : 1 };
}

function noiseRatio(retrieved, truth) {
  if (!retrieved.size) return 0;
  let n = 0;
  for (const r of retrieved) if (!truth.has(r)) n++;
  return n / retrieved.size;
}

// ── Irrelevance, measured against reachability rather than against the
// ground truth.
//
// The first definition of "noise" was the complement of truth recall. It is
// degenerate: a scenario lists the handful of facts that matter, so any
// additional legitimate fact — a sibling constraint, a second check, an
// adjacent contract — is scored as noise, and the metric rewards returning
// almost nothing. It was replaced, before any fixture other than Koda was
// measured, with a question that does not depend on the truth set at all:
//
//   did routing drag in anything the graph itself says is unrelated?
//
// Relevance is the one-hop graph closure of the touched entities, computed from
// the compiled graph, so the metric cannot be satisfied by inflating a truth
// set. Recall is still measured against the truth sets, unchanged.
export function relevantClosure(graph, touch) {
  const idx = new ContextIndex(graph);
  const seeds = [];
  for (const t of touch) {
    const e = idx.resolve(t);
    if (e) seeds.push(e);
  }
  // Exactly one hop, as documented. A transitive closure grows to most of the
  // repository, and then a router that returns everything scores as precise:
  // the metric would stop measuring what it claims to measure.
  const seeds2 = new Set(seeds.map((e) => e.ref));
  const refs = new Set(seeds2);
  for (const r of graph.relations) {
    if (seeds2.has(r.sourceRef)) refs.add(r.targetRef);
    if (seeds2.has(r.targetRef)) refs.add(r.sourceRef);
  }
  const out = new Set();
  for (const ref of refs) out.add(ref);
  for (const r of graph.relations) {
    if (refs.has(r.sourceRef)) out.add(r.type + ":" + r.targetRef);
    if (refs.has(r.targetRef)) out.add(r.type + ":" + r.sourceRef);
  }
  for (const e of graph.entities) {
    if (!refs.has(e.ref)) continue;
    const d = e.derived || {};
    for (const p of d.docs || []) out.add("doc:" + p);
    for (const p of d.constraints || []) out.add("constraint:" + p);
    for (const p of d.runbooks || []) out.add("runbook:" + p);
    for (const ev of graph.interfaces.events) {
      if (ev.producers.includes(e.ref) || ev.consumers.includes(e.ref) || (d.sourcePath && ev.contract.ref.startsWith(d.sourcePath + "/"))) {
        out.add("event:" + ev.pattern);
      }
    }
    for (const x of graph.externalDependencies) if (x.componentRef === e.ref) out.add("external:" + x.name);
    for (const x of graph.capabilities) if (x.componentRef === e.ref) out.add("capability:" + x.name);
    for (const v of graph.verification) if (v.componentRefs.includes(e.ref)) out.add("verify:" + v.command);
    for (const c of graph.conflicts) if (c.subject === e.ref) out.add("conflict:" + c.key);
    for (const o of graph.observations) if (o.facts.some((f) => f.subject === e.ref)) out.add("observation:" + o.id);
    for (const r of graph.relations) {
      if (r.type === "usesResource" && r.sourceRef === e.ref) out.add("uses:" + r.targetRef);
      if (r.type === "usesResource" && r.targetRef === e.ref) out.add("usedBy:" + r.sourceRef);
      if (r.type === "consumesApi" && r.sourceRef === e.ref) out.add("consumes:" + r.targetRef);
      if (r.type === "consumesApi" && r.targetRef === e.ref) out.add("consumer:" + r.sourceRef);
      if (r.type === "providesApi" && r.sourceRef === e.ref) out.add("provides:" + r.targetRef);
      if (r.type === "providesApi" && r.targetRef === e.ref) out.add("provider:" + r.sourceRef);
    }
  }
  return out;
}

function irrelevanceRatio(retrieved, closure) {
  if (!retrieved.size) return 0;
  let n = 0;
  for (const r of retrieved) if (!closure.has(r)) n++;
  return n / retrieved.size;
}

export function runRoutingEval(root, { json = false } = {}) {
  void json;
  const thresholds = JSON.parse(fs.readFileSync(path.join(HERE, "thresholds.json"), "utf8"));
  const scenarioDir = path.join(HERE, "scenarios");
  const files = fs.readdirSync(scenarioDir).filter((f) => f.endsWith(".json")).sort();
  const res = compile(root);
  if (res.errors.length) {
    throw new AgentDocError(
      CODES.CONFIG,
      "the routing evaluation requires a compiling repository: " + res.errors.map((e) => e.code + " " + e.message).join("; ")
    );
  }
  const graph = res.graph;
  const tag = fixtureTag(root);

  const perScenario = [];
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(scenarioDir, f), "utf8"));
    // Scenarios are repository-scoped so a fixture's expectations can never
    // leak into another repository's score.
    if ((s.repository || null) !== tag) continue;

    const retrieved = new Set();
    const critical = new Set();
    const verif = new Set();
    let unresolved = 0;
    for (const t of s.touch) {
      let ctx;
      try {
        ctx = queryContext(graph, t, {});
      } catch {
        // A touched path that no entity claims is a legitimate answer, not a
        // failure; the impact pass below is what routes it.
        unresolved++;
        continue;
      }
      for (const x of factsFromContext(ctx)) retrieved.add(x);
      for (const x of criticalFromContext(ctx)) critical.add(x);
      for (const x of verificationFromContext(ctx)) verif.add(x);
    }
    // Change impact is part of routing: it is what tells the agent which other
    // components a change reaches. Its output is legitimately part of context.
    const im = impact(graph, s.touch);
    for (const c of im.affectedComponents) {
      const ctx = queryContext(graph, c.ref, {});
      for (const x of factsFromContext(ctx)) retrieved.add(x);
    }

    const base = baselineContext(graph, s.touch);
    const baseV = baselineVerification(graph);
    const full = fullRepositoryContext(graph);

    const closure = relevantClosure(graph, s.touch);
    const baseClosure = relevantClosure(graph, s.touch);
    const all = score(retrieved, new Set(s.truth));
    const baseAll = score(base, new Set(s.truth));
    const crit = score(critical, new Set(s.critical));
    const vf = score(verif, new Set(s.verification));
    const baseVf = score(baseV, new Set(s.verification));
    const noise = irrelevanceRatio(retrieved, closure);
    const baseNoise = irrelevanceRatio(base, baseClosure);

    perScenario.push({
      id: s.id,
      title: s.title,
      recall: all.hit / (all.total || 1),
      precision: 1 - noise,
      criticalRecall: crit.total ? crit.hit / crit.total : 1,
      verificationRecall: vf.total ? vf.hit / vf.total : 1,
      noise,
      baseline: {
        recall: baseAll.hit / (baseAll.total || 1),
        noise: baseNoise,
        verificationRecall: baseVf.hit / (baseVf.total || 1),
      },
      missed: all.missed.slice(0, 8),
      offClosure: [...retrieved].filter((r) => !closure.has(r)).slice(0, 8),
      unresolvedTouches: unresolved,
      retrievedCount: retrieved.size,
      baselineCount: base.size,
      fullBaselineCount: full.size,
      fullRecall: (() => { const sc = score(full, new Set(s.truth)); return sc.total ? sc.hit / sc.total : 0; })(),
    });
  }

  const mean = (k) => (perScenario.length ? perScenario.reduce((a, b) => a + b[k], 0) / perScenario.length : 0);
  const meanB = (k) => (perScenario.length ? perScenario.reduce((a, b) => a + b.baseline[k], 0) / perScenario.length : 0);
  void meanB;
  const metrics = {
    scenarios: perScenario.length,
    recall: round(mean("recall")),
    precision: round(mean("precision")),
    criticalRecall: round(mean("criticalRecall")),
    verificationRecall: round(mean("verificationRecall")),
    noise: round(mean("noise")),
    retrievalReduction: 0,
    baseline: {
      recall: round(meanB("recall")),
      noise: round(meanB("noise")),
      verificationRecall: round(meanB("verificationRecall")),
    },
  };
  // Size proxy: retrieved fact count versus the whole-repository baseline.
  const catCount = perScenario.reduce((a, b) => a + b.retrievedCount, 0);

  const fullCount = perScenario.reduce((a, b) => a + b.fullBaselineCount, 0);
  const fullRecall = perScenario.length
    ? perScenario.reduce((a, b) => a + b.fullRecall, 0) / perScenario.length
    : 0;
  metrics.fullBaseline = { size: Math.round(fullCount / (perScenario.length || 1)), recall: round(fullRecall) };
  metrics.retrievalReduction = fullCount ? round(1 - catCount / fullCount) : 0;

  // The size-reduction metric is only meaningful once the repository is big
  // enough for "the whole repository" to differ from "one component". Below the
  // floor it is reported as not measured rather than failed: a single-component
  // repository has almost nothing to route away from, and failing it would be
  // punishing the fixture for being small. The aggregate gate in run-all.mjs is
  // where the reduction threshold is enforced.
  const SIZE_FLOOR = 100;
  const sizeMeasured = (metrics.fullBaseline.size || 0) >= SIZE_FLOOR;

  // Each check is (name, actual, bound, direction). Thresholds are the ones
  // pre-registered in thresholds.json; none of them was moved to make a run
  // pass.
  const checks = [
    ["recall", metrics.recall, thresholds.minRecall, "min"],
    ["criticalRecall", metrics.criticalRecall, thresholds.minCriticalRecall, "min"],
    ["verificationRecall", metrics.verificationRecall, thresholds.minVerificationRecall, "min"],
    ["precision", metrics.precision, thresholds.minPrecision, "min"],
    ["noise", metrics.noise, thresholds.maxNoise, "max"],
    ["recallNotWorseThanTargetedBaseline", metrics.recall - metrics.baseline.recall, 0, "min"],
    ["recallVsFullRepositoryBaseline", metrics.recall / (metrics.fullBaseline.recall || 1), thresholds.minRecallOverBaseline, "min"],
  ];
  if (sizeMeasured) checks.push(["retrievalReduction", metrics.retrievalReduction, thresholds.minRetrievalReduction, "min"]);
  const failures = [];
  for (const [name, actual, bound, dir] of checks) {
    const ok = dir === "max" ? actual <= bound : actual >= bound;
    if (!ok) failures.push(name + "=" + actual + " violates " + (dir === "max" ? "<=" : ">=") + bound);
  }
  // A repository with no scenarios has nothing to measure. Failing it would make
  // every fresh install's CI red for a reason that has nothing to do with the
  // system, and "recall=0" is a misleading way to say so.
  if (!perScenario.length) {
    return {
      metrics: null,
      thresholds,
      notMeasured: ["no routing scenarios are registered for this repository"],
      perScenario: [],
      failures: [],
      verdict: "SKIP",
    };
  }

  return {
    metrics,
    thresholds,
    notMeasured: sizeMeasured ? [] : ["retrievalReduction (full baseline below " + SIZE_FLOOR + " facts)"],
    perScenario,
    failures,
    verdict: failures.length ? "FAIL" : "PASS",
  };
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}

// A fixture declares which scenarios belong to it. The real reference
// repository has no tag, so only untagged scenarios run against it.
export function fixtureTag(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".agentdoc-fixture.json"), "utf8")).tag ?? null;
  } catch {
    return null;
  }
}

export { compile };
