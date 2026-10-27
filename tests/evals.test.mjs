import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verificationRecall, checkSelectivity, runRoutingEval, factsFromContext, baselineContext, compile } from "../evals/harness.mjs";
import { addRelationFacts, addGraphRelations } from "../evals/facts.mjs";
import { searchContext } from "../evals/baseline-search.mjs";
import { queryContext } from "../core/query.mjs";
import { SYSTEM_ROOT, cli, write } from "./helpers.mjs";

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
  for (const p of report.perRepository) {
    for (const s of p.perScenario) {
      assert.ok(s.searchBaseline.checkSelectivity >= 0 && s.searchBaseline.checkSelectivity <= 1);
      assert.ok(s.searchBaseline.recall >= 0 && s.searchBaseline.recall <= 1);
    }
  }
  assert.ok(!Object.keys(report.thresholds).some((key) => /selectivity/i.test(key)));
  const scenarios = report.perRepository.flatMap((repo) => repo.perScenario);
  const facts = scenarios.reduce((sum, s) => sum + s.truthCount, 0);
  assert.equal(facts, 101);
  assert.equal(scenarios.reduce((sum, s) => sum + s.baselineRecalledCount, 0), 100);
  assert.equal(report.aggregate.baseline.microRecall, 0.9901);
  for (const key of ["recall", "noise", "checkSelectivity", "verificationRecall"]) {
    const total = report.perRepository.reduce((sum, repo) => sum + repo.metrics.searchBaseline[key] * repo.scenarios, 0);
    assert.equal(report.aggregate.searchBaseline[key], Math.round(total / scenarios.length * 10000) / 10000);
  }
  assert.equal(report.aggregate.retrievalReduction, null);
  assert.deepEqual(report.aggregate.retrievalReductionMeasuredOver, []);
  const emptyKoda = scenarios.find((s) => s.id === "koda-07");
  assert.equal(emptyKoda.verificationRecall, 1);
  assert.equal(emptyKoda.baseline.verificationRecall, 1);
  const weight = scenarios.length;
  const total = report.perRepository.reduce((sum, repo) => sum + repo.metrics.checkSelectivity * repo.scenarios, 0);
  assert.equal(report.aggregate.checkSelectivity, Math.round(total / weight * 10000) / 10000);
});

test("EVAL: targeted and catalog relations share the scenario fact vocabulary", () => {
  const cases = [
    ["usesResource", "resource:default/db", "out", "uses:resource:default/db"],
    ["usesResource", "component:default/app", "in", "usedBy:component:default/app"],
    ["resourceUsedBy", "resource:default/db", "in", "uses:resource:default/db"],
    ["providesApi", "api:default/api", "out", "provides:api:default/api"],
    ["apiProvidedBy", "component:default/app", "out", "provider:component:default/app"],
    ["consumesApi", "api:default/api", "out", "consumes:api:default/api"],
    ["apiConsumedBy", "component:default/app", "out", "consumer:component:default/app"],
    ["buildDependencyOf", "component:default/app", "out", "component:default/app"],
    ["partOf", "system:default/system", "out", "system:default/system"],
  ];
  for (const [type, other, direction, expected] of cases) {
    const facts = new Set();
    addRelationFacts(facts, type, other, direction);
    assert.ok(facts.has(expected), expected);
    assert.ok(!facts.has(type + ":" + other), "no compiler relation labels: " + type);
  }
  for (const repo of ["examples/koda/repo", "fixtures/a-node-ts-postgres", "fixtures/b-go-multi-service", "fixtures/c-alt-monorepo", "fixtures/e-rust-workspace", "fixtures/f-python-workspace"]) {
    const graph = compile(path.join(SYSTEM_ROOT, repo)).graph;
    const catalog = new Set(graph.entities.flatMap((e) => [...factsFromContext(queryContext(graph, e.ref))]));
    for (const entity of graph.entities) {
      const relations = new Set();
      addGraphRelations(relations, graph, entity.ref);
      const targeted = baselineContext(graph, [entity.ref]);
      for (const f of relations) {
        assert.ok(targeted.has(f), f);
        assert.ok(catalog.has(f), "baseline holds an unmatchable relation fact: " + f);
      }
      if (entity.kind === "API") assert.ok(targeted.has("provides:" + entity.ref));
    }
  }
});

test("EVAL: search follows importer/importee chains to a fixed point without catalog relations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptor = (name, extra = "") => `apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: ${name}\nspec:\n${extra}`;
  for (const name of ["leaf", "middle", "top", "unrelated"]) {
    write(root, name + "/agentdoc.yaml", descriptor(name, "  system: hidden\n  consumesApis:\n    - api:default/hidden\n"));
    write(root, name + "/package.json", JSON.stringify({ name: "@test/" + name, scripts: { test: "node --test", typecheck: "tsc --noEmit" } }));
    write(root, name + "/README.md", "# " + name);
  }
  write(root, "leaf/src/index.js", 'export const EVENT_SUBJECT = "demo.record.changed";');
  write(root, "middle/src/index.js", 'import { value } from "@test/leaf";');
  write(root, "top/src/index.js", 'import { value } from "@test/middle";');
  write(root, "top/CONSTRAINTS.md", "Only one writer.");
  write(root, "top/db/migrations/001.sql", "CREATE TABLE records(id int);");
  write(root, "agentdoc/observations/production.json", '{"facts":["hidden"]}');
  write(root, ".agentdoc/graph.json", "invalid graph must never be read");
  const result = searchContext(root, ["leaf/src/index.js"]);
  assert.deepEqual(result.reached, ["component:default/leaf", "component:default/middle", "component:default/top"]);
  for (const f of ["event:demo.record.changed", "doc:top/README.md", "constraint:top/CONSTRAINTS.md", "uses:resource:default/top-postgres", "verify:tsc --noEmit"]) assert.ok(result.facts.has(f), f);
  assert.ok(![...result.facts].some((f) => /hidden|unrelated|observation:/.test(f)));
  assert.deepEqual(searchContext(root, ["top/src/index.js"]).reached, result.reached);
  fs.rmSync(path.join(root, ".agentdoc"), { recursive: true });
  write(root, "top/agentdoc.yaml", descriptor("top", "  system: changed\n"));
  assert.deepEqual(searchContext(root, ["leaf/src/index.js"]), result);
});

test("EVAL: search discovers contracts by path and endpoints, not API declarations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-search-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["client", "server"]) write(root, name + "/agentdoc.yaml", `apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: ${name}\nspec: {}`);
  write(root, "contracts/orders.yaml", 'openapi: 3.1.0\ninfo: { title: Orders API }\npaths:\n  /orders: {}\n');
  write(root, "client/src/index.js", 'const contract = "contracts/orders.yaml";');
  write(root, "server/src/index.js", 'app.get("/orders", handler);');
  const result = searchContext(root, ["contracts/orders.yaml"]);
  for (const f of ["api:default/orders-api", "provides:api:default/orders-api", "consumes:api:default/orders-api", "provider:component:default/server", "consumer:component:default/client"]) assert.ok(result.facts.has(f), f);
  assert.deepEqual(result.reached, ["component:default/client", "component:default/server"]);
  assert.deepEqual(searchContext(root, ["./contracts/orders.yaml"]), result);
});
