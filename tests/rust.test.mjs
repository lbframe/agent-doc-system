// Rust adapter (issue #17): Cargo workspaces at the same evidence bar as Go and Node.
//
// The adapter reads manifests. It does not run cargo, read a lockfile, or pick
// a crate when two crates would answer the same import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, cpSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SYSTEM_ROOT, write, git, commitAll, cli, read } from "./helpers.mjs";
import { compile } from "../core/compile.mjs";
import { impact } from "../core/impact.mjs";
import { queryContext } from "../core/query.mjs";

const FIXTURE = path.join(SYSTEM_ROOT, "fixtures", "e-rust-workspace");

function edge(graph, type, source, target) {
  return graph.relations.find((r) => r.type === type && r.sourceRef === source && r.targetRef === target);
}

function component(graph, name) {
  return graph.entities.find((e) => e.kind === "Component" && e.name === name);
}

test("RUST: workspace fixture derives crate edges, commands, and refuses the ambiguous import", () => {
  const a = compile(FIXTURE);
  const b = compile(FIXTURE);
  assert.equal(a.errors.length, 0, a.errors.map((e) => e.format?.() || e.message).join("\n"));
  assert.equal(a.serialized, b.serialized, "two compiles must be byte-identical");

  const graph = a.graph;
  const names = graph.entities.filter((e) => e.kind === "Component").map((e) => e.name).sort();
  assert.deepEqual(names, ["cli", "engine", "foo-bar", "foo-u-bar", "logging", "testutil"]);
  assert.equal(component(graph, "cli").entity.spec.type, "service");
  assert.equal(component(graph, "engine").entity.spec.type, "library");
  for (const name of names) {
    const derived = component(graph, name).derived;
    assert.deepEqual(derived.languages, ["rust"], name);
    assert.deepEqual(derived.runtimes, ["rust"], name);
    assert.equal(derived.markers[0].adapter, "rust");
    assert.ok(derived.markers[0].path.endsWith("/Cargo.toml"), derived.markers[0].path);
  }
  assert.equal(component(graph, "cli").derived.hasTests, true);
  assert.equal(component(graph, "engine").derived.hasTests, true);
  assert.equal(component(graph, "logging").derived.hasTests, undefined);
  assert.equal(component(graph, "cli").derived.crateName, "cli");
  assert.equal(component(graph, "foo-u-bar").derived.crateName, "foo_bar");

  const cliRef = "component:default/cli";
  const engineEdge = edge(graph, "buildDependsOn", cliRef, "component:default/engine");
  assert.ok(engineEdge, "workspace = true dependency missing");
  assert.deepEqual(engineEdge.attributes.via, ["cargo-manifest", "source-import"]);
  assert.equal(engineEdge.attributes.package, "engine");
  const loggingEdge = edge(graph, "buildDependsOn", cliRef, "component:default/logging");
  assert.ok(loggingEdge, "import-only sibling missing");
  assert.deepEqual(loggingEdge.attributes.via, ["source-import"]);
  assert.equal(loggingEdge.attributes.package, "logging");
  const devEdge = edge(graph, "testDependsOn", cliRef, "component:default/testutil");
  assert.ok(devEdge, "dev-dependency missing");
  assert.deepEqual(devEdge.attributes.via, ["cargo-manifest"]);
  assert.equal(devEdge.attributes.package, "testutil");
  assert.equal(edge(graph, "buildDependsOn", cliRef, "component:default/foo-bar"), undefined);
  assert.equal(edge(graph, "buildDependsOn", cliRef, "component:default/foo-u-bar"), undefined);
  assert.equal(edge(graph, "buildDependsOn", "component:default/engine", "component:default/testutil"), undefined, "cfg(test) import became a production edge");

  for (const name of ["cli", "engine", "logging", "testutil", "foo-bar", "foo-u-bar"]) {
    const ref = "component:default/" + name;
    const tests = graph.verification.find((v) => v.id === ref + ":cargo-test");
    const clippy = graph.verification.find((v) => v.id === ref + ":cargo-clippy");
    const crate = component(graph, name).derived.crateName;
    assert.equal(tests.tier, "unit");
    assert.equal(tests.command, "cargo test -p " + crate);
    assert.deepEqual(tests.configPaths, [component(graph, name).derived.sourcePath + "/Cargo.toml"]);
    assert.equal(clippy.tier, "static");
    assert.equal(clippy.command, "cargo clippy -p " + crate);
  }

  assert.deepEqual(
    graph.externalDependencies.map((e) => e.componentRef + " " + e.name + " " + e.mechanism),
    ["component:default/cli serde sdk"]
  );

  const ambiguous = a.diagnostics.filter((d) => d.code === "AGENTDOC_BINDING_AMBIGUOUS");
  assert.equal(ambiguous.length, 1);
  assert.match(ambiguous[0].message, /foo_bar/);
  assert.match(ambiguous[0].message, /foo-bar/);
  assert.equal(ambiguous[0].severity, "warning");

  const manifest = "apps/cli/Cargo.toml";
  const hash = "sha256:" + createHash("sha256").update(readFileSync(path.join(FIXTURE, manifest))).digest("hex");
  const prov = graph.provenance.find((p) => p.path === manifest && p.extractor.name === "cargo-extractor");
  assert.ok(prov, "manifest provenance missing");
  assert.equal(prov.contentHash, hash);
  assert.equal(prov.class, "observed");
  const importProv = graph.provenance.find((p) => p.path === "apps/cli/src/main.rs" && p.extractor.name === "cargo-import-extractor");
  assert.ok(importProv, "import provenance missing");
  assert.equal(
    importProv.contentHash,
    "sha256:" + createHash("sha256").update(readFileSync(path.join(FIXTURE, "apps/cli/src/main.rs"))).digest("hex")
  );

  const validateOut = cli(FIXTURE, ["validate"]);
  assert.match(validateOut, /AGENTDOC_BINDING_AMBIGUOUS/);
  assert.match(validateOut, /agentdoc validate: PASS/);

  const hit = impact(graph, ["crates/engine/Cargo.toml", "apps/cli/src/main.rs"]);
  const affected = hit.affectedComponents.map((c) => c.ref).sort();
  assert.ok(affected.includes("component:default/engine"), affected.join(","));
  assert.ok(affected.includes("component:default/cli"), affected.join(","));
  const commands = hit.recommendedVerification.map((v) => v.command);
  assert.ok(commands.includes("cargo test -p engine"), commands.join(","));
  assert.ok(commands.includes("cargo test -p cli"), commands.join(","));

  const queried = queryContext(graph, "apps/cli/src/main.rs");
  assert.equal(queried.entity.ref, "component:default/cli");
  assert.ok(queried.verification.items.some((v) => v.command === "cargo test -p cli"));
  const queriedManifest = queryContext(graph, "crates/logging/Cargo.toml");
  assert.equal(queriedManifest.entity.ref, "component:default/logging");
});

