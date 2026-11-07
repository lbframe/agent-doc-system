// Issue #49: `scaffold --write` and `init` must write the documentation
// skeleton to the configured `docs.*` paths, never to a hard-coded `docs/`.
//
// `docs/` is very often the product's own user documentation. When a
// configuration declares where agent documentation lives, the generator obeys
// it, never clobbers an existing file without `--force`, and reports every path
// it wrote or skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cli, cliFails, commitAll, git, read, write } from "./helpers.mjs";

const CONFIG = "agentdoc/agentdoc.config.yaml";

const ISSUE_DOCS = [
  "docs:",
  "  product: agentdoc/docs/PRODUCT.md",
  "  architecture: agentdoc/docs/ARCHITECTURE.md",
  "  constraints: agentdoc/docs/CONSTRAINTS.md",
  "  adrDir: agentdoc/docs/adr",
  "",
].join("\n");

const CONFIGURED_SKELETON = [
  "agentdoc/docs/PRODUCT.md",
  "agentdoc/docs/ARCHITECTURE.md",
  "agentdoc/docs/CONSTRAINTS.md",
  "agentdoc/docs/adr/README.md",
];

const DEFAULT_SKELETON = ["docs/PRODUCT.md", "docs/ARCHITECTURE.md", "docs/CONSTRAINTS.md", "docs/adr/README.md"];

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freshRepo(t, files = {}) {
  const dir = tmp(t, "agentdoc-docs-paths-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  commitAll(dir);
  return dir;
}

// Replace the generated `docs:` block (always the last section init writes).
function withDocs(configText, docsBlock) {
  const at = configText.indexOf("\ndocs:\n");
  assert.ok(at >= 0, "generated configuration has a docs section");
  return configText.slice(0, at + 1) + docsBlock;
}

// The issue's starting point: a committed configuration that declares
// agentdoc/docs/*, in a clean checkout whose docs/ is the product's own. The
// configuration is produced by `init` itself so it matches what users have.
function configuredRepo(t, docsBlock = ISSUE_DOCS) {
  const dir = freshRepo(t, {
    "app/go.mod": "module example.com/app\ngo 1.22\n",
    "app/cmd/app/main.go": "package main\nfunc main() {}\n",
    "docs/guide.md": "# User guide\n\nThe product's own documentation.\n",
  });
  const scratch = tmp(t, "agentdoc-docs-paths-init-");
  fs.cpSync(path.join(dir, "app"), path.join(scratch, "app"), { recursive: true });
  cli(scratch, ["init"]);
  write(dir, CONFIG, withDocs(read(scratch, CONFIG), docsBlock));
  for (const f of ["journeys.yaml", "domains.yaml", "systems.yaml", "apis.yaml", "resources.yaml", "observations/README.md"]) {
    fs.mkdirSync(path.dirname(path.join(dir, "agentdoc", f)), { recursive: true });
    fs.copyFileSync(path.join(scratch, "agentdoc", f), path.join(dir, "agentdoc", f));
  }
  write(dir, ".gitignore", "/.agentdoc/\n");
  commitAll(dir, "configure agentdoc");
  return dir;
}

function statusUnder(dir, rel) {
  return git(dir, ["status", "--porcelain", "--untracked-files=all", "--", rel]).trim();
}

function choosePlacements(dir, files) {
  for (const f of files) write(dir, f, read(dir, f).replace("  # placementRationale:", "  placementRationale:"));
}

test("#49 scaffold --write writes the skeleton to the configured docs paths and leaves docs/ untouched", (t) => {
  const dir = configuredRepo(t);
  const dry = JSON.parse(cli(dir, ["scaffold"]));
  const proposed = dry.written.map((f) => f.replace(/ \(dry run\)$/, ""));
  for (const f of CONFIGURED_SKELETON) assert.ok(proposed.includes(f), "dry run proposes " + f + ": " + proposed.join(","));
  assert.ok(!proposed.some((f) => f.startsWith("docs/")), "dry run proposes nothing under docs/: " + proposed.join(","));

  const res = JSON.parse(cli(dir, ["scaffold", "--write"]));
  assert.deepEqual(res.written, proposed, "dry run and --write must agree");
  for (const f of CONFIGURED_SKELETON) assert.ok(fs.existsSync(path.join(dir, f)), f + " was written");
  assert.equal(statusUnder(dir, "docs"), "", "git status must show nothing under docs/");
  assert.ok(res.skipped.includes(CONFIG), "the existing configuration is reported as skipped");
  assert.equal(read(dir, "agentdoc/docs/PRODUCT.md"), fs.readFileSync(new URL("../templates/PRODUCT.md", import.meta.url), "utf8"));

  // The scaffolded repository is a working catalog.
  choosePlacements(dir, ["app/agentdoc.yaml"]);
  assert.match(cli(dir, ["validate"]), /validate: PASS/);
  assert.match(cli(dir, ["compile"]), /compile: PASS/);
  assert.match(cli(dir, ["check"]), /PASS/);
  // Audit, scaffold and compile read the same configured locations.
  const audit = JSON.parse(cli(dir, ["audit"]));
  const hierarchy = audit.documentation.hierarchy.map((h) => h.path);
  for (const f of CONFIGURED_SKELETON) assert.ok(hierarchy.includes(f), "audit sees " + f + ": " + hierarchy.join(","));
  assert.equal(statusUnder(dir, "docs"), "");
});

test("#49 scaffold --write skips existing files at the configured paths and reports them", (t) => {
  const dir = configuredRepo(t);
  write(dir, "agentdoc/docs/PRODUCT.md", "# Our product\n\nReviewed text.\n");
  write(dir, "agentdoc/docs/adr/README.md", "# Our ADRs\n");
  const res = JSON.parse(cli(dir, ["scaffold", "--write"]));
  assert.ok(res.skipped.includes("agentdoc/docs/PRODUCT.md"), res.skipped.join(","));
  assert.ok(res.skipped.includes("agentdoc/docs/adr/README.md"), res.skipped.join(","));
  assert.ok(!res.written.includes("agentdoc/docs/PRODUCT.md"));
  assert.ok(res.written.includes("agentdoc/docs/ARCHITECTURE.md"), res.written.join(","));
  assert.equal(read(dir, "agentdoc/docs/PRODUCT.md"), "# Our product\n\nReviewed text.\n\n");
  assert.equal(read(dir, "agentdoc/docs/adr/README.md"), "# Our ADRs\n\n");
  assert.equal(statusUnder(dir, "docs"), "");
});

test("#49 init honours an existing configuration's docs paths", (t) => {
  const dir = configuredRepo(t);
  const res = JSON.parse(cli(dir, ["init"]));
  for (const f of CONFIGURED_SKELETON) assert.ok(res.written.includes(f), "init wrote " + f + ": " + res.written.join(","));
  assert.ok(res.skipped.includes(CONFIG));
  assert.ok(!res.written.some((f) => f.startsWith("docs/")), res.written.join(","));
  assert.equal(statusUnder(dir, "docs"), "", "git status must show nothing under docs/");

  // A second init clobbers nothing.
  write(dir, "agentdoc/docs/PRODUCT.md", "# Our product\n");
  const again = JSON.parse(cli(dir, ["init"]));
  assert.deepEqual(again.written, []);
  for (const f of CONFIGURED_SKELETON) assert.ok(again.skipped.includes(f), f + " skipped: " + again.skipped.join(","));
  assert.equal(read(dir, "agentdoc/docs/PRODUCT.md"), "# Our product\n\n");
});

test("#49 init --force overwrites at the configured paths and keeps them in the regenerated configuration", (t) => {
  const dir = configuredRepo(t);
  write(dir, "agentdoc/docs/PRODUCT.md", "# Our product\n");
  const res = JSON.parse(cli(dir, ["init", "--force"]));
  assert.ok(res.written.includes("agentdoc/docs/PRODUCT.md"), res.written.join(","));
  assert.equal(read(dir, "agentdoc/docs/PRODUCT.md"), fs.readFileSync(new URL("../templates/PRODUCT.md", import.meta.url), "utf8"));
  assert.equal(statusUnder(dir, "docs"), "");
  const cfg = read(dir, CONFIG);
  assert.match(cfg, /^ {2}product: agentdoc\/docs\/PRODUCT\.md$/m);
  assert.match(cfg, /^ {2}adrDir: agentdoc\/docs\/adr$/m);
  assert.doesNotMatch(cfg, /^ {2}\w+: docs\//m, "regenerated configuration must not move docs back to docs/");
});

test("#49 a configuration without a docs role writes nothing for it and says so", (t) => {
  const dir = configuredRepo(t, "docs:\n  product: agentdoc/docs/PRODUCT.md\n");
  const res = JSON.parse(cli(dir, ["scaffold", "--write"]));
  assert.ok(res.written.includes("agentdoc/docs/PRODUCT.md"), res.written.join(","));
  assert.ok(!res.written.some((f) => f.startsWith("docs/") || /ARCHITECTURE|CONSTRAINTS|adr\//.test(f)), res.written.join(","));
  assert.deepEqual(res.notConfigured, ["docs.architecture", "docs.constraints", "docs.adrDir"]);
  assert.equal(statusUnder(dir, "docs"), "");
});

test("#49 runbookDir is honoured: no skeleton is invented for it and nothing lands in docs/", (t) => {
  const dir = configuredRepo(t, ISSUE_DOCS + "  runbookDir: agentdoc/docs/runbooks\n");
  const res = JSON.parse(cli(dir, ["scaffold", "--write"]));
  for (const f of CONFIGURED_SKELETON) assert.ok(res.written.includes(f), res.written.join(","));
  assert.equal(statusUnder(dir, "docs"), "");
});

test("#49 without a configuration, init keeps today's docs/ defaults", (t) => {
  const dir = tmp(t, "agentdoc-docs-default-");
  const res = JSON.parse(cli(dir, ["init"]));
  for (const f of DEFAULT_SKELETON) assert.ok(res.written.includes(f), "default " + f + ": " + res.written.join(","));
  const cfg = read(dir, CONFIG);
  assert.match(cfg, /\ndocs:\n {2}product: docs\/PRODUCT\.md\n {2}architecture: docs\/ARCHITECTURE\.md\n {2}constraints: docs\/CONSTRAINTS\.md\n {2}adrDir: docs\/adr\n/);
  assert.equal(res.notConfigured, undefined);
});

for (const [label, bad] of [
  ["a '..' segment", "../outside/adr"],
  ["an absolute path", "/tmp/agentdoc-escape/adr"],
]) {
  test("#49 a configured docs path with " + label + " is rejected by scaffold and init, writing nothing", (t) => {
    const dir = configuredRepo(t, ISSUE_DOCS.replace("adrDir: agentdoc/docs/adr", "adrDir: " + bad));
    const before = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
    for (const args of [["scaffold", "--write"], ["init"], ["init", "--force"]]) {
      const res = cliFails(dir, args);
      assert.ok(res, args.join(" ") + " must fail on an invalid docs path");
      assert.equal(res.status, 1);
      assert.match(res.stdout + res.stderr, /PATH_ESCAPE/, args.join(" ") + ": " + res.stdout + res.stderr);
      assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=all"]), before, args.join(" ") + " wrote nothing");
    }
    assert.equal(fs.existsSync(path.resolve(dir, "..", "outside")), false);
  });
}

test("#49 a configured docs path that escapes through a symlink is refused", (t) => {
  const dir = configuredRepo(t);
  const outside = tmp(t, "agentdoc-docs-outside-");
  fs.symlinkSync(outside, path.join(dir, "agentdoc", "docs"));
  for (const args of [["scaffold", "--write"], ["init"]]) {
    const res = cliFails(dir, args);
    assert.ok(res, args.join(" ") + " must refuse to write through a symlink out of the repository");
    assert.match(res.stdout + res.stderr, /PATH_ESCAPE/, res.stdout + res.stderr);
    assert.deepEqual(fs.readdirSync(outside), [], args.join(" ") + " wrote outside the repository");
  }
});
