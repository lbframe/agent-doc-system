// The five modes, exercised through the CLI exactly as an agent would use them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { baseFixture, cli, cliFails, commitAll, compile, git, read, write, DEFAULT_CONFIG, graphOf } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── CREATE ─────────────────────────────────────────────────────────────
test("CREATE: init writes a configuration and a documentation skeleton, and refuses to clobber", (t) => {
  const dir = baseFixture(t, {});
  // init into a fresh empty directory: that is the CREATE-mode situation.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-init-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const out = JSON.parse(cli(empty, ["init"]));
  assert.ok(out.written.includes("agentdoc/agentdoc.config.yaml"), out.written.join(","));
  assert.ok(out.written.some((w) => w.endsWith("docs/PRODUCT.md")));
  assert.ok(out.written.some((w) => w.endsWith("docs/ARCHITECTURE.md")));
  assert.ok(out.written.some((w) => w.endsWith("docs/CONSTRAINTS.md")));
  assert.ok(out.written.some((w) => w.includes(".github/workflows/agentdoc.yml")));
  const cfg = read(empty, "agentdoc/agentdoc.config.yaml");
  assert.match(cfg, /apiVersion: agentdoc\.dev\/config\/v1/);
  // A second init must not silently overwrite a reviewed configuration.
  const again = JSON.parse(cli(empty, ["init"]));
  assert.ok(again.skipped.includes("agentdoc/agentdoc.config.yaml"));
  void dir;
});

test("CREATE: scaffold reports what it would write without writing it", (t) => {
  const dir = baseFixture(t, {});
  const dry = JSON.parse(cli(dir, ["scaffold"]));
  assert.ok(Array.isArray(dry.written));
  assert.ok(dry.written.every((w) => !w.endsWith("agentdoc.yaml") || w.includes("dry run")));
  assert.ok(dry.proposal, "a scaffold must come with a proposal");
  assert.match(dry.proposal.rule, /only CONFIRMED and DERIVED/);
});

test("CREATE: scaffold unblocks units discovered by adapter roots, not only descriptor globs", (t) => {
  // go.work members become eligible units through the go adapter's roots() —
  // after `init` the compile fails on COVERAGE_ZERO, which is exactly what
  // scaffold exists to fix. A scaffold that refused to run on a non-compiling
  // repository would deadlock the whole CREATE flow.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-gows-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  write(dir, "go.work", "go 1.22\n\nuse (\n\t./services/api\n\t./libs/shared\n)\n");
  write(dir, "services/api/go.mod", "module example.com/api\n\ngo 1.22\n");
  write(dir, "services/api/cmd/api/main.go", "package main\n\nfunc main() {}\n");
  write(dir, "libs/shared/go.mod", "module example.com/shared\n\ngo 1.22\n");
  // A unit reachable only through config: no marker file, no workspace entry —
  // the layout scan cannot find it on its own.
  write(dir, "ops/runner/run.sh", "#!/bin/sh\ntrue\n");
  cli(dir, ["init"]);
  const cfgPath = "agentdoc/agentdoc.config.yaml";
  write(dir, cfgPath, read(dir, cfgPath).replace(
    "componentDescriptorName: agentdoc.yaml",
    "componentDescriptorName: agentdoc.yaml\n  supplementalRoots:\n    - ops/runner"
  ));

  const res = JSON.parse(cli(dir, ["scaffold", "--write"]));
  assert.ok(res.written.includes("services/api/agentdoc.yaml"), res.written.join(","));
  assert.ok(res.written.includes("libs/shared/agentdoc.yaml"), res.written.join(","));
  assert.ok(res.written.includes("ops/runner/agentdoc.yaml"), res.written.join(","));
  // The generated descriptors must actually be *loaded* — a supplementalRoots
  // unit has no componentDescriptors glob covering it, so this is the part the
  // compiler could otherwise silently miss. Fill every placement so the check
  // reaches coverage rather than stopping at the schema layer.
  for (const d of ["services/api/agentdoc.yaml", "libs/shared/agentdoc.yaml", "ops/runner/agentdoc.yaml"]) {
    write(dir, d, read(dir, d).replace("  # placementRationale:", "  placementRationale:"));
  }
  const v = cliFails(dir, ["validate"]);
  const stderr = v ? v.stderr : "";
  assert.ok(!/COVERAGE_ZERO/.test(stderr), "adapter/configured units still uncovered: " + stderr);
  assert.ok(!v, "scaffolded descriptors with placements should validate: " + stderr);
});

test("scaffold on a repository with no configuration fails, not silently no-ops", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-nocfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(dir, "package.json", JSON.stringify({ name: "x" }));
  const res = cliFails(dir, ["scaffold"]);
  assert.ok(res, "scaffold must exit nonzero when there is nothing to scaffold against");
  assert.equal(res.status, 1);
  assert.ok(JSON.parse(res.stdout).blocked.length > 0);
});

