// Repository access bound to the checkout root.
//
// Every byte the compiler reads flows through the read-path tracker, and every
// existence probe and directory listing is recorded. The complete input record
// is what the graph's inputHash is computed over, so freshness detection can
// never miss an input. This is the single most important property of the
// original system and is preserved verbatim.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgentDocError, CODES } from "./codes.mjs";

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function isRepoPath(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(p) &&
    !p.includes("\\") &&
    !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "") &&
    !/\s/.test(p)
  );
}

export function assertRepoPath(p, ctx) {
  if (!isRepoPath(p)) {
    throw new AgentDocError(
      CODES.PATH_ESCAPE,
      "invalid repository path " + JSON.stringify(p) + ": paths must be relative, use '/', and contain no '..'",
      { path: ctx }
    );
  }
}

// Build/tooling output is never repository authority. Configurable per install
// so a project with e.g. "target" or "vendor" trees keeps them out too.
// Build and tooling output. Tooling caches and dependency directories only: a
// name like `build`, `out` or `tmp` is far more likely to be a real unit in some
// repository than a generated directory, and a repository with a deployable
// `build/` must still be describable. Add project-specific output directories
// through `discovery.generatedDirs` in the configuration.
export const DEFAULT_GENERATED_DIRS = [
  ".git", "node_modules", "vendor", "target", "dist", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".wrangler", ".vercel", ".output",
  ".cache", ".venv", "__pycache__", ".pytest_cache", ".gradle", ".terraform",
  ".idea", ".vscode-test", "test-results", "playwright-report",
  "storybook-static", ".agentdoc", ".dart_tool", ".tox", ".mypy_cache",
];

export class Repo {
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.readPaths = new Map();
    this.probes = new Map();
    this.walks = new Map();
    this.listings = new Map();
    this.generatedDirs = new Set(opts.generatedDirs || DEFAULT_GENERATED_DIRS);
    this.noGit = Boolean(opts.noGit);
  }
  abs(rel) {
    const a = path.resolve(this.root, rel);
    if (a !== this.root && !a.startsWith(this.root + path.sep)) {
      throw new AgentDocError(CODES.PATH_ESCAPE, "path escapes repository: " + rel, { path: rel });
    }
    return a;
  }
  exists(rel) {
    const r = fs.existsSync(this.abs(rel));
    this.probes.set(rel, r);
    return r;
  }
  isDir(rel) {
    try {
      const r = fs.statSync(this.abs(rel)).isDirectory();
      this.probes.set(rel, r);
      return r;
    } catch {
      this.probes.set(rel, false);
      return false;
    }
  }
  readBytes(rel, { track = true } = {}) {
    const a = this.abs(rel);
    let buf;
    try {
      buf = fs.readFileSync(a);
    } catch {
      throw new AgentDocError(CODES.PATH_UNRESOLVED, "path does not resolve inside the repository: " + rel, { path: rel });
    }
    if (track) this.readPaths.set(rel, sha256Hex(buf));
    return buf;
  }
  readText(rel, opts = {}) {
    const buf = this.readBytes(rel, opts);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      throw new AgentDocError(CODES.UTF8, "file is not valid UTF-8: " + rel, { path: rel });
    }
    if (text.startsWith("﻿")) text = text.slice(1);
    return text;
  }
  readJson(rel) {
    return JSON.parse(this.readText(rel));
  }
  readJsonUntracked(rel) {
    return JSON.parse(this.readText(rel, { track: false }));
  }
  // Recursive listing, byte-sorted, never following symlinks out of the repo.
  walk(relDir, { exclude = () => false } = {}) {
    const base = relDir ? this.abs(relDir) : this.root;
    const out = [];
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        if (this.generatedDirs.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        const rel = path.relative(this.root, full).split(path.sep).join("/");
        if (ent.isSymbolicLink()) continue;
        if (exclude(rel, ent)) continue;
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile()) out.push(rel);
      }
    }
    out.sort();
    this.walks.set(relDir || ".", out);
    return out;
  }
  // Files under a path or a path *prefix*. A contract is often named by a module
  // prefix rather than a single file (`events.go`, `events/*.go`), and
  // requiring an exact directory would reject a perfectly good contract.
  filesWithPrefix(prefix) {
    if (this.exists(prefix)) {
      const abs = this.abs(prefix);
      try {
        if (fs.statSync(abs).isFile()) return [prefix];
        if (fs.statSync(abs).isDirectory()) return this.walk(prefix);
      } catch { /* fall through to the prefix walk */ }
    }
    const base = prefix.split("/").slice(0, -1).join("/");
    const last = prefix.split("/").pop();
    if (!last) return [];
    return this.walk(base).filter((f) => {
      const tail = f.slice(base ? base.length + 1 : 0);
      return tail === last || tail.startsWith(last + ".");
    });
  }
  // A directory listing is a compiler input like any other, and is recorded so
  // the input hash covers it. An untracked listing would let a change to a
  // directory's contents escape freshness detection.
  listDir(relDir) {
    let names;
    try {
      names = fs.readdirSync(this.abs(relDir), { withFileTypes: true })
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .sort();
    } catch {
      names = [];
    }
    this.listings.set(relDir, names);
    return names;
  }

  git(args) {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8" }).trim();
  }
  hasGit() {
    if (this.noGit) return false;
    try {
      const probe = execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: this.root,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return probe.toString().trim().length > 0;
    } catch {
      return false;
    }
  }
  // A checkout without git — a source tarball, a vendored copy, a CI runner with
  // no VCS — still compiles. Freshness then rests on the input hash alone, and
  // the graph records a null commit. A missing VCS is not a reason to refuse to
  // describe a repository.
  headCommit() {
    if (this.noGit || !this.hasGit()) return "0000000";
    try {
      return this.git(["rev-parse", "HEAD"]);
    } catch {
      return "0000000";
    }
  }
  // Git reports paths relative to the git toplevel, which may be above
  // this.root when the cataloged project sits inside a larger checkout — a
  // corpus fixture inside this repository, or a vendored sub-project. Anything
  // outside this.root is not a catalog input and must not mark it dirty;
  // anything inside must be re-keyed to the root-relative form the read
  // tracker uses.
  gitPrefix() {
    if (this.noGit || !this.hasGit()) return null;
    try {
      return this.git(["rev-parse", "--show-prefix"]);
    } catch {
      return null;
    }
  }
  toRepoPaths(gitPaths) {
    const prefix = this.gitPrefix();
    if (prefix === null) return [];
    const out = [];
    for (const p of gitPaths) {
      if (prefix && !p.startsWith(prefix) && p !== prefix.slice(0, -1)) continue;
      const rel = prefix ? p.slice(prefix.length) : p;
      if (rel) out.push(rel);
    }
    return out;
  }
  dirtyPaths() {
    if (this.noGit || !this.hasGit()) return [];
    let raw;
    try {
      raw = this.git(["status", "--porcelain", "-z", "--untracked-files=all"]);
    } catch {
      return [];
    }
    const paths = [];
    let skipNext = false;
    for (const rec of raw.split("\0")) {
      if (!rec) continue;
      // In -z format a rename/copy is two records: `XY <to>` then a bare
      // `<from>` with no status. The bare record must be consumed, not parsed
      // as a status line.
      if (skipNext) { skipNext = false; continue; }
      if (rec[0] === "R" || rec[0] === "C" || rec[1] === "R" || rec[1] === "C") skipNext = true;
      paths.push(rec.slice(3));
    }
    return this.toRepoPaths(paths);
  }
  diffPaths(fromRef) {
    if (this.noGit || !this.hasGit()) return [];
    try {
      return this.toRepoPaths(this.git(["diff", "--name-only", fromRef]).split("\n").filter(Boolean));
    } catch {
      return [];
    }
  }
}

