#!/usr/bin/env node
// agentdoc — portable documentation & software-catalog system.
//
// The command list lives in bin/usage.txt and is printed from there, so this
// header, `--help` and the shipped file cannot drift into three different
// claims about what the tool does.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDocError, CODES } from "../core/codes.mjs";
import { compile, sha256Hex } from "../core/compile.mjs";
import { Repo } from "../core/fsx.mjs";
import { assertFresh, readGraph, COMPILER_VERSION, GRAPH_SCHEMA_VERSION, COMPILER_NAME } from "../core/graph.mjs";
import { queryContext, renderContext } from "../core/query.mjs";
import { impact } from "../core/impact.mjs";
import { audit, scaffoldProposal } from "../core/audit.mjs";
import { observationFreshness, stalenessDiagnostics } from "../core/observations.mjs";
import { assertNoSecretsInText } from "../core/secrets.mjs";
import { installTemplates } from "../core/scaffold.mjs";
import { loadSchemaBundle, loadConfig } from "../core/descriptors.mjs";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
const MIN_NODE_MAJOR = 22;
// Commands are run from wherever the agent happens to be. Walk up until the
// configuration is found, so `agentdoc query src/foo.ts` works from a
// subdirectory instead of failing with a misleading missing-file error.
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 24; i++) {
    if (fs.existsSync(path.join(dir, "agentdoc", "agentdoc.config.yaml"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

const ROOT = findRoot(process.cwd());
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")[0]));
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name, dflt = null) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--" + name) {
      const next = argv[i + 1];
      return next && !next.startsWith("--") ? next : true;
    }
    if (argv[i].startsWith("--" + name + "=")) return argv[i].slice(name.length + 3);
  }
  return dflt;
};

function fail(errors, stats) {
  for (const e of errors) console.error("ERROR " + (e.format ? e.format() : e.code + ": " + e.message));
  if (stats) console.error("agentdoc: " + JSON.stringify(stats));
  process.exit(1);
}

function usage(exitCode) {
  const text = fs.readFileSync(path.join(HERE, "usage.txt"), "utf8");
  (exitCode === 0 ? process.stdout : process.stderr).write(text);
  process.exit(exitCode);
}

function printDiagnostics(res) {
  for (const d of res.diagnostics || []) {
    const prefix = d.severity === "error" ? "ERROR " : d.acceptance ? "WARN ACCEPTED " : "WARN  ";
    console.log(prefix + d.code + ": " + d.message);
    if (d.acceptance) console.log("  " + d.acceptance.classification + ": " + d.acceptance.reason);
  }
}

function gateObservationFreshness(res) {
  // Time-dependent gates run before artifact gates. A committed graph can be
  // stale for many reasons; when the cause is an observation that has aged out
  // of its promise, saying "rebuild the graph" sends the reader down the wrong
  // path entirely.
  const abs = path.join(ROOT, res.graphPath);
  if (!fs.existsSync(abs)) return null;
  const { graph } = readGraph(res.repo, res.graphPath);
  const fresh = observationFreshness(graph.observations, new Date());
  const stale = stalenessDiagnostics(fresh);
  if (stale.length && !flags.has("allow-stale-observations")) {
    for (const d of stale) console.error("ERROR " + d.code + ": " + d.message);
    process.exit(1);
  }
  return fresh;
}

function requireFresh(res) {
  const abs = path.join(ROOT, res.graphPath);
  if (!fs.existsSync(abs)) {
    fail([new AgentDocError(CODES.GRAPH_MISSING, "no compiled graph at " + res.graphPath + " — run `agentdoc compile`")]);
  }
  const { graph, text } = readGraph(res.repo, res.graphPath);
  try {
    assertFresh(graph, {
      inputHash: res.stats.inputHash,
      dirty: res.stats.dirty,
      compilerVersion: COMPILER_VERSION,
      schemaVersion: GRAPH_SCHEMA_VERSION,
    });
  } catch (e) {
    fail([e]);
  }
  if (graph.source.dirty && (flags.has("require-clean") || flag("require-clean"))) {
    fail([new AgentDocError(
      CODES.DIRTY_SOURCE,
      "catalog inputs differ from HEAD (" + res.stats.commit + ") — CI/publish evidence requires a clean source; commit the change and rebuild"
    )], res.stats);
  }
  return { graph, text, fresh: gateObservationFreshness(res) || [] };
}

