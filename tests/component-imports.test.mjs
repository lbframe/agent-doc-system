// Issue #70: imports between components of one package are dependencies.
//
// The shape under test is the one from the issue: a single package with one
// descriptor per directory under src/, a Postgres client in src/db, and two
// consumers that import it, one through a tsconfig path alias and one through
// a relative path. A database change must reach both consumers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { write, git, cli, compile, commitAll } from "./helpers.mjs";
import { impact } from "../core/impact.mjs";
import { jsImportSpecifiers, jsImports, parseJsonc, bundlerAliases } from "../adapters/js-imports.mjs";
import { verificationForChange } from "../core/dependents.mjs";

const ref = (name) => "component:fx/" + name;
const DB = "resource:fx/app-postgres";

const component = (name) => `apiVersion: agentdoc.dev/v1
kind: Component
metadata:
  name: ${name}
  description: "Component ${name} of the fixture."
spec:
  type: other
  system: s1
`;

const ISSUE_FILES = {
  "package.json": JSON.stringify({ name: "fx", private: true, dependencies: { pg: "8.13.1" }, devDependencies: { "agent-doc-system": "1.5.2" } }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
  "src/db/index.ts": 'import { Pool } from "pg";\nexport const db = new Pool();\n',
  "src/db/schema.ts": 'export const users = "users";\n',
  "src/lib/user.ts": 'import { db } from "@/db";\nexport const u = db;\n',
  "src/billing/payment.ts": 'import { db } from "../db";\nexport const p = db;\n',
  "drizzle/0001_init.sql": "CREATE TABLE users (id text);\n",
};

function fixture(t, { files = ISSUE_FILES, units = ["db", "lib", "billing"], descriptors, adapters = ["node", "typescript", "database"] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-imports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  const globs = descriptors ?? ["agentdoc.yaml", "src/*/agentdoc.yaml"];
  write(dir, "agentdoc/agentdoc.config.yaml", `apiVersion: agentdoc.dev/config/v1
namespace: fx
discovery:
  componentDescriptorName: agentdoc.yaml
  componentDescriptors:
${globs.map((g) => "    - " + g + "\n").join("")}  centralDescriptors:
    - agentdoc/domains.yaml
    - agentdoc/systems.yaml
    - agentdoc/resources.yaml
  externalDependencies:
    - match: ^pg$
      name: postgres
      mechanism: sdk
      role: primary store client
      resourceType: logical-database
adapters:
${adapters.map((a) => "  - " + a + "\n").join("")}authority:
  rules: []
output:
  graph: .agentdoc/graph.json
  observations: agentdoc/observations
`);
  write(dir, "agentdoc/domains.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Domain\nmetadata:\n  name: d1\n  description: "A domain for the test fixture."\nspec: {}\n');
  write(dir, "agentdoc/systems.yaml", 'apiVersion: agentdoc.dev/v1\nkind: System\nmetadata:\n  name: s1\n  description: "A system inside the test domain."\nspec:\n  domain: d1\n');
  write(dir, "agentdoc/resources.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Resource\nmetadata:\n  name: app-postgres\n  description: "Main database."\nspec:\n  type: logical-database\n  system: s1\n  migrationPaths:\n    - drizzle\n    - src/db/schema.ts\n');
  write(dir, "agentdoc.yaml", component("app"));
  for (const u of units) write(dir, "src/" + u + "/agentdoc.yaml", component(u));
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  write(dir, ".gitignore", "/.agentdoc/\n");
  commitAll(dir);
  return dir;
}

function compiled(dir) {
  const res = compile(dir);
  assert.deepEqual(res.errors.map((e) => e.format()), []);
  return res;
}

const refs = (report) => report.affectedComponents.map((c) => c.ref);
const deps = (graph) => graph.relations
  .filter((r) => r.type === "buildDependsOn" || r.type === "testDependsOn")
  .map((r) => ({ type: r.type, from: r.sourceRef, to: r.targetRef, attributes: r.attributes }));
const evidence = (graph, rel) => rel.provenanceIds.map((id) => graph.provenance.find((p) => p.id === id).path).sort();

test("IMPORTS: relative and path-alias imports between components of one package are build dependencies", (t) => {
  const { graph } = compiled(fixture(t));
  assert.deepEqual(deps(graph), [
    { type: "buildDependsOn", from: ref("billing"), to: ref("db"), attributes: { via: ["relative-import"] } },
    { type: "buildDependsOn", from: ref("lib"), to: ref("db"), attributes: { via: ["path-alias"] } },
  ]);
  // The importing file is the evidence.
  const lib = graph.relations.find((r) => r.type === "buildDependsOn" && r.sourceRef === ref("lib"));
  assert.deepEqual(evidence(graph, lib), ["src/lib/user.ts"]);
  const billing = graph.relations.find((r) => r.type === "buildDependsOn" && r.sourceRef === ref("billing"));
  assert.deepEqual(evidence(graph, billing), ["src/billing/payment.ts"]);
});

test("IMPORTS: a database change reaches every component that imports the database component", (t) => {
  const dir = fixture(t);
  const { graph } = compiled(dir);
  for (const file of ["src/db/schema.ts", "drizzle/0001_init.sql"]) {
    const im = impact(graph, [file]);
    assert.deepEqual(im.affectedResources, [DB], file);
    for (const name of ["db", "lib", "billing"]) assert.ok(refs(im).includes(ref(name)), file + ": " + JSON.stringify(refs(im)));
  }
  // The consumers are reached because they depend on db, which is bound to the
  // database through its own import of the declared pg client.
  assert.ok(graph.relations.some((r) => r.type === "usesResource" && r.sourceRef === ref("db") && r.targetRef === DB));
  // A component of the package that does not import pg is not bound.
  for (const name of ["lib", "billing"]) {
    assert.ok(!graph.relations.some((r) => r.type === "usesResource" && r.sourceRef === ref(name)), name);
  }
  // End to end through the CLI.
  const report = JSON.parse(cli(dir, ["impact", "drizzle/0001_init.sql", "--json"]));
  for (const name of ["db", "lib", "billing"]) assert.ok(refs(report).includes(ref(name)));
});

test("IMPORTS: removing the import removes the consumer", (t) => {
  const dir = fixture(t, { files: { ...ISSUE_FILES, "src/lib/user.ts": "export const u = 1;\n" } });
  const { graph } = compiled(dir);
  const im = impact(graph, ["src/db/schema.ts"]);
  assert.ok(!refs(im).includes(ref("lib")), JSON.stringify(refs(im)));
  assert.ok(refs(im).includes(ref("billing")));
});

test("IMPORTS: aliases follow extends, baseUrl and jsconfig.json", async (t) => {
  await t.test("paths inherited from a repository-relative base config, relative to that config", (st) => {
    const files = { ...ISSUE_FILES };
    delete files["tsconfig.json"];
    files["config/tsconfig.base.json"] = '{\n  // comments and trailing commas, as tsconfig allows\n  "compilerOptions": { "paths": { "@/*": ["../src/*"], }, },\n}\n';
    files["tsconfig.json"] = JSON.stringify({ extends: "./config/tsconfig.base.json" });
    const { graph } = compiled(fixture(st, { files }));
    assert.ok(deps(graph).some((d) => d.from === ref("lib") && d.to === ref("db")), JSON.stringify(deps(graph)));
  });
  await t.test("paths relative to baseUrl, and bare baseUrl resolution", (st) => {
    const files = {
      ...ISSUE_FILES,
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "#db": ["db/index.ts"] } } }),
      "src/lib/user.ts": 'import { db } from "#db";\nexport const u = db;\n',
      "src/billing/payment.ts": 'import { users } from "db/schema";\nexport const p = users;\n',
    };
    const { graph } = compiled(fixture(st, { files }));
    assert.deepEqual(deps(graph).map((d) => [d.from, d.to, d.attributes.via[0]]), [
      [ref("billing"), ref("db"), "path-alias"],
      [ref("lib"), ref("db"), "path-alias"],
    ]);
  });
  await t.test("jsconfig.json is read like tsconfig.json", (st) => {
    const files = { ...ISSUE_FILES };
    delete files["tsconfig.json"];
    files["jsconfig.json"] = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });
    const { graph } = compiled(fixture(st, { files, adapters: ["node", "database"] }));
    assert.ok(deps(graph).some((d) => d.from === ref("lib") && d.to === ref("db")));
  });
});

