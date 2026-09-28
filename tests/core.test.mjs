import fs from "node:fs";
import path from "node:path";
// Core invariants: the properties every other guarantee rests on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFixture, compile, commitAll, hasCode, graphOf, cli, read, write, SYSTEM_ROOT } from "./helpers.mjs";
import { parseYamlDocuments } from "../core/yaml.mjs";
import { SchemaBundle, SUPPORTED_KEYWORDS, Validator } from "../core/jsonschema.mjs";
import { ACCEPTABLE_WARNING_CODES, CODES } from "../core/codes.mjs";
import { loadSchemaBundle } from "../core/descriptors.mjs";
import { parse as parseToml } from "../core/toml.mjs";
import { globToRegExp, isRepoPath } from "../core/fsx.mjs";
import { assertFresh, COMPILER_VERSION, GRAPH_SCHEMA_VERSION } from "../core/graph.mjs";
import { AgentDocError } from "../core/codes.mjs";

// ── YAML subset ────────────────────────────────────────────────────────
test("yaml: parses the constructs a descriptor may use", () => {
  const src = [
    "# comment",
    "apiVersion: agentdoc.dev/v1",
    "kind: Component",
    "metadata:",
    "  name: a-b",
    "  description: \"quoted: with colon\"",
    "spec:",
    "  type: service",
    "  list:",
    "    - one",
    "    - two",
    "  inline: [a, b, 3]",
    "  map: {x: 1, y: two}",
    "  flag: true",
    "  nothing: null",
    "  text: |",
    "    line one",
    "    line two",
    "",
    "---",
    "second: document",
    "",
  ].join("\n");
  const docs = parseYamlDocuments(src, "x");
  assert.equal(docs.length, 2);
  assert.equal(docs[0].doc.apiVersion, "agentdoc.dev/v1");
  assert.equal(docs[0].doc.metadata.description, "quoted: with colon");
  assert.deepEqual(docs[0].doc.spec.list, ["one", "two"]);
  assert.deepEqual(docs[0].doc.spec.inline, ["a", "b", 3]);
  assert.deepEqual(docs[0].doc.spec.map, { x: 1, y: "two" });
  assert.equal(docs[0].doc.spec.flag, true);
  assert.equal(docs[0].doc.spec.nothing, null);
  assert.equal(docs[0].doc.spec.text, "line one\nline two\n");
  assert.equal(docs[1].doc.second, "document");
});

test("yaml: rejects anchors, aliases, tags, merge keys and env interpolation", () => {
  const cases = [
    ["a: &anchor 1\nb: *anchor\n", "AGENTDOC_YAML_ANCHOR"],
    ["a: !!str 1\n", "AGENTDOC_YAML_TAG"],
    ["<<: {a: 1}\n", "AGENTDOC_YAML_MERGE_KEY"],
    ["a: ${SECRET}\n", "AGENTDOC_YAML_ENV"],
  ];
  for (const [src, code] of cases) {
    assert.throws(() => parseYamlDocuments(src, "x"), (e) => e instanceof AgentDocError && e.code === code, src);
  }
});

test("yaml: rejects duplicate keys with a line number", () => {
  try {
    parseYamlDocuments("a: 1\nb: 2\na: 3\n", "x");
    assert.fail("expected a duplicate-key error");
  } catch (e) {
    assert.equal(e.code, "AGENTDOC_YAML_DUP_KEY");
    assert.equal(e.line, 3);
  }
});

// ── JSON Schema subset ──────────────────────────────────────────────────
test("jsonschema: validates the keywords the system relies on", () => {
  const bundle = new SchemaBundle([{
    $id: "t://s",
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: {
      a: { type: "string", minLength: 1, pattern: "^[a-z]+$" },
      b: { enum: ["x", "y"] },
      c: { type: "array", items: { $ref: "#/$defs/n" }, uniqueItems: true },
    },
    $defs: { n: { type: "integer", minimum: 1 } },
  }]);
  const v = new Validator(bundle, bundle.byId.get("t://s"));
  assert.equal(v.validate({ a: "ok", b: "x", c: [1, 2] }), null);
  assert.ok(v.validate({}));
  assert.ok(v.validate({ a: "A" }));
  assert.ok(v.validate({ a: "ok", zzz: 1 }));
  assert.ok(v.validate({ a: "ok", c: [1, 1] }));
});

