// Release tooling: changelog notes extraction and the release guards used by
// .github/workflows/release.yml. Pure functions only; no network, no git.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SYSTEM_ROOT } from "./helpers.mjs";
import { extractReleaseNotes, NotesError } from "../scripts/release/changelog-notes.mjs";
import {
  GuardError, SEMVER, checkRef, checkVersion, checkTokenEnv, checkShippedGraphs,
  classifyRemoteTag, classifyNpmVersion, commitFromProvenance, checkNpmCli, compareVersions,
} from "../scripts/release/guards.mjs";

const CHANGELOG = `# Changelog

All notable changes are documented here, see [Keep a Changelog].

## [Unreleased]

### Added

- Something for 1.10.0 and 1.1.0 not yet released ([#9]).

## [1.10.0] - 2026-12-01

### Fixed

- Ten ([#7]).

## [1.2.0] - 2026-10-27

Intro paragraph with an [inline link](docs/GUIDE.md#part) and a
[full reference][guide] and a [Collapsed][].

### Added

- **Feature** ([#5], [#6]). See [docs/BENCHMARK.md].

## [1.1.1] - 2026-10-01

### Changed

## [1.1.0] - 2026-09-01

### Changed

- One point one ([#5]).

[Unreleased]: https://example.test/compare/v1.10.0...HEAD
[1.10.0]: https://example.test/compare/v1.2.0...v1.10.0
[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[docs/BENCHMARK.md]: docs/BENCHMARK.md
[guide]: https://example.test/guide "The guide"
[collapsed]: https://example.test/collapsed
[#5]: https://example.test/issues/5
[#6]: https://example.test/issues/6
[#7]: https://example.test/issues/7
[#9]: https://example.test/issues/9
`;

test("notes: a normal section, heading excluded, used definitions appended", () => {
  const notes = extractReleaseNotes(CHANGELOG, "1.10.0");
  assert.equal(notes, "### Fixed\n\n- Ten ([#7]).\n\n[#7]: https://example.test/issues/7\n");
});

test("notes: link definitions resolved (shortcut, full, collapsed), each once, unused ones left out", () => {
  const notes = extractReleaseNotes(CHANGELOG, "1.2.0");
  const defs = notes.split("\n").filter((l) => /^\[[^\]]+\]: /.test(l));
  assert.deepEqual(defs, [
    "[guide]: https://example.test/guide \"The guide\"",
    "[collapsed]: https://example.test/collapsed",
    "[#5]: https://example.test/issues/5",
    "[#6]: https://example.test/issues/6",
    "[docs/BENCHMARK.md]: docs/BENCHMARK.md",
  ]);
  assert.ok(!notes.includes("[#9]:"), "a definition used only by another section is not appended");
  assert.ok(!notes.includes("[1.10.0]:"), "version compare links are not appended");
  assert.ok(notes.startsWith("Intro paragraph"));
  assert.ok(!notes.includes("## [1.1.1]"), "the section stops at the next level-2 heading");
});

test("notes: relative link targets become absolute with a base URL", () => {
  const base = "https://github.com/o/r/blob/v1.2.0";
  const notes = extractReleaseNotes(CHANGELOG, "1.2.0", { baseUrl: base + "/" });
  assert.ok(notes.includes(`[inline link](${base}/docs/GUIDE.md#part)`));
  assert.ok(notes.includes(`[docs/BENCHMARK.md]: ${base}/docs/BENCHMARK.md`));
  assert.ok(notes.includes("[#5]: https://example.test/issues/5"), "absolute targets are untouched");
});

test("notes: the last section stops before the trailing link definitions", () => {
  const notes = extractReleaseNotes(CHANGELOG, "1.1.0");
  assert.equal(notes, "### Changed\n\n- One point one ([#5]).\n\n[#5]: https://example.test/issues/5\n");
});

test("notes: a missing version is an error", () => {
  assert.throws(() => extractReleaseNotes(CHANGELOG, "9.9.9"), NotesError);
  assert.throws(() => extractReleaseNotes(CHANGELOG, "9.9.9"), /no "## \[9\.9\.9\] - YYYY-MM-DD" section/);
});

test("notes: an undated heading is not a release section", () => {
  const text = "## [Unreleased]\n\n- x\n\n## [2.0.0]\n\n- y\n";
  assert.throws(() => extractReleaseNotes(text, "2.0.0"), /heading exists but is not/);
});

test("notes: an empty section (only subheadings) is an error", () => {
  assert.throws(() => extractReleaseNotes(CHANGELOG, "1.1.1"), /section for 1\.1\.1 is empty/);
  assert.throws(() => extractReleaseNotes("## [3.0.0] - 2027-01-01\n\n## [2.0.0] - 2026-01-01\n\n- y\n", "3.0.0"), /empty/);
});