test("IMPORTS: nothing is guessed", (t) => {
  const files = {
    ...ISSUE_FILES,
    // A commented-out import, an alias to a missing file, a string that only
    // looks like a path, and a bare package of the same name as a directory.
    "src/lib/user.ts": '// import { db } from "@/db";\n/* import "../db"; */\nimport { x } from "@/missing";\nexport const u = "../db";\n',
    "src/billing/payment.ts": 'import pg from "pg";\nexport const p = pg;\n',
  };
  const { graph } = compiled(fixture(t, { files }));
  assert.deepEqual(deps(graph), []);
});

test("IMPORTS: imports into another package keep the package edge and merge with it", (t) => {
  // Two packages: web depends on @fx/shared in its manifest, imports it by
  // name, and also reaches into it by a relative path. Every route states one
  // dependency. (The bare import adds no `source-import` route when the
  // manifest already declares the package, as before.)
  const dir = fixture(t, {
    units: [],
    descriptors: ["agentdoc.yaml", "packages/*/agentdoc.yaml"],
    files: {
      "drizzle/0001_init.sql": ISSUE_FILES["drizzle/0001_init.sql"],
      "src/db/schema.ts": ISSUE_FILES["src/db/schema.ts"],
      "package.json": JSON.stringify({ name: "fx", private: true }),
      "packages/web/package.json": JSON.stringify({ name: "@fx/web", private: true, dependencies: { "@fx/shared": "workspace:*" } }),
      "packages/web/agentdoc.yaml": component("web"),
      "packages/web/src/index.ts": 'import { a } from "@fx/shared";\nimport { b } from "../../shared/src/b";\nexport const x = a + b;\n',
      "packages/shared/package.json": JSON.stringify({ name: "@fx/shared", main: "src/index.ts" }),
      "packages/shared/agentdoc.yaml": component("shared"),
      "packages/shared/src/index.ts": "export const a = 1;\n",
      "packages/shared/src/b.ts": "export const b = 2;\n",
    },
  });
  const { graph } = compiled(dir);
  assert.deepEqual(deps(graph), [
    { type: "buildDependsOn", from: ref("web"), to: ref("shared"), attributes: { package: "@fx/shared", via: ["npm-manifest", "relative-import"] } },
  ]);
});

