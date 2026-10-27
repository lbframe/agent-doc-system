import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Repo } from "../core/fsx.mjs";
import { readPythonUnit } from "../adapters/python.mjs";
import { cli, commitAll, compile, git, read, write } from "./helpers.mjs";

function freshRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-scaffold-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  commitAll(dir);
  return dir;
}

function choosePlacements(dir, descriptors) {
  for (const file of descriptors) {
    write(dir, file, read(dir, file).replace("  # placementRationale:", "  placementRationale:"));
  }
}

test("CREATE: setup.py-only scaffold uses the Python adapter distribution name", (t) => {
  const dir = freshRepo(t, {
    "legacy/setup.py": 'from setuptools import setup\nsetup(\n    name="published-name",\n    version="0.1.0",\n    packages=["published_name"],\n)\n',
    "legacy/published_name/__init__.py": "",
  });
  const dist = readPythonUnit(new Repo(dir), "legacy").dist;
  assert.equal(dist, "published-name");
  cli(dir, ["init"]);
  const result = JSON.parse(cli(dir, ["scaffold", "--write"]));
  assert.ok(result.written.includes("legacy/agentdoc.yaml"));
  assert.match(read(dir, "legacy/agentdoc.yaml"), new RegExp("^  name: " + dist + "$", "m"));
  choosePlacements(dir, ["legacy/agentdoc.yaml"]);
  assert.match(cli(dir, ["validate"]), /validate: PASS/);
  assert.match(cli(dir, ["compile"]), /compile: PASS/);
  assert.ok(compile(dir).graph.entities.some((e) => e.ref === "component:default/" + dist));
});

for (const [label, files, type, shape] of [
  ["Node app without exports or main", { "app/package.json": '{"name":"app"}' }, "service", [true, false]],
  // Node's adapter reports both for an exported package. Deployable wins when
  // both shapes are supported; the scaffolder must not reinterpret the adapter.
  ["Node package with exports", { "app/package.json": '{"name":"app","exports":"./index.js"}' }, "service", [true, true]],
  ["Go module with cmd", { "app/go.mod": "module example.com/app\ngo 1.22\n", "app/cmd/app/main.go": "package main\nfunc main() {}\n" }, "service", [true, false]],
  ["Go module without cmd", { "app/go.mod": "module example.com/app\ngo 1.22\n" }, "library", [false, true]],
  ["manifest with no artifact shape", { "app/pyproject.toml": '[project]\nname = "app"\nversion = "0.1.0"\n' }, "other", [false, false]],
]) {
  test("CREATE: scaffold uses adapter shape for " + label, (t) => {
    const dir = freshRepo(t, files);
    cli(dir, ["init"]);
    const result = JSON.parse(cli(dir, ["scaffold", "--write"]));
    assert.ok(result.written.includes("app/agentdoc.yaml"));
    assert.match(read(dir, "app/agentdoc.yaml"), new RegExp("^  type: " + type + "$", "m"));
    choosePlacements(dir, ["app/agentdoc.yaml"]);
    assert.match(cli(dir, ["validate"]), /validate: PASS/);
    assert.match(cli(dir, ["compile"]), /compile: PASS/);
    const unit = compile(dir).discovery.eligible.find((u) => u.root === "app");
    assert.deepEqual([unit.deployable, unit.importable], shape);
  });
}

for (const [technology, files] of [
  ["uv", {
    "pyproject.toml": '[tool.uv.workspace]\nmembers = ["examples", "test", "deep/one/two/tests/member"]\n',
    "examples/pyproject.toml": '[project]\nname = "example-unit"\nversion = "0.1.0"\n',
    "test/pyproject.toml": '[project]\nname = "test-unit"\nversion = "0.1.0"\n',
    "deep/one/two/tests/member/pyproject.toml": '[project]\nname = "nested-unit"\nversion = "0.1.0"\n',
    "example/pyproject.toml": '[project]\nname = "unclaimed"\nversion = "0.1.0"\n',
  }],
  ["Cargo", {
    "Cargo.toml": '[workspace]\nmembers = ["examples", "test", "deep/one/two/tests/member"]\nresolver = "2"\n',
    "examples/Cargo.toml": '[package]\nname = "example-unit"\nversion = "0.1.0"\n',
    "examples/src/lib.rs": "pub fn example() {}\n",
    "test/Cargo.toml": '[package]\nname = "test-unit"\nversion = "0.1.0"\n',
    "test/src/lib.rs": "pub fn example() {}\n",
    "deep/one/two/tests/member/Cargo.toml": '[package]\nname = "nested-unit"\nversion = "0.1.0"\n',
    "deep/one/two/tests/member/src/lib.rs": "pub fn example() {}\n",
    "example/Cargo.toml": '[package]\nname = "unclaimed"\nversion = "0.1.0"\n',
    "example/src/lib.rs": "pub fn example() {}\n",
  }],
]) {
  test("CREATE: fresh " + technology + " setup discovers declared members under skipped names", (t) => {
    const dir = freshRepo(t, files);
    cli(dir, ["init"]);
    const cfg = read(dir, "agentdoc/agentdoc.config.yaml");
    const before = compile(dir);
    const roots = ["examples", "test", "deep/one/two/tests/member"];
    assert.deepEqual(before.discovery.eligible.map((u) => u.root).sort(), roots.slice().sort(),
      "init must enable the adapter even when only skipped/deep members supply units");
    const dry = JSON.parse(cli(dir, ["scaffold"]));
    const proposed = dry.written.map((f) => f.replace(/ \(dry run\)$/, ""));
    const descriptors = roots.map((root) => root + "/agentdoc.yaml");
    assert.deepEqual(proposed.filter((f) => f.endsWith("/agentdoc.yaml")).sort(), descriptors.slice().sort());
    for (const file of descriptors) assert.equal(fs.existsSync(path.join(dir, file)), false);
    assert.deepEqual(JSON.parse(cli(dir, ["scaffold", "--write"])).written, proposed);
    assert.equal(fs.existsSync(path.join(dir, "example/agentdoc.yaml")), false, "an unclaimed skipped directory stays excluded");
    choosePlacements(dir, descriptors);
    assert.equal(read(dir, "agentdoc/agentdoc.config.yaml"), cfg, "setup must not require configuration edits");
    assert.match(cli(dir, ["validate"]), /validate: PASS/);
    assert.match(cli(dir, ["compile"]), /compile: PASS/);
    assert.deepEqual(compile(dir).discovery.eligible.map((u) => u.root).sort(), roots.slice().sort());
    // The recursive descriptor glob also covers a new layout marker after init.
    // Use this workspace's technology so no adapter selection changes are needed.
    for (const [file, content] of Object.entries(files)) {
      if (file.startsWith("examples/")) write(dir, file.replace("examples/", "later/unit/"), content.replaceAll("example-unit", "later-unit"));
    }
    const later = JSON.parse(cli(dir, ["scaffold", "--write"]));
    assert.ok(later.written.includes("later/unit/agentdoc.yaml"));
    choosePlacements(dir, ["later/unit/agentdoc.yaml"]);
    assert.equal(read(dir, "agentdoc/agentdoc.config.yaml"), cfg);
    assert.match(cli(dir, ["compile"]), /compile: PASS/);
  });
}
