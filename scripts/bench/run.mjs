#!/usr/bin/env node
// Fresh-setup benchmark on pinned public repositories.
//
// For each repository in repos.json: clone at the pinned commit, run
// `agentdoc init` and `agentdoc scaffold --write`, fill in the one line a human
// must choose (the component's placement), commit, then compile three times.
// It reports what the setup found on its own, how long it took, whether the
// graph is byte-identical across compiles, and the size of a `query` answer.
//
// It also counts every other edit a human would have had to make before the
// catalog compiles: a descriptor scaffold did not write, or a scaffolded type
// that validate rejects. Those counts are the honest measure of "setup works";
// they are expected to be zero.
//
// Usage: node scripts/bench/run.mjs [workDir] [--json]
// Network is needed for the clones. Nothing outside workDir is modified.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "..", "bin", "agentdoc.mjs");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const workDir = path.resolve(args.find((a) => !a.startsWith("--")) || fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-bench-")));
const REPOS = JSON.parse(fs.readFileSync(path.join(HERE, "repos.json"), "utf8"));

// Commits made in the clones are throwaway; never sign them.
const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" };
const git = (cwd, a) => execFileSync("git", a, { cwd, env, encoding: "utf8", maxBuffer: 1 << 28 });
const commit = (cwd, msg) => { git(cwd, ["add", "-A"]); git(cwd, ["-c", "user.email=bench@agentdoc", "-c", "user.name=bench", "commit", "-qm", msg]); };
const agentdoc = (cwd, a, allowFail = false) => {
  try {
    return execFileSync("node", [BIN, ...a], { cwd, env, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (allowFail) return (e.stdout || "") + (e.stderr || "");
    throw new Error("agentdoc " + a.join(" ") + " failed in " + cwd + ":\n" + (e.stderr || e.message));
  }
};
const now = () => Number(process.hrtime.bigint() / 1000000n);
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
// A rough token estimate (4 characters per token), stated as such in the output.
const tokens = (s) => Math.round(s.length / 4);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs)$/;

function prepare(repo) {
  const dir = path.join(workDir, repo.name);
  if (!fs.existsSync(dir)) git(workDir, ["clone", "-q", "--filter=blob:none", repo.url, dir]);
  git(dir, ["fetch", "-q", "origin", repo.commit]);
  git(dir, ["checkout", "-q", "--detach", repo.commit]);
  git(dir, ["reset", "-q", "--hard"]);
  git(dir, ["clean", "-qfdx"]);
  return dir;
}

function measure(repo) {
  const dir = prepare(repo);
  const tracked = git(dir, ["ls-files"]).split("\n").filter(Boolean);
  const sources = tracked.filter((f) => SOURCE.test(f));

  const t0 = now();
  agentdoc(dir, ["init"]);
  agentdoc(dir, ["scaffold", "--write"], true);
  const setupMs = now() - t0;

  // The placement is an ownership decision AgentDoc refuses to make. Fill in
  // the scaffold's own prompt, exactly as a human accepting it would.
  const descriptors = git(dir, ["ls-files", "-o", "--exclude-standard"]).split("\n").filter((f) => f.endsWith("agentdoc.yaml"));
  for (const f of descriptors) {
    const p = path.join(dir, f);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/^  # placementRationale: .*$/m, '  placementRationale: "Benchmark placement."'));
  }
  commit(dir, "agentdoc setup");

  // Any further edit needed before the catalog validates is a setup defect.
  const out = agentdoc(dir, ["validate"], true);
  const missedDescriptors = [...out.matchAll(/AGENTDOC_COVERAGE_ZERO \[([^\]]+)\]/g)].map((m) => m[1]);
  const typeErrors = [...out.matchAll(/AGENTDOC_ARTIFACT_TYPE \[([^\] ]+)/g)].map((m) => m[1]);
  if (missedDescriptors.length || typeErrors.length) {
    return { repo: repo.name, commit: repo.commit.slice(0, 7), setupOk: false, missedDescriptors, typeErrors };
  }

  const compileMs = [];
  const hashes = new Set();
  for (let i = 0; i < 3; i++) {
    const t = now();
    agentdoc(dir, ["compile"]);
    compileMs.push(now() - t);
    hashes.add(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, ".agentdoc", "graph.json"))).digest("hex"));
  }
  const graph = JSON.parse(fs.readFileSync(path.join(dir, ".agentdoc", "graph.json"), "utf8"));
  const components = graph.entities.filter((e) => e.kind === "Component");

  // One query and one impact per component, on a production source file.
  const samples = [];
  for (const c of components) {
    const root = c.derived?.sourcePath;
    const file = sources.find((f) => f.startsWith(root + "/") && !/test/i.test(f));
    if (!file) continue;
    const t = now();
    const md = agentdoc(dir, ["query", file, "--md"]);
    const queryMs = now() - t;
    const imp = JSON.parse(agentdoc(dir, ["impact", file]));
    samples.push({
      component: c.ref, file, queryTokens: tokens(md), queryMs,
      affectedComponents: imp.affectedComponents.length, recommendedChecks: imp.recommendedVerificationTotal ?? imp.recommendedVerification.length,
    });
  }
  return {
    repo: repo.name, commit: repo.commit.slice(0, 7), setupOk: true,
    trackedFiles: tracked.length, sourceFiles: sources.length,
    languages: [...new Set(components.flatMap((c) => c.derived?.languages || []))].sort(),
    components: components.length,
    dependencyEdges: graph.relations.filter((r) => /DependsOn$/.test(r.type)).length,
    checks: graph.verification.length, gates: (graph.gates || []).length,
    setupMs, compileMsMedian: median(compileMs), deterministic: hashes.size === 1,
    queryTokensMedian: median(samples.map((s) => s.queryTokens)),
    queryTokensMax: Math.max(...samples.map((s) => s.queryTokens)),
    samples,
  };
}

const results = REPOS.map(measure);
if (asJson) {
  console.log(JSON.stringify({ agentdoc: agentdoc(workDir, ["--version"]).trim(), node: process.version, platform: process.platform + "-" + process.arch, results }, null, 2));
} else {
  console.log("agentdoc " + agentdoc(workDir, ["--version"]).trim().replace(/^agentdoc /, "") + " · node " + process.version + " · " + process.platform + "-" + process.arch + "\n");
  console.log("| repository | files | setup ok | components | dependency edges | checks | setup + 1st compile | compile | deterministic | query answer (median / max, ~tokens) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (!r.setupOk) {
      console.log(`| ${r.repo}@${r.commit} | | **no**: missed ${r.missedDescriptors.length}, types ${r.typeErrors.length} | | | | | | | |`);
      continue;
    }
    console.log(`| ${r.repo}@${r.commit} | ${r.trackedFiles} | yes | ${r.components} | ${r.dependencyEdges} | ${r.checks} | ${((r.setupMs + r.compileMsMedian) / 1000).toFixed(1)} s | ${(r.compileMsMedian / 1000).toFixed(1)} s | ${r.deterministic ? "yes" : "**no**"} | ${r.queryTokensMedian} / ${r.queryTokensMax} |`);
  }
  console.log("\nWork directory: " + workDir);
}
if (results.some((r) => !r.setupOk || !r.deterministic)) process.exitCode = 1;