test("IMPORTS: compile is deterministic and the gates pass", (t) => {
  const dir = fixture(t);
  const a = compiled(dir).serialized;
  assert.equal(compiled(dir).serialized, a);
  cli(dir, ["validate"]);
  cli(dir, ["compile"]);
  commitAll(dir, "graph");
  cli(dir, ["check", "--strict", "--require-clean"]);
  // The alias configuration is a compiler input.
  write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } } }));
  const after = compiled(dir);
  assert.notEqual(after.graph.source.inputHash, JSON.parse(a).source.inputHash);
  assert.ok(!deps(after.graph).some((d) => d.from === ref("lib")));
});

test("IMPORTS: the import reader takes import statements only", () => {
  const specs = (text) => [...jsImportSpecifiers(text)].sort();
  assert.deepEqual(specs([
    'import a from "./a";',
    "import { b,\n  c } from '../b';",
    'import type { T } from "@/types";',
    'import "./side-effect";',
    'export { d } from "./d";',
    'export * from "./e";',
    'const f = await import("./f");',
    'const g = require("./g");',
    'const s = "./not-an-import";',
    '// import h from "./h";',
    '/* import i from "./i"; */',
    'const url = "http://x/y"; import j from "./j";',
  ].join("\n")), ["../b", "./a", "./d", "./e", "./f", "./g", "./j", "./side-effect", "@/types"]);
  assert.deepEqual(parseJsonc('{ "paths": { "@/*": ["src/*"] }, /* c */ "x": "a//b", }'), { paths: { "@/*": ["src/*"] }, x: "a//b" });
});

// ── review follow-ups: test imports, type-only clients, package imports,
//    bundler aliases, distance ─────────────────────────────────────────────

const withoutTsconfig = (extra) => {
  const files = { ...ISSUE_FILES, ...extra };
  delete files["tsconfig.json"];
  return files;
};

test("IMPORTS: a test file's import is a test dependency, and a production import wins", (t) => {
  const files = {
    ...ISSUE_FILES,
    "src/lib/user.ts": "export const u = 1;\n",
    "src/lib/user.test.ts": 'import { db } from "@/db";\nimport pg from "pg";\nexport const t = [db, pg];\n',
    "src/billing/payment.test.ts": 'import { db } from "../db";\nexport const t = db;\n',
  };
  const { graph } = compiled(fixture(t, { files }));
  assert.deepEqual(deps(graph), [
    { type: "buildDependsOn", from: ref("billing"), to: ref("db"), attributes: { via: ["relative-import"] } },
    { type: "testDependsOn", from: ref("lib"), to: ref("db"), attributes: { via: ["path-alias"] } },
  ]);
  // A test importing the database client does not make the component a client.
  assert.ok(!graph.relations.some((r) => r.type === "usesResource" && r.sourceRef === ref("lib")));
  // The test-only dependent is reached, and only its unit checks would apply.
  assert.ok(refs(impact(graph, ["src/db/schema.ts"])).includes(ref("lib")));
});