test("jsonschema: every shipped schema uses only supported keywords", () => {
  // The validator's contract is that it implements exactly the documented
  // keyword set. A schema using anything else would validate less than it
  // appears to, silently. This walks every shipped schema — at every position
  // where a schema may appear — against the validator's own list.
  //
  // The walk distinguishes a *schema* (whose keys are keywords) from an
  // instance payload embedded in one (whose keys are data). Getting that
  // distinction wrong in either direction is exactly the failure this guards.
  const dir = new URL("../schemas/", import.meta.url).pathname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".schema.json")).sort();
  assert.ok(files.length >= 10, "expected the full schema bundle");

  // Keys whose value is a single schema.
  const SCHEMA_VALUES = ["additionalProperties", "propertyNames", "not", "if", "then", "else", "contains"];
  // Keys whose value is an array of schemas.
  const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"];
  // Keys whose value is an object keyed by name, each a schema.
  const SCHEMA_MAPS = ["properties", "$defs", "patternProperties", "dependentSchemas"];

  let keywords = 0;
  const seenSchema = new Set();

  function walkSchema(node, where) {
    if (!node || typeof node !== "object" || seenSchema.has(node)) return;
    seenSchema.add(node);
    for (const [k, v] of Object.entries(node)) {
      assert.ok(SUPPORTED_KEYWORDS.has(k), where + ": unsupported schema keyword " + k);
      keywords++;
      if (v === null || typeof v !== "object") continue;
      if (SCHEMA_VALUES.includes(k)) walkSchema(v, where + "/" + k);
      else if (SCHEMA_LISTS.includes(k)) for (const item of v) walkSchema(item, where + "/" + k);
      else if (SCHEMA_MAPS.includes(k)) for (const [n, sub] of Object.entries(v)) walkSchema(sub, where + "/" + k + "/" + n);
      else if (k === "items") walkSchema(v, where + "/" + k);
    }
  }

  for (const f of files) walkSchema(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), f);
  assert.ok(keywords > 300, "the keyword guard checked suspiciously few positions: " + keywords);
  assert.ok(seenSchema.size > 60, "the guard visited suspiciously few schemas: " + seenSchema.size);
});

test("jsonschema: `format` is refused rather than silently ignored", () => {
  // A schema author reaching for `format: date-time` must not get a validator
  // that quietly does nothing.
  assert.equal(SUPPORTED_KEYWORDS.has("format"), false);
});

// ── TOML subset ─────────────────────────────────────────────────────────
test("toml: parses a deployment manifest", () => {
  const t = parseToml([
    'name = "w"',
    'main = "src/index.ts"',
    "",
    "[triggers]",
    'crons = ["0 3 * * *"]',
    "",
    "[vars]",
    'URL = "https://h/p"',
    "",
    "[[kv_namespaces]]",
    'binding = "K"',
    'id = "0"',
    "",
    "[[services]]",
    'binding = "S"',
    'service = "other"',
    "",
  ].join("\n"));
  assert.equal(t.name, "w");
  assert.deepEqual(t.triggers.crons, ["0 3 * * *"]);
  assert.equal(t.vars.URL, "https://h/p");
  assert.equal(t.kv_namespaces[0].binding, "K");
  assert.equal(t.services[0].service, "other");
});

// ── path safety ─────────────────────────────────────────────────────────
test("repository paths reject escapes and absolute paths", () => {
  for (const p of ["/abs", "../x", "a/../b", "a//b", "./a", "a\\b", "a b"]) {
    assert.equal(isRepoPath(p), false, p);
  }
  assert.equal(isRepoPath("a/b/c.yaml"), true);
});