test("RUST: scaffold emits one corroborated descriptor per workspace crate", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-rust-scaffold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FIXTURE, dir, { recursive: true });
  const drop = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) drop(p);
      else if (e.name === "agentdoc.yaml" && !p.includes(path.sep + "agentdoc" + path.sep)) rmSync(p);
    }
  };
  drop(dir);
  const res = JSON.parse(cli(dir, ["scaffold", "--write"]));
  assert.ok(res.written.includes("apps/cli/agentdoc.yaml"), res.written.join(","));
  assert.ok(!res.written.includes("crates/excluded/agentdoc.yaml"), res.written.join(","));
  const expect = {
    "apps/cli/agentdoc.yaml": ["name: cli", "type: service"],
    "crates/engine/agentdoc.yaml": ["name: engine", "type: library"],
    "crates/logging/agentdoc.yaml": ["name: logging", "type: library"],
    "crates/testutil/agentdoc.yaml": ["name: testutil", "type: library"],
    "crates/foo-bar/agentdoc.yaml": ["name: foo-bar", "type: library"],
    "crates/foo_bar/agentdoc.yaml": ["name: foo-u-bar", "type: library"],
  };
  for (const [rel, needles] of Object.entries(expect)) {
    const text = read(dir, rel);
    for (const n of needles) assert.ok(text.includes(n), rel + " missing " + n + "\n" + text);
    assert.doesNotMatch(text, /type: other/);
  }
});

