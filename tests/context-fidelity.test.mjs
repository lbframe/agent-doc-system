import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compile } from "../core/compile.mjs";
import { queryContext, renderContext } from "../core/query.mjs";
import { baseFixture, cli, commitAll, git, SYSTEM_ROOT } from "./helpers.mjs";

function context(root, ref, budget) {
  const result = compile(path.join(SYSTEM_ROOT, root), { noGit: true });
  assert.deepEqual(result.errors, []);
  return queryContext(result.graph, ref, { budget });
}

test("context fidelity: Markdown reports Rust checks withheld by the budget", () => {
  const ctx = context("fixtures/e-rust-workspace", "component:default/engine", { verification: 1 });
  assert.equal(ctx.verification.total, 4);
  assert.equal(ctx.verification.items.length, 1);
  const md = renderContext(ctx);
  assert.match(md, /INCOMPLETE CONTEXT/);
  assert.match(md, /verification \[truncated: 1 of 4\]/);
  assert.ok(md.includes(ctx.verification.items[0].command));
});

test("context fidelity: Koda conflict truncation and actual runtime facts survive rendering", () => {
  const ctx = context("examples/koda/repo", "component:default/koda-cron", { conflicts: 1, assertions: 1, provenance: 1 });
  const md = renderContext(ctx);
  assert.equal(ctx.authority.conflicts.total, 4);
  assert.match(md, /authority.conflicts \[truncated: 1 of 4\]/);
  assert.match(md, /RESOLVED CONFLICTS/);
  assert.doesNotMatch(md, /- CONFLICTS \(do not assume one is true\):/);
  assert.match(md, /election: .*deployed-bindings-are-runtime-truth/);
  const observedCron = ctx.authority.observations.flatMap((o) => o.facts).find((f) => f.key === "schedule.cron");
  assert.ok(observedCron);
  assert.ok(md.includes("schedule.cron: " + JSON.stringify(observedCron.value)));
  for (const name of ctx.truncated) {
    const section = name.split(".").reduce((value, key) => value[key], ctx);
    assert.ok(md.includes(name + " [truncated: " + section.items.length + " of " + section.total + "]"));
  }
});

test("context fidelity: API roles and typed dependencies remain actionable", () => {
  const component = context("fixtures/e-rust-workspace", "component:default/engine");
  const md = renderContext(component);
  for (const relation of component.relations.items) {
    assert.ok(md.includes(relation.direction + " " + relation.type + " " + relation.other));
  }
});

test("context fidelity: default CLI includes scoped checks, repository gates and omissions", (t) => {
  const root = baseFixture(t, { extra: {
    ".github/workflows/root.yml": "name: root\non: push\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n",
  } });
  cli(root, ["compile"]);
  const json = JSON.parse(cli(root, ["query", "service", "--json", "--budget", "verification=1,relations=1,provenance=1"]));
  const md = cli(root, ["query", "service", "--budget", "verification=1,relations=1,provenance=1"]);
  assert.ok(json.globalGates.length > 0, "fixture must contain a real repository gate");
  for (const gate of json.globalGates) assert.ok(md.includes(gate.command));
  assert.match(md, /repository gates/);
  assert.ok(json.truncated.length > 0);
  for (const name of json.truncated) assert.ok(md.includes(name + " [truncated:"));
  const api = JSON.parse(cli(root, ["query", "api:default/svc-api", "--json"]));
  const apiMd = cli(root, ["query", "api:default/svc-api"]);
  assert.ok(apiMd.includes("API provider: " + api.apis.provider));
  assert.ok(apiMd.includes(JSON.stringify(api.apis.contract)));
});

test("fixture Git commits bypass local signing without changing its configuration", (t) => {
  const root = baseFixture(t);
  git(root, ["config", "commit.gpgsign", "true"]);
  git(root, ["config", "gpg.program", "agentdoc-test-nonexistent-signer"]);
  commitAll(root, "unsigned fixture commit");
  assert.equal(git(root, ["config", "--local", "commit.gpgsign"]).trim(), "true");
  assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "unsigned fixture commit");
});
