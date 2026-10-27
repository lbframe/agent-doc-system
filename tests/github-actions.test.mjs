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
import { createHash } from "node:crypto";
import { baseFixture, cli, graphOf, read, DEFAULT_CONFIG } from "./helpers.mjs";

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

function ciChecks(graph, file) {
  return [...graph.verification, ...graph.gates].filter((v) => v.configPaths.includes(file));
}

function workflow(steps, header = "on: push\n", defaults = "") {
  return "name: regression\n" + header + defaults + "jobs:\n  checks:\n    steps:\n" + steps;
}

test("github-actions: shell conditions and mentions of checks are not invocations", (t) => {
  const file = ".github/workflows/conditions.yml";
  const dir = baseFixture(t, { extra: { [file]: workflow([
    '      - run: test -n "$CI"',
    '      - run: \'[ -n "$CI" ]\'',
    '      - run: \'[[ -n "$CI" ]]\'',
    '      - run: echo "npm test service/"',
    '      - run: npm install test lint build',
    '      - uses: vendor/test-action@v1',
    '      - run: |',
    '          echo "deploy service/"',
    '          test -n "$CI"',
    '          ./deploy.sh',
  ].join("\n") + "\n") } });
  cli(dir, ["compile"]);
  assert.deepEqual(ciChecks(graphOf(dir), file), []);
});

test("github-actions: init workflow and ops scripts do not attach to a one-letter root", (t) => {
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("    - service/**/agentdoc.yaml\n", "    - service/**/agentdoc.yaml\n    - e/agentdoc.yaml\n"),
    extra: {
      "e/agentdoc.yaml": descriptor("e", "library"),
      "e/package.json": JSON.stringify({ name: "@t/e", main: "index.js" }),
      ".github/workflows/ops.yml": workflow('      - run: |\n          echo "service/ e/"\n          test -n "$CI"\n          npm test\n          npm run build\n'),
    },
  });
  // Exercise the workflow shipped by init rather than a hand-written copy.
  cli(dir, ["init"]);
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  assert.deepEqual(g.verification.filter((v) => v.componentRefs.includes("component:default/e")), []);
  const checks = ciChecks(g, ".github/workflows/ops.yml");
  assert.deepEqual(checks.map((v) => [v.tier, v.command]), [["unit", "npm test"], ["build", "npm run build"]]);
  assert.ok(checks.every((v) => g.gates.includes(v)));
  assert.ok(ciChecks(g, ".github/workflows/agentdoc.yml").some((v) => v.command === "agentdoc compile"));
  assert.ok([...g.verification, ...g.gates].every((v) => !v.command.includes("\n")));
});

test("github-actions: checks are scoped per step and per command, not by workflow mentions", (t) => {
  const file = ".github/workflows/scoped.yml";
  const dir = baseFixture(t, {
    config: NESTED_CONFIG,
    extra: {
      "pkg/a/package.json": JSON.stringify({ name: "@t/a", main: "index.js" }),
      "pkg/a/agentdoc.yaml": descriptor("a", "library"),
      [file]: workflow([
        '      - run: npm test -- service/src',
        '      - run: npm test -- ./pkg/a/',
        '      - run: npm test -- service-other/',
        '      - run: pnpm --filter @t/a test',
        '      - run: npm test',
        '        working-directory: service',
        '      - run: |',
        '          npm test -- service/',
        '          npm run lint -- pkg/a/',
        '      - run: npm test',
      ].join("\n") + "\n"),
    },
  });
  cli(dir, ["compile"]);
  const checks = ciChecks(graphOf(dir), file);
  assert.deepEqual(checks.filter((v) => v.componentRefs).map((v) => [v.command, v.componentRefs]), [
    ["npm test -- service/src", ["component:default/svc"]],
    ["npm test -- ./pkg/a/", ["component:default/a"]],
    ["pnpm --filter @t/a test", ["component:default/a"]],
    ["cd service && npm test", ["component:default/svc"]],
    ["npm test -- service/", ["component:default/svc"]],
    ["npm run lint -- pkg/a/", ["component:default/a"]],
  ]);
  assert.deepEqual(checks.filter((v) => !v.componentRefs).map((v) => v.command), ["npm test -- service-other/", "npm test"]);
});

test("github-actions: workflow paths and working-directory defaults are explicit scopes", (t) => {
  const paths = ".github/workflows/paths.yml";
  const defaults = ".github/workflows/defaults.yml";
  const dir = baseFixture(t, { extra: {
    [paths]: workflow('      - run: npm test\n', 'on:\n  pull_request:\n    paths: ["service/**", "!service/docs/**"]\n'),
    [defaults]: "name: defaults\non: push\ndefaults:\n  run:\n    working-directory: service\njobs:\n  inherited:\n    steps:\n      - run: npm test\n  overridden:\n    defaults:\n      run:\n        working-directory: .\n    steps:\n      - run: npm test\n      - run: npm run lint\n        working-directory: ./service/src\n",
  } });
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  assert.deepEqual(ciChecks(g, paths).map((v) => v.componentRefs), [["component:default/svc"]]);
  assert.deepEqual(ciChecks(g, defaults).map((v) => [v.command, v.componentRefs || []]), [
    ["cd service && npm test", ["component:default/svc"]],
    ["cd service/src && npm run lint", ["component:default/svc"]],
    ["npm test", []],
  ]);
});

