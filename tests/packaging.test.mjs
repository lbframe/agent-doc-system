// Packaging and distribution regression tests.
//
// These guard the boundary that matters for the installed CLI: the package
// must be self-contained, must not leak development files, must not vendor the
// implementation into a project, and user-facing docs must never describe the
// source tree as the install mechanism.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cli, git, SYSTEM_ROOT, write } from "./helpers.mjs";
import { Repo } from "../core/fsx.mjs";

const readText = (rel) => fs.readFileSync(path.join(SYSTEM_ROOT, rel), "utf8");

function walk(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + "/" + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function npmAvailable() {
  try {
    execFileSync("npm", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

// Directories that are the *implementation* of agentdoc. A project uses the
// CLI by having it installed; none of these may ever appear inside a project's
// `agentdoc/` data directory.
const IMPLEMENTATION_DIRS = ["core", "bin", "adapters", "schemas", "templates", "tests", "evals", "scripts"];

test("packaging: init writes project data only, never the CLI implementation", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-init-only-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = JSON.parse(cli(dir, ["init"]));
  assert.ok(out.written.includes("agentdoc/agentdoc.config.yaml"));
  for (const d of IMPLEMENTATION_DIRS) {
    assert.ok(!fs.existsSync(path.join(dir, "agentdoc", d)), "init must not create agentdoc/" + d);
    assert.ok(!fs.existsSync(path.join(dir, d)), "init must not create " + d);
  }
  // Project state is agentdoc/ data + docs + a CI workflow — nothing else.
  const created = walk(dir);
  for (const rel of created) {
    assert.ok(
      rel.startsWith("agentdoc/") || rel.startsWith("docs/") || rel.startsWith(".github/"),
      "init created unexpected path: " + rel
    );
  }
});

test("packaging: no shipped doc or template invokes the CLI by source path", () => {
  // `node <path>/agentdoc.mjs` and `agentdoc/bin/...` are the vendoring model
  // this repository replaced. The shipped surface must only ever say `agentdoc`.
  // Scanned: user-facing docs, the skill, project templates and the corpora.
  // package.json is deliberately out of scope: its bin mapping and dev scripts
  // legitimately name the implementation file.
  const scan = [];
  for (const base of ["docs", "skills", "templates", "fixtures", "examples"]) {
    const abs = path.join(SYSTEM_ROOT, base);
    if (fs.existsSync(abs)) scan.push(...walk(abs).map((r) => base + "/" + r));
  }
  scan.push("README.md", "INSTALL_FOR_AGENTS.md");
  const offenders = [];
  for (const rel of scan) {
    const text = readText(rel);
    // .agentdoc/graph.json inside fixtures legitimately contains the string in
    // recorded verification commands only if the fixture itself uses the old
    // model — it must not either.
    if (/node\s+\S*agentdoc\.mjs|agentdoc\/bin\//.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "files still invoking the CLI by source path: " + offenders.join(", "));
});

test("packaging: README never describes vendoring the source tree", () => {
  const readme = readText("README.md");
  assert.ok(!/drop this directory/i.test(readme));
  assert.ok(!/copy (this|the) (directory|repo|repository) into/i.test(readme));
});

test("packaging: no Node 18 references remain in shipped material", () => {
  const scan = walk(path.join(SYSTEM_ROOT, "docs")).map((r) => "docs/" + r)
    .concat(walk(path.join(SYSTEM_ROOT, "skills")).map((r) => "skills/" + r))
    .concat(["README.md", "INSTALL_FOR_AGENTS.md", "package.json"]);
  for (const rel of scan) {
    const text = readText(rel);
    assert.ok(!/node(?:\.js)?\s*18|\b18\b.*lts|>=\s*18/i.test(text), rel + " still references Node 18");
  }
  const pkg = JSON.parse(readText("package.json"));
  assert.match(pkg.engines.node, /22/);
  assert.ok(!/18|20/.test(pkg.engines.node), "engines.node must require Node 22+: " + pkg.engines.node);
});

test("packaging: skill teaches an installed CLI, with required structure", () => {
  const skill = readText("skills/agent-doc-system/SKILL.md");
  assert.match(skill, /^---\nname: agent-doc-system\ndescription: /);
  assert.ok(skill.includes("agentdoc --version"), "skill must verify the installed CLI");
  for (const ref of ["cli.md", "create-migrate.md", "authority-and-conflicts.md", "maintenance.md"]) {
    assert.ok(fs.existsSync(path.join(SYSTEM_ROOT, "skills/agent-doc-system/references", ref)), "missing skill reference " + ref);
  }
  assert.ok(!fs.existsSync(path.join(SYSTEM_ROOT, "SKILL.md")), "root SKILL.md must not exist");
});

test("packaging: a catalog nested inside a larger checkout tracks only its own tree", (t) => {
  // The project boundary is Repo.root, not the git toplevel. A cataloged
  // sub-directory without its own .git must not go dirty when an unrelated
  // file elsewhere in the enclosing checkout changes — and must go dirty when
  // its own inputs do.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-nested-"));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  git(outer, ["init", "-q", "-b", "main"]);
  git(outer, ["config", "user.name", "Test"]);
  git(outer, ["config", "user.email", "test@example.invalid"]);
  write(outer, "nested/app/package.json", JSON.stringify({ name: "nested-app" }));
  write(outer, "elsewhere/readme.txt", "unrelated to the catalog\n");
  git(outer, ["add", "-A"]);
  git(outer, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "init"]);

  const repo = new Repo(path.join(outer, "nested"));
  write(outer, "elsewhere/changed.txt", "outer change\n");
  assert.deepEqual(repo.dirtyPaths(), [], "outer-repo churn must not dirty the nested project");
  write(outer, "nested/app/new.ts", "export {};\n");
  assert.deepEqual(repo.dirtyPaths(), ["app/new.ts"]);

  // diffPaths — the input to `agentdoc impact --diff` — is relativized the
  // same way: outer-repo changes are out of scope.
  write(outer, "nested/app/package.json", JSON.stringify({ name: "nested-app", version: "2.0.0" }));
  write(outer, "elsewhere/readme.txt", "changed outside the project\n");
  assert.deepEqual(repo.diffPaths("HEAD"), ["app/package.json"]);
});

test("packaging: npm pack produces a self-contained installable CLI", (t) => {
  if (!npmAvailable()) { t.skip("npm is not available"); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-pack-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const packOut = execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: SYSTEM_ROOT, encoding: "utf8" });
  const tarball = path.join(tmp, packOut.trim().split("\n").pop());
  assert.ok(fs.existsSync(tarball), "npm pack produced no tarball");

  // Inspect the archive: runtime dirs present, dev-only dirs absent.
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  const files = new Set(listing.split("\n").map((l) => l.replace(/^package\//, "")));
  for (const need of ["bin/agentdoc.mjs", "bin/usage.txt", "package.json"]) {
    assert.ok(files.has(need), "package is missing " + need);
  }
  assert.ok([...files].some((f) => f.startsWith("schemas/")), "no schemas in package");
  assert.ok([...files].some((f) => f.startsWith("templates/")), "no templates in package");
  assert.ok([...files].some((f) => f.startsWith("adapters/")), "no adapters in package");
  assert.ok([...files].some((f) => f.startsWith("skills/agent-doc-system/")), "skill not packaged");
  for (const bad of ["tests/", "fixtures/", "examples/", "scripts/", ".github/"]) {
    assert.ok(![...files].some((f) => f.startsWith(bad)), "dev-only path shipped: " + bad);
  }

  // Install into a clean prefix with no access to the source checkout.
  const prefix = path.join(tmp, "prefix");
  const project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  execFileSync("npm", ["install", "-g", tarball, "--prefix", prefix], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const bin = path.join(prefix, "bin", "agentdoc");
  assert.ok(fs.existsSync(bin), "installed package has no agentdoc binary");

  const run = (args, cwd = project) =>
    execFileSync(bin, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.match(run(["--version"]), /^agentdoc \d+\.\d+\.\d+/);
  assert.match(run(["--help"]), /agentdoc --version/);
  const doctor = JSON.parse(run(["doctor"]));
  assert.equal(doctor.scope, "machine");
  assert.equal(doctor.ok, true);

  // Representative commands against a throwaway project, with no source
  // checkout reachable.
  const init = JSON.parse(run(["init"]));
  assert.ok(init.written.includes("agentdoc/agentdoc.config.yaml"));
  const doctorProject = JSON.parse(run(["doctor", "--project"]));
  assert.equal(doctorProject.project.configurationFound, true);
  const audit = JSON.parse(run(["audit"]));
  assert.ok("inventory" in audit || "compileErrors" in audit, "audit produced no report");
  // `eval` is shipped and must degrade to a clean SKIP on a repository with no
  // registered scenarios — never a missing-module crash.
  const evalReport = JSON.parse(run(["eval", "routing", "--json"]));
  assert.equal(evalReport.verdict, "SKIP");
});

test("packaging: every shipped source file is greppable text (no NUL bytes)", () => {
  // A literal NUL inside a JS string literal is legal but makes the file
  // binary to ripgrep, git diff and GitHub's renderer — an invisible source
  // file in a public package. The convention is the \u0000 escape.
  const offenders = [];
  for (const dir of ["bin", "core", "adapters", "evals", "tests"]) {
    for (const f of walk(path.join(SYSTEM_ROOT, dir), dir + "/")) {
      if (!f.endsWith(".mjs")) continue;
      if (fs.readFileSync(path.join(SYSTEM_ROOT, f)).includes(0x00)) offenders.push(f);
    }
  }
  assert.deepEqual(offenders, []);
});