const scaffoldManifests = {
  "package.json": (name) => JSON.stringify({ name, main: "index.js" }),
  "go.mod": (name) => "module example.com/" + name + "\n\ngo 1.22\n",
  "Cargo.toml": (name) => '[package]\nname = "' + name + '"\nversion = "0.1.0"\n',
  "pyproject.toml": (name) => '[project]\nname = "' + name + '"\nversion = "0.1.0"\n',
};

function assertScaffoldExclusions(dir, excluded, expectedRoots) {
  const dry = JSON.parse(cli(dir, ["scaffold"]));
  const proposed = dry.written.map((f) => f.replace(/ \(dry run\)$/, ""));
  const descriptors = proposed.filter((f) => f.endsWith("/agentdoc.yaml"));
  for (const root of excluded) {
    assert.equal(descriptors.includes(root + "/agentdoc.yaml"), false, descriptors.join(","));
    assert.equal(fs.existsSync(path.join(dir, root, "agentdoc.yaml")), false, "dry run wrote a descriptor");
  }
  assert.deepEqual(descriptors.sort(), expectedRoots.map((r) => r + "/agentdoc.yaml").sort());
  const before = compile(dir);
  assert.deepEqual(before.discovery.eligible.map((u) => u.root).sort(), ["service", ...expectedRoots].sort());

  const written = JSON.parse(cli(dir, ["scaffold", "--write"]));
  assert.deepEqual(written.written, proposed, "dry run and --write must agree");
  for (const root of excluded) {
    assert.equal(fs.existsSync(path.join(dir, root, "agentdoc.yaml")), false, "wrote an excluded descriptor: " + root);
  }
  for (const rel of descriptors) {
    write(dir, rel, read(dir, rel).replace("  # placementRationale:", "  placementRationale:"));
  }
  const a = compile(dir);
  const b = compile(dir);
  assert.equal(a.errors.length, 0, a.errors.map((e) => e.message).join("\n"));
  assert.deepEqual(a.discovery.eligible.map((u) => u.root).sort(), ["service", ...expectedRoots].sort());
  assert.equal(a.serialized, b.serialized, "two compiles must be byte-identical");
}

for (const [manifest, content] of Object.entries(scaffoldManifests)) {
  test("CREATE: scaffold excludes configured roots and descendants with " + manifest, (t) => {
    const roots = ["packages/contracts", "packages/contracts/child", "packages/contracts-extra"];
    const extra = {};
    for (const [i, root] of roots.entries()) {
      extra[root + "/" + manifest] = content("unit-" + i);
      if (manifest === "Cargo.toml") extra[root + "/src/lib.rs"] = "pub fn hello() {}\n";
    }
    const config = DEFAULT_CONFIG
      .replace("    - service/**/agentdoc.yaml", '    - "**/agentdoc.yaml"')
      .replace("  componentDescriptorName: agentdoc.yaml", [
        "  componentDescriptorName: agentdoc.yaml",
        "  notUnitRoots: [packages/contracts]",
        "  supplementalRoots:",
        "    - packages/contracts/child",
        "    - packages/contracts-extra",
      ].join("\n"))
      .replace("adapters:", "adapters:\n  - go\n  - rust\n  - python");
    const dir = baseFixture(t, { config, extra });
    // The excluded root comes from the layout scan; its child also reaches
    // discovery through supplementalRoots. Neither source may bypass policy.
    assertScaffoldExclusions(dir, roots.slice(0, 2), [roots[2]]);
  });
}

test("CREATE: scaffold excludes default roots and descendants contributed by an adapter", (t) => {
  const defaults = ["agentdoc", "docs", "scripts", ".github", "node_modules"];
  const excluded = defaults.flatMap((r) => [r, r + "/child"]);
  const roots = [...excluded, "docs-extra"];
  const extra = {
    "go.work": "go 1.22\n\nuse (\n" + roots.map((r) => "  ./" + r).join("\n") + "\n)\n",
  };
  for (const [i, root] of roots.entries()) extra[root + "/go.mod"] = scaffoldManifests["go.mod"]("unit-" + i);
  const config = DEFAULT_CONFIG
    .replace("    - service/**/agentdoc.yaml", '    - "**/agentdoc.yaml"')
    .replace("adapters:", "adapters:\n  - go");
  assertScaffoldExclusions(baseFixture(t, { config, extra }), excluded, ["docs-extra"]);
});

