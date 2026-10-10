// Normative requirement coverage (issue #5).
//
// A migration that routes a normative specification is not a migration that
// reviewed it. The fixture reproduces the incident: a specification requires
// the production host to carry a dedicated verifier runtime, the provisioning
// does not install it, and every gate used to pass. These tests pin the
// contract that closes that gap without letting any heuristic elect a fact:
//
//   - every section of a configured normative document is either cited by a
//     structured requirement or attested as carrying no implementation
//     obligation (AGENTDOC_NORMATIVE_UNCOVERED otherwise);
//   - a requirement with no implementation evidence is UNRESOLVED
//     (AGENTDOC_REQUIREMENT_UNVERIFIED), never elected on its own word;
//   - implementation evidence that disagrees with a requirement is a conflict
//     no authority rule may settle;
//   - `check --strict` refuses a migration that still carries any of these.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SYSTEM_ROOT, write, read, git, commitAll, evidence, cli, cliFails } from "./helpers.mjs";

const FIXTURE = path.join(SYSTEM_ROOT, "fixtures", "d-normative-provisioning");
const REQ_KEY = "requirement.provides.verification-runtime";
const PROVISIONING = "component:default/provisioning";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-normative-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  commitAll(dir);
  return dir;
}

function audit(dir) {
  return JSON.parse(cli(dir, ["audit"]));
}

// The digest an operator would copy out of the audit report. Taken from the
// report rather than recomputed here, so the tests do not freeze one hashing
// recipe: what they pin is that the report states it.
function sectionDigest(report, docPath, section) {
  const s = report.normative.sections.find((x) => x.path === docPath && x.section === section);
  assert.ok(s, "audit does not list normative section " + docPath + "#" + section + ": " + JSON.stringify(report.normative));
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
  return s.sha256;
}

function declareRequirement(dir, report, { satisfiedBy = ["ansible"] } = {}) {
  const sha = sectionDigest(report, "specs/EXECUTION_LAYER_SPEC.md", "13-host-configuration");
  const desc = read(dir, "provisioning/agentdoc.yaml").replace(
    "  context:\n",
    [
      "  requirements:",
      "    - id: verification-runtime-on-host",
      "      key: " + REQ_KEY,
      "      value: provided",
      "      source:",
      "        path: specs/EXECUTION_LAYER_SPEC.md",
      "        section: 13-host-configuration",
      "        sha256: " + sha,
      "      satisfiedBy: [" + satisfiedBy.join(", ") + "]",
      "  context:",
      "",
    ].join("\n")
  );
  write(dir, "provisioning/agentdoc.yaml", desc);
}

// Attest every normative section except the ones named, so a test can isolate
// the behaviour it is about.
function attestOtherSections(dir, report, except) {
  const rows = report.normative.sections
    .filter((s) => !except.includes(s.path + "#" + s.section))
    .map((s) => [
      "  - path: " + s.path,
      "    section: " + s.section,
      "    sha256: " + s.sha256,
      "    disposition: no-implementation-obligation",
      '    reason: "Fixture section reviewed during migration; it states scope or behaviour already modeled."',
      '    reviewWhen: "Review when this section of the specification changes."',
    ].join("\n"));
  const cfg = read(dir, "agentdoc/agentdoc.config.yaml");
  write(dir, "agentdoc/agentdoc.config.yaml", cfg + "normativeCoverage:\n" + rows.join("\n") + "\n");
}

function override(dir, value, paths) {
  const cfg = read(dir, "agentdoc/agentdoc.config.yaml").replace(
    "reviewedOverrides: []\n",
    [
      "reviewedOverrides:",
      "  - fact: requirement-satisfaction",
      "    subject: " + PROVISIONING,
      "    key: " + REQ_KEY,
      "    value: " + value,
      '    reason: "Read the Ansible playbooks: this is what the host provisioning actually does."',
      '    reviewWhen: "Review when the provisioning playbooks change."',
      "    evidence:",
      evidence(dir, paths),
      "",
    ].join("\n")
  );
  write(dir, "agentdoc/agentdoc.config.yaml", cfg);
}

const ALL_OTHER = ["specs/EXECUTION_LAYER_SPEC.md#13-host-configuration"];

