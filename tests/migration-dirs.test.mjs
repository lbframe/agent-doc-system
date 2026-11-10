// Issue #63: a migration change is a resource change for the database it
// migrates, whatever directory the ORM writes migrations to.
//
// The shape under test is the one from the issue: a root web unit that keeps
// Drizzle migrations under `drizzle/`, and a worker, both bound to one Postgres
// logical-database Resource through the declared `pg` client mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { write, git, cli, compile, commitAll } from "./helpers.mjs";
import { impact } from "../core/impact.mjs";
import { drizzleOut } from "../adapters/database.mjs";

const ref = (name) => "component:default/" + name;
const DB = "resource:default/app-db";

const component = (name, type = "other") => `apiVersion: agentdoc.dev/v1
kind: Component
metadata:
  name: ${name}
  description: "Unit under test for migration routing."
spec:
  type: ${type}
  system: s1
`;

const resource = (name, type = "logical-database", extra = "") => `apiVersion: agentdoc.dev/v1
kind: Resource
metadata:
  name: ${name}
  description: "Resource under test for migration routing."
spec:
  type: ${type}
  system: s1
${extra}`;

const PG_CLIENT = `  externalDependencies:
    - match: ^pg$
      name: pg-client
      mechanism: sdk
      role: primary store client
      resourceType: logical-database
`;