test("glob translation covers one-level and deep wildcards", () => {
  const re = globToRegExp("apps/*/agentdoc.yaml");
  assert.ok(re.test("apps/a/agentdoc.yaml"));
  assert.ok(!re.test("apps/a/b/agentdoc.yaml"));
  const deep = globToRegExp("apps/**/agentdoc.yaml");
  assert.ok(deep.test("apps/a/agentdoc.yaml"));
  assert.ok(deep.test("apps/a/b/c/agentdoc.yaml"));
});

// ── compilation invariants ──────────────────────────────────────────────
test("the compiled graph is byte-identical across independent compiles", (t) => {
  const dir = baseFixture(t);
  const a = compile(dir);
  const b = compile(dir);
  assert.equal(a.errors.length, 0, a.errors.map((e) => e.format()).join("\n"));
  assert.equal(a.serialized, b.serialized);
});

test("the graph is valid against the shipped graph schema", (t) => {
  const dir = baseFixture(t);
  const res = compile(dir);
  assert.equal(res.errors.length, 0);
  assert.equal(res.graph.schemaVersion, GRAPH_SCHEMA_VERSION);
  assert.equal(res.graph.compiler.version, COMPILER_VERSION);
  const g = res.graph;
  assert.ok(Array.isArray(g.entities) && g.entities.length > 0);
  assert.ok(g.provenance.length > 0);
  for (const r of g.relations) assert.ok(r.provenanceIds.length > 0, "relation without provenance: " + r.type);

  // Actually validate, rather than asserting the shape by hand. The compiler
  // self-checks before writing; validating the serialised form here proves the
  // check is not the only thing standing between a malformed graph and a commit,
  // which is what this test's name claims. Asserting a handful of fields is not
  // that, and reads as though it were.
  const validator = loadSchemaBundle().bundle.validator("agentdoc.dev/schema/graph.schema.json");
  const err = validator.validate(g);
  assert.equal(err, null, "graph violates its own schema: " + JSON.stringify(err, null, 2));
});

test("no timestamp, host path or absolute path reaches the graph", (t) => {
  const dir = baseFixture(t);
  const res = compile(dir);
  const text = res.serialized;
  assert.ok(!text.includes(process.env.HOME || "\u0000"), "home directory leaked into the graph");
  assert.ok(!/"\/(home|Users|tmp)\//.test(text), "absolute host path in the graph");
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g)) {
    assert.fail("timestamp in a graph with no observations: " + m[0]);
  }
});

test("freshness refuses a graph from a different commit or input set", (t) => {
  const dir = baseFixture(t);
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  assert.equal(code(() => assertFresh(g, { inputHash: "sha256:" + "1".repeat(64), dirty: false })), "AGENTDOC_GRAPH_FRESHNESS");
  assert.equal(code(() => assertFresh(g, { inputHash: "sha256:" + "0".repeat(64), dirty: false })), "AGENTDOC_GRAPH_FRESHNESS");
  assert.equal(code(() => assertFresh(g, { inputHash: g.source.inputHash, dirty: true })), "AGENTDOC_GRAPH_FRESHNESS");
  assert.equal(code(() => assertFresh({ ...g, compiler: { ...g.compiler, version: "99.0.0" } }, { inputHash: g.source.inputHash, dirty: false })), "AGENTDOC_COMPILER_MISMATCH");
  assert.equal(code(() => assertFresh({ ...g, schemaVersion: "agentdoc.dev/graph/v99" }, { inputHash: g.source.inputHash, dirty: false })), "AGENTDOC_GRAPH_SCHEMA");
  assert.doesNotThrow(() => assertFresh(g, { inputHash: g.source.inputHash, dirty: false }));
});

