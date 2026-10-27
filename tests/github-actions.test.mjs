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

test("github-actions: repository script repro retains component checks and gates", (t) => {
  const file = ".github/workflows/scripts.yml";
  const dir = baseFixture(t, { extra: {
    "scripts/test.sh": "exit 0\n",
    "scripts/lint.sh": "exit 0\n",
    [file]: workflow('      - run: ./scripts/test.sh service/\n      - run: bash scripts/lint.sh\n      - run: npm test\n'),
  } });
  cli(dir, ["compile"]);
  assert.deepEqual(ciChecks(graphOf(dir), file).map((v) => [v.command, v.tier, v.componentRefs || []]), [
    ["./scripts/test.sh service/", "unit", ["component:default/svc"]],
    ["bash scripts/lint.sh", "static", []],
    ["npm test", "unit", []],
  ]);
});

for (const [command, script, tier] of [
  ["./scripts/test.sh service/", "scripts/test.sh", "unit"],
  ["bash scripts/lint.sh service/", "scripts/lint.sh", "static"],
  ["sh scripts/check.sh service/", "scripts/check.sh", "unit"],
  ["node scripts/typecheck.mjs service/", "scripts/typecheck.mjs", "static"],
  ["python scripts/build.py service/", "scripts/build.py", "build"],
  ["python3 scripts/e2e.py service/", "scripts/e2e.py", "e2e"],
  ["./scripts/integration-test service/", "scripts/integration-test", "integration"],
  ["node scripts/contract-check.mjs service/", "scripts/contract-check.mjs", "contract"],
]) {
  test("github-actions: repository script launcher " + command, (t) => {
    const file = ".github/workflows/launcher.yml";
    const dir = baseFixture(t, { extra: {
      [script]: "# repository check\n",
      [file]: workflow("      - run: " + command + "\n"),
    } });
    cli(dir, ["compile"]);
    assert.deepEqual(ciChecks(graphOf(dir), file).map((v) => [v.command, v.tier, v.componentRefs]), [
      [command, tier, ["component:default/svc"]],
    ]);
  });
}

test("github-actions: repository scripts reuse directory, path and trigger scope", (t) => {
  const file = ".github/workflows/script-scope.yml";
  const filtered = ".github/workflows/script-paths.yml";
  const dir = baseFixture(t, { extra: {
    "scripts/test.sh": "exit 0\n",
    "service/check.py": "pass\n",
    [file]: workflow([
      "      - run: bash ../scripts/test.sh",
      "        working-directory: service",
      "      - run: cd service && sh ../scripts/test.sh",
      "      - run: python3 service/check.py",
      "      - run: ./scripts/test.sh service-other/",
    ].join("\n") + "\n"),
    [filtered]: workflow("      - run: ./scripts/test.sh\n", 'on:\n  pull_request:\n    paths: ["service/**"]\n'),
  } });
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  assert.deepEqual(ciChecks(g, file).map((v) => [v.command, v.componentRefs || []]), [
    ["cd service && bash ../scripts/test.sh", ["component:default/svc"]],
    ["cd service && sh ../scripts/test.sh", ["component:default/svc"]],
    ["python3 service/check.py", ["component:default/svc"]],
    ["./scripts/test.sh service-other/", []],
  ]);
  assert.deepEqual(ciChecks(g, filtered).map((v) => v.componentRefs), [["component:default/svc"]]);
});

test("github-actions: non-check names and scripts outside the repository stay dropped", (t) => {
  const file = ".github/workflows/non-check-scripts.yml";
  const dir = baseFixture(t, { extra: {
    "scripts/deploy.sh": "exit 0\n",
    "scripts/contest.py": "pass\n",
    "scripts/test-dir/README": "not a script\n",
    [file]: workflow([
      "./scripts/deploy.sh service/", "bash scripts/deploy.sh service/",
      "sh scripts/deploy.sh service/", "node scripts/deploy.sh service/",
      "python scripts/contest.py service/", "python3 scripts/contest.py service/",
      "./scripts/test-missing.sh service/", "./scripts/test-dir service/",
      "bash /tmp/test.sh service/", "sh ../test.sh service/",
      'python3 "$SCRIPT" service/', "test -n service/",
    ].map((command) => "      - run: " + command).join("\n") + "\n"),
  } });
  cli(dir, ["compile"]);
  assert.deepEqual(ciChecks(graphOf(dir), file), []);
});