test("IMPORTS: a type-only import is a build dependency but binds no client", (t) => {
  const files = {
    ...ISSUE_FILES,
    "src/lib/user.ts": 'import type { Pool } from "pg";\nimport { type QueryResult } from "pg";\nimport type { db } from "@/db";\nexport type U = [Pool, QueryResult, typeof db];\n',
  };
  const { graph } = compiled(fixture(t, { files }));
  assert.ok(deps(graph).some((d) => d.from === ref("lib") && d.to === ref("db") && d.type === "buildDependsOn"));
  assert.ok(!graph.relations.some((r) => r.type === "usesResource" && r.sourceRef === ref("lib")));
  assert.ok(!graph.externalDependencies.some((e) => e.componentRef === ref("lib")));
  assert.ok(graph.relations.some((r) => r.type === "usesResource" && r.sourceRef === ref("db")));
});

test("IMPORTS: package.json imports (#x) resolve, including patterns and conditions", (t) => {
  const files = withoutTsconfig({
    "package.json": JSON.stringify({
      name: "fx", private: true, dependencies: { pg: "8.13.1" },
      imports: {
        "#db": { types: "./src/db/index.ts", default: "./dist/db/index.js" },
        "#billing/*": "./src/billing/*.ts",
        "#ext": "pg",
      },
    }),
    "src/lib/user.ts": 'import { db } from "#db";\nexport const u = db;\n',
    "src/billing/payment.ts": 'import pg from "#ext";\nexport const p = pg;\n',
  });
  files["src/db/index.ts"] = 'import { p } from "#billing/payment";\nimport { Pool } from "pg";\nexport const db = new Pool(p);\n';
  const { graph } = compiled(fixture(t, { files }));
  assert.deepEqual(deps(graph).map((d) => [d.from, d.to, d.attributes.via[0]]), [
    [ref("db"), ref("billing"), "subpath-import"],
    [ref("lib"), ref("db"), "subpath-import"],
  ]);
});

test("IMPORTS: Vite and webpack aliases stated with literals resolve", async (t) => {
  await t.test("Vite object form: fileURLToPath(new URL(...)) and a root-relative string", (st) => {
    const files = withoutTsconfig({
      "vite.config.ts": [
        'import { fileURLToPath, URL } from "node:url";',
        'import { defineConfig } from "vite";',
        "export default defineConfig({",
        "  resolve: {",
        "    alias: {",
        '      "@": fileURLToPath(new URL("./src", import.meta.url)),',
        '      "~db": "/src/db",',
        "    },",
        "  },",
        "});",
      ].join("\n"),
      "src/billing/payment.ts": 'import { db } from "~db";\nexport const p = db;\n',
    });
    const res = compiled(fixture(st, { files }));
    assert.deepEqual(deps(res.graph).map((d) => [d.from, d.to, d.attributes.via[0]]), [
      [ref("billing"), ref("db"), "bundler-alias"],
      [ref("lib"), ref("db"), "bundler-alias"],
    ]);
    assert.deepEqual(res.diagnostics.filter((d) => d.code === "AGENTDOC_IMPORT_ALIAS_UNRESOLVED"), []);
  });
  await t.test("webpack: path.resolve(__dirname, ...) and an exact $ key", (st) => {
    const files = withoutTsconfig({
      "webpack.config.js": 'const path = require("path");\nmodule.exports = { resolve: { alias: { Db$: path.resolve(__dirname, "src/db/index.ts"), Src: path.resolve(__dirname, "src") } } };\n',
      "src/lib/user.ts": 'import { db } from "Db";\nexport const u = db;\n',
      "src/billing/payment.ts": 'import { db } from "Src/db";\nexport const p = db;\n',
    });
    const { graph } = compiled(fixture(st, { files }));
    assert.deepEqual(deps(graph).map((d) => [d.from, d.to]), [[ref("billing"), ref("db")], [ref("lib"), ref("db")]]);
  });
  await t.test("an alias that is not a literal is reported, and the rest still resolves", (st) => {
    const files = withoutTsconfig({
      "vite.config.ts": 'export default {\n  resolve: {\n    alias: [\n      { find: "@", replacement: "/src" },\n      { find: /^~(.*)$/, replacement: "/src/$1" },\n      { find: "#env", replacement: process.env.ENV_DIR },\n    ],\n  },\n};\n',
      "src/billing/payment.ts": 'import { db } from "~db";\nexport const p = db;\n',
    });
    const res = compiled(fixture(st, { files }));
    assert.deepEqual(deps(res.graph).map((d) => [d.from, d.to]), [[ref("lib"), ref("db")]]);
    const warn = res.diagnostics.filter((d) => d.code === "AGENTDOC_IMPORT_ALIAS_UNRESOLVED");
    assert.equal(warn.length, 1, JSON.stringify(res.diagnostics));
    assert.deepEqual(warn[0].paths, ["vite.config.ts"]);
    assert.deepEqual(warn[0].refs, [ref("app")]);
  });
});

