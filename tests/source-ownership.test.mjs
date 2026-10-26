// Nested units own their sources, independently of language and adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFixture, compile, read, write, commitAll, cli, DEFAULT_CONFIG } from "./helpers.mjs";
import { Repo } from "../core/fsx.mjs";
import { discoverUnits } from "../core/discover.mjs";
import { sourceFiles } from "../core/sourcescan.mjs";

const ref = (name) => "component:default/" + name;
const descriptor = (name, type = "service") => `apiVersion: agentdoc.dev/v1
kind: Component
metadata:
  name: ${name}
  description: "Owns the sources under its root."
spec:
  type: ${type}
  system: s1
`;

function fixture(t, files, adapters = ["node", "dockerfile"], discovery = "") {
  const config = DEFAULT_CONFIG
    .replace("    - service/**/agentdoc.yaml", '    - "**/agentdoc.yaml"\n    - agentdoc.yaml' + discovery)
    .replace(/adapters:[\s\S]*?authority:/, "adapters:\n" + adapters.map((a) => "  - " + a).join("\n") + "\nauthority:");
  return baseFixture(t, { config, extra: files });
}

function checked(dir) {
  const a = compile(dir);
  assert.deepEqual(a.errors.map((e) => e.format()), []);
  const b = compile(dir);
  assert.deepEqual(b.errors.map((e) => e.format()), []);
  assert.equal(a.serialized, b.serialized, "two compiles must be byte-identical");
  return a.graph;
}

const component = (graph, name) => graph.entities.find((e) => e.ref === ref(name)).derived;
const edge = (graph, source, target) => graph.relations.find((r) => r.type === "buildDependsOn" && r.sourceRef === ref(source) && r.targetRef === ref(target));
const evidencePaths = (graph, relation) => relation.provenanceIds.map((id) => graph.provenance.find((p) => p.id === id).path);

test("sources: issue #21 scaffold repro attributes health, port and capability only to inner", (t) => {
  const dir = fixture(t, {
    "svc/package.json": '{"name":"outer"}',
    "svc/Dockerfile": "FROM node:22-alpine\n",
    "svc/inner/package.json": '{"name":"inner"}',
    "svc/inner/Dockerfile": "FROM node:22-alpine\n",
    "svc/inner/index.js": 'app.get("/healthz", h); const PORT = 9090; browser.launch();\n',
  }, undefined, '\n  supplementalRoots: [svc, svc/inner]\n  capabilities:\n    - name: browser\n      match: "browser.launch"');
  cli(dir, ["scaffold", "--write"]);
  for (const root of ["svc", "svc/inner"]) {
    write(dir, root + "/agentdoc.yaml", read(dir, root + "/agentdoc.yaml").replace("# system: <system-name>", "system: s1"));
  }
  commitAll(dir);
  const graph = checked(dir);
  assert.deepEqual(component(graph, "outer").healthContracts, []);
  assert.equal(component(graph, "outer").port, undefined);
  assert.equal(component(graph, "inner").port, 9090);
  assert.deepEqual(component(graph, "inner").healthContracts.map(({ path, route }) => ({ path, route })), [
    { path: "svc/inner/index.js", route: "/healthz" },
  ]);
  assert.deepEqual(graph.capabilities.map((c) => c.componentRef), [ref("inner")]);
});

test("sources: Node parent keeps its own imports but never its nested member's imports or provenance", (t) => {
  const dir = fixture(t, {
    "package.json": '{"name":"outer","main":"index.js"}',
    "agentdoc.yaml": descriptor("outer"),
    "src/index.js": 'import "@t/own-dep";\n',
    "inner/package.json": '{"name":"inner","main":"index.js"}',
    "inner/agentdoc.yaml": descriptor("inner"),
    "inner/index.js": 'import "@t/nested-dep";\n',
    "deps/own/package.json": '{"name":"@t/own-dep","main":"index.js"}',
    "deps/own/agentdoc.yaml": descriptor("own-dep"),
    "deps/nested/package.json": '{"name":"@t/nested-dep","main":"index.js"}',
    "deps/nested/agentdoc.yaml": descriptor("nested-dep"),
  });
  const graph = checked(dir);
  assert.equal(edge(graph, "outer", "nested-dep"), undefined);
  assert.deepEqual(evidencePaths(graph, edge(graph, "outer", "own-dep")), ["src/index.js"]);
  assert.deepEqual(evidencePaths(graph, edge(graph, "inner", "nested-dep")), ["inner/index.js"]);
});