test("RUST: init suggests the rust adapter from Cargo.toml", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-rust-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, "Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
  write(dir, "crates/engine/Cargo.toml", '[package]\nname = "engine"\nversion = "0.1.0"\n');
  write(dir, "crates/engine/src/lib.rs", "pub fn start() {}\n");
  const out = JSON.parse(cli(dir, ["init"]));
  assert.ok(out.written.includes("agentdoc/agentdoc.config.yaml"));
  const cfg = read(dir, "agentdoc/agentdoc.config.yaml");
  assert.match(cfg, /\n  - rust\n/);
});

test("RUST: validate, compile, and check pass on the fixture", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-rust-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FIXTURE, dir, { recursive: true, filter: (s) => !s.endsWith(path.sep + ".agentdoc") && !s.includes(path.sep + ".agentdoc" + path.sep) });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  commitAll(dir);
  assert.match(cli(dir, ["validate"]), /agentdoc validate: PASS/);
  assert.match(cli(dir, ["compile"]), /agentdoc compile: PASS/);
  const first = read(dir, ".agentdoc/graph.json");
  assert.match(cli(dir, ["compile"]), /agentdoc compile: PASS/);
  assert.equal(read(dir, ".agentdoc/graph.json"), first);
  assert.match(cli(dir, ["check"]), /agentdoc check: PASS/);
  const queried = cli(dir, ["query", "apps/cli/src/main.rs", "--json"]);
  assert.equal(JSON.parse(queried).entity.ref, "component:default/cli");
  const impacted = JSON.parse(cli(dir, ["impact", "crates/engine/Cargo.toml"]));
  assert.ok(impacted.affectedComponents.some((c) => c.ref === "component:default/cli"));
  assert.ok(impacted.affectedComponents.some((c) => c.ref === "component:default/engine"));
});