test("IMPORTS: the bundler alias reader accepts only literal shapes", () => {
  const read = (text, file = "vite.config.ts") => bundlerAliases(text, file);
  assert.deepEqual(read('export default { resolve: { alias: { "@": "/src" } } };'), { entries: [{ find: "@", exact: false, dir: "src" }], unresolved: [] });
  assert.deepEqual(read("export default { plugins: [] };"), { entries: [], unresolved: [] });
  assert.deepEqual(read('// alias: { "@": "/x" }\nexport default {};'), { entries: [], unresolved: [] });
  assert.deepEqual(read('module.exports = { resolve: { alias: { "@": path.join(__dirname, "lib", "a") } } };', "app/webpack.config.js").entries,
    [{ find: "@", exact: false, dir: "app/lib/a" }]);
  for (const bad of [
    "export default { resolve: { alias } };",
    "export default { resolve: { alias: aliases } };",
    'export default { resolve: { alias: { ...base, "@": "/src" } } };',
    'export default { resolve: { alias: { "@": path.resolve(process.cwd(), "src") } } };',
    'export default { resolve: { alias: { "@": "./src" } } };',
    'export default { resolve: { alias: { "@": path.resolve(__dirname, "../outside") } } };',
  ]) assert.ok(read(bad).unresolved.length > 0, "must not guess: " + bad);
  // A webpack absolute string is a filesystem path, not the project root.
  assert.ok(read('module.exports = { resolve: { alias: { "@": "/src" } } };', "webpack.config.js").unresolved.length > 0);
});

test("IMPORTS: impact names the distance to the nearest changed component", (t) => {
  const files = {
    ...ISSUE_FILES,
    "src/api/handler.ts": 'import { u } from "@/lib/user";\nexport const h = u;\n',
  };
  const { graph } = compiled(fixture(t, { files, units: ["db", "lib", "billing", "api"] }));
  const im = impact(graph, ["src/db/schema.ts"]);
  const reasons = (name) => im.affectedComponents.find((c) => c.ref === ref(name)).reasons;
  assert.deepEqual(reasons("lib"), ["depends on a changed component: " + ref("db") + " (1 hop)"]);
  assert.deepEqual(reasons("api"), ["depends on a changed component: " + ref("db") + " (2 hops, through " + ref("lib") + ")"]);
});

test("IMPORTS: verification is ordered by distance, and nothing is dropped for being far", () => {
  const r = (n) => "component:default/" + n;
  const graph = {
    relations: [
      { type: "buildDependsOn", sourceRef: r("aa-far"), targetRef: r("zz-near") },
      { type: "buildDependsOn", sourceRef: r("zz-near"), targetRef: r("lib") },
    ],
    verification: ["aa-far", "zz-near", "lib"].map((n) => ({ id: n + ":unit", componentRefs: [r(n)], tier: "unit" })),
  };
  assert.deepEqual(verificationForChange(graph, [r("lib")]).map((v) => v.id), ["lib:unit", "zz-near:unit", "aa-far:unit"]);
  assert.deepEqual(verificationForChange({ ...graph, relations: [...graph.relations].reverse() }, [r("lib")]).map((v) => v.id),
    ["lib:unit", "zz-near:unit", "aa-far:unit"]);
});

test("IMPORTS: the import reader marks type-only statements", () => {
  const m = jsImports([
    'import type { A } from "a";',
    'import { type B, type C } from "b";',
    'import { type D, E } from "d";',
    'export type { F } from "f";',
    'import type { G } from "g"; import { g } from "g";',
    'import H, { type I } from "h";',
  ].join("\n"));
  assert.deepEqual(Object.fromEntries(m), { a: true, b: true, d: false, f: true, g: false, h: false });
});