test("github-actions: workflow impact returns its component checks and repository gates only", (t) => {
  const file = ".github/workflows/impact.yml";
  const dir = baseFixture(t, { extra: {
    [file]: workflow('      - run: npm test -- service/\n      - run: npm run lint\n'),
    ".github/workflows/unrelated.yml": workflow('      - run: npm run build\n'),
  } });
  cli(dir, ["compile"]);
  const im = JSON.parse(cli(dir, ["impact", "./" + file]));
  assert.deepEqual(im.affectedComponents.map((c) => c.ref), ["component:default/svc"]);
  assert.deepEqual(im.unmatchedFiles, []);
  assert.deepEqual(im.affectedGates.map((v) => v.command), ["npm run lint"]);
  assert.ok(im.recommendedVerification.some((v) => v.command === "npm test -- service/"));
  assert.ok(im.recommendedVerification.some((v) => v.command === "npm run lint"));
  assert.ok(!im.recommendedVerification.some((v) => v.command === "npm run build"));
  const gateOnly = JSON.parse(cli(dir, ["impact", ".github/workflows/unrelated.yml"]));
  assert.deepEqual(gateOnly.affectedComponents, []);
  assert.deepEqual(gateOnly.affectedGates.map((v) => v.command), ["npm run build"]);
  assert.deepEqual(gateOnly.unmatchedFiles, []);
});

test("github-actions: known runners determine tiers, not words in arguments", (t) => {
  const file = ".github/workflows/runners.yml";
  const invocations = [
    ["node --test tests/*.test.mjs", "unit"],
    ["go test ./service/...", "unit"],
    ["cargo test --package engine", "unit"],
    ["python -m pytest service", "unit"],
    ["uv run pytest service", "unit"],
    ["npx vitest run service", "unit"],
    ["pnpm exec eslint service", "static"],
    ["pnpm run test:integration", "integration"],
    ["npm run test:e2e", "e2e"],
    ["npm run api:check", "contract"],
    ["npm run typecheck", "static"],
    ["tsc --noEmit", "static"],
    ["npm run build -- --label integration", "build"],
    ["test -n service && npm test -- service/", "unit"],
    ["npm test -- --label 'semi;colon'", "unit"],
  ];
  const dir = baseFixture(t, { extra: { [file]: workflow(invocations.map(([command]) =>
    "      - run: " + JSON.stringify(command)).join("\n") + "\n") } });
  cli(dir, ["compile"]);
  const checks = ciChecks(graphOf(dir), file);
  for (const [command, tier] of invocations) {
    const extracted = command.replace(/^test -n service && /, "");
    assert.equal(checks.find((v) => v.command === extracted)?.tier, tier, command);
  }
  assert.equal(checks.length, invocations.length);
});

test("github-actions: one-letter path arguments and filters require whole path segments", (t) => {
  const file = ".github/workflows/letter.yml";
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("    - service/**/agentdoc.yaml\n", "    - service/**/agentdoc.yaml\n    - e/agentdoc.yaml\n    - test/agentdoc.yaml\n"),
    extra: {
      "e/agentdoc.yaml": descriptor("e", "library"),
      "e/package.json": JSON.stringify({ name: "@t/e", main: "index.js" }),
      "test/agentdoc.yaml": descriptor("test", "library"),
      "test/package.json": JSON.stringify({ name: "@t/test", main: "index.js" }),
      [file]: workflow('      - run: npm test -- ./e/tests\n      - run: npm test -- elsewhere/\n      - run: npm test\n'),
      ".github/workflows/letter-paths.yml": workflow('      - run: npm run lint\n', 'on:\n  push:\n    paths: ["e/**"]\n'),
      ".github/workflows/negative-paths.yml": workflow('      - run: npm run lint\n', 'on:\n  push:\n    paths: ["e/**", "!e/**"]\n'),
    },
  });
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  assert.deepEqual(ciChecks(g, file).filter((v) => v.componentRefs).map((v) => [v.command, v.componentRefs]), [
    ["npm test -- ./e/tests", ["component:default/e"]],
  ]);
  assert.deepEqual(ciChecks(g, ".github/workflows/letter-paths.yml").map((v) => v.componentRefs), [["component:default/e"]]);
  assert.ok(ciChecks(g, ".github/workflows/negative-paths.yml").every((v) => !v.componentRefs));
});

test("github-actions: opaque shell programs and oversized commands are never copied as checks", (t) => {
  const file = ".github/workflows/opaque.yml";
  const dir = baseFixture(t, { extra: { [file]: workflow([
    '      - run: |',
    '          cat <<EOF',
    '          npm test -- service/',
    '          EOF',
    '      - run: |',
    '          if test -n "$CI"; then',
    '            npm test -- service/',
    '          fi',
    '      - run: cd service && npm test',
    '      - run: "npm test -- ' + "x".repeat(610) + '"',
  ].join("\n") + "\n") } });
  cli(dir, ["compile"]);
  assert.deepEqual(ciChecks(graphOf(dir), file), []);
});

test("github-actions: repeated compiles are identical and checks cite real workflow hashes", (t) => {
  const file = ".github/workflows/provenance.yml";
  const dir = baseFixture(t, { extra: { [file]: workflow('      - run: |\n          npm test -- service/\n          npm run lint\n') } });
  cli(dir, ["compile"]);
  const first = read(dir, ".agentdoc/graph.json");
  cli(dir, ["compile"]);
  assert.equal(read(dir, ".agentdoc/graph.json"), first);
  const g = graphOf(dir);
  const pr = g.provenance.find((p) => p.path === file && p.extractor.name === "ci-extractor");
  assert.equal(pr.contentHash, "sha256:" + createHash("sha256").update(read(dir, file)).digest("hex"));
  assert.equal(pr.subjects.length, 2);
  assert.ok(pr.subjects.some((s) => s.startsWith("/verification/")));
  assert.ok(pr.subjects.some((s) => s.startsWith("/gates/")));
  assert.ok(ciChecks(g, file).every((v) => v.provenanceIds.includes(pr.id)));
});
