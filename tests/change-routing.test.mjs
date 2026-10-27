// Regression coverage for #30 (direction/resources) and #25 (dependent checks).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { compile, SYSTEM_ROOT, write, read } from "./helpers.mjs";
import { impact } from "../core/impact.mjs";
import { queryContext } from "../core/query.mjs";

const ref = (name) => "component:default/" + name;
const corpora = [
  { repo: "c-alt-monorepo", library: "shared", consumer: "console", file: "frontend/src/app/api/health/route.ts", dependencies: ["shared"] },
  { repo: "b-go-multi-service", library: "protocol", consumer: "ingest", file: "services/ingest/internal/relay/relay.go", dependencies: ["protocol"] },
  { repo: "e-rust-workspace", library: "engine", consumer: "cli", file: "apps/cli/src/main.rs", dependencies: ["engine", "testutil"] },
  { repo: "f-python-workspace", library: "ledger-core", consumer: "ledger-api", file: "services/ledger-api/src/ledger_api/app.py", dependencies: ["ledger-core", "ledger-proto", "ledger-testing"] },
];

for (const shape of corpora) {
  const result = compile(path.join(SYSTEM_ROOT, "fixtures", shape.repo));
  assert.deepEqual(result.errors, []);
  const graph = result.graph;
  test("IMPACT: " + shape.repo + " reaches dependents and excludes dependencies", () => {
    for (const omit of [null, "DependencyOf", "DependsOn"]) {
      const g = { ...graph, relations: graph.relations.filter((r) => !omit || !r.type.endsWith(omit)) };
      const service = impact(g, [shape.file]);
      const affected = service.affectedComponents.map((c) => c.ref);
      assert.ok(affected.includes(ref(shape.consumer)));
      for (const name of shape.dependencies) assert.ok(!affected.includes(ref(name)), name + " is a dependency, not a dependent");
      const library = impact(g, [ref(shape.library)]);
      assert.ok(library.affectedComponents.some((c) => c.ref === ref(shape.consumer)));
    }
    const ctx = queryContext(graph, shape.file);
    for (const name of shape.dependencies) {
      assert.ok(ctx.relations.items.some((r) => ["buildDependsOn", "testDependsOn"].includes(r.type) && r.direction === "out" && r.other === ref(name)), "dependencies remain explicitly typed context");
    }
  });

  test("QUERY/IMPACT: " + shape.repo + " recommends the dependent's checks after the library's", () => {
    const own = graph.verification.filter((v) => v.componentRefs.includes(ref(shape.library)));
    const consumer = graph.verification.filter((v) => v.componentRefs.includes(ref(shape.consumer)));
    assert.ok(consumer.length);
    const ctx = queryContext(graph, ref(shape.library));
    const im = impact(graph, [ref(shape.library)]);
    const ids = ctx.verification.items.map((v) => v.id);
    assert.ok(consumer.every((v) => ids.includes(v.id)), "missing dependent checks: " + JSON.stringify(ids));
    assert.deepEqual(im.recommendedVerification.map((v) => v.id), ids);
    if (own.length) assert.ok(Math.max(...own.map((v) => ids.indexOf(v.id))) < Math.min(...consumer.map((v) => ids.indexOf(v.id))));
    const capped = queryContext(graph, ref(shape.library), { budget: { verification: 1 } });
    assert.equal(capped.verification.total, ids.length);
    assert.equal(capped.verification.truncated, ids.length > 1);
    assert.ok(capped.truncated.includes("verification"));
    assert.deepEqual(capped.verification.items, ctx.verification.items.slice(0, 1));
    for (const v of consumer) {
      for (const id of v.provenanceIds) assert.ok(ctx.provenance.items.some((p) => p.id === id), "dependent check evidence must remain visible");
    }
  });
}