test("querying a stale graph fails rather than falling back", (t) => {
  const dir = baseFixture(t);
  cli(dir, ["compile"]);
  cli(dir, ["query", "service/src/index.ts"]);
  write(dir, "service/src/index.ts", 'export const NAME = "svc";\nexport const EXTRA = 1;\n');
  commitAll(dir);
  const r = compile(dir);
  assert.equal(r.errors.length, 0);
  assert.notEqual(r.stats.inputHash, graphOf(dir).source.inputHash);
  // assertFresh is what the CLI calls; it must reject.
  assert.throws(
    () => assertFresh(graphOf(dir), { inputHash: r.stats.inputHash, dirty: r.stats.dirty }),
    (e) => e.code === "AGENTDOC_GRAPH_FRESHNESS"
  );
});

test("with no adapters enabled, a component descriptor is uncorroborated", (t) => {
  const dir = baseFixture(t, {
    config: [
      "apiVersion: agentdoc.dev/config/v1",
      "namespace: default",
      "discovery:",
      "  componentDescriptorName: agentdoc.yaml",
      "  componentDescriptors:",
      "    - service/**/agentdoc.yaml",
      "  centralDescriptors:",
      "    - agentdoc/domains.yaml",
      "    - agentdoc/systems.yaml",
      "    - agentdoc/apis.yaml",
      "    - agentdoc/resources.yaml",
      "  journeyDefinitions: agentdoc/journeys.yaml",
      "adapters: []",
      "authority:",
      "  rules: []",
      "reviewedOverrides: []",
      "warningAcceptances: []",
      "output:",
      "  graph: .agentdoc/graph.json",
      "  observations: agentdoc/observations",
      "",
    ].join("\n"),
  });
  // Fail closed: a descriptor is a claim, and with no adapter able to
  // corroborate any artifact the claim is unsupported. Silently compiling an
  // empty graph would hide a misconfiguration.
  const res = compile(dir);
  const codes = res.errors.map((e) => e.code);
  assert.ok(codes.length > 0, "expected a fail-closed error, got none");
  assert.ok(
    codes.includes("AGENTDOC_ARTIFACT_TYPE") || codes.includes("AGENTDOC_COMPONENT_UNCORROBORATED"),
    codes.join(",")
  );
  assert.match(res.errors[0].message, /no deployable artifact evidence|no adapter found/);
});

test("codes: every diagnostic code the engine emits is declared in codes.mjs", () => {
  // `codes.mjs` is the single registry of every failure the compiler or a gate
  // can produce. A code emitted as a bare string literal is invisible to that
  // registry: a grep for `CODES.X` reports it as dead, and a dead-code cleanup
  // then deletes a live error. This asserts the invariant in the direction that
  // matters — every literal resolves — so the registry and the engine cannot
  // drift apart silently.
  const roots = ["core", "adapters", "bin", "evals"].map((d) => path.join(SYSTEM_ROOT, d));
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".mjs")) files.push(p);
    }
  };
  roots.forEach(walk);

  const declared = new Set(Object.values(CODES));
  const acceptable = new Set(ACCEPTABLE_WARNING_CODES);
  const allowed = new Set([...declared, ...acceptable]);

  const found = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/"(AGENTDOC_[A-Z0-9_]+)"/g)) {
      found.push({ file: path.relative(SYSTEM_ROOT, f), code: m[1] });
    }
  }
  assert.ok(found.length > 0, "expected the engine to emit some codes by literal");
  const undeclared = found.filter((f) => !allowed.has(f.code));
  assert.deepEqual(
    undeclared.map((f) => f.file + ": " + f.code), [],
    "these codes are emitted but not declared in codes.mjs; route them through CODES so the registry stays complete"
  );

  // The reverse: nothing in the registry may be unreachable, or it documents a
  // failure the system cannot actually produce.
  const sources = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const unreferenced = Object.entries(CODES).filter(([k]) => !new RegExp("CODES\\." + k + "\\b").test(sources));
  assert.deepEqual(
    unreferenced.map(([k]) => k), [],
    "these codes are declared but never referenced through CODES; either emit them or remove them"
  );
});

