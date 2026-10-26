// Python adapter (issue #18) and the TOML reader it depends on.
//
// Facts come from the manifest text and from import statements. The adapter
// does not run Python, and a specifier or a package list it cannot read is a
// diagnostic rather than a guessed dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "../core/toml.mjs";
import { parsePep508 } from "../adapters/python.mjs";
import { SYSTEM_ROOT, write, git, commitAll, cli, cliFails, compile } from "./helpers.mjs";

const FIXTURE = path.join(SYSTEM_ROOT, "fixtures", "f-python-workspace");

function throwsParse(src) {
  assert.throws(() => parseToml(src), (e) => e.code === "AGENTDOC_YAML_PARSE");
}

function pyRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-py-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  write(dir, "agentdoc/agentdoc.config.yaml", [
    "apiVersion: agentdoc.dev/config/v1",
    "namespace: default",
    "discovery:",
    "  componentDescriptorName: agentdoc.yaml",
    "  componentDescriptors:",
    '    - "**/agentdoc.yaml"',
    "  centralDescriptors:",
    "    - agentdoc/domains.yaml",
    "    - agentdoc/systems.yaml",
    "  journeyDefinitions: agentdoc/journeys.yaml",
    "adapters:",
    "  - python",
    "authority:",
    "  rules: []",
    "reviewedOverrides: []",
    "warningAcceptances: []",
    "output:",
    "  graph: .agentdoc/graph.json",
    "  observations: agentdoc/observations",
    "",
  ].join("\n"));
  write(dir, "agentdoc/domains.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Domain\nmetadata:\n  name: d1\n  description: "A domain for the python tests."\nspec: {}\n');
  write(dir, "agentdoc/systems.yaml", 'apiVersion: agentdoc.dev/v1\nkind: System\nmetadata:\n  name: s1\n  description: "A system for the python tests."\nspec:\n  domain: d1\n');
  write(dir, "agentdoc/journeys.yaml", "schemaVersion: agentdoc.dev/journeys/v1\njourneys: []\n");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  commitAll(dir);
  return dir;
}

function component(name, type = "library") {
  return [
    "apiVersion: agentdoc.dev/v1",
    "kind: Component",
    "metadata:",
    "  name: " + name,
    '  description: "Test component ' + name + '."',
    "spec:",
    "  type: " + type,
    "  system: s1",
    "",
  ].join("\n");
}

function edge(graph, type, source, target) {
  return graph.relations.find((r) => r.type === type && r.sourceRef.endsWith("/" + source) && r.targetRef.endsWith("/" + target));
}

function componentOf(graph, name) {
  return graph.entities.find((e) => e.kind === "Component" && e.name === name);
}

function copyFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-pyfix-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

// ── TOML 1.0 strings ────────────────────────────────────────────────────
test("toml: a multi-line basic string keeps the interior newline", () => {
  const doc = parseToml('[project]\ndescription = """\nhello\n"""\n');
  assert.equal(doc.project.description, "hello\n");
});

test("toml: a literal string does not treat a backslash as an escape", () => {
  assert.equal(parseToml("p = 'C:\\Users\\me'\n").p, "C:\\Users\\me");
  assert.equal(parseToml("p = 'a\\nb'\n").p, "a\\nb");
  assert.equal(parseToml('p = "a\\nb"\n').p, "a\nb");
});

test("toml: a multi-line literal string is raw, and a line-ending backslash joins basic lines", () => {
  assert.equal(parseToml("p = '''\nhello\\n\n'''\n").p, "hello\\n\n");
  assert.equal(parseToml('p = """\nhello \\\nworld\n"""\n').p, "hello world\n");
});

test("toml: unsupported forms are a diagnostic, not a value", () => {
  throwsParse('p = "\\\'"\n');
  throwsParse('p = "unterminated\n');
  throwsParse('p = """\nhello\n');
  throwsParse("p = 2024-01-01\n");
  throwsParse("p = 0x10\n");
  throwsParse("p = inf\n");
  throwsParse("p = nan\n");
});

