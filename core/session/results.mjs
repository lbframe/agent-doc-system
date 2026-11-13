import { CODES } from "../codes.mjs";
// Imported runner evidence is scoped to one repository snapshot and execution
// context. This module never executes a check or promotes a recommendation into
// a success. Any changed graph or evidence invalidates the imported result.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { compileSnapshot } from "../snapshot.mjs";
import { canonicalPath } from "../paths.mjs";
import { observationFreshness } from "../observations.mjs";
import { assertNoSecretsInText } from "../secrets.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const graphHash = (graph) => digest(JSON.stringify(graph));
function reject(message) { throw Object.assign(new Error(message), { code: CODES.SESSION_RESULT }); }
function object(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(name + " must be an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) reject("unknown " + name + " field: " + key);
}
function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) reject(name + " must be a nonempty string");
}
function sessionFile(root, session) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(session || "")) reject("invalid session reference");
  return path.join(path.resolve(root), ".agentdoc", "sessions", "check-results", session + ".json");
}
function repositoryPath(root, value, directory = false) {
  const rel = canonicalPath(value);
  if (rel === null || typeof value !== "string" || !value) reject("execution paths must stay inside the repository");
  let real;
  try {
    real = fs.realpathSync(path.join(root, rel));
    const stat = fs.statSync(real);
    if (directory ? !stat.isDirectory() : !stat.isFile()) reject("wrong execution path kind: " + rel);
  } catch { reject("execution path unavailable: " + rel); }
  const base = fs.realpathSync(root);
  if (real !== base && !real.startsWith(base + path.sep)) reject("execution path escapes repository: " + rel);
  return { rel, real };
}
function current(root, snapshot) {
  if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.graphHash || "")) reject("snapshot.graphHash must identify the full graph");
  const res = compileSnapshot(root);
  if (res.errors.length) reject("cannot validate results against a failing compilation");
  if (snapshot.graphHash !== graphHash(res.graph)) reject("snapshot changed; imported checks must be run again");
  if (observationFreshness(res.graph.observations).some((o) => o.stale)) reject("runtime observation expired; refresh context before importing checks");
  return res.graph;
}
function execution(result, root, graph) {
  object(result, ["checkId", "command", "cwd", "status", "exitCode", "runner", "evidence"], "result");
  nonempty(result.checkId, "checkId");
  nonempty(result.command, "command");
  const check = [...graph.verification, ...graph.gates].find((v) => v.id === result.checkId);
  if (!check || check.command !== result.command) reject("result must name the exact registered check and command");
  const cwd = repositoryPath(root, result.cwd, true).rel;
  if (!["succeeded", "failed"].includes(result.status) || !Number.isSafeInteger(result.exitCode) || result.exitCode < 0 ||
      (result.status === "succeeded") !== (result.exitCode === 0)) reject("execution status must agree with its exit code");
  object(result.runner, ["name", "version"], "runner");
  nonempty(result.runner.name, "runner.name"); nonempty(result.runner.version, "runner.version");
  object(result.evidence, ["path", "sha256"], "evidence");
  if (!/^[a-f0-9]{64}$/.test(result.evidence.sha256 || "")) reject("evidence requires a SHA-256 digest");
  const evidencePath = repositoryPath(root, result.evidence.path);
  const bytes = fs.readFileSync(evidencePath.real);
  if (digest(bytes) !== result.evidence.sha256) reject("execution evidence changed");
  let report;
  try { report = JSON.parse(bytes.toString("utf8")); } catch { reject("execution evidence must be a JSON runner report"); }
  if (!report || typeof report !== "object" || report.snapshot?.graphHash !== graphHash(graph) ||
      report.checkId !== result.checkId || report.command !== result.command || report.cwd !== cwd ||
      report.status !== result.status || report.exitCode !== result.exitCode ||
      report.runner?.name !== result.runner.name || report.runner?.version !== result.runner.version) reject("runner report does not corroborate the imported result");
  return { ...result, cwd, runner: { ...result.runner }, evidence: { path: evidencePath.rel, sha256: result.evidence.sha256 } };
}
function read(root, session) {
  const file = sessionFile(root, session);
  if (!fs.existsSync(file)) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    if (stored.digest !== digest(JSON.stringify(stored.data)) || stored.data.repository !== fs.realpathSync(root) ||
        stored.data.session !== session || stored.data.schemaVersion !== "agentdoc.dev/check-results/v1" || !Array.isArray(stored.data.results)) reject("invalid stored results");
    return stored.data;
  } catch { reject("stored session results are invalid; forget the session and rerun its checks"); }
}

export function importCheckResults(root, request) {
  object(request, ["session", "snapshot", "results"], "import");
  const file = sessionFile(root, request.session);
  if (!Array.isArray(request.results) || !request.results.length) reject("results must be a nonempty execution list");
  const graph = current(root, request.snapshot);
  const incoming = request.results.map((r) => execution(r, root, graph));
  const previous = read(root, request.session);
  const combined = new Map();
  if (previous?.graphHash === request.snapshot.graphHash) {
    for (const r of previous.results) {
      try { const valid = execution(r, root, graph); combined.set(JSON.stringify([valid.checkId, valid.command, valid.cwd, valid.runner]), valid); }
      catch { /* An old evidence bundle may have been replaced by a rerun. */ }
    }
  }
  for (const r of incoming) combined.set(JSON.stringify([r.checkId, r.command, r.cwd, r.runner]), r);
  const data = { schemaVersion: "agentdoc.dev/check-results/v1", repository: fs.realpathSync(root), session: request.session,
    graphHash: request.snapshot.graphHash, results: [...combined.values()] };
  const serialized = JSON.stringify({ data, digest: digest(JSON.stringify(data)) });
  assertNoSecretsInText(serialized, "session check results");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { fs.writeFileSync(temp, serialized, { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
  return { session: request.session, graphHash: data.graphHash, results: data.results };
}

export function validResultsForSnapshot(root, session, snapshot) {
  const data = read(root, session);
  if (!data || data.graphHash !== snapshot?.graphHash) return [];
  let graph;
  try { graph = current(root, snapshot); } catch { return []; }
  const valid = [];
  for (const result of data.results) {
    try { valid.push(execution(result, root, graph)); } catch { /* Expired or changed evidence is not a valid result. */ }
  }
  return valid;
}

export function forgetSession(root, session) {
  const file = sessionFile(root, session);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return existed;
}

export function clearSessions(root) {
  const dir = path.dirname(sessionFile(root, "session"));
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/.test(entry.name)) {
      fs.unlinkSync(path.join(dir, entry.name)); removed++;
    }
  }
  return removed;
}
