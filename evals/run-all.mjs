#!/usr/bin/env node
// Aggregate routing evaluation.
//
// Per-repository numbers are reported for every fixture and for the golden
// corpus. The gate is applied to the aggregate, because a system-level claim
// ("routing beats unassisted exploration") is a claim about the system, not
// about a repository that happens to have one component. The thresholds are the
// pre-registered ones; nothing here changes them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRoutingEval } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const REPOS = [
  { id: "koda-golden-corpus", dir: path.join(ROOT, "examples", "koda", "repo") },
  { id: "fixture-a-node-ts-postgres", dir: path.join(ROOT, "fixtures", "a-node-ts-postgres") },
  { id: "fixture-b-go-multi-service", dir: path.join(ROOT, "fixtures", "b-go-multi-service") },
  { id: "fixture-c-alt-monorepo", dir: path.join(ROOT, "fixtures", "c-alt-monorepo") },
];

const per = [];
for (const r of REPOS) {
  if (!fs.existsSync(r.dir)) { per.push({ id: r.id, skipped: "missing" }); continue; }
  const report = runRoutingEval(r.dir);
  per.push({ id: r.id, verdict: report.verdict, metrics: report.metrics, failures: report.failures, scenarios: report.perScenario.length });
}

const scored = per.filter((p) => p.metrics);
const keys = ["recall", "precision", "criticalRecall", "verificationRecall", "noise", "retrievalReduction"];
// Scenario-weighted: a repository with more scenarios says more about the
// system than one with fewer, and every repository is a real deployment.
const totals = {};
const counts = {};
for (const p of scored) {
  const n = p.scenarios || 1;
  for (const k of keys) { totals[k] = (totals[k] || 0) + p.metrics[k] * n; counts[k] = (counts[k] || 0) + n; }
}
const aggregate = {};
for (const k of keys) aggregate[k] = counts[k] ? Math.round((totals[k] / counts[k]) * 10000) / 10000 : 0;
// Baseline metrics are averaged only over the scenarios that actually measured
// them. A missing key is *unmeasured*, not zero: defaulting it to 0 reported
// `fullBaseline.noise: 0` — which reads as "the whole-repository baseline has
// zero noise", i.e. perfect — and `baseline.size: 0`, which reads as "the
// baseline retrieved nothing". In a system whose thesis is evidence discipline,
// the headline comparison must not invent a value it did not take. Unmeasured
// keys are reported as null.
const notMeasured = [];
for (const side of ["baseline", "fullBaseline"]) {
  aggregate[side] = {};
  for (const k of ["recall", "noise", "verificationRecall", "size"]) {
    const contributors = scored.filter((p) => typeof ((p.metrics[side] || {})[k]) === "number");
    if (!contributors.length) {
      aggregate[side][k] = null;
      notMeasured.push(side + "." + k);
      continue;
    }
    const weight = contributors.reduce((a, p) => a + (p.scenarios || 1), 0);
    const total = contributors.reduce((a, p) => a + p.metrics[side][k] * (p.scenarios || 1), 0);
    aggregate[side][k] = Math.round((total / weight) * 10000) / 10000;
  }
}
aggregate.notMeasured = notMeasured;

const thresholds = JSON.parse(fs.readFileSync(path.join(HERE, "thresholds.json"), "utf8"));
const checks = [
  ["recall", aggregate.recall, thresholds.minRecall, "min"],
  ["criticalRecall", aggregate.criticalRecall, thresholds.minCriticalRecall, "min"],
  ["verificationRecall", aggregate.verificationRecall, thresholds.minVerificationRecall, "min"],
  ["precision", aggregate.precision, thresholds.minPrecision, "min"],
  ["noise", aggregate.noise, thresholds.maxNoise, "max"],
  // A null means unmeasured, not zero and not a pass.
  ["retrievalReduction", aggregate.retrievalReduction, thresholds.minRetrievalReduction, "min", true],
];
const failures = [];
for (const [name, actual, bound, dir, allowNull] of checks) {
  if (allowNull && actual === null) continue; // unmeasured, and reported as such
  const ok = dir === "max" ? actual <= bound : actual >= bound;
  if (!ok) failures.push(name + "=" + actual + " violates " + (dir === "max" ? "<=" : ">=") + bound);
}

// A per-repository failure is a failure of the aggregate. Folding them in is the
// difference between a gate and a report: without this, one broken corpus
// prints FAIL and the run still exits 0.
for (const p of per) {
  if (p.skipped) { failures.push(p.id + ": corpus " + p.skipped + " — the gate ran on a smaller system than declared"); continue; }
  if (p.verdict === "SKIP") { failures.push(p.id + ": no routing scenarios — a corpus that measures nothing cannot support an aggregate claim"); continue; }
  for (const f of p.failures || []) failures.push(p.id + ": " + f);
}

// `retrievalReduction` is only meaningful on a repository large enough for the
// whole-repository baseline to be a real alternative. The harness withholds the
// per-repository check below 100 facts; averaging the value in anyway made the
// headline size-reduction claim a mean that includes numbers the harness itself
// called meaningless, and it passed on the strength of the others.
const SIZE_FLOOR = 100;
const measurable = scored.filter((p) => ((p.metrics.fullBaseline || {}).size || 0) >= SIZE_FLOOR);
if (!measurable.length) {
  aggregate.retrievalReduction = null;
  aggregate.notMeasured.push("retrievalReduction");
} else {
  const weight = measurable.reduce((a, p) => a + (p.scenarios || 1), 0);
  aggregate.retrievalReduction = Math.round(
    (measurable.reduce((a, p) => a + p.metrics.retrievalReduction * (p.scenarios || 1), 0) / weight) * 10000
  ) / 10000;
}
aggregate.retrievalReductionMeasuredOver = measurable.map((p) => p.id);

const out = { aggregate, thresholds, perRepository: per, failures, verdict: failures.length ? "FAIL" : "PASS" };
if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} else {
  console.log("aggregate: " + JSON.stringify(aggregate));
  for (const p of per) {
    if (p.skipped) { console.log("  " + p.id + ": SKIPPED (" + p.skipped + ")"); continue; }
    console.log("  " + p.id + ": " + p.verdict + " scenarios=" + p.scenarios + " " + JSON.stringify(p.metrics));
    if (p.failures.length) console.log("      " + p.failures.join("; "));
  }
  console.log("verdict: " + out.verdict + (failures.length ? " (" + failures.join("; ") + ")" : ""));
}
process.exit(out.verdict === "PASS" ? 0 : 1);
