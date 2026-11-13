import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { compileSnapshot } from "../core/snapshot.mjs";
import { importCheckResults, validResultsForSnapshot, forgetSession, clearSessions } from "../core/session/results.mjs";
import { baseFixture, write } from "./helpers.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = baseFixture(t);
  const res = compileSnapshot(root);
  assert.deepEqual(res.errors, []);
  const snapshot = { graphHash: hash(JSON.stringify(res.graph)) };
  const check = res.graph.verification[0];
  assert.ok(check);
  return { root, snapshot, check };
}
function result(f, status = "succeeded", suffix = "one") {
  const execution = { checkId: f.check.id, command: f.check.command, cwd: "service", status,
    exitCode: status === "succeeded" ? 0 : 1, runner: { name: "fixture-runner", version: "1.0.0" } };
  const relative = ".agentdoc/executions/" + suffix + ".json";
  const bytes = JSON.stringify({ snapshot: f.snapshot, ...execution });
  fs.mkdirSync(path.dirname(path.join(f.root, relative)), { recursive: true });
  fs.writeFileSync(path.join(f.root, relative), bytes);
  return { ...execution, evidence: { path: relative, sha256: hash(bytes) } };
}
const request = (f, results, session = "work") => ({ session, snapshot: f.snapshot, results });

test("session results: corroborated successes and failures retain their execution context", (t) => {
  const f = fixture(t);
  const failed = result(f, "failed", "failed");
  importCheckResults(f.root, request(f, [failed]));
  assert.equal(validResultsForSnapshot(f.root, "work", f.snapshot)[0].status, "failed");
  const succeeded = result(f, "succeeded", "rerun");
  importCheckResults(f.root, request(f, [succeeded]));
  const valid = validResultsForSnapshot(f.root, "work", f.snapshot);
  assert.equal(valid.length, 1);
  assert.deepEqual(valid[0], succeeded);
});

test("session results: a changed graph invalidates prior success even with a caller's old snapshot", (t) => {
  const f = fixture(t);
  importCheckResults(f.root, request(f, [result(f)]));
  write(f.root, "service/src/index.ts", "export const NAME = 'different';\n");
  assert.deepEqual(validResultsForSnapshot(f.root, "work", f.snapshot), []);
  assert.throws(() => importCheckResults(f.root, request(f, [result(f)])), /snapshot changed/);
});

test("session results: modified evidence and mismatched runner reports cannot remain valid", (t) => {
  const f = fixture(t);
  const imported = result(f);
  importCheckResults(f.root, request(f, [imported]));
  fs.appendFileSync(path.join(f.root, imported.evidence.path), " ");
  assert.deepEqual(validResultsForSnapshot(f.root, "work", f.snapshot), []);
  assert.throws(() => importCheckResults(f.root, request(f, [imported])), /evidence changed/);
  const fresh = result(f, "succeeded", "fresh");
  assert.throws(() => importCheckResults(f.root, request(f, [{ ...fresh, runner: { name: "other", version: "1" } }])), /does not corroborate/);
});

test("session results: recommendations, exit-code disagreement, guessed commands and absent cwd are refused", (t) => {
  const f = fixture(t);
  const r = result(f);
  for (const change of [
    { status: "recommended" }, { status: "failed", exitCode: 0 }, { command: "true" },
    { cwd: undefined }, { cwd: "../outside" }, { evidence: { ...r.evidence, sha256: "0".repeat(64) } },
  ]) assert.throws(() => importCheckResults(f.root, request(f, [{ ...r, ...change }])), { code: "AGENTDOC_SESSION_RESULT" });
});

test("session results: cwd and runner identity are part of validity, not aliases of the check ID", (t) => {
  const f = fixture(t);
  const r = result(f);
  assert.throws(() => importCheckResults(f.root, request(f, [{ ...r, cwd: "." }])), /does not corroborate/);
  importCheckResults(f.root, request(f, [r]));
  assert.deepEqual(validResultsForSnapshot(f.root, "work", { graphHash: "0".repeat(64) }), []);
});

test("session results: corruption is detected and forgetting recovers without touching context or evidence", (t) => {
  const f = fixture(t);
  const r = result(f);
  importCheckResults(f.root, request(f, [r]));
  const file = path.join(f.root, ".agentdoc/sessions/check-results/work.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.data.results[0].status = "failed";
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.throws(() => validResultsForSnapshot(f.root, "work", f.snapshot), /invalid/);
  assert.equal(forgetSession(f.root, "work"), true);
  assert.equal(forgetSession(f.root, "work"), false);
  assert.deepEqual(validResultsForSnapshot(f.root, "work", f.snapshot), []);
  assert.ok(fs.existsSync(path.join(f.root, r.evidence.path)));
});

test("session results: sessions are isolated and cleanup removes only their result records", (t) => {
  const f = fixture(t);
  const r = result(f);
  importCheckResults(f.root, request(f, [r], "first"));
  importCheckResults(f.root, request(f, [r], "second"));
  forgetSession(f.root, "first");
  assert.equal(validResultsForSnapshot(f.root, "second", f.snapshot).length, 1);
  assert.equal(clearSessions(f.root), 1);
  assert.equal(clearSessions(f.root), 0);
  assert.ok(fs.existsSync(path.join(f.root, r.evidence.path)));
  assert.throws(() => forgetSession(f.root, "../context"), /invalid session/);
});
