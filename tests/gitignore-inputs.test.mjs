// Issue #45: the compiler's view of the repository — and therefore discovery
// and the input hash — must exclude paths git ignores. A local build that
// writes into a git-ignored directory (`astro build` → `.astro/`) must not
// change the inputHash, or a graph compiled after that build fails freshness
// in every clean checkout. Git is the oracle: these tests pin git's documented
// semantics (gitignore(5), git-status(1) `--ignored=matching`), not a
// re-implementation of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { baseFixture, compile, commitAll, cli, cliFails, git, graphOf, write, SYSTEM_ROOT } from "./helpers.mjs";
import { Repo } from "../core/fsx.mjs";

const BIN = path.join(SYSTEM_ROOT, "bin", "agentdoc.mjs");

// The issue's reproduction, transposed onto the test fixture: the graph is
// committed (as in lbframe/klozeo), generated files land in ignored
// directories next to the component, and nothing about the graph may move.
function astroFixture(t) {
  const dir = baseFixture(t);
  write(dir, ".gitignore", ".astro/\nbuild/\n*.log\n");
  commitAll(dir, "ignore build output");
  cli(dir, ["compile"]);
  commitAll(dir, "graph");
  return dir;
}

function simulateLocalBuild(dir) {
  // What `astro build` / `astro sync` writes, plus a generic build dir and a
  // log file — all git-ignored, all next to (or inside) walked unit paths.
  write(dir, "service/.astro/content.d.ts", "export {}\n");
  write(dir, "service/.astro/content-modules.mjs", "export default {}\n");
  write(dir, "service/src/.astro/types.d.ts", "export {}\n");
  write(dir, "service/build/index.js", "module.exports = {}\n");
  write(dir, "service/build/nested/deep.js", "module.exports = {}\n");
  write(dir, "service/src/debug.log", "noise\n");
  write(dir, "contracts/.astro/x.d.ts", "export {}\n");
  write(dir, "agentdoc/build/central.yaml", "not: an input\n");
}

