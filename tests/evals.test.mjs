import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verificationRecall, checkSelectivity, runRoutingEval } from "../evals/harness.mjs";
import { SYSTEM_ROOT, cli } from "./helpers.mjs";

test("EVAL: verification recall treats empty expectations consistently", () => {
  const catalog = new Set(["verify-id:unit:a"]);
  const baseline = new Set([...catalog, "verify-id:unit:b"]);
  for (const retrieved of [new Set(), catalog, baseline]) {
    assert.equal(verificationRecall(retrieved, new Set()), 1);
  }
  const expected = new Set(["verify-id:unit:a", "verify-id:unit:b"]);
  assert.equal(verificationRecall(catalog, expected), 0.5);
  assert.equal(verificationRecall(baseline, expected), 1);
  assert.equal(verificationRecall(new Set(), expected), 0);
});

test("EVAL: selectivity counts scoped checks and gates once by ID", () => {
  const graph = {
    verification: [
      { id: "unit:a", command: "npm test" },
      { id: "unit:b", command: "npm test" },
      { id: "lint:a", command: "npm run lint" },
    ],
    gates: [{ id: "repo:lint", command: "npm run lint" }],
  };
  assert.equal(checkSelectivity(graph, new Set(["unit:a", "unit:a", "repo:lint"])), 0.5);
  assert.equal(checkSelectivity(graph, new Set(["unit:a", "unit:b"])), 0.5);
  assert.equal(checkSelectivity(graph, new Set()), 0);
  assert.equal(checkSelectivity(graph, new Set([...graph.verification, ...graph.gates].map((v) => v.id))), 1);
  assert.equal(checkSelectivity({ verification: [], gates: [] }, new Set()), 1);
});

test("EVAL: empty-expectation scenarios and selectivity reach CLI reports", () => {
  const root = path.join(SYSTEM_ROOT, "fixtures", "f-python-workspace");
  const report = runRoutingEval(root);
  assert.equal(report.verdict, "PASS");
  for (const id of ["f-03", "f-04"]) {
    const scenario = report.perScenario.find((s) => s.id === id);
    assert.ok(scenario, id);
    assert.equal(scenario.verificationRecall, 1);
    assert.equal(scenario.baseline.verificationRecall, 1);
  }
  for (const scenario of report.perScenario) {
    assert.ok(scenario.checkSelectivity >= 0 && scenario.checkSelectivity <= 1);
    assert.equal(scenario.baseline.checkSelectivity, 1);
  }
  const mean = report.perScenario.reduce((sum, s) => sum + s.checkSelectivity, 0) / report.perScenario.length;
  assert.equal(report.metrics.checkSelectivity, Math.round(mean * 10000) / 10000);
  assert.equal(report.metrics.baseline.checkSelectivity, 1);
  assert.equal(report.metrics.baseline.verificationRecall, 1);
  const json = JSON.parse(cli(root, ["eval", "routing", "--json"]));
  assert.deepEqual(json.metrics, report.metrics);
  const text = cli(root, ["eval", "routing"]);
  assert.match(text, /"checkSelectivity":/);
  assert.match(text, /verdict: PASS/);
});

test("EVAL: aggregate reports scenario-weighted selectivity without a new gate", () => {
  const report = JSON.parse(execFileSync(process.execPath, ["evals/run-all.mjs", "--json"], { cwd: SYSTEM_ROOT, encoding: "utf8" }));
  assert.equal(report.verdict, "PASS");
  assert.equal(report.aggregate.baseline.verificationRecall, 1);
  assert.equal(report.aggregate.baseline.checkSelectivity, 1);
  assert.ok(!Object.keys(report.thresholds).some((key) => /selectivity/i.test(key)));
  const scenarios = report.perRepository.flatMap((repo) => repo.perScenario);
  const emptyKoda = scenarios.find((s) => s.id === "koda-07");
  assert.equal(emptyKoda.verificationRecall, 1);
  assert.equal(emptyKoda.baseline.verificationRecall, 1);
  const weight = scenarios.length;
  const total = report.perRepository.reduce((sum, repo) => sum + repo.metrics.checkSelectivity * repo.scenarios, 0);
  assert.equal(report.aggregate.checkSelectivity, Math.round(total / weight * 10000) / 10000);
});
