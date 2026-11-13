import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { baseFixture, write, git } from "./helpers.mjs";
import { Repo } from "../core/fsx.mjs";
import { compile } from "../core/compile.mjs";
import { compileSnapshot } from "../core/snapshot.mjs";
import { ParseCache } from "../core/cache/parses.mjs";

test("snapshot: content-addressed parses survive source changes but never mutable object changes", (t) => {
  const root = baseFixture(t);
  const parseCache = new ParseCache();
  const first = compile(root, { snapshotReads: true, telemetry: true, parseCache });
  assert.ok(first.telemetry.jsonParses > 0);
  write(root, "service/src/index.ts", "export const changed = true;");
  const changed = compile(root, { snapshotReads: true, telemetry: true, parseCache });
  assert.ok(changed.telemetry.sharedJsonHits > 0);
  assert.ok(changed.telemetry.jsonParses < first.telemetry.jsonParses);
  assert.equal(changed.serialized, compile(root).serialized);
  const before = parseCache.get('{"a":1}');
  assert.equal(before, undefined);
  parseCache.set('{"a":1}', { a: 1 });
  parseCache.get('{"a":1}').a = 2;
  assert.deepEqual(parseCache.get('{"a":1}'), { a: 1 });
});

test("snapshot: cached reads are isolated from caller JSON mutations and full compile matches", (t) => {
  const root = baseFixture(t);
  const repo = new Repo(root, { snapshotReads: true });
  repo.readJson("service/package.json").name = "mutated";
  assert.equal(repo.readJson("service/package.json").name, "@t/svc");
  assert.equal(repo.metrics.physicalReads, 1);
  assert.equal(repo.metrics.jsonParses, 1);
  const full = compile(root);
  const snap = compile(root, { snapshotReads: true, telemetry: true });
  assert.equal(snap.serialized, full.serialized);
  assert.ok(snap.telemetry.readCacheHits > 0);
  assert.equal(snap.graph.telemetry, undefined);
});

test("snapshot: persistent reuse invalidates changed, added, deleted and renamed source files", (t) => {
  const root = baseFixture(t);
  const first = compileSnapshot(root);
  assert.deepEqual(first.errors, []);
  assert.equal(first.cache.hit, false);
  assert.equal(compileSnapshot(root).cache.hit, true);
  const mutateAndCompare = (mutate) => {
    mutate();
    const result = compileSnapshot(root);
    assert.equal(result.cache.hit, false);
    assert.equal(result.serialized, compile(root).serialized);
    assert.equal(compileSnapshot(root).cache.hit, true);
  };
  mutateAndCompare(() => write(root, "service/src/index.ts", 'export const NAME = "changed";'));
  mutateAndCompare(() => write(root, "service/src/new.ts", "export const extra = 1;"));
  mutateAndCompare(() => fs.renameSync(path.join(root, "service/src/new.ts"), path.join(root, "service/src/renamed.ts")));
  mutateAndCompare(() => fs.rmSync(path.join(root, "service/src/renamed.ts")));
});

test("snapshot: negative directory probes and ignore rules invalidate safely", (t) => {
  const root = baseFixture(t);
  compileSnapshot(root);
  fs.mkdirSync(path.join(root, "service/src/empty"));
  const added = compileSnapshot(root);
  assert.equal(added.cache.hit, false);
  assert.equal(added.serialized, compile(root).serialized);
  write(root, ".gitignore", "/.agentdoc/\n/ignored/\n");
  const ignored = compileSnapshot(root);
  assert.equal(ignored.cache.hit, false);
  write(root, "ignored/hidden.ts", "export const ignored = 1;");
  assert.equal(compileSnapshot(root).cache.hit, true);
  write(root, ".gitignore", "/.agentdoc/\n");
  assert.equal(compileSnapshot(root).cache.hit, false);
});

test("snapshot: malformed persistent cache falls back, disabled cache stays full, Git metadata is current", (t) => {
  const root = baseFixture(t);
  compileSnapshot(root);
  const file = path.join(root, ".agentdoc/cache/compiled-v1.json");
  fs.writeFileSync(file, "not json");
  const recovered = compileSnapshot(root);
  assert.equal(recovered.cache.hit, false);
  assert.equal(recovered.serialized, compile(root).serialized);
  assert.equal(compileSnapshot(root, { cache: false }).cache.hit, false);
  git(root, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "new HEAD"]);
  const moved = compileSnapshot(root);
  assert.equal(moved.cache.hit, false);
  assert.equal(moved.graph.source.commit, git(root, ["rev-parse", "HEAD"]).trim());
});

test("snapshot: symlink inputs fall back to the full oracle", (t) => {
  const root = baseFixture(t);
  fs.symlinkSync("src/index.ts", path.join(root, "service/linked.ts"));
  const result = compileSnapshot(root);
  assert.equal(result.cache, undefined);
  assert.equal(result.serialized, compile(root).serialized);
});

test("snapshot: transient edits read during extraction cannot be cached as the settled tree", (t) => {
  const root = baseFixture(t);
  const target = "service/src/index.ts";
  const absolute = path.join(root, target);
  const original = fs.readFileSync(absolute);
  const readBytes = Repo.prototype.readBytes;
  let injected = false;
  Repo.prototype.readBytes = function (rel, opts) {
    if (!injected && this.root === root && this.snapshotReads && rel === target) {
      injected = true;
      fs.writeFileSync(absolute, 'export const transient = "not the settled tree";');
      try { return readBytes.call(this, rel, opts); }
      finally { fs.writeFileSync(absolute, original); }
    }
    return readBytes.call(this, rel, opts);
  };
  let result;
  try { result = compileSnapshot(root); }
  finally { Repo.prototype.readBytes = readBytes; }
  assert.ok(injected);
  assert.equal(result.serialized, compile(root).serialized);
  assert.equal(compileSnapshot(root).serialized, result.serialized);
});
