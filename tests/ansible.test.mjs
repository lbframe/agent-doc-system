// Ansible adapter (issue #6): the DERIVED side of a provisioning requirement.
//
// The adapter reads playbooks without running them and without evaluating
// Jinja. It may say "provided" or "absent" as a deterministic fact only when it
// could have seen the opposite; everything weaker is a candidate the authority
// engine never elects, which leaves the requirement unverified rather than
// pretending either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SYSTEM_ROOT, write, read, git, commitAll, cli, cliFails, graphOf } from "./helpers.mjs";

const FIXTURE = path.join(SYSTEM_ROOT, "fixtures", "d-normative-provisioning");
const KEY = "requirement.provides.verification-runtime";
const SUBJECT = "component:default/provisioning";
const RUNTIME = "/var/lib/agent-platform-runtime/verification-python-v1";
const SANDBOX = "provisioning/runtime_sandbox/site.yml";

// The incident fixture with the ansible adapter enabled, the requirement
// declared with what to look for, and every other normative section attested.
function setup(t, { expects = "installs: " + RUNTIME, adapter = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-ansible-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  commitAll(dir);
  const sections = JSON.parse(cli(dir, ["audit"])).normative.sections;
  const cited = sections.find((s) => s.section === "13-host-configuration");
  write(dir, "provisioning/agentdoc.yaml", read(dir, "provisioning/agentdoc.yaml").replace("  context:\n", [
    "  requirements:",
    "    - id: verification-runtime-on-host",
    "      key: " + KEY,
    "      value: provided",
    "      source:",
    "        path: " + cited.path,
    "        section: " + cited.section,
    "        sha256: " + cited.sha256,
    "      satisfiedBy: [ansible]",
    "      expects:",
    "        " + expects,
    "  context:",
    "",
  ].join("\n")));
  let cfg = read(dir, "agentdoc/agentdoc.config.yaml");
  if (adapter) cfg = cfg.replace("  - github-actions\n", "  - github-actions\n  - ansible\n");
  cfg += "normativeCoverage:\n" + sections.filter((s) => s !== cited).map((s) => [
    "  - path: " + s.path,
    "    section: " + s.section,
    "    sha256: " + s.sha256,
    "    disposition: no-implementation-obligation",
    '    reason: "Fixture section reviewed; it states scope or behaviour already modeled."',
    '    reviewWhen: "Review when this section of the specification changes."',
  ].join("\n")).join("\n") + "\n";
  write(dir, "agentdoc/agentdoc.config.yaml", cfg);
  commitAll(dir, "declare the requirement");
  return dir;
}

function addTasks(dir, file, yaml) {
  write(dir, file, read(dir, file) + yaml);
  commitAll(dir, "provision");
}

const INSTALL_RUNTIME = [
  "    - name: Install the pinned verifier runtime",
  "      ansible.builtin.unarchive:",
  "        src: /opt/agent-platform/verification-python-v1.tar",
  "        dest: " + RUNTIME,
  "",
].join("\n");

function row(dir) {
  return JSON.parse(cli(dir, ["audit"])).facts.find((f) => f.fact === SUBJECT + " " + KEY);
}

function strictOutput(dir) {
  cli(dir, ["compile"]);
  const r = cliFails(dir, ["check", "--strict"]);
  return r ? r.stdout + r.stderr : null;
}

// ── the incident, without any manual override ──────────────────────────
test("ANSIBLE: provisioning that never installs the required runtime is a conflict, derived from the playbooks", (t) => {
  const dir = setup(t);
  const r = cliFails(dir, ["validate"]);
  assert.ok(r, "the missing runtime validated");
  const out = r.stdout + r.stderr;
  assert.match(out, /AGENTDOC_CONFLICT_UNRESOLVED/);
  assert.match(out, /AUTHORED="provided" vs DERIVED="absent"/);
  assert.match(out, /no reachable task installs path \/var\/lib\/agent-platform-runtime\/verification-python-v1/);
  assert.match(out, /specs\/EXECUTION_LAYER_SPEC\.md#13-host-configuration/);
  assert.doesNotMatch(out, /Add an authority rule/, "a requirement conflict must not suggest waiving it by rule");
});

test("ANSIBLE: a playbook task that installs the runtime corroborates the requirement", (t) => {
  const dir = setup(t);
  addTasks(dir, SANDBOX, INSTALL_RUNTIME);
  assert.equal(cliFails(dir, ["validate"]), null);
  assert.equal(row(dir).classification, "CONFIRMED");
  assert.equal(strictOutput(dir), null);
  const prov = graphOf(dir).entities.find((e) => e.ref === SUBJECT).derived.provisioning;
  assert.ok(prov.installs.some((i) => i.path === RUNTIME && i.file === SANDBOX && !i.conditional), JSON.stringify(prov));
  assert.ok(prov.installs.some((i) => i.path === "/usr/local/lib/agent-platform-runtime/platform-venv"));
});

test("ANSIBLE: a path below the required root counts as installing it; a parent does not", (t) => {
  const below = setup(t);
  addTasks(below, SANDBOX, "    - copy:\n        src: interpreter\n        dest: " + RUNTIME + "/bin/python3\n");
  assert.equal(cliFails(below, ["validate"]), null);

  const parent = setup(t);
  addTasks(parent, SANDBOX, "    - file:\n        path: /var/lib/agent-platform-runtime\n        state: directory\n");
  assert.ok(cliFails(parent, ["validate"]), "creating the parent directory proved the runtime");
});

// ── absence is only a fact when the adapter could have seen the opposite ─
test("ANSIBLE: an opaque shell task turns the absence into a candidate and leaves the requirement unverified", (t) => {
  const dir = setup(t);
  addTasks(dir, SANDBOX, "    - name: Build things\n      ansible.builtin.shell: make install\n");
  assert.equal(cliFails(dir, ["validate"]), null, "a candidate absence must not be a conflict");
  const r = row(dir);
  assert.equal(r.classification, "UNRESOLVED");
  assert.match(r.evidence.join(" | "), /heuristic candidate only/);
  const out = strictOutput(dir);
  assert.match(out, /AGENTDOC_REQUIREMENT_UNVERIFIED/);
  assert.match(out, /shell task without a literal `creates`/);
});

test("ANSIBLE: a command's literal `creates` is an install", (t) => {
  const dir = setup(t);
  addTasks(dir, SANDBOX, "    - command: /opt/build-runtime.sh\n      args:\n        creates: " + RUNTIME + "\n");
  assert.equal(cliFails(dir, ["validate"]), null);
  assert.equal(row(dir).classification, "CONFIRMED");
});

test("ANSIBLE: an install behind `when` is only a candidate", (t) => {
  const dir = setup(t);
  addTasks(dir, SANDBOX, INSTALL_RUNTIME.replace("      ansible.builtin.unarchive:", "      when: install_verifier | bool\n      ansible.builtin.unarchive:"));
  assert.equal(cliFails(dir, ["validate"]), null);
  assert.equal(row(dir).classification, "UNRESOLVED");
  assert.match(strictOutput(dir), /installed only conditionally/);
});

test("ANSIBLE: a templated destination is never matched or ruled out", (t) => {
  const dir = setup(t);
  addTasks(dir, SANDBOX, "    - unarchive:\n        src: runtime.tar\n        dest: \"{{ verifier_root }}\"\n");
  assert.equal(cliFails(dir, ["validate"]), null);
  assert.equal(row(dir).classification, "UNRESOLVED");
  assert.match(strictOutput(dir), /unarchive dest is templated/);
});

test("ANSIBLE: an unmodeled module is opaque rather than ignored", (t) => {
  const dir = setup(t);
  addTasks(dir, SANDBOX, "    - ansible.builtin.apt:\n        name: python3-verifier\n");
  assert.equal(cliFails(dir, ["validate"]), null);
  assert.match(strictOutput(dir), /module ansible\.builtin\.apt is not modeled/);
});

// ── reachability ─────────────────────────────────────────────────────────
test("ANSIBLE: roles and included task files are followed inside the repository", (t) => {
  const role = setup(t);
  addTasks(role, SANDBOX, "    - include_role:\n        name: verifier\n");
  write(role, "provisioning/runtime_sandbox/roles/verifier/tasks/main.yml", "- import_tasks: unpack.yml\n");
  write(role, "provisioning/runtime_sandbox/roles/verifier/tasks/unpack.yml", "- unarchive:\n    src: runtime.tar\n    dest: " + RUNTIME + "\n");
  commitAll(role, "role");
  assert.equal(cliFails(role, ["validate"]), null);
  assert.equal(row(role).classification, "CONFIRMED");

  const missing = setup(t);
  addTasks(missing, SANDBOX, "    - include_role:\n        name: from-galaxy\n");
  assert.equal(cliFails(missing, ["validate"]), null);
  assert.match(strictOutput(missing), /role not found in the repository: from-galaxy/);
});

test("ANSIBLE: a task file no playbook reaches installs nothing", (t) => {
  const dir = setup(t);
  write(dir, "provisioning/runtime_sandbox/roles/unused/tasks/main.yml", "- unarchive:\n    src: runtime.tar\n    dest: " + RUNTIME + "\n");
  commitAll(dir, "dead role");
  const r = cliFails(dir, ["validate"]);
  assert.ok(r);
  assert.match(r.stdout + r.stderr, /DERIVED="absent"/);
});

test("ANSIBLE: a service requirement is matched against managed services", (t) => {
  const dir = setup(t, { expects: "service: agent-verifier" });
  addTasks(dir, SANDBOX, "    - systemd:\n        name: agent-verifier.service\n        enabled: true\n");
  assert.equal(cliFails(dir, ["validate"]), null);
  assert.equal(row(dir).classification, "CONFIRMED");
});

// ── unit detection and determinism ───────────────────────────────────────
test("ANSIBLE: a playbook root is a deployable unit, so an infrastructure component is corroborated", (t) => {
  for (const adapter of [true, false]) {
    const dir = setup(t, { adapter });
    write(dir, "provisioning/agentdoc.yaml", read(dir, "provisioning/agentdoc.yaml").replace("type: other", "type: infrastructure"));
    addTasks(dir, SANDBOX, INSTALL_RUNTIME);
    const r = cliFails(dir, ["validate"]);
    if (adapter) assert.equal(r, null, r && r.stdout + r.stderr);
    else assert.match(r.stdout + r.stderr, /AGENTDOC_ARTIFACT_TYPE/);
  }
});

test("ANSIBLE: compiling twice produces identical bytes", (t) => {
  const dir = setup(t);
  addTasks(dir, SANDBOX, INSTALL_RUNTIME + "    - shell: echo hi\n");
  cli(dir, ["compile"]);
  const first = read(dir, ".agentdoc/graph.json");
  cli(dir, ["compile"]);
  assert.equal(read(dir, ".agentdoc/graph.json"), first);
});
