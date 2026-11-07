// Supply-chain hardening of this repository's own GitHub Actions workflows
// (#54): every workflow in .github/workflows/ pins each external action or
// reusable workflow to a full commit SHA with a version comment, and every
// actions/checkout step sets `persist-credentials: false`. These match
// zizmor's `unpinned-uses` and `artipacked` audits and OpenSSF Scorecard's
// Pinned-Dependencies check. No YAML library: a small line-based scan that is
// enough for the workflows we write, with unit tests for its edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SYSTEM_ROOT } from "./helpers.mjs";

const WORKFLOWS = path.join(SYSTEM_ROOT, ".github/workflows");

const indentOf = (line) => line.length - line.trimStart().length;
const stripComment = (line) => line.replace(/(^|\s)#.*$/, "");

/** Every `uses:` in a workflow, step-level or job-level, with its line. */
function usesRefs(text) {
  const refs = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*(["']?)([^\s"'#]+)\1\s*(#.*)?$/.exec(line);
    if (m) refs.push({ line: i + 1, ref: m[2], comment: (m[3] ?? "").trim() });
  });
  return refs;
}

/** Problems with the pinning of every `uses:`; empty when all are pinned. */
function pinningProblems(text) {
  const problems = [];
  for (const { line, ref, comment } of usesRefs(text)) {
    if (ref.startsWith("./")) continue; // a local action or workflow in this repository
    if (ref.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref)) problems.push(`line ${line}: ${ref} is not pinned to an image digest`);
      continue;
    }
    if (!/^[^@\s]+@[0-9a-f]{40}$/.test(ref)) {
      problems.push(`line ${line}: ${ref} is not pinned to a full commit SHA`);
    } else if (!/^# v\d+(\.\d+)*\b/.test(comment)) {
      problems.push(`line ${line}: ${ref} has no "# vX.Y.Z" version comment`);
    }
  }
  return problems;
}

/**
 * The text of each list item (`- ...`) whose own keys include
 * `uses: actions/checkout@...`, i.e. each checkout step.
 */
function checkoutSteps(text) {
  const lines = text.split("\n");
  const steps = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)-\s+/.exec(line);
    if (!m) return;
    const dash = m[1].length;
    const keyIndent = m[0].length;
    const body = [{ line: line.slice(keyIndent), indent: keyIndent }];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (indentOf(lines[j]) <= dash) break;
      body.push({ line: lines[j].trimStart(), indent: indentOf(lines[j]) });
    }
    const ownKeys = body.filter((b) => b.indent === keyIndent).map((b) => stripComment(b.line));
    if (ownKeys.some((k) => /^uses:\s*["']?actions\/checkout@/.test(k))) {
      steps.push({ line: i + 1, text: body.map((b) => stripComment(b.line)).join("\n") });
    }
  });
  return steps;
}

/** Checkout steps that leave the token in .git/config (zizmor `artipacked`). */
function credentialProblems(text) {
  return checkoutSteps(text)
    .filter((s) => !/(^|[\s{,])persist-credentials:\s*false\b/.test(s.text))
    .map((s) => `line ${s.line}: actions/checkout without persist-credentials: false`);
}

function workflowFiles() {
  return fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
}

test("workflows: the scan sees the workflows this repository ships", () => {
  const files = workflowFiles();
  assert.ok(files.includes("ci.yml") && files.includes("release.yml"), files.join(", "));
  for (const f of files) {
    const text = fs.readFileSync(path.join(WORKFLOWS, f), "utf8");
    assert.ok(usesRefs(text).length > 0, `${f}: no uses: found`);
    assert.ok(checkoutSteps(text).length > 0, `${f}: no checkout step found`);
  }
});

test("workflows: every external action and reusable workflow is pinned to a full commit SHA", () => {
  for (const f of workflowFiles()) {
    const text = fs.readFileSync(path.join(WORKFLOWS, f), "utf8");
    assert.deepEqual(pinningProblems(text), [], f);
  }
});

test("workflows: every checkout sets persist-credentials: false", () => {
  for (const f of workflowFiles()) {
    const text = fs.readFileSync(path.join(WORKFLOWS, f), "utf8");
    assert.deepEqual(credentialProblems(text), [], f);
  }
});

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

test("scan: tags, branches, short SHAs and missing version comments are rejected", () => {
  for (const ref of ["actions/checkout@v4", "actions/checkout@main", "actions/checkout@3d3c42e", "o/r/.github/workflows/x.yml@v1"]) {
    assert.equal(pinningProblems(`    steps:\n      - uses: ${ref}\n`).length, 1, ref);
  }
  assert.equal(pinningProblems(`      - uses: "actions/checkout@v4" # v4\n`).length, 1, "quoted");
  assert.equal(pinningProblems(`    uses: org/repo/.github/workflows/ci.yml@v1\n`).length, 1, "job-level reusable workflow");
  assert.equal(pinningProblems("      - uses: docker://alpine:3\n").length, 1);
  assert.match(pinningProblems(`      - uses: actions/checkout@${SHA}\n`)[0], /version comment/);
  assert.deepEqual(pinningProblems(`      - uses: actions/checkout@${SHA} # v7.0.1\n`), []);
  assert.deepEqual(pinningProblems("    uses: ./.github/workflows/ci.yml # zizmor: ignore[self-repository]\n"), []);
  assert.deepEqual(pinningProblems(`      - uses: docker://alpine@sha256:${"0".repeat(64)}\n`), []);
});

test("scan: checkout steps without persist-credentials: false are rejected, in any layout", () => {
  const ok = [
    `      - uses: actions/checkout@${SHA} # v7.0.1\n        with:\n          fetch-depth: 0\n          persist-credentials: false\n`,
    `      - uses: actions/checkout@${SHA} # v7.0.1\n        with: { fetch-depth: 0, persist-credentials: false }\n`,
    `      - name: Checkout\n        uses: actions/checkout@${SHA} # v7.0.1\n        with:\n          persist-credentials: false\n`,
  ];
  for (const wf of ok) assert.deepEqual(credentialProblems(wf), [], wf);
  const bad = [
    `      - uses: actions/checkout@${SHA} # v7.0.1\n`,
    `      - uses: actions/checkout@${SHA} # v7.0.1\n        with:\n          fetch-depth: 0\n`,
    `      - uses: actions/checkout@${SHA} # v7.0.1\n        with:\n          persist-credentials: true\n`,
    `      - uses: actions/checkout@${SHA} # v7.0.1\n        with:\n          # persist-credentials: false\n          fetch-depth: 0\n`,
    // The next step's setting does not count for this checkout.
    `      - uses: actions/checkout@${SHA} # v7.0.1\n      - uses: other/action@${SHA} # v1\n        with:\n          persist-credentials: false\n`,
  ];
  for (const wf of bad) assert.equal(credentialProblems(wf).length, 1, wf);
});
