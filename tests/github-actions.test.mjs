// GitHub Actions adapter (issue #12): only the repository-root
// .github/workflows is CI authority, and a workflow directory is never a unit
// marker.
//
// GitHub runs workflows from the repository root only. A nested
// .github/workflows (vendored upstream code, a subtree layout, a package kept
// for upstream merges) is inert, so it must neither fail validation nor
// contribute checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFixture, cli, graphOf, DEFAULT_CONFIG } from "./helpers.mjs";

const NESTED_CONFIG = DEFAULT_CONFIG.replace(
  "    - service/**/agentdoc.yaml\n",
  "    - service/**/agentdoc.yaml\n    - pkg/*/agentdoc.yaml\n"
);

const descriptor = (name, type) =>
  "apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: " + name +
  '\n  description: "A component for the github-actions tests."\nspec:\n  type: ' + type + "\n  system: s1\n";

function component(graph, name) {
  return graph.entities.find((e) => e.ref === "component:default/" + name);
}

test("github-actions: a nested .github/workflows is ignored, not read as a unit marker", (t) => {
  const dir = baseFixture(t, {
    config: NESTED_CONFIG,
    extra: {
      "pkg/a/package.json": JSON.stringify({ name: "@t/a", version: "1.0.0", main: "index.js" }),
      "pkg/a/agentdoc.yaml": descriptor("a", "library"),
      // A real check that names the unit: if the nested directory were read,
      // it would surface as a verification or gate.
      "pkg/a/.github/workflows/ci.yml":
        "name: x\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test -- pkg/a/\n",
    },
  });
  cli(dir, ["validate"]);
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  const a = component(g, "a");
  assert.ok(a, "pkg/a compiles as a component");
  assert.deepEqual(a.derived.markers.map((m) => m.adapter), ["node"]);
  const paths = [...g.verification, ...g.gates].flatMap((v) => v.configPaths || []);
  assert.ok(paths.includes(".github/workflows/ci.yml"), JSON.stringify(paths));
  assert.ok(!paths.some((p) => p.startsWith("pkg/a/.github/")), JSON.stringify(paths));
  assert.ok(!JSON.stringify(g.provenance).includes("pkg/a/.github"), "nested workflows are never read");
});

test("github-actions: repository-root workflows still yield component checks and repository gates", (t) => {
  const dir = baseFixture(t, {
    extra: {
      ".github/workflows/lint.yml": "name: lint\non: { pull_request: {} }\njobs:\n  l:\n    steps:\n      - run: pnpm lint\n",
    },
  });
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  const ver = g.verification.find((v) => v.id === "ci:-github-workflows-ci-yml:t:0");
  assert.ok(ver, JSON.stringify(g.verification));
  assert.deepEqual(ver.componentRefs, ["component:default/svc"]);
  assert.equal(ver.tier, "unit");
  assert.deepEqual(ver.configPaths, [".github/workflows/ci.yml"]);
  const gate = g.gates.find((x) => x.id === "repo-gate:-github-workflows-lint-yml:l:0");
  assert.ok(gate, JSON.stringify(g.gates));
  assert.equal(gate.tier, "static");
  // CI is not artifact evidence: the service's markers come from its own files.
  assert.ok(component(g, "svc").derived.markers.every((m) => m.adapter !== "github-actions"));
});

test("github-actions: a unit at the repository root is not marked by .github/workflows", (t) => {
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace(
      "    - service/**/agentdoc.yaml\n",
      "    - service/**/agentdoc.yaml\n    - agentdoc.yaml\n"
    ),
    extra: { "agentdoc.yaml": descriptor("root", "service") },
  });
  // Before #12 this failed with AGENTDOC_PATH_UNRESOLVED [./.github/workflows].
  cli(dir, ["validate"]);
  cli(dir, ["compile"]);
  const root = component(graphOf(dir), "root");
  assert.deepEqual(root.derived.markers.map((m) => m.adapter), ["node"]);
});