test("github-actions: shell conditions and mentions of checks are not invocations", (t) => {
  const file = ".github/workflows/conditions.yml";
  const dir = baseFixture(t, { extra: { [file]: workflow([
    '      - run: test -n "$CI"',
    '      - run: \'[ -n "$CI" ]\'',
    '      - run: \'[[ -n "$CI" ]]\'',
    '      - run: echo "npm test service/"',
    '      - run: npm install test lint build',
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

test("github-actions: workflow impact seeds library dependents and appends repository gates", (t) => {
  const file = ".github/workflows/library.yml";
  const dir = baseFixture(t, { config: NESTED_CONFIG, extra: {
    "pkg/a/package.json": JSON.stringify({ name: "@t/a", main: "index.js", scripts: { test: "node --test" } }),
    "pkg/a/agentdoc.yaml": descriptor("a", "library"),
    "service/package.json": JSON.stringify({
      name: "@t/svc", main: "dist/index.js", scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
      dependencies: { "@t/a": "workspace:*", pg: "^8.13.1" },
    }),
    [file]: workflow('      - run: pnpm --filter @t/a test\n      - run: agentdoc compile\n'),
  } });
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  assert.ok(g.relations.some((r) => r.type === "buildDependsOn" && r.sourceRef === "component:default/svc" && r.targetRef === "component:default/a"));
  const im = JSON.parse(cli(dir, ["impact", file]));
  assert.deepEqual(im.affectedComponents.map((c) => c.ref), ["component:default/a", "component:default/svc"]);
  assert.deepEqual(im.unmatchedFiles, []);
  const own = g.verification.filter((v) => v.componentRefs.includes("component:default/a"));
  const dependent = g.verification.filter((v) => v.componentRefs.includes("component:default/svc"));
  assert.ok(own.length && dependent.some((v) => v.tier === "static"));
  const ids = im.recommendedVerification.map((v) => v.id);
  assert.ok([...own, ...dependent].every((v) => ids.includes(v.id)));
  assert.ok(Math.max(...own.map((v) => ids.indexOf(v.id))) < Math.min(...dependent.map((v) => ids.indexOf(v.id))));
  assert.deepEqual(im.affectedGates.map((v) => v.command), ["agentdoc compile"]);
  assert.deepEqual(im.recommendedVerification.slice(-1), im.affectedGates);
  assert.equal(im.recommendedVerificationTotal, own.length + dependent.length + 1);
  assert.equal(im.recommendedVerificationTruncated, false);
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
    '      - run: cd "$TARGET" && npm test',
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


test("github-actions: review repro keeps real checks and scopes each independently", (t) => {
  const file = ".github/workflows/review.yml";
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("    - service/**/agentdoc.yaml\n", "    - service/**/agentdoc.yaml\n    - services/*/agentdoc.yaml\n    - web/agentdoc.yaml\n").replace("  - node\n", "  - node\n  - python\n"),
    extra: {
      "services/api/agentdoc.yaml": descriptor("api", "library"),
      "services/api/pyproject.toml": '[project]\nname = "api"\nversion = "1.0.0"\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      "services/api/api/__init__.py": "",
      "web/agentdoc.yaml": descriptor("web", "library"),
      "web/package.json": JSON.stringify({ name: "web", main: "index.js", scripts: { test: "vitest run" } }),
      [file]: `jobs:
  api:
    steps:
      - uses: actions/checkout@v4
      - run: cd services/api && pytest
      - uses: golangci/golangci-lint-action@v6
        with: { working-directory: services/api }
  web:
    steps:
      - run: npm ci
      - run: pnpm turbo run test --filter=web
      - run: npx turbo run lint
      - run: pnpm --filter web test
`,
    },
  });
  cli(dir, ["compile"]);
  const checks = ciChecks(graphOf(dir), file);
  // The six review rows, including the install that must stay absent.
  assert.deepEqual(checks.map((v) => [v.command, v.tier, v.componentRefs || []]), [
    ["cd services/api && pytest", "unit", ["component:default/api"]],
    ["golangci/golangci-lint-action@v6", "static", ["component:default/api"]],
    ["pnpm turbo run test --filter=web", "unit", ["component:default/web"]],
    ["pnpm --filter web test", "unit", ["component:default/web"]],
    ["npx turbo run lint", "static", []],
  ]);
});

test("github-actions: literal cd updates scope only within its step, opaque changes stop extraction", (t) => {
  const file = ".github/workflows/directories.yml";
  const dir = baseFixture(t, { extra: { [file]: workflow([
    '      - run: |',
    '          cd service',
    '          npm test',
    '          cd src',
    '          npm run lint',
    '          cd ../..',
    '          npm run build',
    '      - run: npm test',
    '      - run: cd .. && npm test',
    '        working-directory: service/src',
    ...['cd "$TARGET"', 'cd ~', 'cd service*', 'cd -', 'cd', 'pushd service', 'popd', 'source setup.sh', '. setup.sh', 'eval setup', 'export PWD=service'].map((change) => '      - run: ' + JSON.stringify(change + ' && npm test -- service/')),
  ].join("\n") + "\n") } });
  cli(dir, ["compile"]);
  const checks = ciChecks(graphOf(dir), file);
  assert.deepEqual(checks.map((v) => [v.command, v.componentRefs || []]), [
    ["cd service && npm test", ["component:default/svc"]],
    ["cd service/src && npm run lint", ["component:default/svc"]],
    ["cd service && npm test", ["component:default/svc"]],
    ["npm run build", []],
    ["npm test", []],
  ]);
});

test("github-actions: turbo tasks work through wrappers, multiple tiers and literal filters", (t) => {
  const file = ".github/workflows/turbo.yml";
  const invocations = [
    ["turbo run test lint --filter=@t/svc", ["unit", "static"], true],
    ["turbo test --filter=./service", ["unit"], true],
    ["pnpm turbo run test --filter=service", ["unit"], true],
    ["npx turbo run lint", ["static"], false],
    ["yarn turbo test --filter @t/svc", ["unit"], true],
    ["bunx turbo run build", ["build"], false],
    ["pnpm exec turbo run test", ["unit"], false],
    ["turbo run test --filter=service-other", ["unit"], false],
    ["turbo run test --filter=$PACKAGE", ["unit"], false],
    ["turbo run deploy --label=test", [], false],
  ];
  const dir = baseFixture(t, { extra: { [file]: workflow(invocations.map(([command]) => '      - run: ' + JSON.stringify(command)).join("\n") + "\n") } });
  cli(dir, ["compile"]);
  const checks = ciChecks(graphOf(dir), file);
  for (const [command, tiers, scoped] of invocations) {
    const found = checks.filter((v) => v.command === command);
    assert.deepEqual(found.map((v) => v.tier), tiers, command);
    assert.ok(found.every((v) => JSON.stringify(v.componentRefs || []) === JSON.stringify(scoped ? ["component:default/svc"] : [])), command);
  }
});

test("github-actions: nx resolves project tasks and unfiltered run-many or affected gates", (t) => {
  const file = ".github/workflows/nx.yml";
  const dir = baseFixture(t, { extra: {
    "service/project.json": JSON.stringify({ name: "backend" }),
    [file]: workflow([
      '      - run: nx run backend:test',
      '      - run: pnpm nx run-many -t lint',
      '      - run: npx nx affected --target=test',
      '      - run: nx run-many -t test,build --projects=backend',
      '      - run: nx run elsewhere:lint',
    ].join("\n") + "\n"),
  } });
  cli(dir, ["compile"]);
  const checks = ciChecks(graphOf(dir), file);
  assert.deepEqual(checks.map((v) => [v.command, v.tier, v.componentRefs || []]), [
    ["nx run backend:test", "unit", ["component:default/svc"]],
    ["nx run-many -t test,build --projects=backend", "unit", ["component:default/svc"]],
    ["nx run-many -t test,build --projects=backend", "build", ["component:default/svc"]],
    ["pnpm nx run-many -t lint", "static", []],
    ["npx nx affected --target=test", "unit", []],
    ["nx run elsewhere:lint", "static", []],
  ]);
});

test("github-actions: make -C scopes tasks and preserves its runnable command", (t) => {
  const file = ".github/workflows/make.yml";
  const dir = baseFixture(t, { extra: { [file]: workflow([
    '      - run: make -C service test',
    '      - run: make --directory=service lint build',
    '      - run: make test',
    '      - run: make -C .. test',
    '        working-directory: service/src',
  ].join("\n") + "\n") } });
  cli(dir, ["compile"]);
  assert.deepEqual(ciChecks(graphOf(dir), file).map((v) => [v.command, v.tier, v.componentRefs || []]), [
    ["make -C service test", "unit", ["component:default/svc"]],
    ["make --directory=service lint build", "static", ["component:default/svc"]],
    ["make --directory=service lint build", "build", ["component:default/svc"]],
    ["cd service/src && make -C .. test", "unit", ["component:default/svc"]],
    ["make test", "unit", []],
  ]);
});

test("github-actions: just tasks are gates unless their step has explicit scope", (t) => {
  const file = ".github/workflows/just.yml";
  const dir = baseFixture(t, { extra: { [file]: workflow('      - run: just test\n      - run: just lint\n        working-directory: service\n      - run: just deploy\n') } });
  cli(dir, ["compile"]);
  assert.deepEqual(ciChecks(graphOf(dir), file).map((v) => [v.command, v.tier, v.componentRefs || []]), [
    ["cd service && just lint", "static", ["component:default/svc"]],
    ["just test", "unit", []],
  ]);
});

test("github-actions: check actions use their own input scopes and exclude infrastructure actions", (t) => {
  const file = ".github/workflows/actions.yml";
  const dir = baseFixture(t, { extra: { [file]: workflow([
    '      - uses: vendor/lint-action@v1',
    '        with: { working_directory: service }',
    '      - uses: vendor/test-action@v1',
    '        with: { path: service/tests }',
    '      - uses: vendor/check-action@v1',
    '      - uses: vendor/scan-action@v1',
    '      - uses: vendor/audit-action@v1',
    '      - uses: vendor/test-action@v2',
    '        with: { path: service-other }',
    ...['setup-test', 'checkout', 'cache-test', 'upload-test', 'download-test', 'test-artifact', 'build', 'deploy'].map((name) => '      - uses: vendor/' + name + '@v1'),
  ].join("\n") + "\n", "on: push\n", "defaults:\n  run:\n    working-directory: service\n") } });
  cli(dir, ["compile"]);
  assert.deepEqual(ciChecks(graphOf(dir), file).map((v) => [v.command, v.tier, v.componentRefs || []]), [
    ["vendor/lint-action@v1", "static", ["component:default/svc"]],
    ["vendor/test-action@v1", "unit", ["component:default/svc"]],
    ["vendor/check-action@v1", "static", []],
    ["vendor/scan-action@v1", "static", []],
    ["vendor/audit-action@v1", "static", []],
    ["vendor/test-action@v2", "unit", []],
  ]);
});