test("toml: comments, dotted keys, inline tables and arrays of tables still parse", () => {
  const doc = parseToml([
    "# comment",
    'name = "w"',
    "count = 1_000",
    "flag = true",
    'point = { x = 1, y = 2 }',
    "",
    "[tool.uv.sources]",
    'core = { workspace = true }',
    "",
    "[[package]]",
    'name = "pytest"',
    "",
  ].join("\n"));
  assert.equal(doc.name, "w");
  assert.equal(doc.count, 1000);
  assert.equal(doc.flag, true);
  assert.deepEqual(doc.point, { x: 1, y: 2 });
  assert.equal(doc.tool.uv.sources.core.workspace, true);
  assert.equal(doc.package[0].name, "pytest");
});

test("toml: a quoted date stays a string", () => {
  assert.equal(parseToml('compatibility_date = "2025-01-01"\n').compatibility_date, "2025-01-01");
});

test("pep 508: a name is the whole distribution name, extras and markers included", () => {
  assert.equal(parsePep508("fastapi>=0.110").name, "fastapi");
  assert.equal(parsePep508("psycopg[binary]>=3.1").name, "psycopg");
  assert.equal(parsePep508("psycopg[not an extra]"), null);
  assert.equal(parsePep508("sqlalchemy>=2; python_version >= '3.11'").name, "sqlalchemy");
  assert.equal(parsePep508("ledger-core").name, "ledger-core");
  assert.equal(parsePep508("not a spec!!!"), null);
});

// ── the workspace fixture ───────────────────────────────────────────────
test("PYTHON: the workspace fixture derives edges, commands and the refused import name", () => {
  const res = compile(FIXTURE);
  assert.deepEqual(res.errors.map((e) => e.code), []);
  const g = res.graph;
  const names = g.entities.filter((e) => e.kind === "Component").map((e) => e.name).sort();
  assert.deepEqual(names, ["ambiguous-dist", "ledger-api", "ledger-core", "ledger-jobs", "ledger-proto", "ledger-testing"]);

  const api = componentOf(g, "ledger-api");
  assert.equal(api.entity.spec.type, "service");
  assert.equal(api.derived.requiresPython, ">=3.11");
  assert.deepEqual(api.derived.languages, ["python"]);
  assert.deepEqual(api.derived.runtimes, ["python"]);
  assert.equal(api.derived.pythonDistribution, "ledger-api");
  assert.deepEqual(api.derived.pythonImportNames, ["ledger_api"]);
  assert.equal(api.derived.hasTests, true);
  assert.equal(api.derived.migrationAuthority, "services/ledger-api/alembic.ini");

  const core = edge(g, "buildDependsOn", "ledger-api", "ledger-core");
  assert.deepEqual(core.attributes.via, ["python-import", "python-manifest"]);
  assert.equal(core.attributes.package, "ledger-core");
  const proto = edge(g, "buildDependsOn", "ledger-api", "ledger-proto");
  assert.deepEqual(proto.attributes.via, ["python-import"]);
  assert.equal(proto.attributes.package, "ledger-proto");
  const testing = edge(g, "testDependsOn", "ledger-api", "ledger-testing");
  assert.deepEqual(testing.attributes.via, ["python-manifest"]);
  assert.equal(testing.attributes.package, "ledger-testing");

  const commands = Object.fromEntries(g.verification.map((v) => [v.id, v.command]));
  assert.equal(commands["component:default/ledger-api:pytest"], "uv run pytest");
  assert.equal(commands["component:default/ledger-api:ruff"], "uv run ruff check");
  assert.equal(commands["component:default/ledger-api:mypy"], "uv run mypy");
  assert.equal(commands["component:default/ledger-jobs:unittest"], "python -m unittest discover");
  assert.equal(g.verification.find((v) => v.id.endsWith(":pytest")).configPaths.includes("uv.lock"), true);

  const db = g.relations.find((r) => r.type === "usesResource" && r.targetRef.endsWith("/ledger-api-postgres"));
  assert.deepEqual(db.attributes.via, ["declared-client", "migrations+connection"]);
  assert.equal(db.attributes.client, "sqlalchemy");
  assert.ok(g.relations.some((r) => r.type === "usesResource" && r.targetRef.endsWith("/ledger-cache")));
  assert.ok(g.relations.some((r) => r.type === "usesResource" && r.targetRef.endsWith("/uploads") && r.attributes.via.includes("bucket-literal")));
  assert.ok(g.externalDependencies.some((e) => e.name === "sqlalchemy" && e.componentRef.endsWith("/ledger-api")));

  assert.equal(componentOf(g, "ambiguous-dist").derived.pythonImportNames, undefined);
  assert.ok(res.diagnostics.some((d) => d.code === "AGENTDOC_BINDING_AMBIGUOUS" && d.subject.endsWith("/ambiguous-dist")));
  assert.equal(componentOf(g, "ledger-core").derived.hasTests, undefined);
  assert.equal(componentOf(g, "ledger-jobs").entity.spec.type, "job");

  const prov = g.provenance.find((p) => p.path === "services/ledger-api/pyproject.toml" && p.extractor.name === "python-manifest-extractor");
  const hash = "sha256:" + createHash("sha256").update(fs.readFileSync(path.join(FIXTURE, "services/ledger-api/pyproject.toml"))).digest("hex");
  assert.equal(prov.contentHash, hash);
  assert.ok(prov.subjects.some((s) => s.includes("requiresPython")));
});