// ── the incident ───────────────────────────────────────────────────────
test("NORMATIVE: plain check stays green so existing gates do not change meaning", (t) => {
  const dir = fixture(t);
  assert.equal(cliFails(dir, ["validate"]), null);
  assert.equal(cliFails(dir, ["compile"]), null);
  assert.equal(cliFails(dir, ["check"]), null);
});

test("NORMATIVE: a routed but unreviewed normative section is reported, with the digest to cite", (t) => {
  const dir = fixture(t);
  const report = audit(dir);
  const uncovered = report.normative.uncovered.map((s) => s.path + "#" + s.section);
  assert.ok(uncovered.includes("specs/EXECUTION_LAYER_SPEC.md#13-host-configuration"), JSON.stringify(uncovered));
  assert.ok(uncovered.includes("verification_layer/PYTHON_PROFILE.md#runtime-root"), JSON.stringify(uncovered));
  // Documents outside the normative globs are inventoried, not gated.
  assert.ok(!uncovered.some((u) => u.startsWith("docs/") || u.startsWith("provisioning/")), JSON.stringify(uncovered));
  assert.ok(report.reviewedAmbiguity.some((a) => a.kind === "NORMATIVE_UNCOVERED" && a.subject === "specs/EXECUTION_LAYER_SPEC.md#13-host-configuration"));
  sectionDigest(report, "specs/EXECUTION_LAYER_SPEC.md", "13-host-configuration");
});