test("IMPACT: Rust migration follows an evidenced database binding", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-rust-impact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(SYSTEM_ROOT, "fixtures", "e-rust-workspace"), dir, { recursive: true });
  write(dir, "agentdoc/agentdoc.config.yaml", read(dir, "agentdoc/agentdoc.config.yaml").replace("  - rust\n", "  - rust\n  - database\n"));
  write(dir, "crates/engine/migrations/0001_init.sql", "CREATE TABLE t (id INT);\n");
  write(dir, "crates/engine/src/db.rs", "fn connect() { let _pool = sqlx::PgPool::connect(DATABASE_URL); }\n");
  write(dir, "agentdoc/resources.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Resource\nmetadata:\n  name: engine-db\n  description: "Logical database for the engine."\nspec:\n  type: logical-database\n  system: pipeline\n');
  const { graph, errors } = compile(dir);
  assert.deepEqual(errors, []);
  const im = impact(graph, ["crates/engine/migrations/0001_init.sql"]);
  assert.ok(im.affectedResources.includes("resource:default/engine-db"));
});

for (const [repo, file, resource] of [
  ["a-node-ts-postgres", "service/db/migrations/0001_orders.sql", "orders-service-postgres"],
  ["b-go-multi-service", "services/gateway/internal/store/migrations/0001_ledger.sql", "gateway-postgres"],
  ["f-python-workspace", "services/ledger-api/alembic/versions/0001_init.py", "ledger-api-postgres"],
]) {
  test("IMPACT: " + repo + " migration names the bound logical database", () => {
    const { graph, errors } = compile(path.join(SYSTEM_ROOT, "fixtures", repo));
    assert.deepEqual(errors, []);
    for (const omit of [null, "usesResource", "resourceUsedBy"]) {
      const g = { ...graph, relations: graph.relations.filter((r) => r.type !== omit) };
      const im = impact(g, [file]);
      assert.ok(im.affectedResources.includes("resource:default/" + resource), JSON.stringify(im.affectedResources));
    }
  });
}

// A longer diamond with a cycle exercises the closure independently of adapter
// extraction. A test-only path stays unit-only until an all-build path reaches it.
function dependencyGraph() {
  const names = ["lib", "upstream", "build", "test", "second", "third", "unrelated"];
  const relations = [
    ["buildDependsOn", "lib", "upstream"],
    ["buildDependsOn", "build", "lib"],
    ["testDependsOn", "test", "lib"],
    ["buildDependsOn", "second", "test"],
    ["buildDependsOn", "third", "second"],
    ["buildDependsOn", "build", "third"],
    ["buildDependsOn", "second", "build"],
  ].map(([type, source, target]) => ({ type, sourceRef: ref(source), targetRef: ref(target) }));
  return {
    entities: names.map((name) => ({ ref: ref(name), kind: "Component", name, entity: { metadata: { description: name }, spec: {} }, derived: { sourcePath: name } })),
    relations,
    verification: names.flatMap((name) => ["unit", "static", "integration"].map((tier) => ({ id: name + ":" + tier, componentRefs: [ref(name)], tier, command: name + " " + tier, configPaths: [name + "/manifest"], provenanceIds: [] }))),
    contracts: [], provenance: [], conflicts: [], journeys: [], assertions: [], observations: [], diagnostics: [], gates: [], interfaces: { events: [] }, externalDependencies: [], capabilities: [],
  };
}