test("PYTHON: two compiles of the fixture are the same bytes", () => {
  const a = compile(FIXTURE);
  const b = compile(FIXTURE);
  assert.equal(a.serialized, b.serialized);
  assert.equal(a.errors.length, 0);
});

test("PYTHON: validate, compile and check pass on the committed fixture", (t) => {
  const dir = copyFixture(t);
  assert.match(cli(dir, ["validate"]), /agentdoc validate: PASS/);
  assert.match(cli(dir, ["compile"]), /agentdoc compile: PASS/);
  assert.equal(cliFails(dir, ["check"]), null);
});

test("PYTHON: scaffold writes a corroborated type for every discovered unit", (t) => {
  const dir = copyFixture(t);
  for (const rel of [
    "services/ledger-api/agentdoc.yaml",
    "libs/ledger-core/agentdoc.yaml",
    "libs/ledger-proto/agentdoc.yaml",
    "libs/ledger-testing/agentdoc.yaml",
    "libs/ambiguous-dist/agentdoc.yaml",
    "jobs/ledger-jobs/agentdoc.yaml",
  ]) fs.rmSync(path.join(dir, rel));
  const res = JSON.parse(cli(dir, ["scaffold", "--write"]));
  assert.ok(res.written.includes("services/ledger-api/agentdoc.yaml"), res.written.join(","));
  const typeOf = (rel) => fs.readFileSync(path.join(dir, rel), "utf8");
  assert.match(typeOf("services/ledger-api/agentdoc.yaml"), /name: ledger-api[\s\S]*type: service/);
  assert.match(typeOf("libs/ledger-core/agentdoc.yaml"), /name: ledger-core[\s\S]*type: library/);
  assert.match(typeOf("libs/ambiguous-dist/agentdoc.yaml"), /name: ambiguous-dist[\s\S]*type: library/);
  assert.match(typeOf("jobs/ledger-jobs/agentdoc.yaml"), /name: ledger-jobs[\s\S]*type: service/);
  for (const rel of res.written.filter((w) => w.endsWith("agentdoc.yaml"))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, rel), "utf8"), /type: other/);
  }
});

test("PYTHON: query and impact resolve a module and its manifest to the component and its dependents", (t) => {
  const dir = copyFixture(t);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  commitAll(dir);
  cli(dir, ["compile"]);
  const q = JSON.parse(cli(dir, ["query", "services/ledger-api/src/ledger_api/main.py", "--json"]));
  assert.equal(q.query.resolved, "component:default/ledger-api");
  const file = JSON.parse(cli(dir, ["impact", "libs/ledger-core/src/ledger_core/models.py"]));
  const manifest = JSON.parse(cli(dir, ["impact", "libs/ledger-core/pyproject.toml"]));
  for (const im of [file, manifest]) {
    const refs = im.affectedComponents.map((c) => c.ref).sort();
    assert.deepEqual(refs, ["component:default/ledger-api", "component:default/ledger-core"]);
  }
});