test("CREATE: an empty notUnitRoots overrides the default scaffold exclusions", (t) => {
  const config = DEFAULT_CONFIG
    .replace("    - service/**/agentdoc.yaml", '    - "**/agentdoc.yaml"')
    .replace("  componentDescriptorName: agentdoc.yaml", "  componentDescriptorName: agentdoc.yaml\n  notUnitRoots: []");
  const dir = baseFixture(t, { config, extra: {
    "scripts/package.json": scaffoldManifests["package.json"]("tools"),
    "scripts/worker/package.json": scaffoldManifests["package.json"]("worker"),
  } });
  const proposed = JSON.parse(cli(dir, ["scaffold"])).written.map((f) => f.replace(/ \(dry run\)$/, ""));
  assert.ok(proposed.includes("scripts/agentdoc.yaml"), proposed.join(","));
  assert.ok(proposed.includes("scripts/worker/agentdoc.yaml"), proposed.join(","));
  assert.deepEqual(JSON.parse(cli(dir, ["scaffold", "--write"])).written, proposed);
});

const authoredTool = [
  "apiVersion: agentdoc.dev/v1",
  "kind: Component",
  "metadata:",
  "  name: tool",
  '  description: "Provides repository tooling."',
  "spec:",
  "  type: library",
  '  placementRationale: "Repository tooling has no system or domain."',
  "",
].join("\n");

for (const [label, excludedRoot] of [["default", "scripts"], ["configured", "packages/contracts"]]) {
  const config = DEFAULT_CONFIG
    .replace("    - service/**/agentdoc.yaml", '    - "**/agentdoc.yaml"')
    .replace("  componentDescriptorName: agentdoc.yaml", "  componentDescriptorName: agentdoc.yaml" +
      (label === "configured" ? "\n  notUnitRoots: [" + excludedRoot + "]" : ""));

  test("VALIDATE: authored descendants of a " + label + " exclusion remain corroborated units", (t) => {
    const root = excludedRoot + "/tool";
    const descriptor = root + "/agentdoc.yaml";
    const dir = baseFixture(t, { config, extra: {
      [excludedRoot + "/package.json"]: scaffoldManifests["package.json"]("parent"),
      [root + "/package.json"]: scaffoldManifests["package.json"]("tool"),
      [root + "/child/package.json"]: scaffoldManifests["package.json"]("unclaimed-child"),
      [descriptor]: authoredTool,
    } });
    assert.match(cli(dir, ["validate"]), /validate: PASS/);
    const result = compile(dir);
    assert.deepEqual(result.discovery.eligible.map((u) => u.root).sort(), [root, "service"].sort());
    assert.deepEqual(result.discovery.eligible.find((u) => u.root === root).markers,
      [{ adapter: "node", path: root + "/package.json", shape: "both" }]);
    assert.equal(result.serialized, compile(dir).serialized, "two compiles must be byte-identical");

    const original = read(dir, descriptor);
    const dry = JSON.parse(cli(dir, ["scaffold"]));
    const proposed = dry.written.map((f) => f.replace(/ \(dry run\)$/, ""));
    assert.ok(!proposed.some((f) => f.startsWith(excludedRoot + "/")), proposed.join(","));
    assert.deepEqual(JSON.parse(cli(dir, ["scaffold", "--write"])).written, proposed);
    assert.equal(read(dir, descriptor), original, "scaffold must preserve the authored descriptor");
    assert.equal(fs.existsSync(path.join(dir, root, "child/agentdoc.yaml")), false);
    assert.match(cli(dir, ["validate"]), /validate: PASS/);

    // Evidence in the excluded parent cannot corroborate the child's claim.
    fs.rmSync(path.join(dir, root, "package.json"));
    const unsupported = cliFails(dir, ["validate"]);
    assert.ok(unsupported, "an authored library still needs evidence in its own root");
    assert.match(unsupported.stderr, /AGENTDOC_ARTIFACT_TYPE/);
  });

  test("VALIDATE: a descriptor at a " + label + " excluded root names the exclusion", (t) => {
    const dir = baseFixture(t, { config, extra: {
      [excludedRoot + "/package.json"]: scaffoldManifests["package.json"]("tool"),
      [excludedRoot + "/agentdoc.yaml"]: authoredTool,
    } });
    const failure = cliFails(dir, ["validate"]);
    assert.ok(failure, "an exact-root descriptor must stay refused");
    assert.match(failure.stderr, /AGENTDOC_COMPONENT_UNCORROBORATED/);
    assert.ok(failure.stderr.includes("component descriptor at '" + excludedRoot + "' is in discovery.notUnitRoots"), failure.stderr);
    assert.match(failure.stderr, /remove it from notUnitRoots or move the descriptor/);
    assert.doesNotMatch(failure.stderr, /no adapter found|enable the adapter/);
    assert.deepEqual(compile(dir).discovery.eligible.map((u) => u.root), ["service"]);
  });
}

test("VALIDATE: an authored descendant loaded only through supplementalRoots remains a unit", (t) => {
  const config = DEFAULT_CONFIG.replace("  componentDescriptorName: agentdoc.yaml",
    "  componentDescriptorName: agentdoc.yaml\n  supplementalRoots: [scripts/tool]");
  const dir = baseFixture(t, { config, extra: {
    "scripts/tool/package.json": scaffoldManifests["package.json"]("tool"),
    "scripts/tool/agentdoc.yaml": authoredTool,
  } });
  assert.match(cli(dir, ["validate"]), /validate: PASS/);
  assert.deepEqual(compile(dir).discovery.eligible.map((u) => u.root), ["scripts/tool", "service"]);
});

