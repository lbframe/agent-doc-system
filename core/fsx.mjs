// Repository access bound to the checkout root.
//
// Every byte the compiler reads flows through the read-path tracker, and every
// existence probe and directory listing is recorded. The complete input record
// is what the graph's inputHash is computed over, so freshness detection can
// never miss an input. This is the single most important property of the
// original system and is preserved verbatim.
//
// The input set is the checkout as git sees it: paths git ignores are not part
// of the repository (issue #45). A local build writing into an ignored
// directory — `astro build` filling `.astro/`, a `build/` tree, a `*.log` —
// must not move the inputHash, or a graph compiled after that build can never
// be reproduced by a clean checkout or by CI. Git itself is the oracle (see
// `ignoredPaths`); nothing here re-implements gitignore matching. Every read,
// probe and listing below consults the same oracle, and `check` recomputes the
// hash by running the same compile, so compile and check cannot disagree.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgentDocError, CODES } from "./codes.mjs";
import { canonicalPath, ownsPath, REPO_ROOT } from "./paths.mjs";

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
// This list applies everywhere, and is the *only* exclusion when there is no
// git oracle (no repository, no git binary, or `noGit`). Inside a git
// checkout, git-ignored paths are excluded in addition — see `ignoredPaths`.
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
    this.nestedUnitRoots = new Map();
    this.generatedDirs = new Set(opts.generatedDirs || DEFAULT_GENERATED_DIRS);
    this.noGit = Boolean(opts.noGit);
    // Per-Repo git caches. undefined = not asked yet; null = no answer.
    this._hasGit = undefined;
    this._prefix = undefined;
    this._status = undefined;
    this._ignored = undefined;
  }
  abs(rel) {
    const a = path.resolve(this.root, rel);
    if (a !== this.root && !a.startsWith(this.root + path.sep)) {
      throw new AgentDocError(CODES.PATH_ESCAPE, "path escapes repository: " + rel, { path: rel });
    }
    return a;
  }
  // The paths git ignores under this.root, asked once per Repo and cached, so
  // every read, probe and listing in a run sees the same snapshot.
  //
  // `git status --ignored=matching` is the oracle (git-status(1)): it reports
  // exactly the untracked paths that match an ignore pattern, and an ignored
  // directory as one `dir/` entry without its contents. That gives git's own
  // semantics for free:
  //   - tracked files are never reported, so a tracked file that matches a
  //     pattern stays an input ("tracked always wins", gitignore(5));
  //   - nested .gitignore files, $GIT_DIR/info/exclude and core.excludesFile
  //     apply with gitignore(5) precedence, negations included, and a file
  //     whose parent directory is excluded cannot be re-included;
  //   - a directory that is not itself ignored is never collapsed, only its
  //     ignored contents are listed. (`git ls-files -o -i --directory` gets
  //     this wrong: it also prints a non-ignored parent whose only content is
  //     ignored, and aborts when run from inside an ignored directory.)
  //
  // The user's global core.excludesFile deliberately counts. An ignored
  // untracked file is, by definition, absent from every clean checkout, so
  // whichever ignore source matched it, dropping it moves this machine's input
  // set *towards* what CI sees, never away from it — no ignore rule can hide a
  // tracked file. Ignoring core.excludesFile would bring back issue #45 for
  // anything a developer ignores globally (editor swap files, `.envrc`): the
  // file would enter the hash while `git status`, and therefore the graph's
  // `dirty` flag, stays silent about it.
  //
  // The snapshot comes from `statusRecords`, the same single `git status`
  // call the compile's dirty check reads, so the input set and the `dirty`
  // flag describe the same moment. Paths come back relative to the git
  // toplevel and are re-keyed by `toRepoPaths`; an ignored *ancestor* of
  // this.root is dropped there, so a project the user pointed the compiler at
  // is never blanked out by an outer .gitignore.
  //
  // null when there is no oracle — `noGit`, not a git checkout, git missing
  // or failing. The input set is then the filesystem minus generatedDirs,
  // exactly as before #45.
  ignoredPaths() {
    if (this._ignored !== undefined) return this._ignored;
    const recs = this.statusRecords();
    const prefix = recs ? this.gitPrefix() : null;
    this._ignored = recs && prefix !== null
      ? new Set(this.toRepoPaths(recs.filter((r) => r.xy === "!!").map((r) => r.path), prefix))
      : null;
    return this._ignored;
  }
  // True when git ignores `rel` or one of its parent directories. Directory
  // entries carry a trailing "/" in git's output.
  isIgnored(rel) {
    const set = this.ignoredPaths();
    if (!set || set.size === 0 || !rel || rel === ".") return false;
    if (set.has(rel) || set.has(rel + "/")) return true;
    for (let i = rel.indexOf("/"); i >= 0; i = rel.indexOf("/", i + 1)) {
      if (set.has(rel.slice(0, i + 1))) return true;
    }
    return false;
  }
  // An ignored path is probed as absent: that is what a clean checkout sees.
  exists(rel) {
    const r = !this.isIgnored(rel) && fs.existsSync(this.abs(rel));
    this.probes.set(rel, r);
    return r;
  }
  isDir(rel) {
    try {
      const r = !this.isIgnored(rel) && fs.statSync(this.abs(rel)).isDirectory();
      this.probes.set(rel, r);
      return r;
    } catch {
      this.probes.set(rel, false);
      return false;
    }
  }
  readBytes(rel, { track = true } = {}) {
    const a = this.abs(rel);
    // A tracked (input) read of an ignored path fails exactly as a read of a
    // missing file does, so a descriptor that points into build output breaks
    // locally the same way it breaks in CI. Untracked reads are not inputs.
    if (track && this.isIgnored(rel)) {
      throw new AgentDocError(
        CODES.PATH_UNRESOLVED,
        "path is ignored by git, so it is not a repository input: " + rel,
        { path: rel }
      );
    }
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
  // Ignored directories are pruned, not descended: an ignored `node_modules`
  // or `.astro` costs one Set lookup.
  walk(relDir, { exclude = () => false } = {}) {
    const base = relDir ? this.abs(relDir) : this.root;
    const out = [];
    const ignored = this.ignoredPaths();
    const stack = relDir && this.isIgnored(relDir) ? [] : [base];
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
        // Parents are already known not to be ignored, so the entry itself is
        // the only lookup needed.
        if (ignored && ignored.has(ent.isDirectory() ? rel + "/" : rel)) continue;
        if (exclude(rel, ent)) continue;
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile()) out.push(rel);
      }
    }
    out.sort();
    this.walks.set(relDir || ".", out);
    return out;
  }
  // Per-unit scans use the discovery result, never filesystem heuristics.
  // Keep walk() repository-wide for discovery, contracts and authored inputs.
  ownsUnitPath(unitRoot, rel) {
    if (!ownsPath(unitRoot, rel)) return false;
    // nestedUnitRoots is keyed with the root spelled "" (see discoverUnits).
    const root = canonicalPath(unitRoot);
    for (const child of this.nestedUnitRoots.get(root === REPO_ROOT ? "" : root) || []) {
      if (ownsPath(child, rel)) return false;
    }
    return true;
  }
  walkUnit(unitRoot, relDir = unitRoot, { exclude = () => false } = {}) {
    if (!this.ownsUnitPath(unitRoot, relDir)) return [];
    return this.walk(relDir, { exclude: (rel, ent) => !this.ownsUnitPath(unitRoot, rel) || exclude(rel, ent) });
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
  // Ignored entries are left out, as if absent.
  listDir(relDir) {
    let names;
    try {
      const prefix = relDir && relDir !== "." ? relDir + "/" : "";
      names = this.isIgnored(relDir)
        ? []
        : fs.readdirSync(this.abs(relDir), { withFileTypes: true })
          .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
          .filter((n) => !this.isIgnored(prefix + n.replace(/\/$/, "")))
          .sort();
    } catch {
      names = [];
    }
    this.listings.set(relDir, names);
    return names;
  }

  git(args, { trim = true } = {}) {
    // stderr must be piped, not inherited: every caller treats a non-zero exit
    // as a signal to degrade (unborn HEAD, detached worktree, missing remote),
    // and execFileSync would otherwise print git's own "fatal:" line to the
    // user's terminal while the command reports success.
    const out = execFileSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return trim ? out.trim() : out;
  }
  // Cached per Repo, like gitPrefix: whether this.root is a git checkout does
  // not change during a run, and each probe is a process spawn.
  hasGit() {
    if (this.noGit) return false;
    if (this._hasGit !== undefined) return this._hasGit;
    try {
      const probe = execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: this.root,
        stdio: ["ignore", "pipe", "ignore"],
      });
      this._hasGit = probe.toString().trim().length > 0;
    } catch {
      this._hasGit = false;
    }
    return this._hasGit;
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
    if (this._prefix !== undefined) return this._prefix;
    try {
      this._prefix = this.git(["rev-parse", "--show-prefix"]);
    } catch {
      this._prefix = null;
    }
    return this._prefix;
  }
  toRepoPaths(gitPaths, prefix = this.gitPrefix()) {
    if (prefix === null) return [];
    const out = [];
    for (const p of gitPaths) {
      if (prefix && !p.startsWith(prefix) && p !== prefix.slice(0, -1)) continue;
      const rel = prefix ? p.slice(prefix.length) : p;
      if (rel) out.push(rel);
    }
    return out;
  }
  // One `git status` for both questions a compile asks git about the
  // working tree: what is dirty (`XY` records) and what is ignored (`!!`).
  // `--untracked-files=all` lists untracked files individually, so they can
  // be matched against the read tracker; `--ignored=matching` adds the
  // ignored paths without descending into ignored directories.
  // `--no-optional-locks` keeps it read-only: no refreshed index is written
  // back, so it never contends with a git command the user is running.
  // `-- .` scopes the scan to this.root, which may sit inside a larger
  // checkout. Cached unless `fresh`: the ignore oracle must answer from one
  // snapshot for the whole run.
  statusRecords({ fresh = false } = {}) {
    if (!fresh && this._status !== undefined) return this._status;
    let recs = null;
    if (!this.noGit && this.hasGit()) {
      try {
        // Untrimmed: a porcelain record is `XY <path>` with fixed columns, and
        // an unstaged change has X = " ". Trimming would eat that space from
        // the first record, so `.slice(3)` would drop the path's first
        // character — ` M .agentdoc/graph.json` became `agentdoc/graph.json`,
        // slipped past the output exclusion and counted as a dirty input
        // (issue #11).
        recs = parseStatusZ(this.git(
          ["--no-optional-locks", "status", "--porcelain", "-z",
            "--untracked-files=all", "--ignored=matching", "--", "."],
          { trim: false }
        ));
      } catch {
        recs = null;
      }
    }
    if (!fresh) this._status = recs;
    return recs;
  }
  // Fresh by default, so a caller holding a Repo sees the current tree. The
  // compile passes `snapshot: true` to read the same status the ignore oracle
  // used — one git call, and a dirty flag consistent with the input set.
  dirtyPaths({ snapshot = false } = {}) {
    const recs = this.statusRecords({ fresh: !snapshot });
    if (!recs) return [];
    return this.toRepoPaths(recs.filter((r) => r.xy !== "!!").map((r) => r.path));
  }
  // null on failure (bad ref, missing object store) so callers can tell
  // "the diff failed" apart from "the diff is empty".
  diffPaths(fromRef) {
    if (this.noGit || !this.hasGit()) return null;
    try {
      return this.toRepoPaths(this.git(["diff", "--name-only", fromRef]).split("\n").filter(Boolean));
    } catch {
      return null;
    }
  }
}

// `git status --porcelain -z` records (git-status(1), "Porcelain Format
// Version 1"): `XY <path>`, NUL-terminated, never quoted.
function parseStatusZ(raw) {
  const out = [];
  let skipNext = false;
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    // In -z format a rename/copy is two records: `XY <to>` then a bare
    // `<from>` with no status. The bare record must be consumed, not parsed
    // as a status line.
    if (skipNext) { skipNext = false; continue; }
    if (rec[0] === "R" || rec[0] === "C" || rec[1] === "R" || rec[1] === "C") skipNext = true;
    out.push({ xy: rec.slice(0, 2), path: rec.slice(3) });
  }
  return out;
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
