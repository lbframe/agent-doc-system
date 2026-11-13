// Conservative persistent compilation reuse. Every visible file is hashed;
// this deliberately over-invalidates rather than inventing extractor-level
// dependencies. Full compile remains the oracle and is always available.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Repo, sha256Hex } from "./fsx.mjs";
import { compile, CompileResult } from "./compile.mjs";
import { loadConfig, loadSchemaBundle } from "./descriptors.mjs";
import { AgentDocError, CODES } from "./codes.mjs";
import { readCompiledCache, writeCompiledCache } from "./cache/compiled.mjs";
import { ParseCache } from "./cache/parses.mjs";

const implementationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function implementationHash() {
  const records = [];
  for (const dir of ["core", "adapters", "schemas"]) {
    const walk = (base) => {
      for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(base, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) records.push([path.relative(implementationRoot, file), sha256Hex(fs.readFileSync(file))]);
      }
    };
    walk(path.join(implementationRoot, dir));
  }
  return sha256Hex(JSON.stringify(records));
}

// A running process keeps its imported implementation even if files on disk
// are replaced by an upgrade. Never label old code's result with the new hash.
const implementationVersion = implementationHash();
const sharedParses = new ParseCache();

function capture(root, opts) {
  const schema = loadSchemaBundle();
  const cfg = loadConfig(new Repo(root, { noGit: true }), schema.bundle);
  const repo = new Repo(root, { noGit: opts.noGit, generatedDirs: cfg.discovery.generatedDirs || opts.generatedDirs, snapshotReads: true });
  const files = repo.walk("").filter((file) => file !== cfg.output.graph);
  const content = files.map((file) => [file, sha256Hex(repo.readBytes(file))]);
  // Empty directories and path kinds are captured too: exists/isDir/listDir
  // probes may affect resolution even when there is no readable file yet.
  let symlinks = false;
  const listings = [];
  const visit = (dir) => {
    if (repo.isIgnored(dir)) return;
    const entries = fs.readdirSync(repo.abs(dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const visible = [];
    for (const entry of entries) {
      const rel = dir === "." ? entry.name : dir + "/" + entry.name;
      if (repo.generatedDirs.has(entry.name) || repo.isIgnored(rel)) continue;
      visible.push([entry.name, entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : "file"]);
      if (entry.isSymbolicLink()) symlinks = true;
      if (entry.isDirectory()) visit(rel);
    }
    listings.push([dir, visible]);
  };
  visit(".");
  const state = {
    version: 1, implementation: implementationVersion, schemas: schema.versionInputs, noGit: Boolean(opts.noGit),
    generatedDirs: [...repo.generatedDirs].sort(), commit: repo.headCommit(),
    status: repo.statusRecords()?.filter((r) => r.xy !== "!!" && r.path !== cfg.output.graph) || null, content, listings,
  };
  return { key: sha256Hex(JSON.stringify(state)), repo, cfg, files: new Set(files), digests: new Map(content), symlinks };
}

/** Read-only result consumer API. Extraction-only fields (ctx/discovery) are
 * available on a miss only; callers needing those must use compile().
 * Time-dependent observation gates must run after every call, including hits.
 */
export function compileSnapshot(root, opts = {}) {
  const started = performance.now();
  const file = path.join(path.resolve(root), ".agentdoc", "cache", "compiled-v1.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    let before;
    try { before = capture(root, opts); }
    catch { return compile(root, { ...opts, snapshotReads: false }); }
    // Explicit authored paths can follow a symlink even though discovery does
    // not. Without a target manifest, reuse would miss changes outside the walk.
    if (before.symlinks) return compile(root, { ...opts, snapshotReads: false });
    const cached = opts.cache === false ? null : readCompiledCache(file, before.key);
    let result;
    if (cached) {
      try {
        const graph = JSON.parse(cached.serialized);
        const invalid = loadSchemaBundle().bundle.validator("agentdoc.dev/schema/graph.schema.json").validate(graph);
        if (!invalid) {
          result = new CompileResult();
          Object.assign(result, { graph, serialized: cached.serialized, stats: cached.stats, diagnostics: graph.diagnostics,
            cfg: before.cfg, repo: before.repo, graphPath: before.cfg.output.graph });
        }
      } catch { /* corrupt cache: compile instead */ }
    }
    const hit = Boolean(result);
    result ||= compile(root, { ...opts, snapshotReads: true, telemetry: true, parseCache: opts.parseCache || sharedParses });
    if (!hit && result.repo) {
      const excluded = [...result.repo.readPaths.keys()].some((p) => !before.files.has(p)) ||
        [...result.repo.probes.keys()].some((p) => p.split("/").some((seg) => before.repo.generatedDirs.has(seg)) || p === before.cfg.output.graph);
      if (excluded) return compile(root, { ...opts, snapshotReads: false });
    }
    let after;
    try { after = capture(root, opts); }
    catch { continue; }
    if (before.key !== after.key) continue;
    if (!hit && result.repo) {
      if ([...result.repo.readPaths].some(([p, digest]) => after.digests.get(p) !== digest)) continue;
      if ([...result.repo.probeRecords.values()].some((probe) => after.repo[probe.kind](probe.path) !== probe.value)) continue;
      if ([...result.repo.listings].some(([p, names]) => JSON.stringify(after.repo.listDir(p)) !== JSON.stringify(names))) continue;
      if ([...result.repo.walkInputs].some(([dir, entries]) => JSON.stringify(after.repo.directoryState(dir)) !== JSON.stringify(entries))) continue;
    }
    if (!hit && !result.errors.length && opts.cache !== false) writeCompiledCache(file, {
      key: before.key, serialized: result.serialized, stats: result.stats,
    });
    // Consumers read evidence from the captured bytes, including on cache hits.
    result.repo = before.repo;
    result.cache = { hit, key: before.key, mode: "whole-compile", persisted: opts.cache !== false };
    result.telemetry = { ...(result.telemetry || {}), durationMs: performance.now() - started,
      captureReads: before.repo.metrics.physicalReads + after.repo.metrics.physicalReads };
    return result;
  }
  throw new AgentDocError(CODES.SNAPSHOT_UNSTABLE, "repository changed during context capture; retry once edits have settled");
}