// ── MIGRATE ────────────────────────────────────────────────────────────
test("MIGRATE: audit classifies every fact and never promotes uncertainty", (t) => {
  const dir = baseFixture(t, {
    extra: {
      "legacy/NOTES.md": "# Legacy notes\n\nThe service is called `ingest-worker` and listens on port 9099.\n",
    },
  });
  const report = JSON.parse(cli(dir, ["audit"]));
  for (const key of ["inventory", "facts", "counts", "contradictions", "reviewedAmbiguity", "documentation", "contracts", "observations", "scaffold"]) {
    assert.ok(key in report, "audit report is missing " + key);
  }
  for (const row of report.facts) {
    assert.ok(["CONFIRMED", "DERIVED", "OBSERVED", "CONFLICT", "UNRESOLVED"].includes(row.classification), row.classification);
  }
  // Stale documentation that no component claims is reported, not deleted.
  assert.ok(report.documentation.orphanDocs.includes("legacy/NOTES.md"));
  assert.ok(report.scaffold.summary.toReview > 0);
});

test("MIGRATE: audit runs on a repository that cannot compile yet", (t) => {
  const dir = baseFixture(t, {});
  write(dir, "agentdoc/apis.yaml", "this: is not a valid entity document\n");
  const out = JSON.parse(cli(dir, ["audit"]));
  assert.ok(Array.isArray(out.compileErrors));
  assert.ok(out.compileErrors.length > 0);
  assert.ok(out.compileErrors.every((e) => e.code && e.message));
});

