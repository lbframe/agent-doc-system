import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