test("sources: Cargo root package excludes nested member imports and test attributes", (t) => {
  const dir = fixture(t, {
    "Cargo.toml": '[package]\nname = "outer"\nversion = "0.1.0"\n[workspace]\nmembers = ["member", "dep"]\n[dependencies]\ndep = { path = "dep" }\n',
    "src/lib.rs": "pub fn outer() {}\n",
    "agentdoc.yaml": descriptor("outer", "library"),
    "member/Cargo.toml": '[package]\nname = "inner"\nversion = "0.1.0"\n[dependencies]\ndep = { path = "../dep" }\n',
    "member/src/lib.rs": "use dep::run;\n#[test] fn check() {}\n",
    "member/agentdoc.yaml": descriptor("inner", "library"),
    "dep/Cargo.toml": '[package]\nname = "dep"\nversion = "0.1.0"\n',
    "dep/src/lib.rs": "pub fn run() {}\n",
    "dep/agentdoc.yaml": descriptor("dep", "library"),
  }, ["node", "rust"]);
  const graph = checked(dir);
  assert.deepEqual(edge(graph, "outer", "dep").attributes.via, ["cargo-manifest"]);
  assert.deepEqual(evidencePaths(graph, edge(graph, "outer", "dep")), ["Cargo.toml"]);
  assert.deepEqual(edge(graph, "inner", "dep").attributes.via, ["cargo-manifest", "source-import"]);
  assert.ok(evidencePaths(graph, edge(graph, "inner", "dep")).includes("member/src/lib.rs"));
  assert.equal(component(graph, "outer").hasTests, undefined);
  assert.equal(component(graph, "inner").hasTests, true);
});

test("sources: database migrations and connection evidence belong only to the nested unit", (t) => {
  const dir = fixture(t, {
    "svc/package.json": '{"name":"outer"}',
    "svc/agentdoc.yaml": descriptor("outer"),
    "svc/inner/package.json": '{"name":"inner"}',
    "svc/inner/agentdoc.yaml": descriptor("inner"),
    "svc/inner/db/migrations/001.sql": "CREATE TABLE nested (id int);\n",
    "svc/inner/index.js": "const pool = new Pool();\n",
    "agentdoc/resources.yaml": 'apiVersion: agentdoc.dev/v1\nkind: Resource\nmetadata:\n  name: inner-db\n  description: "Database used by the inner unit."\nspec:\n  type: logical-database\n  system: s1\n',
  }, ["node", "database"]);
  const graph = checked(dir);
  assert.equal(component(graph, "outer").migrationAuthority, undefined);
  assert.equal(component(graph, "outer").bindings, undefined);
  assert.equal(component(graph, "inner").migrationAuthority, "svc/inner/db/migrations/001.sql");
  assert.deepEqual(graph.relations.filter((r) => r.type === "usesResource").map((r) => r.sourceRef), [ref("inner")]);

  // A parent migration must not borrow a child's connection evidence either.
  write(dir, "svc/db/migrations/001.sql", "CREATE TABLE parent (id int);\n");
  const res = compile(dir);
  assert.deepEqual(res.errors.map((e) => e.code), []);
  assert.equal(component(res.graph, "outer").bindings, undefined);
  assert.deepEqual(res.diagnostics.filter((d) => d.code === "AGENTDOC_RESOURCE_CANDIDATE" && d.subject !== ref("svc")).map((d) => d.subject), [ref("outer")]);
});

test("sources: ownership uses eligible roots, path segments and deepest nesting deterministically", (t) => {
  const dir = fixture(t, {
    "svc/index.js": "parent();\n",
    "svc/candidate/index.js": "stillParent();\n",
    "svc/inner/index.js": "inner();\n",
    "svc/inner/deep/index.js": "deep();\n",
    "svc/inner-other/index.js": "alsoParent();\n",
  });
  const repo = new Repo(dir, { noGit: true });
  const cfg = { discovery: { componentDescriptors: [], supplementalRoots: ["svc/inner/deep", "svc", "svc/inner"] } };
  const adapters = [{ roots: () => ["svc/candidate"] }]; // no marker: not eligible
  const discovered = discoverUnits(repo, cfg, adapters);
  repo.nestedUnitRoots = discovered.nestedRoots;
  assert.deepEqual(sourceFiles(repo, "svc"), ["svc/candidate/index.js", "svc/index.js", "svc/inner-other/index.js"]);
  assert.deepEqual(sourceFiles(repo, "svc/inner"), ["svc/inner/index.js"]);
  assert.deepEqual(sourceFiles(repo, "svc/inner/deep"), ["svc/inner/deep/index.js"]);
  assert.deepEqual(repo.walkUnit("svc", "svc/inner"), []);
  assert.ok(repo.walk("svc").includes("svc/inner/deep/index.js"), "repository-wide discovery remains unscoped");
  cfg.discovery.supplementalRoots.reverse();
  assert.deepEqual(discoverUnits(repo, cfg, adapters).nestedRoots, discovered.nestedRoots);
});