// `webDeps`/`workerDeps` decide which units are bound to the database; nothing
// else in the fixture creates a binding.
function fixture(t, { files = {}, resources, webDeps = { pg: "^8.13.1" }, workerDeps = { pg: "^8.13.1" } } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-migrations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  write(dir, "agentdoc/agentdoc.config.yaml", `apiVersion: agentdoc.dev/config/v1
namespace: default
discovery:
  componentDescriptorName: agentdoc.yaml
  componentDescriptors:
    - agentdoc.yaml
    - worker/agentdoc.yaml
  centralDescriptors:
    - agentdoc/domains.yaml
    - agentdoc/systems.yaml
    - agentdoc/resources.yaml
${PG_CLIENT}adapters:
  - node
  - database
authority:
  rules: []
output:
  graph: .agentdoc/graph.json
  observations: agentdoc/observations
`);
  write(dir, "agentdoc/domains.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Domain\nmetadata:\n  name: d1\n  description: "A domain for the test fixture."\nspec: {}\n');
  write(dir, "agentdoc/systems.yaml", 'apiVersion: agentdoc.dev/v1\nkind: System\nmetadata:\n  name: s1\n  description: "A system inside the test domain."\nspec:\n  domain: d1\n');
  write(dir, "agentdoc/resources.yaml", resources ?? resource("app-db"));
  write(dir, "package.json", JSON.stringify({ name: "web", private: true, dependencies: webDeps }));
  write(dir, "agentdoc.yaml", component("web"));
  write(dir, "src/index.ts", "export const NAME = 'web';\n");
  write(dir, "worker/package.json", JSON.stringify({ name: "worker", private: true, dependencies: workerDeps }));
  write(dir, "worker/agentdoc.yaml", component("worker"));
  write(dir, "worker/src/index.ts", "export const NAME = 'worker';\n");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  write(dir, ".gitignore", "/.agentdoc/\n");
  commitAll(dir);
  return dir;
}

const DRIZZLE_FILES = {
  "drizzle/0001_x.sql": "CREATE TABLE t (id text primary key);\n",
  "drizzle/meta/_journal.json": '{"version":"7","dialect":"postgresql","entries":[]}\n',
};

function compiled(dir) {
  const res = compile(dir);
  assert.deepEqual(res.errors.map((e) => e.format()), []);
  return res;
}

const refs = (report) => report.affectedComponents.map((c) => c.ref);
const reasonsOf = (report, r) => report.affectedComponents.find((c) => c.ref === r)?.reasons || [];
const derivedOf = (graph, name) => graph.entities.find((e) => e.ref === ref(name)).derived;

test("MIGRATIONS: Drizzle default out (./drizzle) is a resource change for every bound component", (t) => {
  const dir = fixture(t, {
    files: {
      ...DRIZZLE_FILES,
      "drizzle.config.ts": 'import { defineConfig } from "drizzle-kit";\nexport default defineConfig({\n  schema: "./src/schema.ts",\n  dialect: "postgresql",\n});\n',
    },
  });
  const { graph } = compiled(dir);
  for (const file of ["drizzle/0001_x.sql", "drizzle/meta/_journal.json"]) {
    const im = impact(graph, [file]);
    assert.ok(im.affectedResources.includes(DB), file + ": " + JSON.stringify(im.affectedResources));
    assert.deepEqual(refs(im), [ref("web"), ref("worker")], file);
    assert.ok(
      reasonsOf(im, ref("worker")).some((r) => r.includes(file) && r.includes(DB)),
      "the reason must name the migration path: " + JSON.stringify(reasonsOf(im, ref("worker")))
    );
  }
  // The detected directory is recorded in the graph with the config as evidence.
  const dirs = derivedOf(graph, "web").migrationDirs;
  assert.deepEqual(dirs.map(({ path: p, via }) => ({ path: p, via })), [{ path: "drizzle", via: ["drizzle-config"] }]);
  const evidence = dirs[0].provenanceIds.map((id) => graph.provenance.find((p) => p.id === id).path);
  assert.deepEqual(evidence, ["drizzle.config.ts"]);

  // End to end through the CLI, which compiles in memory.
  const cliReport = JSON.parse(cli(dir, ["impact", "drizzle/0001_x.sql", "--json"]));
  assert.ok(cliReport.affectedResources.includes(DB));
  assert.deepEqual(refs(cliReport), [ref("web"), ref("worker")]);
});

test("MIGRATIONS: Drizzle non-default out is read from drizzle.config.ts as a string literal", (t) => {
  const dir = fixture(t, {
    files: {
      "drizzle.config.ts": [
        'import { defineConfig } from "drizzle-kit";',
        "// out: './not-this'",
        "/* out: \"./nor-this\" */",
        "export default defineConfig({",
        '  schema: "./src/schema.ts",',
        "  out: './db/sql',",
        '  dialect: "postgresql",',
        '  dbCredentials: { url: "postgres://localhost/app" },',
        "});",
        "",
      ].join("\n"),
      "db/sql/0001_x.sql": "CREATE TABLE t (id text primary key);\n",
      "db/sql-extra/0001_x.sql": "-- not a migration directory\n",
      ...DRIZZLE_FILES,
    },
  });
  const { graph } = compiled(dir);
  assert.deepEqual(derivedOf(graph, "web").migrationDirs.map((d) => d.path), ["db/sql"]);
  const im = impact(graph, ["db/sql/0001_x.sql"]);
  assert.ok(im.affectedResources.includes(DB));
  assert.deepEqual(refs(im), [ref("web"), ref("worker")]);
  // Segment semantics: a sibling sharing a prefix is not the migration directory.
  assert.ok(!impact(graph, ["db/sql-extra/0001_x.sql"]).affectedResources.includes(DB));
  // The default is not assumed when the config names another directory.
  assert.ok(!impact(graph, ["drizzle/0001_x.sql"]).affectedResources.includes(DB));
});

test("MIGRATIONS: a dynamic Drizzle out is not guessed", (t) => {
  const dir = fixture(t, {
    files: {
      ...DRIZZLE_FILES,
      "drizzle.config.ts": 'export default {\n  schema: "./src/schema.ts",\n  out: process.env.MIGRATIONS_DIR,\n  dialect: "postgresql",\n};\n',
    },
  });
  const res = compiled(dir);
  assert.equal(derivedOf(res.graph, "web").migrationDirs, undefined);
  const warn = res.diagnostics.filter((d) => d.code === "AGENTDOC_MIGRATION_DIR_UNRESOLVED");
  assert.equal(warn.length, 1, JSON.stringify(res.diagnostics));
  assert.deepEqual(warn[0].paths, ["drizzle.config.ts"]);
  assert.ok(!impact(res.graph, ["drizzle/0001_x.sql"]).affectedResources.includes(DB));
});

test("MIGRATIONS: a declared migration path on the Resource is authoritative whichever component owns it", (t) => {
  // The web unit has no binding of its own: only the declaration links the
  // directory to the database.
  const dir = fixture(t, {
    webDeps: {},
    resources: resource("app-db", "logical-database", "  migrationPaths:\n    - sql/schema\n"),
    files: { "sql/schema/0001_x.sql": "CREATE TABLE t (id text primary key);\n", "sql/schema-old/0001_x.sql": "-- old\n" },
  });
  const { graph } = compiled(dir);
  const im = impact(graph, ["sql/schema/0001_x.sql"]);
  assert.deepEqual(im.affectedResources, [DB]);
  assert.deepEqual(refs(im), [ref("web"), ref("worker")]);
  assert.ok(reasonsOf(im, ref("worker")).some((r) => r.includes("sql/schema/0001_x.sql") && r.includes(DB)));
  // The declaration never creates a binding.
  assert.ok(!graph.relations.some((r) => r.type === "usesResource" && r.sourceRef === ref("web")));
  // Segment semantics on the declared prefix.
  assert.ok(!impact(graph, ["sql/schema-old/0001_x.sql"]).affectedResources.includes(DB));
  // The declaration is in the graph with descriptor provenance.
  const db = graph.entities.find((e) => e.ref === DB);
  assert.deepEqual(db.entity.spec.migrationPaths, ["sql/schema"]);
  const idx = graph.entities.indexOf(db);
  assert.ok(graph.provenance.some((p) => p.path === "agentdoc/resources.yaml" && p.subjects.includes("/entities/" + idx + "/entity/spec/migrationPaths")));
});

test("MIGRATIONS: a declared path wins over a detected binding of the enclosing component", (t) => {
  // Two logical databases make the pg client mapping ambiguous, so the web unit
  // is bound to web-db by the database adapter's own route instead (migrations
  // plus a connection string, resolved by name).
  const dir = fixture(t, {
    resources: resource("web-db") + "---\n" + resource("audit-db", "logical-database", "  migrationPaths:\n    - drizzle\n"),
    files: {
      ...DRIZZLE_FILES,
      "src/db.ts": 'export const DATABASE_URL = process.env.DATABASE_URL;\n',
      "drizzle.config.ts": 'export default { schema: "./src/schema.ts", out: "./drizzle", dialect: "postgresql" };\n',
    },
  });
  const { graph } = compiled(dir);
  assert.ok(graph.relations.some((r) => r.type === "usesResource" && r.sourceRef === ref("web") && r.targetRef === "resource:default/web-db"),
    "precondition: the enclosing component is bound to another database");
  const im = impact(graph, ["drizzle/0001_x.sql"]);
  assert.deepEqual(im.affectedResources, ["resource:default/audit-db"]);
});

test("MIGRATIONS: declared migration paths are validated", async (t) => {
  const cases = [
    ["  migrationPaths:\n    - ../outside\n", "AGENTDOC_PATH_ESCAPE"],
    ["  migrationPaths:\n    - /abs/dir\n", "AGENTDOC_PATH_ESCAPE"],
    ["  migrationPaths:\n    - missing/dir\n", "AGENTDOC_PATH_UNRESOLVED"],
    ["  migrationPaths:\n    - \"drizzle/**\"\n", "AGENTDOC_MIGRATION_PATH"],
  ];
  for (const [extra, code] of cases) {
    await t.test(code + " " + extra.trim().split("\n").pop().trim(), (st) => {
      const dir = fixture(st, { files: DRIZZLE_FILES, resources: resource("app-db", "logical-database", extra) });
      const res = compile(dir);
      assert.ok(res.errors.some((e) => e.code === code), JSON.stringify(res.errors.map((e) => e.format())));
    });
  }
  await t.test("only a logical-database may declare migration paths", (st) => {
    const dir = fixture(st, { files: DRIZZLE_FILES, resources: resource("app-db") + "---\n" + resource("app-cache", "cache", "  migrationPaths:\n    - drizzle\n") });
    const res = compile(dir);
    assert.ok(res.errors.some((e) => e.code === "AGENTDOC_MIGRATION_PATH"), JSON.stringify(res.errors.map((e) => e.format())));
  });
  await t.test("two Resources may not declare the same path", (st) => {
    const dir = fixture(st, {
      files: DRIZZLE_FILES,
      resources: resource("app-db", "logical-database", "  migrationPaths:\n    - drizzle\n") + "---\n" + resource("other-db", "logical-database", "  migrationPaths:\n    - drizzle\n"),
    });
    const res = compile(dir);
    assert.ok(res.errors.some((e) => e.code === "AGENTDOC_MIGRATION_PATH"), JSON.stringify(res.errors.map((e) => e.format())));
  });
});

test("MIGRATIONS: a detected directory whose component has no binding invents no Resource", (t) => {
  const dir = fixture(t, {
    webDeps: {},
    workerDeps: {},
    files: { ...DRIZZLE_FILES, "drizzle.config.ts": 'export default { schema: "./src/schema.ts", dialect: "postgresql" };\n' },
  });
  const { graph } = compiled(dir);
  assert.ok(!graph.relations.some((r) => r.type === "usesResource"));
  const im = impact(graph, ["drizzle/0001_x.sql"]);
  assert.ok(!im.affectedResources.some((r) => r.startsWith("resource:")), JSON.stringify(im.affectedResources));
  assert.deepEqual(refs(im), [ref("web")]);
});

test("MIGRATIONS: Prisma Migrate's prisma/migrations is a recorded migration directory", (t) => {
  const dir = fixture(t, {
    files: {
      "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "prisma/migrations/20240101000000_init/migration.sql": "CREATE TABLE t (id text primary key);\n",
      "prisma/migrations/migration_lock.toml": 'provider = "postgresql"\n',
    },
  });
  const { graph } = compiled(dir);
  assert.deepEqual(derivedOf(graph, "web").migrationDirs.map(({ path: p, via }) => ({ path: p, via })), [{ path: "prisma/migrations", via: ["directory-name"] }]);
  const im = impact(graph, ["prisma/migrations/20240101000000_init/migration.sql"]);
  assert.ok(im.affectedResources.includes(DB));
  assert.deepEqual(refs(im), [ref("web"), ref("worker")]);
});

test("MIGRATIONS: compile is deterministic and the gates pass with detected and declared directories", (t) => {
  const dir = fixture(t, {
    resources: resource("app-db", "logical-database", "  migrationPaths:\n    - sql/schema\n"),
    files: {
      ...DRIZZLE_FILES,
      "sql/schema/0001_x.sql": "CREATE TABLE t (id text primary key);\n",
      "drizzle.config.ts": 'export default { schema: "./src/schema.ts", out: "./drizzle", dialect: "postgresql" };\n',
    },
  });
  const a = compiled(dir).serialized;
  assert.equal(compiled(dir).serialized, a);
  assert.equal(compiled(dir).serialized, a);
  cli(dir, ["validate"]);
  cli(dir, ["compile"]);
  commitAll(dir, "graph");
  cli(dir, ["check", "--require-clean"]);
  // The config is a compiler input: changing it invalidates the graph.
  write(dir, "drizzle.config.ts", 'export default { schema: "./src/schema.ts", out: "./migrations-sql", dialect: "postgresql" };\n');
  assert.notEqual(compiled(dir).graph.source.inputHash, JSON.parse(a).source.inputHash);
});

test("MIGRATIONS: the Drizzle out reader accepts only a single string literal", () => {
  const ok = (text, value) => assert.deepEqual(drizzleOut(text), { value }, text);
  const no = (text) => assert.ok(drizzleOut(text).error, "must not guess: " + text);
  ok('export default defineConfig({ dialect: "postgresql" });', null);
  ok("export default { out: './db/sql' };", "./db/sql");
  ok('export default { "out": "migrations-sql" };', "migrations-sql");
  ok("export default { out: `./drizzle-pg`, };", "./drizzle-pg");
  ok('export default { schema: "check out: this", out: "a" };', "a");
  ok('// out: "x"\n/* out: "y" */\nexport default { out: "z" };', "z");
  ok('export default { dbCredentials: { url: "postgres://h/db" }, out: "o" };', "o");
  ok('export default { layout: "timeout: 5", dialect: "postgresql" };', null);
  no("export default { out: process.env.OUT };");
  no("export default { out: `./${dir}` };");
  no('export default { out: "./a" + suffix };');
  no("const out = './x';\nexport default { out };");
  no('export default { ...base, dialect: "postgresql" };');
  no('export default isProd ? { out: "a" } : { out: "b" };');
  no('export default { out: "" };');
  no('export default { out: "unterminated };');
});