test("QUERY/IMPACT: reverse closure handles cycles, build upgrades and test-only tiers deterministically", () => {
  const graph = dependencyGraph();
  const ctx = queryContext(graph, "lib/source");
  const im = impact(graph, ["lib/source"]);
  assert.deepEqual(im.affectedComponents.map((c) => c.ref), ["build", "lib", "second", "test", "third"].map(ref).sort());
  assert.equal(ctx.verification.truncated, true);
  assert.ok(ctx.truncated.includes("verification"));
  const full = queryContext(graph, ref("lib"), { budget: { verification: 100 } });
  const ids = full.verification.items.map((v) => v.id);
  for (const name of ["lib", "build", "second", "third"]) {
    for (const tier of ["unit", "static", "integration"]) assert.ok(ids.includes(name + ":" + tier));
  }
  assert.equal(full.verification.total, 13);
  assert.ok(full.verification.items.some((v) => v.id === "test:unit"));
  assert.ok(!full.verification.items.some((v) => v.id === "test:static" || v.id === "test:integration"));
  assert.deepEqual(im.recommendedVerification.map((v) => v.id), full.verification.items.map((v) => v.id));
  const reversed = { ...graph, relations: [...graph.relations].reverse(), verification: [...graph.verification].reverse() };
  assert.deepEqual(queryContext(reversed, ref("lib"), { budget: { verification: 100 } }).verification, full.verification);
});

test("QUERY/IMPACT: a test-only route restricts transitive build dependents to unit checks", () => {
  const graph = dependencyGraph();
  graph.relations = graph.relations.filter((r) => !(r.sourceRef === ref("second") && r.targetRef === ref("build")));
  const ctx = queryContext(graph, ref("lib"), { budget: { verification: 100 } });
  const ids = ctx.verification.items.map((v) => v.id);
  for (const name of ["test", "second", "third"]) {
    assert.ok(ids.includes(name + ":unit"));
    assert.ok(!ids.includes(name + ":static"));
    assert.ok(!ids.includes(name + ":integration"));
  }
  assert.deepEqual(impact(graph, [ref("lib")]).recommendedVerification.map((v) => v.id), ids);
});

test("IMPACT: verification overflow is explicit and keeps changed component checks first", () => {
  const graph = dependencyGraph();
  for (let i = 0; i < 30; i++) graph.verification.push({ id: "extra:" + i, componentRefs: [ref("build")], tier: "unit", command: "extra " + i });
  const im = impact(graph, [ref("lib")]);
  assert.equal(im.recommendedVerification.length, 25);
  assert.equal(im.recommendedVerificationTotal, 43);
  assert.equal(im.recommendedVerificationTruncated, true);
  assert.ok(im.recommendedVerification.slice(0, 3).every((v) => v.id.startsWith("lib:")));
});

test("IMPACT: directly changed checks precede runtime peers' checks", () => {
  const graph = dependencyGraph();
  graph.relations.push({ type: "runtimeCalls", sourceRef: ref("lib"), targetRef: ref("build") });
  const im = impact(graph, [ref("lib")]);
  assert.ok(im.recommendedVerification.slice(0, 3).every((v) => v.id.startsWith("lib:")));
});

test("IMPACT: migration resource routing uses exact refs and never invents ownership", () => {
  const graph = dependencyGraph();
  graph.entities.push(...["db", "db-archive", "bucket"].map((name) => ({ ref: "resource:default/" + name, kind: "Resource", name, entity: { spec: { type: name === "bucket" ? "logical-dataset" : "logical-database" } }, derived: {} })));
  graph.relations.push(
    { type: "usesResource", sourceRef: ref("lib"), targetRef: "resource:default/db" },
    { type: "usesResource", sourceRef: ref("lib"), targetRef: "resource:default/bucket" },
    { type: "usesResource", sourceRef: ref("unrelated"), targetRef: "resource:default/db-archive" },
  );
  const im = impact(graph, ["lib/migrations/001.sql"]);
  assert.ok(im.affectedResources.includes("resource:default/db"));
  assert.ok(!im.affectedResources.includes("resource:default/bucket"));
  assert.ok(!im.affectedComponents.some((c) => c.ref === ref("unrelated")));
  const archive = impact(graph, ["resource:default/db-archive"]);
  assert.deepEqual(archive.affectedComponents.map((c) => c.ref), [ref("unrelated")]);
  const unbound = { ...graph, relations: graph.relations.filter((r) => r.type !== "usesResource") };
  assert.ok(!impact(unbound, ["lib/migrations/001.sql"]).affectedResources.some((r) => r.startsWith("resource:")));
});