test("#45: git-ignored build output does not change inputHash; check --strict still passes", (t) => {
  const dir = astroFixture(t);
  assert.equal(cliFails(dir, ["check", "--strict"]), null);
  // The graph a clean checkout of HEAD produces (the committed one records
  // the commit before it was itself committed).
  cli(dir, ["compile"]);
  const clean = readFileSync(path.join(dir, ".agentdoc/graph.json"));

  simulateLocalBuild(dir);
  assert.match(git(dir, ["status", "--short", "--ignored"]), /!! service\/\.astro\//);

  const r = compile(dir);
  assert.deepEqual(r.errors.map((e) => e.code), []);
  assert.equal(r.stats.inputHash, graphOf(dir).source.inputHash);
  assert.equal(r.stats.dirty, false);
  assert.equal(cliFails(dir, ["check", "--strict"]), null, "a graph compiled before the build stays fresh after it");

  // And a graph compiled *after* the build is byte-identical to the one
  // compiled before it — the graph a clean checkout reproduces.
  cli(dir, ["compile"]);
  assert.ok(readFileSync(path.join(dir, ".agentdoc/graph.json")).equals(clean), "recompiled graph is byte-identical");
});

test("#45: a non-ignored untracked input still changes inputHash (freshness is not weakened)", (t) => {
  const dir = astroFixture(t);
  const before = graphOf(dir).source.inputHash;
  simulateLocalBuild(dir);
  assert.equal(compile(dir).stats.inputHash, before);

  write(dir, "service/src/extra.ts", "export const EXTRA = 1;\n");
  const r = compile(dir);
  assert.notEqual(r.stats.inputHash, before, "a new untracked, non-ignored source file is an input");
  assert.equal(r.stats.dirty, true);
  assert.ok(cliFails(dir, ["check", "--strict"]), "check must reject the stale graph");
});

test("#45: a new untracked descriptor is an input; the same descriptor under an ignored dir is not", (t) => {
  const dir = astroFixture(t);
  const before = graphOf(dir).source.inputHash;
  // A complete second component: descriptor plus manifest.
  const descriptor = readFileSync(path.join(dir, "service/agentdoc.yaml"), "utf8")
    .replace("name: svc", "name: svc-extra")
    .replace(/  context:[\s\S]*/, "");
  const manifest = JSON.stringify({ name: "@t/extra", version: "1.0.0" });
  // `service/**/agentdoc.yaml` matches both locations; git ignores only build/.
  write(dir, "service/build/extra/agentdoc.yaml", descriptor);
  write(dir, "service/build/extra/package.json", manifest);
  const ignored = compile(dir);
  assert.deepEqual(ignored.errors.map((e) => e.code), []);
  assert.equal(ignored.stats.inputHash, before, "an ignored descriptor is not discovered");
  assert.equal(ignored.stats.components, 1);
  write(dir, "service/extra/agentdoc.yaml", descriptor);
  write(dir, "service/extra/package.json", manifest);
  const res = compile(dir);
  assert.deepEqual(res.errors.map((e) => e.code), []);
  assert.equal(res.stats.components, 2, "the new descriptor is discovered");
  const after = res.stats.inputHash;
  assert.match(String(after), /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(after, before, "a non-ignored descriptor is discovered and hashed");
});

test("#45: tracked files win over ignore patterns, exactly as in git", (t) => {
  const dir = astroFixture(t);
  write(dir, "service/build/tracked.ts", "export const T = 1;\n");
  git(dir, ["add", "-f", "service/build/tracked.ts"]);
  commitAll(dir, "force-track a file in an ignored dir");
  const tracked = compile(dir).stats.inputHash;

  // Untrack it: it is now ignored and must leave the input set, exactly as if
  // it had been deleted.
  git(dir, ["rm", "-q", "--cached", "service/build/tracked.ts"]);
  commitAll(dir, "untrack");
  const ignored = compile(dir).stats.inputHash;
  assert.notEqual(ignored, tracked, "a tracked file under an ignored dir is an input");
  rmSync(path.join(dir, "service/build"), { recursive: true, force: true });
  assert.equal(compile(dir).stats.inputHash, ignored, "an ignored untracked file is indistinguishable from an absent one");
});

// ── Repo-level semantics: reads, probes and listings ────────────────────
function gitRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-ignore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  return dir;
}

test("#45: Repo hides git-ignored paths from walk, listDir, exists, isDir and tracked reads", (t) => {
  const dir = gitRepo(t);
  write(dir, ".gitignore", "build/\n*.log\n!keep.log\n");
  write(dir, "app/src/a.ts", "a\n");
  write(dir, "app/build/out.js", "o\n");
  write(dir, "app/build/tracked.js", "t\n");
  write(dir, "app/x.log", "x\n");
  write(dir, "app/keep.log", "k\n");
  // Nested .gitignore with a negation that cannot re-include a file whose
  // parent directory is excluded (gitignore(5)).
  write(dir, "app/sub/.gitignore", "secret.txt\n!build/\n");
  write(dir, "app/sub/secret.txt", "s\n");
  write(dir, "app/sub/build/r.js", "r\n");
  write(dir, "app/sub/ok.txt", "ok\n");
  // $GIT_DIR/info/exclude
  write(dir, "local/notes.md", "n\n");
  write(dir, "local/kept.md", "k\n");
  appendFileSync(path.join(dir, ".git/info/exclude"), "local/notes.md\n");
  git(dir, ["add", ".gitignore", "app/src/a.ts", "app/sub/.gitignore"]);
  git(dir, ["add", "-f", "app/build/tracked.js"]);
  git(dir, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

  const repo = new Repo(dir);
  assert.deepEqual(repo.walk(""), [
    ".gitignore",
    "app/build/tracked.js",
    "app/keep.log",
    "app/src/a.ts",
    "app/sub/.gitignore",
    "app/sub/build/r.js",
    "app/sub/ok.txt",
    "local/kept.md",
  ]);
  assert.deepEqual(repo.walk("app/build"), ["app/build/tracked.js"]);
  assert.deepEqual(repo.listDir("app"), ["build/", "keep.log", "src/", "sub/"]);
  assert.deepEqual(repo.listDir("app/sub"), [".gitignore", "build/", "ok.txt"]);
  assert.equal(repo.exists("app/x.log"), false);
  assert.equal(repo.exists("app/build/out.js"), false);
  assert.equal(repo.exists("app/build/tracked.js"), true);
  assert.equal(repo.isDir("app/build"), true, "a dir holding a tracked file is visible");
  assert.equal(repo.exists("app/sub/secret.txt"), false);
  assert.equal(repo.exists("local/notes.md"), false);
  assert.throws(() => repo.readText("app/x.log"), (e) => e.code === "AGENTDOC_PATH_UNRESOLVED");
  assert.match(repo.readText("app/build/tracked.js"), /^t\n/);
  assert.equal(repo.probes.get("app/x.log"), false);

  // A directory that is wholly ignored disappears, including when probed or
  // walked directly.
  write(dir, "gen/.astro/a.d.ts", "a\n");
  appendFileSync(path.join(dir, ".gitignore"), ".astro/\n");
  const fresh = new Repo(dir);
  assert.equal(fresh.isDir("gen/.astro"), false);
  assert.deepEqual(fresh.walk("gen/.astro"), []);
  assert.deepEqual(fresh.walk("gen"), []);
  assert.deepEqual(fresh.listDir("gen"), []);
});

test("#45: a project nested inside a larger checkout uses root-relative ignore paths", (t) => {
  const outer = gitRepo(t);
  write(outer, ".gitignore", "*.log\n");
  write(outer, "projects/p/src/a.ts", "a\n");
  write(outer, "projects/p/src/a.log", "l\n");
  write(outer, "projects/p/.gitignore", "build/\n");
  write(outer, "projects/p/build/out.js", "o\n");
  commitAll(outer);
  const repo = new Repo(path.join(outer, "projects/p"));
  assert.deepEqual(repo.walk(""), [".gitignore", "src/a.ts"]);
});

test("#45: a project whose own root sits under an ignored directory is still compiled whole", (t) => {
  // The user pointed the compiler at this directory; an ignored ancestor
  // must not blank the repository.
  const outer = gitRepo(t);
  write(outer, ".gitignore", "scratch/\n");
  write(outer, "scratch/p/src/a.ts", "a\n");
  write(outer, "scratch/p/x.log", "l\n");
  commitAll(outer);
  const repo = new Repo(path.join(outer, "scratch/p"));
  assert.deepEqual(repo.walk(""), ["src/a.ts", "x.log"]);
});

test("#45: the user's global core.excludesFile counts, as it does for git status", (t) => {
  const dir = astroFixture(t);
  const before = graphOf(dir).source.inputHash;
  const globalCfg = path.join(dir, "..", path.basename(dir) + ".gitconfig");
  const globalIgnore = path.join(dir, "..", path.basename(dir) + ".ignore");
  t.after(() => { rmSync(globalCfg, { force: true }); rmSync(globalIgnore, { force: true }); });
  writeFileSync(globalIgnore, "*.swp\n");
  writeFileSync(globalCfg, "[core]\n\texcludesFile = " + globalIgnore + "\n");
  write(dir, "service/src/.index.ts.swp", "editor swap\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg };
  const out = execFileSync(process.execPath, [BIN, "compile"], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /graph:/);
  assert.equal(graphOf(dir).source.inputHash, before, "a globally ignored editor file is not an input");
  assert.equal(graphOf(dir).source.dirty, false);
});

test("#45: outside git (no repository, or no git binary) the previous behaviour holds", (t) => {
  const dir = astroFixture(t);
  const inGit = graphOf(dir).source.inputHash;
  rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const clean = compile(dir);
  assert.deepEqual(clean.errors.map((e) => e.code), []);
  assert.equal(clean.stats.commit, "0000000");
  // Without git the input set is everything except DEFAULT_GENERATED_DIRS.
  write(dir, "service/build/index.js", "module.exports = {}\n");
  assert.notEqual(compile(dir).stats.inputHash, clean.stats.inputHash, "no oracle: .gitignore is not interpreted");
  rmSync(path.join(dir, "service/build"), { recursive: true, force: true });
  write(dir, "service/dist/index.js", "module.exports = {}\n");
  assert.equal(compile(dir).stats.inputHash, clean.stats.inputHash, "generated dirs stay excluded");
  assert.ok(inGit);

  // No git binary on PATH: a git checkout degrades the same way, no crash.
  const withGit = astroFixture(t);
  const emptyBin = mkdtempSync(path.join(tmpdir(), "agentdoc-nogit-"));
  t.after(() => rmSync(emptyBin, { recursive: true, force: true }));
  mkdirSync(emptyBin, { recursive: true });
  const env = { ...process.env, PATH: emptyBin };
  execFileSync(process.execPath, [BIN, "compile"], { cwd: withGit, env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(graphOf(withGit).source.commit, "0000000");
});