test("MIGRATE: a port claimed in linked documentation contradicts the source", (t) => {
  const dir = baseFixture(t, {
    extra: { "service/LEGACY.md": "# Legacy\n\nThe service listens on port 9099.\n" },
  });
  write(dir, "service/agentdoc.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Serves the test surface."\nspec:\n  type: service\n  system: s1\n  context:\n    docs:\n      - service/LEGACY.md\n');
  commitAll(dir, "link the legacy doc");
  const report = JSON.parse(cli(dir, ["audit"]));
  const mismatch = report.documentationContradictions.find((c) => c.kind === "PORT_MISMATCH");
  assert.ok(mismatch, "expected a port contradiction: " + JSON.stringify(report.documentationContradictions));
  assert.equal(mismatch.contradicts, "component:default/svc");
});

// ── VALIDATE ───────────────────────────────────────────────────────────
test("VALIDATE: compile then check passes, and check alone without a graph says so", (t) => {
  const dir = baseFixture(t, {});
  assert.ok(cliFails(dir, ["check"]), "check must refuse when no graph exists");
  assert.match(cliFails(dir, ["check"]).stderr, /GRAPH_MISSING/);
  cli(dir, ["compile"]);
  assert.equal(cliFails(dir, ["check"]), null);
  assert.equal(cliFails(dir, ["check", "--require-clean"]), null);
});

test("VALIDATE: a dirty source is refused under --require-clean", (t) => {
  const dir = baseFixture(t, {});
  cli(dir, ["compile"]);
  write(dir, "service/README.md", "# changed while compiling\n");
  const r = cliFails(dir, ["check", "--require-clean"]);
  assert.ok(r);
  assert.match(r.stderr, /DIRTY|FRESHNESS/);
});

// Issue #11. With the graph committed (the default `init` setup), CI runs
// validate → compile → check on a clean checkout. compile rewrites
// `source.commit`, so the graph itself is modified relative to HEAD. The graph
// is an output, not an input: it must not flip the dirty flag, or a committed
// graph could never pass the generated workflow.
function committedGraphFixture(t) {
  const dir = baseFixture(t, {});
  write(dir, ".gitignore", "node_modules/\n");
  cli(dir, ["validate"]);
  cli(dir, ["compile"]);
  commitAll(dir, "catalog");
  assert.equal(git(dir, ["status", "--porcelain"]), "", "fixture must start from a clean tree");
  return dir;
}

test("VALIDATE: a committed graph passes validate → compile → check → check --require-clean (#11)", (t) => {
  const dir = committedGraphFixture(t);
  // Twice: committing the recompiled graph moves HEAD, and the next CI run
  // must still pass.
  for (let round = 0; round < 2; round++) {
    cli(dir, ["validate"]);
    cli(dir, ["compile"]);
    assert.match(git(dir, ["status", "--porcelain"]), /^ M \.agentdoc\/graph\.json$/m,
      "compile rewrites source.commit, so the committed graph is modified");
    assert.equal(graphOf(dir).source.dirty, false);
    assert.equal(cliFails(dir, ["check"]), null);
    assert.equal(cliFails(dir, ["check", "--require-clean"]), null);
    commitAll(dir, "recompile " + round);
  }
});

test("VALIDATE: with a committed graph, an uncommitted input change still fails --require-clean (#11)", (t) => {
  const dir = committedGraphFixture(t);
  cli(dir, ["compile"]);
  // An unstaged modification of a tracked input: porcelain `XY` is ` M`, the
  // exact shape the graph had. It must still count.
  write(dir, "service/CONSTRAINTS.md", "# Constraints\n\n- One rule, edited.\n  - Reason: because.\n  - Checked by: `pnpm test`\n");
  const stale = cliFails(dir, ["check"]);
  assert.ok(stale, "an input change after compile must make the graph stale");
  assert.match(stale.stderr, /AGENTDOC_GRAPH_FRESHNESS/);
  const out = cli(dir, ["compile"]);
  assert.match(out, /"dirty":true/);
  assert.equal(graphOf(dir).source.dirty, true);
  const r = cliFails(dir, ["check", "--require-clean"]);
  assert.ok(r, "a dirty input must be refused under --require-clean");
  assert.match(r.stderr, /AGENTDOC_DIRTY_SOURCE/);
});

test("VALIDATE: compiling twice produces identical bytes", (t) => {
  const dir = baseFixture(t, {});
  cli(dir, ["compile"]);
  const a = read(dir, ".agentdoc/graph.json");
  cli(dir, ["compile"]);
  assert.equal(read(dir, ".agentdoc/graph.json"), a);
});

// ── QUERY ──────────────────────────────────────────────────────────────
test("QUERY: a source path, a directory, a contract file and a ref all route", (t) => {
  const dir = baseFixture(t, {});
  cli(dir, ["compile"]);
  for (const needle of ["service/src/index.ts", "service", "contracts/svc.openapi.yaml", "component:default/svc", "api:default/svc-api", "resource:default/svc-postgres"]) {
    const out = cli(dir, ["query", needle, "--json"]);
    const ctx = JSON.parse(out);
    assert.ok(ctx.entity, needle);
  }
  const missing = cliFails(dir, ["query", "does/not/exist.ts"]);
  assert.ok(missing);
  assert.match(missing.stderr, /REF_UNRESOLVED/);
});

test("QUERY: the routed context carries constraints, checks, contracts and provenance", (t) => {
  const dir = baseFixture(t, {});
  cli(dir, ["compile"]);
  const ctx = JSON.parse(cli(dir, ["query", "service/src/index.ts", "--json"]));
  assert.deepEqual(ctx.constraints.constraints, ["service/CONSTRAINTS.md"]);
  assert.ok(ctx.verification.items.length > 0);
  assert.ok(ctx.verification.items.every((v) => typeof v.command === "string" && v.command.length > 0));
  assert.equal(ctx.apis.provided[0].api, "api:default/svc-api");
  assert.ok(ctx.resources.used.includes("resource:default/svc-postgres"));
  assert.ok(ctx.provenance.items.length > 0);
  assert.ok(ctx.provenance.items.every((p) => /^sha256:[0-9a-f]{64}$/.test(p.contentHash)));
  assert.ok(ctx.entity.sourcePaths.length > 0);
  const md = cli(dir, ["query", "service/src/index.ts", "--md"]);
  assert.match(md, /component:default\/svc/);
  assert.match(md, /CONSTRAINTS/);
});

test("QUERY: budgets are reported as truncation rather than silently applied", (t) => {
  // Truncation is rare by design — routing is one hop, so a focused query
  // returns a handful of relations — which is exactly why the previous version
  // of this test never ran its body: the base fixture compiles to ~10 relations
  // against a cap of 40, and every assertion sat inside `if (truncated)`. A test
  // that cannot fail is not a test.
  //
  // So the budget is lowered to a value the fixture genuinely exceeds, rather
  // than pretending a normal query truncates. The contract under test is that
  // every capped section reports what it withheld.
  const dir = baseFixture(t, {
    extra: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        "service/src/mod" + i + ".ts",
        "import { pool } from './db';\nexport const M" + i + " = " + i + " + pool.total;\n",
      ])
    ),
  });
  cli(dir, ["compile"]);
  // The default budgets are deliberately generous, so truncation is driven here
  // explicitly rather than waited for.
  const ctx = JSON.parse(cli(dir, ["query", "service", "--json", "--budget", "relations=2,provenance=2,verification=1,assertions=2"]));

  assert.ok(Array.isArray(ctx.truncated), "truncated must always be a list, even when empty");
  assert.ok(ctx.truncated.length > 0, "a budget of 2 against a larger section must truncate; got nothing");

  // Truncated sections are named by their path in the payload, so nested ones
  // read `authority.assertions` rather than `assertions`.
  const resolve = (name) => name.split(".").reduce((o, k) => (o == null ? o : o[k]), ctx);

  for (const name of ctx.truncated) {
    const section = resolve(name);
    assert.ok(section, "truncated names a section absent from the payload: " + name);
    assert.equal(section.truncated, true, name + " is listed as truncated but does not report it");
    assert.ok(
      section.total > section.items.length,
      name + " claims truncation but returned " + section.items.length + " of " + section.total
    );
    // The withheld count must be derivable, or an agent cannot tell what it missed.
    assert.ok(section.total - section.items.length > 0, name + " reports no withheld items");
  }

  // A section that is not listed must be complete, so the list is not simply
  // naming everything and the contract stays informative.
  for (const name of [
    "relations", "events", "externals", "verification", "contracts", "journeys", "capabilities",
    "authority.assertions", "authority.conflicts", "provenance",
  ]) {
    const section = resolve(name);
    if (!section || !Array.isArray(section.items)) continue;
    if (ctx.truncated.includes(name)) continue;
    assert.equal(
      section.items.length, section.total,
      name + " is absent from `truncated` yet is incomplete (" +
        section.items.length + " of " + section.total + ")"
    );
  }
});