// Minimal glob: '*' matches within one segment, '**' matches any depth.
export function globToRegExp(glob) {
  const segs = glob.split("/");
  let re = "^";
  segs.forEach((seg, i) => {
    if (seg === "**") {
      if (i > 0) re += "/";
      re += i === segs.length - 1 ? "(?:[^/]+/)*[^/]+" : "(?:[^/]+/)*";
      return;
    }
    if (i > 0 && segs[i - 1] !== "**") re += "/";
    re += seg
      .split("")
      .map((c) => {
        if (c === "*") return "[^/]*";
        if (c === "?") return "[^/]";
        return c.replace(/[.+^{$}()|[\]\\]/g, "\\$&");
      })
      .join("");
  });
  re += "$";
  return new RegExp(re);
}

export function assertGlob(g, ctx) {
  if (typeof g !== "string" || g.length === 0 || g.startsWith("/")) {
    throw new AgentDocError(CODES.GLOB, "glob must be repository-relative: " + g, { path: ctx });
  }
  if (g.split("/").includes("..")) {
    throw new AgentDocError(CODES.GLOB, "glob must not contain '..': " + g, { path: ctx });
  }
}

export function expandGlob(repo, glob) {
  assertGlob(glob);
  const re = globToRegExp(glob);
  const firstStar = glob.search(/[*?]/);
  const prefix = firstStar < 0 ? glob : glob.slice(0, firstStar);
  const baseDir = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
  return repo.walk(baseDir).filter((f) => re.test(f)).sort();
}

// Canonical input hash: version inputs first, then every input file as
// path+content records, then every existence probe and directory listing.
// Length-prefixed so no concatenation is ambiguous.
export function computeInputHash(repo, versionInputs) {
  const h = createHash("sha256");
  const feed = (buf) => {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(buf.length));
    h.update(len);
    h.update(buf);
  };
  for (const v of versionInputs) feed(Buffer.from(v, "utf8"));
  for (const p of [...repo.readPaths.keys()].sort()) {
    feed(Buffer.from("file:" + p, "utf8"));
    feed(repo.readBytesUntracked ? repo.readBytesUntracked(p) : repo.readBytes(p, { track: false }));
  }
  for (const [p, r] of [...repo.probes.entries()].sort()) {
    feed(Buffer.from("probe:" + p, "utf8"));
    feed(Buffer.from(r ? "1" : "0", "utf8"));
  }
  for (const [d, files] of [...repo.walks.entries()].sort()) {
    feed(Buffer.from("walk:" + d, "utf8"));
    feed(Buffer.from(files.join("\n"), "utf8"));
  }
  for (const [d, names] of [...repo.listings.entries()].sort()) {
    feed(Buffer.from("list:" + d, "utf8"));
    feed(Buffer.from(names.join("\n"), "utf8"));
  }
  return "sha256:" + h.digest("hex");
}