function catalog(t, files, { adapters = ["rust"], extra = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-rust-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  write(dir, "agentdoc/domains.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Domain\nmetadata:\n  name: workspace\n  description: "Groups the crates under test."\nspec: {}\n');
  write(dir, "agentdoc/systems.yaml", 'apiVersion: agentdoc.dev/v1\nkind: System\nmetadata:\n  name: pipeline\n  description: "Holds the crates under test."\nspec:\n  domain: workspace\n');
  write(dir, "agentdoc/apis.yaml", "# none\n");
  write(dir, "agentdoc/resources.yaml", "# none\n");
  write(dir, "agentdoc/journeys.yaml", "schemaVersion: agentdoc.dev/journeys/v1\njourneys: []\n");
  write(dir, "agentdoc/agentdoc.config.yaml", [
    "apiVersion: agentdoc.dev/config/v1",
    "namespace: default",
    "discovery:",
    "  componentDescriptorName: agentdoc.yaml",
    "  componentDescriptors:",
    '    - "crates/**/agentdoc.yaml"',
    '    - "apps/**/agentdoc.yaml"',
    "  centralDescriptors:",
    "    - agentdoc/domains.yaml",
    "    - agentdoc/systems.yaml",
    "    - agentdoc/apis.yaml",
    "    - agentdoc/resources.yaml",
    "  journeyDefinitions: agentdoc/journeys.yaml",
    extra,
    "adapters:",
    ...adapters.map((a) => "  - " + a),
    "authority:",
    "  rules: []",
    "output:",
    "  graph: .agentdoc/graph.json",
    "  observations: agentdoc/observations",
    "",
  ].join("\n"));
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  commitAll(dir);
  return dir;
}

const LIB = (name, desc) => [
  "apiVersion: agentdoc.dev/v1",
  "kind: Component",
  "metadata:",
  "  name: " + name,
  '  description: "' + desc + '"',
  "spec:",
  "  type: library",
  "  system: pipeline",
  "",
].join("\n");

test("RUST: a Cargo.toml that does not parse stays a unit and yields AGENTDOC_YAML_PARSE", (t) => {
  const dir = catalog(t, {
    "crates/broken/Cargo.toml": '[package]\nname = "broken"\nversion = "0.1.0"\ndescription = """\nhello\n"""\n',
    "crates/broken/src/lib.rs": "pub fn broken() {}\n",
    "crates/broken/agentdoc.yaml": LIB("broken", "Holds a manifest the TOML reader rejects."),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  assert.ok(component(res.graph, "broken"), "parse failure dropped the unit");
  assert.deepEqual(component(res.graph, "broken").derived.languages, ["rust"]);
  const diag = res.diagnostics.find((d) => d.code === "AGENTDOC_YAML_PARSE");
  assert.ok(diag, res.diagnostics.map((d) => d.code).join(","));
  assert.equal(diag.severity, "warning");
  assert.equal(res.graph.verification.find((v) => v.id.endsWith(":cargo-test") && v.componentRefs.includes("component:default/broken")), undefined);
});

test("RUST: duplicate crate names and a version-only lookalike are not elected", (t) => {
  const dir = catalog(t, {
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    "crates/left/Cargo.toml": '[package]\nname = "dup"\nversion = "0.1.0"\n',
    "crates/left/src/lib.rs": "pub fn left() {}\n",
    "crates/left/agentdoc.yaml": LIB("left", "Declares the first crate named dup."),
    "crates/right/Cargo.toml": '[package]\nname = "dup"\nversion = "0.1.0"\n',
    "crates/right/src/lib.rs": "pub fn right() {}\n",
    "crates/right/agentdoc.yaml": LIB("right", "Declares the second crate named dup."),
    "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\ndup = "0.1.0"\n',
    "crates/app/src/lib.rs": "use dup::left;\npub fn go() { let _ = left; }\n",
    "crates/app/agentdoc.yaml": LIB("app", "Depends on a name that two crates share."),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  const codes = res.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("AGENTDOC_BINDING_AMBIGUOUS"), codes.join(","));
  assert.equal(edge(res.graph, "buildDependsOn", "component:default/app", "component:default/left"), undefined);
  assert.equal(edge(res.graph, "buildDependsOn", "component:default/app", "component:default/right"), undefined);
});

test("RUST: path, rename, workspace, target cfg, and build-dependencies share one edge key", (t) => {
  const dir = catalog(t, {
    "Cargo.toml": [
      "[workspace]",
      'members = ["crates/*"]',
      "[workspace.dependencies]",
      'logging = { path = "crates/logging", version = "0.1.0" }',
      "",
    ].join("\n"),
    "crates/logging/Cargo.toml": '[package]\nname = "logging"\nversion = "0.1.0"\n',
    "crates/logging/src/lib.rs": "pub fn init() {}\n",
    "crates/logging/agentdoc.yaml": LIB("logging", "Provides the logging entry point."),
    "crates/app/Cargo.toml": [
      "[package]",
      'name = "app"',
      'version = "0.1.0"',
      "[dependencies]",
      'logs = { package = "logging", workspace = true }',
      "[build-dependencies]",
      'logging = { path = "../logging" }',
      "[target.'cfg(unix)'.dependencies]",
      'logging = { path = "../logging" }',
      "",
    ].join("\n"),
    "crates/app/src/lib.rs": "use logs::init;\npub fn boot() { init(); let _ = logging::init; }\n",
    "crates/app/agentdoc.yaml": LIB("app", "Depends on logging under a renamed key."),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  const rel = edge(res.graph, "buildDependsOn", "component:default/app", "component:default/logging");
  assert.ok(rel, JSON.stringify(res.graph.relations.filter((r) => r.type === "buildDependsOn")));
  assert.equal(rel.attributes.package, "logging");
  assert.deepEqual(rel.attributes.via, ["cargo-manifest", "source-import"]);
  assert.equal(res.graph.relations.filter((r) => r.type === "buildDependsOn" && r.sourceRef === "component:default/app" && r.targetRef === "component:default/logging").length, 1);
});

test("RUST: extern crate and a bare path import a sibling that the manifest does not name", (t) => {
  const dir = catalog(t, {
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    "crates/logging/Cargo.toml": '[package]\nname = "logging"\nversion = "0.1.0"\n',
    "crates/logging/src/lib.rs": "pub fn init() {}\n",
    "crates/logging/agentdoc.yaml": LIB("logging", "Provides the logging entry point."),
    "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
    "crates/app/src/lib.rs": "extern crate logging;\npub fn boot() { logging::init(); }\n",
    "crates/app/agentdoc.yaml": LIB("app", "Imports logging without a manifest dependency."),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  const rel = edge(res.graph, "buildDependsOn", "component:default/app", "component:default/logging");
  assert.ok(rel);
  assert.deepEqual(rel.attributes.via, ["source-import"]);
  assert.equal(rel.attributes.package, "logging");
});

test("RUST: a path that leaves the repository and a missing workspace entry create no edge", (t) => {
  const dir = catalog(t, {
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\nlogging = "0.1.0"\n',
    "crates/app/Cargo.toml": [
      "[package]",
      'name = "app"',
      'version = "0.1.0"',
      "[dependencies]",
      'outside = { path = "../../outside" }',
      'logging = { workspace = true }',
      "",
    ].join("\n"),
    "crates/app/src/lib.rs": "pub fn boot() {}\n",
    "crates/app/agentdoc.yaml": LIB("app", "Points a dependency outside the repository."),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  assert.equal(res.graph.relations.filter((r) => r.type === "buildDependsOn").length, 0);
});

test("RUST: a virtual workspace manifest is not a unit, and an excluded member is not either", () => {
  const res = compile(FIXTURE);
  assert.equal(res.errors.length, 0);
  assert.ok(!res.graph.entities.some((e) => e.kind === "Component" && (e.derived.sourcePath === "." || e.name === "excluded")));
  assert.equal(res.discovery.eligible.some((u) => u.root === "." || u.root === "" || u.root === "crates/excluded"), false);
});

test("RUST: both a lib and a bin are deployable and importable", (t) => {
  const dir = catalog(t, {
    "crates/both/Cargo.toml": '[package]\nname = "both"\nversion = "0.1.0"\n\n[lib]\npath = "src/lib.rs"\n\n[[bin]]\nname = "both"\npath = "src/main.rs"\n',
    "crates/both/src/lib.rs": "pub fn lib() {}\n",
    "crates/both/src/main.rs": "fn main() {}\n",
    "crates/both/agentdoc.yaml": [
      "apiVersion: agentdoc.dev/v1",
      "kind: Component",
      "metadata:",
      "  name: both",
      '  description: "Builds a library and a binary from one crate."',
      "spec:",
      "  type: service",
      "  system: pipeline",
      "",
    ].join("\n"),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  const facts = res.graph.assertions.filter((f) => f.subject === "component:default/both" && (f.key === "component.deployable" || f.key === "component.importable"));
  const byKey = Object.fromEntries(facts.map((f) => [f.key, f.value]));
  assert.equal(byKey["component.deployable"], true);
  assert.equal(byKey["component.importable"], true);
});

test("RUST: sqlx, diesel, redis, and aws-sdk-s3 become resource edges", (t) => {
  const dir = catalog(t, {
    "crates/store/Cargo.toml": [
      "[package]",
      'name = "store"',
      'version = "0.1.0"',
      "[dependencies]",
      'redis = "0.27.0"',
      'sqlx = { version = "0.8.0", features = ["postgres"] }',
      'aws-sdk-s3 = "1.0.0"',
      "",
    ].join("\n"),
    "crates/store/src/lib.rs": [
      "pub async fn open() {",
      "    let _pool: sqlx::PgPool = panic!();",
      "    let _ = sqlx::migrate!(\"./migrations\");",
      "    let _ = tokio_postgres::connect;",
      "    let _ = deadpool::managed::Pool;",
      "    let _ = sea_orm::Database;",
      "    let _ = aws_sdk_s3::Client::from_conf;",
      "}",
      'pub fn bucket() -> &\'static str { "uploads" }',
      "",
    ].join("\n"),
    "crates/store/migrations/001_init.sql": "CREATE TABLE t (id text);\n",
    "crates/store/agentdoc.yaml": LIB("store", "Opens a database, a cache, and an object store."),
    "crates/dieselbox/Cargo.toml": '[package]\nname = "dieselbox"\nversion = "0.1.0"\n',
    "crates/dieselbox/diesel.toml": '[print_schema]\nfile = "src/schema.rs"\n',
    "crates/dieselbox/src/lib.rs": "pub fn open() { let _ = diesel::PgConnection::establish; }\n",
    "crates/dieselbox/agentdoc.yaml": LIB("dieselbox", "Owns the database the diesel configuration describes."),
    "agentdoc/resources.yaml": [
      "apiVersion: agentdoc.dev/v1",
      "kind: Resource",
      "metadata:",
      "  name: store-postgres",
      '  description: "Logical database opened by the store crate."',
      "spec:",
      "  type: logical-database",
      "  system: pipeline",
      "---",
      "apiVersion: agentdoc.dev/v1",
      "kind: Resource",
      "metadata:",
      "  name: store-cache",
      '  description: "Cache opened by the store crate."',
      "spec:",
      "  type: cache",
      "  system: pipeline",
      "---",
      "apiVersion: agentdoc.dev/v1",
      "kind: Resource",
      "metadata:",
      "  name: uploads",
      '  description: "Object store the store crate writes objects into."',
      "spec:",
      "  type: logical-dataset",
      "  system: pipeline",
      "---",
      "apiVersion: agentdoc.dev/v1",
      "kind: Resource",
      "metadata:",
      "  name: dieselbox-postgres",
      '  description: "Logical database described by the diesel crate."',
      "spec:",
      "  type: logical-database",
      "  system: pipeline",
      "",
    ].join("\n"),
  }, {
    adapters: ["rust", "database", "cache", "object-store"],
    extra: [
      "  externalDependencies:",
      '    - match: "^redis$"',
      "      name: redis",
      "      mechanism: sdk",
      '      role: "Cache client declared by the crate manifest."',
      "      resourceType: cache",
    ].join("\n"),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  const uses = res.graph.relations.filter((r) => r.type === "usesResource").map((r) => r.sourceRef + " -> " + r.targetRef + " " + (r.attributes.via || []).join("+"));
  assert.ok(uses.some((u) => u.includes("component:default/store -> resource:default/store-postgres")), uses.join("\n"));
  assert.ok(uses.some((u) => u.includes("component:default/store -> resource:default/store-cache")), uses.join("\n"));
  assert.ok(uses.some((u) => u.includes("component:default/store -> resource:default/uploads")), uses.join("\n"));
  assert.ok(uses.some((u) => u.includes("component:default/dieselbox -> resource:default/dieselbox-postgres")), uses.join("\n"));
  assert.ok(uses.some((u) => u.includes("declared-client")), uses.join("\n"));
  const cacheProv = res.graph.provenance.find((p) => p.path === "crates/store/Cargo.toml" && p.extractor.name === "binding-extractor");
  assert.ok(cacheProv, res.graph.provenance.filter((p) => p.extractor.name === "binding-extractor").map((p) => p.path).join(","));
});

test("RUST: a workspace Cargo.toml that does not parse is a diagnostic, not a crash", (t) => {
  const dir = catalog(t, {
    "Cargo.toml": '[workspace]\nmembers = """\ncrates/app\n"""\n',
    "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
    "crates/app/src/lib.rs": "pub fn boot() {}\n",
    "crates/app/agentdoc.yaml": LIB("app", "Sits under a workspace manifest that does not parse."),
  });
  let res;
  assert.doesNotThrow(() => { res = compile(dir); });
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  assert.ok(component(res.graph, "app"));
  assert.ok(res.diagnostics.some((d) => d.code === "AGENTDOC_YAML_PARSE" && (d.paths || []).includes("Cargo.toml")));
});

test("RUST: dev-dependency source in tests/ does not become a production edge", (t) => {
  const dir = catalog(t, {
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\ntestutil = { path = "crates/testutil" }\n',
    "crates/testutil/Cargo.toml": '[package]\nname = "testutil"\nversion = "0.1.0"\n',
    "crates/testutil/src/lib.rs": "pub fn fixture() {}\n",
    "crates/testutil/agentdoc.yaml": LIB("testutil", "Provides helpers used only from crate tests."),
    "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n\n[dev-dependencies]\ntestutil = { workspace = true }\n',
    "crates/app/src/lib.rs": "pub fn boot() {}\n",
    "crates/app/tests/usage.rs": "use testutil::fixture;\n#[test]\nfn t() { fixture(); }\n",
    "crates/app/agentdoc.yaml": LIB("app", "Depends on testutil only while testing."),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => (e.format ? e.format() : e.message)).join("\n"));
  assert.ok(edge(res.graph, "testDependsOn", "component:default/app", "component:default/testutil"));
  assert.equal(edge(res.graph, "buildDependsOn", "component:default/app", "component:default/testutil"), undefined);
});