test("QUERY: the query payload never contains a secret-shaped value", (t) => {
  const dir = baseFixture(t, {
    extra: {
      "service/package.json": JSON.stringify({
        name: "@t/svc", version: "1.0.0", main: "dist/index.js",
        scripts: { test: "API_KEY=sk-abcdefghijklmnopqrstuvwx vitest run" },
      }),
    },
  });
  cli(dir, ["compile"]);
  const out = cli(dir, ["query", "service", "--json"]);
  assert.ok(!/sk-abcdefghijklmnopqrstuvwx/.test(out), "a secret leaked into the query payload");
  assert.match(out, /REDACTED/);
});

// ── MAINTAIN ───────────────────────────────────────────────────────────
test("MAINTAIN: impact reports affected components, contracts and checks", (t) => {
  const dir = baseFixture(t, {});
  cli(dir, ["compile"]);
  const im = JSON.parse(cli(dir, ["impact", "contracts/svc.openapi.yaml"]));
  assert.ok(im.affectedComponents.some((c) => c.ref === "component:default/svc"));
  assert.deepEqual(im.affectedContracts, ["contracts/svc.openapi.yaml"]);
  assert.ok(im.graphWillBeStale, "changing a contract must invalidate the graph");
  assert.ok(im.recommendedVerification.length > 0);
});

test("MAINTAIN: impact on a constraint names the component that owns it", (t) => {
  const dir = baseFixture(t, {});
  cli(dir, ["compile"]);
  const im = JSON.parse(cli(dir, ["impact", "service/CONSTRAINTS.md"]));
  assert.ok(im.affectedComponents.some((c) => c.ref === "component:default/svc"));
  assert.deepEqual(im.affectedDocs, ["service/CONSTRAINTS.md"]);
});