function out(obj, asJson) {
  const text = asJson ? JSON.stringify(obj, null, 2) + "\n" : null;
  if (text) assertNoSecretsInText(text, "output");
  process.stdout.write(text || obj + "\n");
}

try {
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log("agentdoc " + VERSION);
    process.exit(0);
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help" || flags.has("help") || argv.includes("-h")) {
    usage(0);
  }
  if (cmd === "validate") {
    const res = compile(ROOT);
    printDiagnostics(res);
    if (res.errors.length) fail(res.errors, res.stats);
    console.log("agentdoc validate: PASS " + JSON.stringify(res.stats));
  } else if (cmd === "compile") {
    const res = compile(ROOT);
    printDiagnostics(res);
    if (res.errors.length) fail(res.errors, res.stats);
    if ((flags.has("require-clean") || flag("require-clean")) && res.stats.dirty) {
      fail([new AgentDocError(CODES.DIRTY_SOURCE, "catalog inputs differ from HEAD — commit the change and rebuild")], res.stats);
    }
    fs.mkdirSync(path.dirname(path.join(ROOT, res.graphPath)), { recursive: true });
    const tmp = path.join(ROOT, res.graphPath) + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, res.serialized);
    fs.renameSync(tmp, path.join(ROOT, res.graphPath));
    console.log("agentdoc compile: PASS " + JSON.stringify(res.stats));
    console.log("graph: " + res.graphPath);
  } else if (cmd === "check") {
    const res = compile(ROOT);
    printDiagnostics(res);
    if (res.errors.length) fail(res.errors, res.stats);
    gateObservationFreshness(res);
    const { graph, text, fresh } = requireFresh(res);
    // `source.commit` records which checkout produced the graph, and a checkout
    // without VCS — an extracted archive, a vendored dependency — compiles to
    // `0000000`. That is a difference in provenance, not in content, and failing
    // on it would make a committed graph unusable in exactly the situation it
    // is most needed: shipped as a file, with no history. Everything else must
    // still match byte for byte.
    const withoutCommit = (t) => t.replace(/^(\s*)"commit": "[0-9a-f]*",$/m, '$1"commit": "<provenance>",');
    if (withoutCommit(text) !== withoutCommit(res.serialized)) {
      fail([new AgentDocError(
        CODES.STALE_GRAPH,
        "compiled graph differs from a fresh deterministic compile — commit the descriptor or authority change and rebuild" +
          (text === res.serialized ? "" : " (only source.commit differs, which is tolerated: this checkout has no VCS history)")
      )]);
    }
    const gj = JSON.stringify(graph, null, 2) + "\n";
    if (gj !== text) {
      fail([new AgentDocError(CODES.STALE_GRAPH, "compiled graph is not canonically serialized — rebuild the graph")]);
    }
    console.log("agentdoc check: PASS " + JSON.stringify({ ...res.stats, observationFreshness: fresh.length }));
  } else if (cmd === "query") {
    const needle = positional[0];
    if (!needle) { console.error("usage: agentdoc query <repo-path|entity-ref> [--json] [--md] [--budget relations=10,verification=4]"); process.exit(2); }
    const res = compile(ROOT);
    if (res.errors.length) fail(res.errors, res.stats);
    // Time-dependent gates first, for the same reason as `check`: a stale
    // observation is a different problem from a stale graph and sends the reader
    // somewhere else entirely.
    gateObservationFreshness(res);
    const { graph } = requireFresh(res);
    // `--budget` exists because the default budgets are generous enough that a
    // focused query never truncates, which makes the truncation contract
    // untestable and unreachable from the CLI. An agent working in a tight
    // context needs to be able to say so.
    let budget = {};
    const raw = flag("budget");
    if (raw) {
      for (const pair of raw.split(",")) {
        const [k, v] = pair.split("=");
        if (!k || !/^\d+$/.test(String(v))) {
          console.error("usage: --budget section=limit,... (limits are positive integers)");
          process.exit(2);
        }
        budget[k.trim()] = Number(v);
      }
    }
    const ctx = queryContext(graph, needle, { budget });
    if (flags.has("md") || flag("md")) out(renderContext(ctx));
    else if (flags.has("json")) out(ctx, true);
    else out(renderContext(ctx));
  } else if (cmd === "impact") {
    // Impact answers a question about the working tree, so it compiles in
    // memory rather than reading the committed graph. Refusing a stale graph
    // would be right for `query` (which feeds a prompt) and wrong here: the
    // whole point of impact is to run *before* you rebuild.
    const res = compile(ROOT);
    if (res.errors.length) fail(res.errors, res.stats);
    const graph = res.graph;
    const fromRef = flag("diff") || flag("from");
    let paths = positional;
    if (fromRef && fromRef !== true) {
      paths = res.repo.diffPaths(fromRef);
      if (!paths.length) {
        console.error("no changed files between " + fromRef + " and HEAD");
        process.exit(2);
      }
    }
    if (!paths.length) {
      console.error("usage: agentdoc impact <path...> | agentdoc impact --diff <git-ref>");
      process.exit(2);
    }
    out(impact(graph, paths), true);
  } else if (cmd === "audit") {
    const res = compile(ROOT);
    if (!res.graph) {
      // An audit must work on a repository that cannot compile yet; report the
      // compilation failures as part of the audit rather than aborting.
      const report = {
        compileErrors: res.errors.map((e) => ({ code: e.code, message: e.message, path: e.path || null, ref: e.ref || null })),
        stats: res.stats,
      };
      out(report, true);
      process.exit(0);
    }
    const report = audit(res.repo, res.cfg, res);
    report.scaffold = scaffoldProposal(res.repo, res.cfg, report);
    out(report, true);
  } else if (cmd === "scaffold") {
    const res = compile(ROOT);
    const write = flags.has("write") || flag("write");
    if (!res.graph) {
      out({
        scaffolded: [],
        blocked: res.errors.map((e) => ({ code: e.code, message: e.message })),
        note: "the repository cannot compile yet; install the configuration first with `agentdoc init`",
      }, true);
      process.exit(0);
    }
    const report = audit(res.repo, res.cfg, res);
    const proposal = scaffoldProposal(res.repo, res.cfg, report);
    const result = installTemplates(res.repo, res.cfg, { write: Boolean(write) });
    out({ ...result, proposal }, true);
  } else if (cmd === "init") {
    const result = installTemplates(null, null, { write: true, root: ROOT, force: flags.has("force") });
    out(result, true);
  } else if (cmd === "eval") {
    const which = positional[0] || "routing";
    if (which !== "routing") { console.error("usage: agentdoc eval routing [--json]"); process.exit(2); }
    // The evaluation corpora are development material and are not shipped in
    // the installed package, so the harness is loaded lazily: it must not make
    // every other command fail on a missing directory it never uses.
    let runRoutingEval;
    try {
      ({ runRoutingEval } = await import("../evals/harness.mjs"));
    } catch {
      console.error("agentdoc eval: the routing evaluation is not included in the installed package — run it from an agent-doc-system source checkout");
      process.exit(1);
    }
    const report = runRoutingEval(ROOT, { json: flags.has("json") });
    if (flags.has("json")) { out(report, true); process.exit(report.verdict === "FAIL" ? 1 : 0); }
    else {
      console.log(JSON.stringify(report.metrics, null, 2));
      console.log("thresholds: " + JSON.stringify(report.thresholds));
      console.log("verdict: " + report.verdict + " (" + report.failures.join("; ") + ")");
    }
    if (report.verdict === "FAIL") process.exit(1);
  } else if (cmd === "pin-evidence") {
    // Reviewed overrides pin their evidence by content hash, and those digests
    // are re-verified on every compile. That is only workable if an author can
    // obtain the current digest without computing SHA-256 by hand — otherwise
    // the discipline quietly becomes "delete the override", which is worse
    // than not requiring it.
    // Read the configuration directly rather than through `compile`: a stale
    // digest is precisely the condition this command exists to report, and it
    // must be reportable when `compile` refuses to run.
    const repo = new Repo(ROOT);
    const cfg = loadConfig(repo, loadSchemaBundle().bundle);
    const results = [];
    for (const o of cfg.reviewedOverrides || []) {
      for (const ev of o.evidence || []) {
        const p = path.join(ROOT, ev.path);
        if (!fs.existsSync(p)) {
          results.push({ subject: o.subject, path: ev.path, current: null, pinned: ev.sha256, status: "MISSING" });
          continue;
        }
        const current = sha256Hex(fs.readFileSync(p));
        results.push({
          subject: o.subject, path: ev.path, current,
          pinned: ev.sha256,
          status: current === ev.sha256 ? "CURRENT" : "STALE",
        });
      }
    }
    if (flags.has("json")) { out({ evidence: results }, true); }
    else {
      for (const r of results) {
        console.log(r.status.padEnd(8) + " " + r.path);
        if (r.status === "STALE") {
          console.log("         pinned:  " + r.pinned);
          console.log("         current: " + r.current + "   <- update the digest after reviewing the change");
        }
      }
      console.log(results.length + " evidence entries across " + (cfg.reviewedOverrides || []).length + " reviewed overrides");
    }
    if (results.some((r) => r.status !== "CURRENT")) process.exit(1);
  } else if (cmd === "doctor") {
    // Two scopes, kept explicit: `doctor` is a machine check — is this
    // installation of the CLI itself healthy — and never fails because a
    // project happens not to be configured yet. `doctor --project` adds the
    // project checks and fails on those too.
    const major = Number(process.versions.node.split(".")[0]);
    const machine = {
      agentdoc: VERSION,
      node: process.version,
      nodeSupported: major >= MIN_NODE_MAJOR,
      nodeRequired: ">=" + MIN_NODE_MAJOR,
      compiler: COMPILER_NAME + "@" + COMPILER_VERSION,
      graphSchema: GRAPH_SCHEMA_VERSION,
      installRoot: PACKAGE_ROOT,
      schemaBundle: null,
      gitAvailable: false,
      externalRuntimeDependencies: [],
    };
    try {
      const { versionInputs } = loadSchemaBundle();
      machine.schemaBundle = { ok: true, schemas: versionInputs.length };
    } catch (e) {
      machine.schemaBundle = { ok: false, error: (e.code ? e.code + ": " : "") + e.message };
    }
    try {
      execFileSync("git", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      machine.gitAvailable = true;
    } catch {
      machine.gitAvailable = false;
    }
    let machineOk = machine.nodeSupported && machine.schemaBundle.ok;

    const report = { scope: "machine", ok: machineOk, machine };
    if (flags.has("project")) {
      const configFound = fs.existsSync(path.join(ROOT, "agentdoc", "agentdoc.config.yaml"));
      const project = {
        root: ROOT,
        configurationFound: configFound,
        configPath: "agentdoc/agentdoc.config.yaml",
        writable: null,
        graphPresent: false,
      };
      try {
        fs.accessSync(ROOT, fs.constants.W_OK);
        project.writable = true;
      } catch {
        project.writable = false;
      }
      if (configFound) {
        try {
          const cfg = loadConfig(new Repo(ROOT), loadSchemaBundle().bundle);
          project.graphPath = cfg.output?.graph || ".agentdoc/graph.json";
          project.graphPresent = fs.existsSync(path.join(ROOT, project.graphPath));
        } catch (e) {
          project.configError = (e.code ? e.code + ": " : "") + e.message;
        }
      }
      report.scope = "machine+project";
      report.project = project;
      report.ok = machineOk && configFound && project.writable === true && !project.configError;
    }
    out(report, true);
    if (!report.ok) process.exit(1);
  } else {
    usage(2);
  }
} catch (e) {
  if (e instanceof AgentDocError) {
    console.error("ERROR " + e.format());
    process.exit(1);
  }
  console.error("agentdoc internal error: " + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
}