test("jsonschema: a $ref inside items is enforced, and a local ref resolves against its own document", () => {
  // Two silent soundness holes lived here, and both failed *open*:
  //
  //  1. A `#/...` pointer was resolved against the referring subschema rather
  //     than the document containing it, yielding `undefined` — and an undefined
  //     schema means "no constraint", not an error. Any schema using `$ref` for
  //     an enum inside `items` therefore validated anything at all.
  //  2. Resolving against the root always was wrong in the other direction:
  //     `#/$defs/repoPath` written inside `common.json` was looked up in whichever
  //     schema led there, so every component descriptor failed validation.
  //
  // The base document must follow the reference, and both directions are pinned.
  const v = SchemaBundle.fromMap(new Map([["t", {
    $id: "t",
    $defs: { E: { type: "string", enum: ["A", "B"] } },
    type: "object",
    properties: {
      list: { type: "array", items: { $ref: "#/$defs/E" } },
      obj: { type: "object", properties: { x: { $ref: "#/$defs/E" } } },
    },
  }]])).validator("t");

  assert.equal(v.validate({ list: ["A"] }), null, "a valid item must pass");
  const itemErr = v.validate({ list: ["NOPE"] });
  assert.ok(itemErr, "a $ref inside items must be enforced");
  assert.equal(itemErr[0].instancePath, "/list/0");
  assert.equal(itemErr[0].keyword, "enum");

  const propErr = v.validate({ obj: { x: "NOPE" } });
  assert.ok(propErr, "a $ref under properties must be enforced");
  assert.equal(propErr[0].keyword, "enum");

  // A cross-document reference, where the target's own local ref must resolve
  // against the target document rather than the referrer.
  const bundle = SchemaBundle.fromMap(
    new Map([
      ["lib.json", {
        $id: "lib.json",
        $defs: { path: { type: "string", pattern: "^[a-z][a-z0-9/]*$" } },
        type: "object",
        properties: { p: { $ref: "#/$defs/path" } },
      }],
      ["use.json", {
        $id: "use.json",
        type: "object",
        properties: { item: { $ref: "lib.json" } },
      }],
    ])
  );
  const uv = bundle.validator("use.json");
  assert.equal(uv.validate({ item: { p: "a/b" } }), null);
  const crossErr = uv.validate({ item: { p: "NOT A PATH" } });
  assert.ok(crossErr, "a local ref inside a cross-document ref must be enforced");
  assert.equal(crossErr[0].keyword, "pattern");
});

test("jsonschema: every shipped schema's $ref pointers actually resolve", () => {
  // A `$ref` that resolves to nothing is an unenforced constraint. The resolver
  // now throws on a dangling local pointer, so this walks the bundle and proves
  // every pointer in every shipped schema lands on a real node.
  const bundle = loadSchemaBundle().bundle;
  let pointers = 0;
  for (const [id, schema] of bundle.byId) {
    const seen = new Set();
    const walk = (node, doc) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (typeof node.$ref === "string") {
        pointers++;
        const { node: target, document } = resolveForTest(bundle, doc, node.$ref);
        assert.ok(target !== undefined, id + ": dangling $ref " + node.$ref);
        assert.ok(document !== undefined, id + ": unresolvable $ref " + node.$ref);
        walk(target, document);
        return;
      }
      for (const v of Object.values(node)) walk(v, doc);
    };
    walk(schema, schema);
  }
  assert.ok(pointers > 40, "expected the schemas to contain many $ref pointers, saw " + pointers);
});

// Resolve a $ref the way the validator does, for the test above.
function resolveForTest(bundle, doc, ref) {
  if (!ref.startsWith("#")) return bundle.resolve(doc.$id, ref);
  if (ref === "#") return { node: doc, document: doc };
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (const p of parts) cur = cur && cur[p];
  return { node: cur, document: doc };
}