test("MAINTAIN: impact --diff reads a commit range", (t) => {
  const dir = baseFixture(t, {});
  cli(dir, ["compile"]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  write(dir, "service/src/index.ts", 'export const NAME = "svc";\nexport const MORE = 2;\n');
  commitAll(dir, "change");
  const im = JSON.parse(cli(dir, ["impact", "--diff", head]));
  assert.deepEqual(im.changedFiles, ["service/src/index.ts"]);
  assert.ok(im.affectedComponents.some((c) => c.ref === "component:default/svc"));
});

// ── the corpus fixtures ────────────────────────────────────────────────
test("every bundled corpus compiles, checks and passes its routing scenarios", (t) => {
  const corpora = [
    path.join(ROOT, "examples", "koda", "repo"),
    path.join(ROOT, "fixtures", "a-node-ts-postgres"),
    path.join(ROOT, "fixtures", "b-go-multi-service"),
    path.join(ROOT, "fixtures", "c-alt-monorepo"),
    path.join(ROOT, "fixtures", "e-rust-workspace"),
    path.join(ROOT, "fixtures", "f-python-workspace"),
  ];
  for (const src of corpora) {
    const name = path.basename(src);
    // Compiled in a copy, never in place. Compiling the shipped corpora
    // rewrote their committed `.agentdoc/graph.json`, so `node --test` mutated
    // the package it was testing, and a read-only install would fail outright.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-corpus-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.cpSync(src, dir, { recursive: true });

    assert.equal(cliFails(dir, ["validate"]), null, name + " validate");
    assert.equal(cliFails(dir, ["compile"]), null, name + " compile: " + describeFailure(dir, ["compile"]));
    assert.equal(cliFails(dir, ["check"]), null, name + " check: " + describeFailure(dir, ["check"]));
    const ev = cliFails(dir, ["eval", "routing"]);
    assert.equal(ev, null, name + " eval: " + describeFailure(dir, ["eval", "routing"]));
  }
});

test("the committed graph of every shipped corpus is current with the compiler", (t) => {
  // A committed graph that no longer matches its compiler is worse than none:
  // it is a stale answer that looks authoritative. `check` compares the input
  // hash, which catches edits to the corpus but not a compiler change, so the
  // comparison is done by rebuilding.
  const corpora = [
    path.join(ROOT, "examples", "koda", "repo"),
    path.join(ROOT, "fixtures", "a-node-ts-postgres"),
    path.join(ROOT, "fixtures", "b-go-multi-service"),
    path.join(ROOT, "fixtures", "c-alt-monorepo"),
    path.join(ROOT, "fixtures", "e-rust-workspace"),
    path.join(ROOT, "fixtures", "f-python-workspace"),
  ];
  for (const src of corpora) {
    const name = path.basename(src);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-fresh-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.cpSync(src, dir, { recursive: true });
    // Run the real gate. `check` recompiles and compares bytes, which is exactly
    // the property that matters, and it does not care that a temp copy has no
    // git history. An earlier version of this test compared the JSON with
    // `source` removed — and that omission hid three genuinely stale shipped
    // graphs, because the field it dropped was the one that differed. A
    // hand-rolled comparison that is looser than the gate is worse than none.
    const res = cliFails(dir, ["check"]);
    assert.equal(
      res, null,
      name + ": the committed graph is not current with the compiler. " +
      describeFailure(dir, ["check"]) +
      "\nRun `agentdoc compile` in " + src + " and commit the result."
    );
    void graphOf;
  }
});

function describeFailure(dir, args) {
  const r = cliFails(dir, args);
  return r ? (r.stderr || r.stdout || "").slice(0, 600) : "(no failure)";
}

test("the aggregate routing evaluation meets its pre-registered thresholds", () => {
  const r = execFileSync("node", [path.join(ROOT, "evals", "run-all.mjs"), "--json"], { encoding: "utf8" });
  const report = JSON.parse(r);
  assert.equal(report.verdict, "PASS", report.failures.join("; "));
  assert.ok(report.aggregate.recall >= report.thresholds.minRecall);
  assert.ok(report.aggregate.criticalRecall >= report.thresholds.minCriticalRecall);
  assert.ok(report.aggregate.noise <= report.thresholds.maxNoise);
});

// ── the golden corpus specifically ─────────────────────────────────────
test("the golden corpus represents the four incident classes as explicit conflicts", (t) => {
  // Read the committed graph rather than recompiling in place. A test that
  // rewrites the fixture it asserts on cannot fail for the right reason, and it
  // mutates the package on every run.
  const dir = path.join(ROOT, "examples", "koda", "repo");
  const g = JSON.parse(read(dir, ".agentdoc/graph.json"));
  void t;
  const keys = new Set(g.conflicts.map((c) => c.key));
  // repo declares bindings the runtime does not have
  assert.ok(keys.has("binding.declared"), [...keys].join(","));
  // a supposed daily cron that is really hourly with hour gating
  assert.ok(keys.has("schedule.cron"), [...keys].join(","));
  const cron = g.conflicts.find((c) => c.key === "schedule.cron");
  const elected = g.assertions.find((a) => a.id === cron.election.electedAssertionId);
  const contradicted = g.assertions.find((a) => a.id === cron.election.contradictedAssertionIds[0]);
  assert.equal(elected.evidenceClass, "OBSERVED_RUNTIME");
  // The value is the raw expression list; the hour-gating explanation lives in
  // the observation's semantics, which is where prose belongs.
  assert.equal(elected.value, "0 * * * *,3 0 * * *");
  assert.match(elected.semantics || "", /hour 3/);
  assert.equal(contradicted.evidenceClass, "DERIVED");
  assert.equal(contradicted.value, "0 3 * * *");
  // an external API capability contradicting a repository assumption
  const supports = g.assertions.find((a) => a.key === "contract.supports");
  assert.equal(supports.evidenceClass, "OBSERVED_RUNTIME");
  // a recovered runtime intentionally different from the governed state
  const target = g.assertions.find((a) => a.key === "binding.target");
  assert.match(target.semantics, /deliberately retained/);
  // every contradiction is visible in the query surface
  const ctx = JSON.parse(cli(dir, ["query", "workers/koda-cron", "--json"]));
  assert.ok(ctx.authority.conflicts.items.length >= 2);
  assert.ok(ctx.authority.observations.length >= 1);
});

test("the golden corpus preserves the reference system's warning acceptances", () => {
  const dir = path.join(ROOT, "examples", "koda", "repo");
  const g = JSON.parse(read(dir, ".agentdoc/graph.json"));
  const accepted = g.diagnostics.filter((d) => d.acceptance);
  assert.ok(accepted.length >= 3, "expected reviewed warning acceptances");
  for (const d of accepted) {
    assert.ok(d.acceptance.reason && d.acceptance.reviewWhen);
    assert.ok(d.acceptance.evidence.length > 0);
    assert.ok(d.acceptance.evidence.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
  }
});

test("IMPACT: a Resource change names every component bound to it", (t) => {
  // `impact` on a Resource used to report nothing, or reported the Resource
  // itself in a list the reader reads as "components to check". Under-reporting
  // is the failure this router is supposed to prevent: an agent asking what a
  // dataset's owner change breaks was told "nothing", and the one component
  // bound to it was never mentioned.
  const dir = baseFixture(t);
  cli(dir, ["compile"]);

  const byRef = JSON.parse(cli(dir, ["impact", "resource:default/svc-postgres", "--json"]));
  assert.ok(
    byRef.affectedComponents.some((c) => c.ref === "component:default/svc"),
    "a Resource change must name the component bound to it: " + JSON.stringify(byRef.affectedComponents)
  );
  // A Resource is not a component and must not appear in that list.
  assert.ok(
    !byRef.affectedComponents.some((c) => c.ref.startsWith("resource:")),
    "a Resource must not be listed as an affected component: " + JSON.stringify(byRef.affectedComponents)
  );
  assert.ok(
    byRef.affectedComponents.some((c) => (c.reasons || []).some((r) => /resource/.test(r))),
    "the reason must say the resource is why: " + JSON.stringify(byRef.affectedComponents)
  );

  // The migration directory is the same change seen through a path.
  const byPath = JSON.parse(cli(dir, ["impact", "service/db/migrations/0001_init.sql", "--json"]));
  assert.ok(
    byPath.affectedComponents.some((c) => c.ref === "component:default/svc"),
    "a migration change must name the component bound to the resource: " + JSON.stringify(byPath.affectedComponents)
  );
});

test("AUDIT: a repository-wide doc role that resolves inside a component is reported", (t) => {
  // The orphan exemption covers the three fixed repository-wide roles. That is a
  // real exemption, and the previous fix for it shipped with no test — so the
  // bound itself was unverifiable. It is asserted here in both directions: a
  // genuine repository-wide path stays exempt, and a component-scoped path
  // wearing the role is reported rather than silenced by configuration.
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG,
    extra: {
      "service/SCOPED.md": "# Scoped notes\n\nBelongs to the service.\n",
      "docs/PRODUCT.md": "# Product\n\nRepository-wide.\n",
    },
  });
  write(dir, "agentdoc/agentdoc.config.yaml", read(dir, "agentdoc/agentdoc.config.yaml")
    .replace("  contractRoots:",
      "  contractRoots:")
    .replace("output:", "docs:\n  product: docs/PRODUCT.md\n  architecture: service/SCOPED.md\noutput:"));
  commitAll(dir);

  const report = JSON.parse(cli(dir, ["audit"]));
  const scoped = report.documentation.hierarchy.find((h) => h.path === "service/SCOPED.md");
  assert.ok(scoped, "the configured hierarchy must be reported: " + JSON.stringify(report.documentation.hierarchy));
  assert.equal(scoped.componentScoped, "service",
    "a repository-wide role resolving inside a component must be marked component-scoped: " + JSON.stringify(scoped));
  assert.ok(
    report.documentation.findings.some((f) => f.code === "AGENTDOC_DOC_ORPHANED" && f.subject === "service/SCOPED.md"),
    "the component-scoped orphan must be reported: " + JSON.stringify(report.documentation.findings)
  );
  assert.ok(
    report.documentation.orphanDocs.includes("service/SCOPED.md"),
    "and must appear in orphanDocs: " + JSON.stringify(report.documentation.orphanDocs)
  );

  // A genuine repository-wide document stays exempt, and is not an orphan.
  const product = report.documentation.hierarchy.find((h) => h.path === "docs/PRODUCT.md");
  assert.equal(product.componentScoped, null, "docs/PRODUCT.md is repository-wide: " + JSON.stringify(product));
  assert.ok(
    !report.documentation.orphanDocs.includes("docs/PRODUCT.md"),
    "a repository-wide document must not be reported as an orphan: " + JSON.stringify(report.documentation.orphanDocs)
  );

  // A configured path that does not exist is reported, which is what `exists`
  // is for. The previous implementation built this list by filtering the file
  // walk, which made `exists` a constant `true`.
  write(dir, "agentdoc/agentdoc.config.yaml", read(dir, "agentdoc/agentdoc.config.yaml")
    .replace("  product: docs/PRODUCT.md", "  product: docs/MISSING.md"));
  commitAll(dir);
  const missing = JSON.parse(cli(dir, ["audit"]));
  const gone = missing.documentation.hierarchy.find((h) => h.path === "docs/MISSING.md");
  assert.ok(gone, "a configured path that does not exist must still be listed: " + JSON.stringify(missing.documentation.hierarchy));
  assert.equal(gone.exists, false, "exists must be able to report false");
  assert.ok(
    missing.documentation.findings.some((f) => f.subject === "docs/MISSING.md"),
    "a missing configured document must be reported: " + JSON.stringify(missing.documentation.findings)
  );
});