test("NORMATIVE: check --strict refuses a migration with uncovered normative sections", (t) => {
  const dir = fixture(t);
  cli(dir, ["compile"]);
  const r = cliFails(dir, ["check", "--strict"]);
  assert.ok(r, "check --strict passed on a migration that never reviewed its specification");
  assert.match(r.stdout + r.stderr, /AGENTDOC_NORMATIVE_UNCOVERED/);
  assert.match(r.stdout + r.stderr, /specs\/EXECUTION_LAYER_SPEC\.md#13-host-configuration/);
});

// ── a declared requirement must be proven ──────────────────────────────
test("NORMATIVE: a requirement with no implementation evidence is UNRESOLVED and names the missing adapter", (t) => {
  const dir = fixture(t);
  declareRequirement(dir, audit(dir));
  attestOtherSections(dir, audit(dir), ALL_OTHER);
  commitAll(dir, "declare the requirement");

  const report = audit(dir);
  assert.deepEqual(report.normative.uncovered, []);
  const row = report.facts.find((f) => f.fact === PROVISIONING + " " + REQ_KEY);
  assert.ok(row, "the requirement is not a fact in the audit: " + JSON.stringify(report.facts.map((f) => f.fact)));
  assert.equal(row.classification, "UNRESOLVED");
  const ev = row.evidence.join(" | ");
  assert.match(ev, /specs\/EXECUTION_LAYER_SPEC\.md#13-host-configuration/, "the authored evidence is not named");
  assert.match(ev, /ansible/, "the missing extractor is not named");
  assert.ok(report.reviewedAmbiguity.some((a) => a.kind === "REQUIREMENT_UNVERIFIED"));

  cli(dir, ["compile"]);
  assert.equal(cliFails(dir, ["check"]), null, "a missing proof is a warning, not an error, without --strict");
  const r = cliFails(dir, ["check", "--strict"]);
  assert.ok(r);
  assert.match(r.stdout + r.stderr, /AGENTDOC_REQUIREMENT_UNVERIFIED/);
});

test("NORMATIVE: provisioning that treats the requirement as an external input is a conflict", (t) => {
  const dir = fixture(t);
  declareRequirement(dir, audit(dir));
  attestOtherSections(dir, audit(dir), ALL_OTHER);
  override(dir, "external-input", ["provisioning/lifecycle/site.yml", "provisioning/lifecycle/README.md"]);
  commitAll(dir, "record what provisioning does");

  const r = cliFails(dir, ["validate"]);
  assert.ok(r, "a contradicted normative requirement validated");
  assert.match(r.stdout + r.stderr, /AGENTDOC_CONFLICT_UNRESOLVED/);
  assert.match(r.stdout + r.stderr, new RegExp(REQ_KEY.replace(/\./g, "\\.")));
});

test("NORMATIVE: no authority rule may elect an override over a normative requirement", (t) => {
  const dir = fixture(t);
  declareRequirement(dir, audit(dir));
  attestOtherSections(dir, audit(dir), ALL_OTHER);
  override(dir, "external-input", ["provisioning/lifecycle/site.yml"]);
  const cfg = read(dir, "agentdoc/agentdoc.config.yaml").replace(
    "  rules:\n",
    [
      "  rules:",
      "    - id: overrides-settle-requirements",
      '      keyPattern: " requirement\\\\."',
      "      elect: [REVIEWED_OVERRIDE]",
      '      rationale: "An attempt to let a review silently waive a specification."',
      '      reviewWhen: "Never; this rule must be refused."',
      "",
    ].join("\n")
  );
  write(dir, "agentdoc/agentdoc.config.yaml", cfg);
  commitAll(dir, "try to waive the requirement");

  const r = cliFails(dir, ["validate"]);
  assert.ok(r, "an authority rule waived a normative requirement");
  assert.match(r.stdout + r.stderr, /AGENTDOC_CONFLICT_UNRESOLVED|AGENTDOC_CONFIG/);
});

test("NORMATIVE: a reviewed proof satisfies the requirement and is re-verified against its evidence", (t) => {
  const dir = fixture(t);
  declareRequirement(dir, audit(dir));
  attestOtherSections(dir, audit(dir), ALL_OTHER);
  write(dir, "provisioning/runtime_sandbox/site.yml",
    read(dir, "provisioning/runtime_sandbox/site.yml") +
    "    - name: Install the pinned verifier runtime\n" +
    "      ansible.builtin.unarchive:\n" +
    "        src: /opt/agent-platform/verification-python-v1.tar\n" +
    "        dest: /var/lib/agent-platform-runtime/verification-python-v1\n" +
    "        owner: root\n" +
    "        mode: \"0555\"\n");
  override(dir, "provided", ["provisioning/runtime_sandbox/site.yml"]);
  commitAll(dir, "install the verifier runtime");

  const report = audit(dir);
  const row = report.facts.find((f) => f.fact === PROVISIONING + " " + REQ_KEY);
  assert.ok(row && row.classification !== "UNRESOLVED" && row.classification !== "CONFLICT", JSON.stringify(row));
  cli(dir, ["compile"]);
  assert.equal(cliFails(dir, ["check", "--strict"]), null, "a fully reviewed migration must pass the strict gate");

  // The proof is pinned: changing the playbook forces a fresh review.
  write(dir, "provisioning/runtime_sandbox/site.yml", "- hosts: runtime\n  tasks: []\n");
  commitAll(dir, "drop the runtime");
  assert.ok(cliFails(dir, ["validate"]), "an override survived a change to the evidence it cites");
});

// ── the citation itself is pinned ──────────────────────────────────────
test("NORMATIVE: editing a cited section invalidates the requirement and the attestations", (t) => {
  const dir = fixture(t);
  declareRequirement(dir, audit(dir));
  attestOtherSections(dir, audit(dir), ALL_OTHER);
  commitAll(dir, "declare");
  assert.equal(cliFails(dir, ["validate"]), null);

  write(dir, "specs/EXECUTION_LAYER_SPEC.md",
    read(dir, "specs/EXECUTION_LAYER_SPEC.md").replace("reproduced on the production host", "reproduced on a staging host"));
  commitAll(dir, "change the spec");
  const r = cliFails(dir, ["validate"]);
  assert.ok(r, "a requirement survived a change to the section it cites");
  assert.match(r.stdout + r.stderr, /AGENTDOC_NORMATIVE_SOURCE_STALE/);
  assert.match(r.stdout + r.stderr, /13-host-configuration/);
});

test("NORMATIVE: a changed normative document makes the committed graph stale", (t) => {
  const dir = fixture(t);
  cli(dir, ["compile"]);
  write(dir, "verification_layer/PYTHON_PROFILE.md", read(dir, "verification_layer/PYTHON_PROFILE.md") + "\n## Upgrades\n\nA new runtime root is a new profile.\n");
  const r = cliFails(dir, ["check"]);
  assert.ok(r, "check did not notice a new normative section");
});