// ── manifests the fixture does not use ─────────────────────────────────
test("PYTHON: a poetry path dependency and an import of that package are one build edge", (t) => {
  const dir = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["app", "libs/core-lib"]\n',
    "app/pyproject.toml": [
      "[tool.poetry]",
      'name = "app"',
      'version = "0.1.0"',
      "packages = [{ include = \"app_pkg\" }]",
      "",
      "[tool.poetry.dependencies]",
      'python = ">=3.11"',
      'core-lib = { path = "../libs/core-lib" }',
      "",
      "[build-system]",
      'requires = ["poetry-core"]',
      'build-backend = "poetry.core.masonry.api"',
      "",
    ].join("\n"),
    "app/app_pkg/__init__.py": "",
    "app/app_pkg/main.py": "import core_lib\n",
    "app/agentdoc.yaml": component("app"),
    "libs/core-lib/pyproject.toml": [
      "[tool.poetry]",
      'name = "core-lib"',
      'version = "0.1.0"',
      "packages = [{ include = \"core_lib\" }]",
      "",
      "[tool.poetry.dependencies]",
      'python = ">=3.11"',
      "",
      "[build-system]",
      'requires = ["poetry-core"]',
      'build-backend = "poetry.core.masonry.api"',
      "",
    ].join("\n"),
    "libs/core-lib/core_lib/__init__.py": "",
    "libs/core-lib/agentdoc.yaml": component("core-lib"),
  });
  const g = compile(dir).graph;
  const rel = edge(g, "buildDependsOn", "app", "core-lib");
  assert.ok(rel, "poetry path did not become an edge");
  assert.deepEqual(rel.attributes.via, ["python-import", "python-manifest"]);
  assert.equal(rel.attributes.package, "core-lib");
  assert.equal(componentOf(g, "app").derived.requiresPython, ">=3.11");
});

test("PYTHON: an editable requirement is a build edge, and -r is not expanded", (t) => {
  const dir = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["svc", "libs/helper"]\n',
    "svc/requirements.txt": "-e ../libs/helper\nrequests==2.31.0\n-r other.txt\n",
    "svc/agentdoc.yaml": component("svc", "other"),
    "libs/helper/pyproject.toml": '[project]\nname = "helper"\nversion = "0.1.0"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    "libs/helper/src/helper/__init__.py": "",
    "libs/helper/agentdoc.yaml": component("helper"),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => e.message).join("\n"));
  const rel = edge(res.graph, "buildDependsOn", "svc", "helper");
  assert.ok(rel);
  assert.deepEqual(rel.attributes.via, ["python-manifest"]);
  assert.ok(res.diagnostics.some((d) => d.code === "AGENTDOC_PYTHON_SPECIFIER" && /not expanded/.test(d.message)));
});

test("PYTHON: unittest is the command only when pytest is not evidenced", (t) => {
  const unittestOnly = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["jobs"]\n',
    "jobs/pyproject.toml": '[project]\nname = "jobs"\nversion = "0.1.0"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    "jobs/src/jobs/__init__.py": "",
    "jobs/tests/test_jobs.py": "import unittest\n",
    "jobs/agentdoc.yaml": component("jobs"),
  });
  const only = compile(unittestOnly).graph.verification.map((v) => v.command);
  assert.deepEqual(only, ["python -m unittest discover"]);

  const both = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["jobs"]\n',
    "jobs/pyproject.toml": '[project]\nname = "jobs"\nversion = "0.1.0"\n\n[dependency-groups]\ndev = ["pytest"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    "jobs/src/jobs/__init__.py": "",
    "jobs/tests/test_jobs.py": "import unittest\n",
    "jobs/agentdoc.yaml": component("jobs"),
  });
  const cmds = compile(both).graph.verification.map((v) => v.command);
  assert.deepEqual(cmds, ["pytest"]);
});