test("notes: [Unreleased] is never picked", () => {
  assert.throws(() => extractReleaseNotes(CHANGELOG, "Unreleased"), NotesError);
  for (const v of ["1.10.0", "1.2.0", "1.1.0"]) {
    assert.ok(!extractReleaseNotes(CHANGELOG, v).includes("not yet released"), v);
  }
  assert.throws(() => extractReleaseNotes("## [Unreleased]\n\n- 1.3.0 work\n", "1.3.0"), /no "## \[1\.3\.0\]/);
});

test("notes: 1.1.0 does not match 1.10.0, and dots are literal", () => {
  assert.ok(!extractReleaseNotes(CHANGELOG, "1.1.0").includes("Ten"));
  assert.ok(!extractReleaseNotes(CHANGELOG, "1.10.0").includes("One point one"));
  assert.throws(() => extractReleaseNotes("## [1x1x0] - 2026-01-01\n\n- z\n", "1.1.0"), NotesError);
  assert.throws(() => extractReleaseNotes("## [1.10.0] - 2026-01-01\n\n- z\n", "1.1.0"), NotesError);
});

test("notes: a duplicated version section is an error", () => {
  const text = "## [1.0.0] - 2026-01-01\n\n- a\n\n## [1.0.0] - 2026-01-02\n\n- b\n";
  assert.throws(() => extractReleaseNotes(text, "1.0.0"), /2 sections/);
});

test("notes: CRLF line endings are accepted", () => {
  assert.equal(extractReleaseNotes(CHANGELOG.replace(/\n/g, "\r\n"), "1.10.0"), extractReleaseNotes(CHANGELOG, "1.10.0"));
});

test("notes: every released section of the real CHANGELOG.md extracts", () => {
  const text = fs.readFileSync(path.join(SYSTEM_ROOT, "CHANGELOG.md"), "utf8");
  const versions = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/gm)].map((m) => m[1]);
  assert.ok(versions.includes("1.2.0"));
  for (const v of versions) {
    const notes = extractReleaseNotes(text, v);
    // Every shortcut reference to an issue has its definition appended.
    for (const [, label] of notes.matchAll(/\[(#\d+)\](?!:)/g)) {
      assert.ok(notes.includes(`[${label}]: https://github.com/lbframe/agent-doc-system/issues/`), `${v}: ${label}`);
    }
  }
});

// --- guards ---------------------------------------------------------------

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

test("guard: only refs/heads/main may release", () => {
  checkRef("refs/heads/main");
  for (const ref of ["refs/heads/release/v1.3.0", "refs/tags/v1.3.0", "refs/heads/main2", "", undefined]) {
    assert.throws(() => checkRef(ref), GuardError, String(ref));
  }
});

test("guard: SemVer 2.0.0 grammar", () => {
  for (const v of ["0.0.0", "1.2.3", "10.20.30", "1.0.0-alpha.1", "1.0.0+build.5"]) assert.ok(SEMVER.test(v), v);
  for (const v of ["v1.2.3", "1.2", "01.2.3", "1.2.3.4", "1.2.3-", " 1.2.3", "1.2.3\n", ""]) assert.ok(!SEMVER.test(v), JSON.stringify(v));
});

test("guard: version must be stable SemVer and equal package.json and the compiler", () => {
  checkVersion({ input: "1.3.0", packageVersion: "1.3.0", compilerVersion: "1.3.0" });
  assert.throws(() => checkVersion({ input: "v1.3.0", packageVersion: "1.3.0", compilerVersion: "1.3.0" }), /not valid SemVer/);
  assert.throws(() => checkVersion({ input: "1.3.0", packageVersion: "1.2.0", compilerVersion: "1.2.0" }), /does not match package\.json/);
  assert.throws(() => checkVersion({ input: "1.3.0", packageVersion: "1.3.0", compilerVersion: "1.2.0" }), /COMPILER_VERSION/);
  assert.throws(() => checkVersion({ input: "1.3.0-rc.1", packageVersion: "1.3.0-rc.1", compilerVersion: "1.3.0-rc.1" }), /pre-release/);
  assert.throws(() => checkVersion({ input: "1.3", packageVersion: "1.2.0", compilerVersion: "1.2.0" }), (err) => {
    assert.equal(err.messages.length, 2, "every failure is reported, not only the first");
    return true;
  });
});

test("guard: npm tokens in the environment are refused, even empty", () => {
  checkTokenEnv({ PATH: "/bin", NPM_ID_TOKEN: "oidc" });
  assert.throws(() => checkTokenEnv({ NPM_TOKEN: "x" }), /NPM_TOKEN must not be set/);
  assert.throws(() => checkTokenEnv({ NODE_AUTH_TOKEN: "" }), /NODE_AUTH_TOKEN/);
  assert.throws(() => checkTokenEnv({ NPM_TOKEN: "x", NODE_AUTH_TOKEN: "y" }), /NPM_TOKEN and NODE_AUTH_TOKEN/);
});

test("guard: shipped graphs must carry the released compiler version", () => {
  checkShippedGraphs([{ path: "a/graph.json", compilerVersion: "1.3.0" }], "1.3.0");
  assert.throws(() => checkShippedGraphs([
    { path: "a/graph.json", compilerVersion: "1.3.0" },
    { path: "b/graph.json", compilerVersion: "1.2.0" },
  ], "1.3.0"), /not recompiled for 1\.3\.0:\n  b\/graph\.json \(compiler 1\.2\.0\)$/);
});

test("guard: remote tag absent, same commit (annotated or lightweight), or conflicting", () => {
  const ls = [
    `${"1".repeat(40)}\trefs/tags/v1.1.0`,
    `${"2".repeat(40)}\trefs/tags/v1.10.0`,
    `${"3".repeat(40)}\trefs/tags/v1.10.0^{}`,
    `${"4".repeat(40)}\trefs/tags/v1.3.0-rc.1`,
  ].join("\n");
  assert.equal(classifyRemoteTag(ls, "v1.3.0", SHA), "absent", "a prefix match is not the tag");
  assert.equal(classifyRemoteTag("", "v1.3.0", SHA), "absent");
  assert.equal(classifyRemoteTag(ls, "v1.10.0", "3".repeat(40)), "same", "annotated: compares the peeled commit");
  assert.throws(() => classifyRemoteTag(ls, "v1.10.0", "2".repeat(40)), GuardError, "the tag object is not the commit");
  assert.equal(classifyRemoteTag(ls, "v1.1.0", "1".repeat(40)), "same", "lightweight");
  assert.throws(() => classifyRemoteTag(ls, "v1.1.0", SHA), /already exists on the remote at 1{40}, not at a{40}/);
  assert.throws(() => classifyRemoteTag(ls, "v1.3.0", "abc"), /full commit SHA/);
});

test("guard: npm version absent, published from this commit, or refused", () => {
  const m = (extra) => ({ name: "agent-doc-system", version: "1.3.0", ...extra });
  assert.equal(classifyNpmVersion(null, SHA), "absent");
  assert.equal(classifyNpmVersion(m({ gitHead: SHA }), SHA), "published-same");
  assert.equal(classifyNpmVersion(m({}), SHA, SHA), "published-same", "provenance commit when gitHead is missing");
  assert.throws(() => classifyNpmVersion(m({ gitHead: OTHER }), SHA, SHA), /published from b{40}, not from a{40}/, "gitHead wins");
  assert.throws(() => classifyNpmVersion(m({}), SHA), /records no commit/);
});

test("guard: commit extracted from an npm SLSA provenance statement", () => {
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: { buildDefinition: { resolvedDependencies: [
      { uri: "git+https://github.com/lbframe/agent-doc-system@refs/heads/main", digest: { gitCommit: SHA } },
    ] } },
  };
  assert.equal(commitFromProvenance(statement), SHA);
  assert.equal(commitFromProvenance({ predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" }), undefined);
  assert.equal(commitFromProvenance(null), undefined);
});

test("guard: npm CLI must support trusted publishing (>= 11.5.1)", () => {
  for (const v of ["11.5.1", "11.21.2", "12.0.0"]) checkNpmCli(v);
  for (const v of ["11.5.0", "10.9.2", "9.99.99", "garbage", ""]) assert.throws(() => checkNpmCli(v), GuardError, v);
  assert.equal(compareVersions("11.10.0", "11.5.1"), 1);
  assert.equal(compareVersions("11.5.1", "11.5.1"), 0);
});

test("release workflow: dispatch-only, pinned, least privilege, inputs never interpolated in run:", () => {
  const wf = fs.readFileSync(path.join(SYSTEM_ROOT, ".github/workflows/release.yml"), "utf8");
  const on = /^on:\n((?:[ #].*\n|\n)*)/m.exec(wf)[1];
  assert.deepEqual([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]), ["workflow_dispatch"]);
  assert.match(wf, /^permissions:\n {2}contents: read\n/m);
  for (const [, ref] of wf.matchAll(/uses: ([^\s#]+)/g)) {
    if (ref.startsWith("./")) continue;
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is pinned to a full commit SHA`);
  }
  assert.equal((wf.match(/id-token: write/g) ?? []).length, 1, "only one job holds id-token: write");
  assert.ok(!/NPM_TOKEN:|NODE_AUTH_TOKEN:|secrets\./.test(wf), "no npm token or secret is referenced");
  // No expression inside a run: block.
  for (const [, body] of wf.matchAll(/run: [|>]?.*\n((?: {10,}.*\n|\n)*)/g)) {
    assert.ok(!body.includes("${{"), "expression interpolated in run:\n" + body);
  }
  for (const [, line] of wf.matchAll(/run: (?![|>])(.*)/g)) assert.ok(!line.includes("${{"), line);
  const ci = fs.readFileSync(path.join(SYSTEM_ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /^ {2}workflow_call:$/m, "ci.yml is reusable as the release gate");
});