test("PYTHON: a library with no test evidence gets no verification command", (t) => {
  const dir = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["lib"]\n',
    "lib/pyproject.toml": '[project]\nname = "lib"\nversion = "0.1.0"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    "lib/src/lib/__init__.py": "",
    "lib/agentdoc.yaml": component("lib"),
  });
  assert.deepEqual(compile(dir).graph.verification, []);
});

test("PYTHON: a specifier that is not PEP 508 is warned and not kept", (t) => {
  const dir = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["svc"]\n',
    "svc/pyproject.toml": '[project]\nname = "svc"\nversion = "0.1.0"\ndependencies = ["not a spec!!!"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    "svc/src/svc/__init__.py": "",
    "svc/agentdoc.yaml": component("svc"),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0);
  assert.equal(res.graph.relations.some((r) => r.type === "buildDependsOn"), false);
  assert.ok(res.diagnostics.some((d) => d.code === "AGENTDOC_PYTHON_SPECIFIER" && d.message.includes("not a spec!!!")));
});

test("PYTHON: both lockfiles proving a tool leaves the command unprefixed", (t) => {
  const dir = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["svc"]\n',
    "uv.lock": '[[package]]\nname = "pytest"\n',
    "poetry.lock": '[[package]]\nname = "pytest"\n',
    "svc/pyproject.toml": '[project]\nname = "svc"\nversion = "0.1.0"\n\n[dependency-groups]\ndev = ["pytest"]\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    "svc/src/svc/__init__.py": "",
    "svc/agentdoc.yaml": component("svc"),
  });
  const res = compile(dir);
  assert.deepEqual(res.graph.verification.map((v) => v.command), ["pytest"]);
  assert.ok(res.diagnostics.some((d) => d.code === "AGENTDOC_BINDING_AMBIGUOUS" && /both uv.lock and poetry.lock/.test(d.message)));
});

test("PYTHON: setup.py that computes install_requires does not invent dependencies", (t) => {
  const dir = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["dyn", "libs/should-not-appear"]\n',
    "dyn/setup.py": 'from setuptools import setup\n\ndef read_requires():\n    return ["should-not-appear"]\n\nsetup(\n    name="dyn-tool",\n    install_requires=read_requires(),\n)\n',
    "dyn/agentdoc.yaml": component("dyn-tool", "other"),
    "libs/should-not-appear/pyproject.toml": '[project]\nname = "should-not-appear"\nversion = "0.1.0"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    "libs/should-not-appear/src/should_not_appear/__init__.py": "",
    "libs/should-not-appear/agentdoc.yaml": component("should-not-appear"),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => e.message).join("\n"));
  assert.equal(edge(res.graph, "buildDependsOn", "dyn-tool", "should-not-appear"), undefined);
  assert.ok(res.diagnostics.some((d) => d.code === "AGENTDOC_PYTHON_SPECIFIER" && /not a literal list/.test(d.message)));
});

test("PYTHON: setup.cfg install_requires and python_requires are read as text", (t) => {
  const dir = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["cfg"]\n',
    "cfg/setup.cfg": [
      "[metadata]",
      "name = cfg-lib",
      "python_requires = >=3.10",
      "",
      "[options]",
      "packages = cfg_lib",
      "install_requires =",
      "    requests>=2",
      "",
    ].join("\n"),
    "cfg/cfg_lib/__init__.py": "",
    "cfg/agentdoc.yaml": component("cfg-lib"),
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => e.message).join("\n"));
  const lib = componentOf(res.graph, "cfg-lib");
  assert.equal(lib.derived.requiresPython, ">=3.10");
  assert.deepEqual(lib.derived.pythonImportNames, ["cfg_lib"]);
  assert.equal(lib.derived.pythonDistribution, "cfg-lib");
});

test("PYTHON: an unclosed multi-line string fails the compile", (t) => {
  const dir = pyRepo(t, {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["svc"]\n',
    "svc/pyproject.toml": '[project]\nname = "svc"\ndescription = """\nhello\n',
    "svc/agentdoc.yaml": component("svc", "other"),
  });
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_YAML_PARSE"));
});
