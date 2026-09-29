// Mutation and adversarial suite.
//
// Each case injects one specific defect and asserts that the system produces
// the right diagnostic — or, where the system is supposed to tolerate the
// input, that it produces the right *behaviour* instead. A case that passes
// because the compiler crashes is a failing case, so every assertion inspects
// the error code or the resulting behaviour.
//
// The list is the adversarial surface from the specification:
//   stale graph, bad YAML, duplicate entity, dangling ref, unregistered
//   contract file, wrong API provider, changed warning evidence, stale runtime
//   observation, contradictory runtime fact, secret-shaped input, missing
//   verification command, ambiguous component ownership.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  baseFixture, commitAll, compile, read, write, cli, cliFails, graphOf, evidence, DEFAULT_CONFIG,
} from "./helpers.mjs";
import { sha256Hex } from "../core/fsx.mjs";
import { loadSchemaBundle } from "../core/descriptors.mjs";

const OBSERVATION = [
  "apiVersion: agentdoc.dev/observation/v1",
  "kind: ObservationSet",
  "metadata:",
  "  name: production",
  '  description: "What production reported for one observation window."',
  "  environment: production",
  '  capturedAt: "2099-01-01T00:00:00Z"',
  "  maxAgeDays: 30",
  "  sourceSystem: test-scheduler",
  '  collector: "test-cli schedules list"',
  "  evidenceBundle: agentdoc/observations/production/evidence.json",
  "spec:",
  "  facts:",
  "    - id: cron",
  "      subject: component:default/svc",
  "      key: schedule.cron",
  '      value: "0 3 * * *"',
  '      semantics: "The expression the scheduler actually evaluates."',
  "",
].join("\n");

const EVIDENCE = JSON.stringify({ note: "raw scheduler output, no credentials", triggers: [{ cron: "0 3 * * *" }] }, null, 2) + "\n";

export const SCHEDULE_RULE = [
  "  rules:",
  "    - id: schedule-is-runtime-truth",
  "      keyPattern: ' schedule\\.'",
  "      elect: [OBSERVED_RUNTIME]",
  '      rationale: "Only the live scheduler states what fires."',
  '      reviewWhen: "Review when the scheduler configuration changes."',
  "",
].join("\n");

function withObservation(t, extra = {}) {
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("  rules: []", SCHEDULE_RULE).replace("  - openapi", "  - openapi\n  - wrangler"),
    extra: {
      "agentdoc/observations/production.yaml": OBSERVATION,
      "agentdoc/observations/production/evidence.json": EVIDENCE,
      ...extra,
    },
  });
  commitAll(dir, "add observation");
  return dir;
}

// ── 1. stale graph ──────────────────────────────────────────────────────
test("adversarial: a stale committed graph fails the gate, and query refuses it", (t) => {
  const dir = baseFixture(t);
  cli(dir, ["compile"]);
  assert.equal(cliFails(dir, ["check"]), null);
  write(dir, "service/CONSTRAINTS.md", "# Constraints\n\n- A different rule entirely.\n  - Reason: because.\n  - Checked by: `pnpm test`\n");
  commitAll(dir);
  const check = cliFails(dir, ["check"]);
  assert.ok(check, "a stale graph must fail check");
  assert.match(check.stderr, /STALE|FRESHNESS/);
  const q = cliFails(dir, ["query", "service/src/index.ts"]);
  assert.ok(q, "query must refuse a stale graph rather than fall back");
  assert.match(q.stderr, /FRESHNESS/);
});

// ── 2. bad YAML ─────────────────────────────────────────────────────────
test("adversarial: malformed YAML fails with a parse error and a line", (t) => {
  const dir = baseFixture(t);
  write(dir, "agentdoc/systems.yaml", "apiVersion: agentdoc.dev/v1\nkind: System\nmetadata:\n  name: s1\n   description: bad indent\n");
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_YAML_PARSE"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: a duplicate mapping key is rejected, not last-write-wins", (t) => {
  const dir = baseFixture(t);
  write(dir, "agentdoc/systems.yaml", 'apiVersion: agentdoc.dev/v1\nkind: System\nmetadata:\n  name: s1\n  description: "One."\n  description: "Two."\nspec:\n  domain: d1\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_YAML_DUP_KEY"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 3. duplicate entity ─────────────────────────────────────────────────
test("adversarial: two components with the same identity fail", (t) => {
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("    - service/**/agentdoc.yaml", "    - \"*/**/agentdoc.yaml\""),
    extra: {
      "other/agentdoc.yaml": 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "A second component claiming the same identity."\nspec:\n  type: service\n  system: s1\n',
      "other/package.json": JSON.stringify({ name: "@t/other", main: "i.js" }),
    },
  });
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_DUPLICATE_IDENTITY"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 4. dangling ref ─────────────────────────────────────────────────────
test("adversarial: a dangling entity reference fails", (t) => {
  const dir = baseFixture(t);
  write(dir, "agentdoc/systems.yaml", 'apiVersion: agentdoc.dev/v1\nkind: System\nmetadata:\n  name: s1\n  description: "Points at a domain that does not exist."\nspec:\n  domain: nowhere\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_REF_UNRESOLVED"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: a context link to a missing file fails", (t) => {
  const dir = baseFixture(t);
  write(dir, "service/agentdoc.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Links to documentation that does not exist."\nspec:\n  type: service\n  system: s1\n  context:\n    docs:\n      - service/GHOST.md\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_PATH_UNRESOLVED"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 5. unregistered contract file ───────────────────────────────────────
test("adversarial: a contract file in a contract root that no API claims fails", (t) => {
  const dir = baseFixture(t);
  write(dir, "contracts/orphan.openapi.yaml", 'openapi: 3.1.0\ninfo:\n  title: Orphan\n  version: "1.0.0"\npaths: {}\ncomponents: {}\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_CONTRACT_UNCLAIMED"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: a contract file that is not valid for its declared type fails", (t) => {
  const dir = baseFixture(t);
  write(dir, "contracts/svc.openapi.yaml", "components: {}\n");
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_CONTRACT_SYNTAX"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: two APIs claiming the same contract fail", (t) => {
  const dir = baseFixture(t);
  write(dir, "agentdoc/apis.yaml",
    'apiVersion: agentdoc.dev/v1\nkind: API\nmetadata:\n  name: svc-api\n  description: "First claimant of the canonical contract."\nspec:\n  type: openapi\n  provider: component:default/svc\n  contract:\n    ref: contracts/svc.openapi.yaml\n' +
    '---\napiVersion: agentdoc.dev/v1\nkind: API\nmetadata:\n  name: other-api\n  description: "Second claimant of the same canonical contract."\nspec:\n  type: openapi\n  provider: component:default/svc\n  contract:\n    ref: contracts/svc.openapi.yaml\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_CONTRACT_SHARED"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 6. wrong API provider ───────────────────────────────────────────────
test("adversarial: an API whose provider is not a component fails", (t) => {
  const dir = baseFixture(t);
  write(dir, "agentdoc/apis.yaml", 'apiVersion: agentdoc.dev/v1\nkind: API\nmetadata:\n  name: svc-api\n  description: "Provider points at a resource instead of a component."\nspec:\n  type: openapi\n  provider: resource:default/svc-postgres\n  contract:\n    ref: contracts/svc.openapi.yaml\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_REF_INVALID" || e.code === "AGENTDOC_REF_UNRESOLVED"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: an OIDC provider that does not expose its discovery path fails", (t) => {
  const dir = baseFixture(t, {
    descriptors: ['apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Claims an OIDC surface it never serves."\nspec:\n  type: service\n  system: s1\n'],
    extra: {
      "agentdoc/apis.yaml": 'apiVersion: agentdoc.dev/v1\nkind: API\nmetadata:\n  name: svc-oidc\n  description: "OIDC surface the provider does not implement."\nspec:\n  type: oidc\n  provider: component:default/svc\n  contract:\n    standard: openid-connect-discovery-1.0\n    discoveryPath: /oidc/nonexistent\n',
    },
  });
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_OIDC_DISCOVERY"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 7. contradictory runtime fact ───────────────────────────────────────
test("adversarial: a runtime fact contradicting an authored fact is a conflict, never a silent overwrite", (t) => {
  const dir = withObservation(t, {
    "service/wrangler.toml": 'name = "svc"\nmain = "src/index.ts"\n\n[triggers]\ncrons = ["0 4 * * *"]\n',
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => e.format()).join("\n"));
  const conflict = res.graph.conflicts.find((c) => c.key === "schedule.cron");
  assert.ok(conflict, "expected a schedule.cron conflict");
  assert.equal(conflict.status, "resolved");
  assert.equal(conflict.election.basis, "authority-rule");
  const elected = res.graph.assertions.find((a) => a.id === conflict.election.electedAssertionId);
  assert.equal(elected.evidenceClass, "OBSERVED_RUNTIME");
  // The contradicted value must still be in the graph. A system that discards
  // the repository's own claim cannot explain the divergence to a human.
  const contradicted = res.graph.assertions.find((a) => a.id === conflict.election.contradictedAssertionIds[0]);
  assert.equal(contradicted.evidenceClass, "DERIVED");
  assert.equal(contradicted.value, "0 4 * * *");
});

test("adversarial: with no authority rule the same contradiction fails closed", (t) => {
  const dir = withObservation(t, {
    "service/wrangler.toml": 'name = "svc"\nmain = "src/index.ts"\n\n[triggers]\ncrons = ["0 4 * * *"]\n',
    "agentdoc/agentdoc.config.yaml": DEFAULT_CONFIG.replace("  - openapi", "  - openapi\n  - wrangler"),
  });
  commitAll(dir, "no authority rule");
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_CONFLICT_UNRESOLVED"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: a runtime observation can never overwrite an authored fact without a rule", (t) => {
  const dir = withObservation(t);
  const res = compile(dir);
  const authored = res.graph.assertions.filter((a) => a.evidenceClass === "AUTHORED");
  assert.ok(authored.length > 0);
  for (const a of authored) {
    const sameKey = res.graph.assertions.filter((b) => b.subject === a.subject && b.key === a.key);
    assert.ok(sameKey.every((b) => b.value === a.value || b.status === "unresolved"),
      "an authored value was overwritten: " + a.key);
  }
});

// ── 8. stale runtime observation ─────────────────────────────────────────
test("adversarial: an observation past its declared maxAgeDays fails every gate", (t) => {
  const dir = withObservation(t, {
    "service/wrangler.toml": 'name = "svc"\nmain = "src/index.ts"\n\n[triggers]\ncrons = ["0 3 * * *"]\n',
  });
  const ok = compile(dir);
  assert.equal(ok.errors.length, 0, ok.errors.map((e) => e.format()).join("\n"));
  cli(dir, ["compile"]);
  assert.equal(cliFails(dir, ["check"]), null, "a fresh observation must pass");
  // Time passes: nothing in the repository changes, but the observation ages
  // out of the freshness window it promised. This is the case the gate exists
  // for, and it is not detectable at compile time.
  write(dir, "agentdoc/observations/production.yaml", OBSERVATION.replace("2099-01-01", "2020-01-01"));
  commitAll(dir, "age the observation");
  assert.equal(cli(dir, ["compile"]).includes("PASS"), true);
  const check = cliFails(dir, ["check"]);
  assert.ok(check, "a stale observation must fail the gate");
  assert.match(check.stderr, /OBSERVATION_STALE/);
  const q = cliFails(dir, ["query", "service/src/index.ts"]);
  assert.ok(q && /OBSERVATION_STALE/.test(q.stderr), "query must refuse on a stale observation");
  // The escape hatch exists and is explicit, never silent.
  assert.equal(cliFails(dir, ["check", "--allow-stale-observations"]), null);
});

// ── 9. changed warning evidence ─────────────────────────────────────────
test("adversarial: changing the evidence of an accepted warning invalidates the acceptance", (t) => {
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("  - openapi", "  - openapi\n  - wrangler"),
    extra: {
      "agentdoc/observations/production.yaml": OBSERVATION,
      "agentdoc/observations/production/evidence.json": EVIDENCE,
      "service/wrangler.toml": 'name = "svc"\nmain = "src/index.ts"\n\n[triggers]\ncrons = ["0 3 * * *"]\n\n[[services]]\nbinding = "OTHER"\nservice = "not-in-this-repo"\n',
    },
  });
  // First run: the event-without-producer style warning does not exist here, so
  // manufacture a stable warning by giving a service binding that resolves to
  // nothing, and accept it with a real digest.
  const first = compile(dir);
  assert.equal(first.errors.length, 0, first.errors.map((e) => e.format()).join("\n"));
  const warn = (first.diagnostics || []).find((d) => d.severity === "warning" && d.code.startsWith("AGENTDOC_"));
  assert.ok(warn, "expected at least one warning to accept: " + JSON.stringify(first.diagnostics));
  const evidencePath = warn.paths[0];
  const digest = sha256Hex(fs.readFileSync(path.join(dir, evidencePath)));
  const cfg = read(dir, "agentdoc/agentdoc.config.yaml").replace(
    "warningAcceptances: []",
    "warningAcceptances:\n" +
      "  - code: " + warn.code + "\n" +
      "    subject: " + (warn.subject || "component:default/svc") + "\n" +
      "    classification: REVIEWED_DISPOSITION\n" +
      '    reason: "Reviewed and accepted for this fixture."\n' +
      '    reviewWhen: "Review when the underlying fact changes."\n' +
      "    observedRefs:\n" +
      (warn.refs || ["component:default/svc"]).map((r) => "      - " + r).join("\n") + "\n" +
      "    evidence:\n" +
      "      - path: " + evidencePath + "\n" +
      "        sha256: " + digest + "\n"
  );
  write(dir, "agentdoc/agentdoc.config.yaml", cfg);
  commitAll(dir, "accept the warning");
  const accepted = compile(dir);
  assert.equal(accepted.errors.length, 0, accepted.errors.map((e) => e.format()).join("\n"));
  assert.ok((accepted.diagnostics || []).some((d) => d.acceptance), "acceptance was not applied");

  // Now change the evidence. The acceptance must stop matching.
  write(dir, evidencePath, read(dir, evidencePath) + "\n# a review-relevant change\n");
  commitAll(dir, "change the evidence");
  const broken = compile(dir);
  assert.ok(
    broken.errors.some((e) => e.code === "AGENTDOC_WARNING_ACCEPTANCE" && /evidence changed/.test(e.message)),
    broken.errors.map((e) => e.format()).join("\n")
  );
});

test("adversarial: an acceptance that matches no current warning fails", (t) => {
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("warningAcceptances: []",
      "warningAcceptances:\n" +
      "  - code: AGENTDOC_EVENT_UNRESOLVED\n" +
      "    subject: nothing.like.this\n" +
      "    classification: STALE_DISPOSITION\n" +
      '    reason: "This warning no longer exists."\n' +
      '    reviewWhen: "Never."\n' +
      "    observedRefs: []\n" +
      "    evidence:\n" +
      "      - path: service/CONSTRAINTS.md\n" +
      '        sha256: "0000000000000000000000000000000000000000000000000000000000000000"\n'),
  });
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_WARNING_ACCEPTANCE"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 10. secret-shaped input ─────────────────────────────────────────────
test("adversarial: secret-shaped values in a descriptor are rejected", (t) => {
  const cases = [
    'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Uses token=abcdef0123456789abcdef to connect."\nspec:\n  type: service\n  system: s1\n',
    'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Connects to https://user:hunter2@example.com/x."\nspec:\n  type: service\n  system: s1\n',
  ];
  for (const doc of cases) {
    const dir = baseFixture(t);
    write(dir, "service/agentdoc.yaml", doc);
    const res = compile(dir);
    assert.ok(res.errors.some((e) => e.code === "AGENTDOC_SECRET"), doc);
  }
});

test("adversarial: a secret-shaped value in a verification command is redacted, never emitted", (t) => {
  const dir = baseFixture(t, {
    extra: {
      "service/package.json": JSON.stringify({
        name: "@t/svc", version: "1.0.0", main: "dist/index.js",
        scripts: { test: "vitest run", "test:integration": "DATABASE_URL=postgres://u:p@host/db vitest run db" },
      }),
    },
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => e.format()).join("\n"));
  const text = res.serialized;
  assert.ok(!/postgres:\/\/u:p@/.test(text), "a database credential reached the graph");
  assert.ok(/REDACTED/.test(text), "the command should be kept in redacted, runnable form");
});

test("adversarial: a secret-shaped value in an observation is rejected", (t) => {
  const dir = withObservation(t, {
    "agentdoc/observations/production.yaml": OBSERVATION.replace('value: "0 3 * * *"', 'value: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghijkl"'),
  });
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_SECRET"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 11. missing verification command ────────────────────────────────────
test("adversarial: a component with no discoverable check is reported by the audit, not invented", (t) => {
  const dir = baseFixture(t, {
    extra: {
      "service/package.json": JSON.stringify({ name: "@t/svc", version: "1.0.0", main: "dist/index.js", scripts: { build: "tsc" } }),
      ".github/workflows/ci.yml": "name: ci\non: { pull_request: {} }\njobs:\n  t:\n    steps:\n      - run: pnpm install --frozen-lockfile\n",
    },
  });
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => e.format()).join("\n"));
  const unit = res.graph.verification.filter((v) => v.componentRefs.includes("component:default/svc"));
  // The repository declares no test or lint script for this component, so the
  // graph must not manufacture one.
  assert.ok(!unit.some((v) => v.command.includes("test")), "a test command was invented: " + JSON.stringify(unit));
});

// ── 12. ambiguous component ownership ───────────────────────────────────
test("adversarial: a descriptor with no corroborating artifact fails closed", (t) => {
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("    - service/**/agentdoc.yaml", "    - \"*/**/agentdoc.yaml\""),
    extra: { "stray/README.md": "# Stray\n\nA directory with documentation and nothing that deploys.\n" },
  });
  write(dir, "stray/agentdoc.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: stray\n  description: "A component whose source root contains no deployable artifact."\nspec:\n  type: service\n  system: s1\n');
  const res = compile(dir);
  assert.ok(res.errors.length > 0);
  assert.ok(
    res.errors.some((e) => e.code === "AGENTDOC_ARTIFACT_TYPE"),
    res.errors.map((e) => e.format()).join("\n")
  );
});

test("adversarial: placement of every kind is mutually exclusive", (t) => {
  const dir = baseFixture(t);
  write(dir, "service/agentdoc.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Claims to be in a system and a domain at once."\nspec:\n  type: service\n  system: s1\n  domain: d1\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_SCHEMA"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 13. prohibited fields ───────────────────────────────────────────────
test("adversarial: lifecycle and relation fields are refused in an entity", (t) => {
  for (const field of ["owner: bob", "status: active", "lifecycle: prod"]) {
    const dir = baseFixture(t);
    write(dir, "service/agentdoc.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Carries a field that has no place in a machine-readable entity."\nspec:\n  type: service\n  system: s1\n  ' + field + "\n");
    const res = compile(dir);
    assert.ok(
      res.errors.some((e) => e.code === "AGENTDOC_PROHIBITED_FIELD" || e.code === "AGENTDOC_SCHEMA"),
      field + " -> " + res.errors.map((e) => e.format()).join("\n")
    );
  }
});

test("adversarial: an authored relation is refused; relations are derived", (t) => {
  const dir = baseFixture(t);
  write(dir, "service/agentdoc.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Tries to author its own relations."\nspec:\n  type: service\n  system: s1\n  relations:\n    - uses: something\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_RELATION_AUTHORED"), res.errors.map((e) => e.format()).join("\n"));
});

// ── 14. schema evolution ────────────────────────────────────────────────
test("adversarial: an unknown field is rejected rather than ignored", (t) => {
  const dir = baseFixture(t);
  write(dir, "service/agentdoc.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Carries a field the schema does not define."\nspec:\n  type: service\n  system: s1\n  mysteryField: true\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_UNKNOWN_FIELD" || e.code === "AGENTDOC_SCHEMA"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: an unknown apiVersion is refused, so a future format cannot be silently half-read", (t) => {
  const dir = baseFixture(t);
  write(dir, "service/agentdoc.yaml", 'apiVersion: agentdoc.dev/v2\nkind: Component\nmetadata:\n  name: svc\n  description: "Declares a format this compiler does not implement."\nspec:\n  type: service\n  system: s1\n');
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_API_VERSION"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: an unknown adapter name is a configuration error", (t) => {
  const dir = baseFixture(t, { config: DEFAULT_CONFIG.replace("  - node", "  - node\n  - does-not-exist") });
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_CONFIG" && /unknown adapter/.test(e.message)), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: an authority rule that elects nothing useful is refused at construction", (t) => {
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("authority:", "authority:").replace("  rules: []",
      "  rules:\n" +
      "    - id: bad\n" +
      "      keyPattern: ' schedule\\\\.'\n" +
      "      elect: [UNRESOLVED]\n" +
      '      rationale: "Electing the unresolved class elects nothing."\n' +
      '      reviewWhen: "Never."\n'),
  });
  const res = compile(dir);
  assert.ok(
    res.errors.some((e) => e.code === "AGENTDOC_SCHEMA" || e.code === "AGENTDOC_CONFIG"),
    res.errors.map((e) => e.format()).join("\n")
  );
});

// ── 15. graph integrity ─────────────────────────────────────────────────
test("adversarial: every relation endpoint resolves and every relation is corroborated", (t) => {
  const dir = baseFixture(t);
  const res = compile(dir);
  assert.equal(res.errors.length, 0);
  const refs = new Set(res.graph.entities.map((e) => e.ref));
  for (const r of res.graph.relations) {
    assert.ok(refs.has(r.sourceRef), "dangling source: " + r.sourceRef);
    assert.ok(refs.has(r.targetRef), "dangling target: " + r.targetRef);
    assert.ok(r.provenanceIds.length > 0, "uncorroborated relation: " + r.type);
    assert.ok(["AUTHORED", "DERIVED", "OBSERVED_RUNTIME", "REVIEWED_OVERRIDE", "EXTERNAL_STANDARD"].includes(r.evidenceClass));
  }
});

test("adversarial: a hand-edited graph is rejected by the gate", (t) => {
  const dir = baseFixture(t);
  cli(dir, ["compile"]);
  const g = graphOf(dir);
  g.entities[0].entity.metadata.description = "Something an agent wrote by hand.";
  write(dir, ".agentdoc/graph.json", JSON.stringify(g, null, 2) + "\n");
  const check = cliFails(dir, ["check"]);
  assert.ok(check, "a hand-edited graph must fail");
  assert.match(check.stderr, /STALE/);
});

test("adversarial: the compiler's own schema bundle is complete and self-consistent", () => {
  const { bundle, versionInputs } = loadSchemaBundle();
  for (const id of [
    "agentdoc.dev/schema/config.schema.json",
    "agentdoc.dev/schema/graph.schema.json",
    "agentdoc.dev/schema/common.json",
  ]) {
    assert.ok(bundle.byId.has(id), "missing schema " + id);
  }
  assert.ok(versionInputs.length >= 10);
  assert.ok(versionInputs.every((v) => v.startsWith("schema:")));
});

test("adversarial: a component type that contradicts the artifact fails", (t) => {
  const dir = baseFixture(t);
  // A deployable artifact (Dockerfile) described as an importable library.
  write(dir, "service/agentdoc.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Describes a deployable image as an importable library."\nspec:\n  type: library\n  system: s1\n');
  fs.rmSync(path.join(dir, "service/tsconfig.json"));
  write(dir, "service/package.json", JSON.stringify({ name: "@t/svc", version: "1.0.0", dependencies: { pg: "^8.13.1" } }));
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_ARTIFACT_TYPE"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: reviewed overrides must cite evidence inside a mapped component", (t) => {
  const dir = baseFixture(t);
  // Written after the fixture exists, because the digest is of fixture content.
  write(dir, "agentdoc/agentdoc.config.yaml", DEFAULT_CONFIG.replace("reviewedOverrides: []",
    "reviewedOverrides:\n" +
    "  - fact: api-consumer\n" +
    "    subject: component:default/svc\n" +
    "    target: api:default/svc-api\n" +
    '    reason: "Asserts a consumer with no corroborating file."\n' +
    '    reviewWhen: "when a source reference to the contract appears."\n' +
    "    evidence:\n" +
    evidence(dir, ["package.json"])));
  commitAll(dir);
  const res = compile(dir);
  assert.ok(res.errors.some((e) => e.code === "AGENTDOC_RELATION_KIND" || e.code === "AGENTDOC_CONFIG"), res.errors.map((e) => e.format()).join("\n"));
});

test("adversarial: one fact found by two routes is one edge, and both routes are kept", (t) => {
  // A component that references the OpenAPI contract in its own source *and* is
  // asserted as a consumer by a reviewed override. That is one architectural
  // fact corroborated twice. Emitting it as two edges would make a repository's
  // edge count measure adapter overlap rather than architecture — and, worse,
  // would hide a reviewed override behind a derived edge with the same endpoints.
  const dir = baseFixture(t, {
    extra: {
      "client/agentdoc.yaml": 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: client\n  description: "Consumes the published surface."\nspec:\n  type: service\n  system: s1\n',
      "client/package.json": JSON.stringify({ name: "@t/client", version: "1.0.0", dependencies: { "@t/svc": "^1.0.0" } }),
      "client/src/index.ts": "// see ../../contracts/svc.openapi.yaml\nexport const N = 1;\n",
    },
  });
  // Written after the fixture exists, because the override pins the digest of
  // client/src/index.ts and that is only knowable once the file is written.
  // `client` is a component distinct from the API's own provider: the provider
  // is deliberately never counted as a consumer of its own contract.
  write(dir, "agentdoc/agentdoc.config.yaml", DEFAULT_CONFIG
    .replace("    - service/**/agentdoc.yaml", "    - service/**/agentdoc.yaml\n    - client/agentdoc.yaml")
    .replace("reviewedOverrides: []",
      "reviewedOverrides:\n" +
      "  - fact: api-consumer\n" +
      "    subject: component:default/client\n" +
      "    target: api:default/svc-api\n" +
      '    reason: "The client calls the published surface; a source reference confirms it."\n' +
      '    reviewWhen: "when the OpenAPI client generator covers this component."\n' +
      "    evidence:\n" +
      evidence(dir, ["client/src/index.ts"])));
  commitAll(dir);
  cli(dir, ["compile"]); // throws on failure, which is the assertion
  const g = graphOf(dir);
  const forward = g.relations.filter(
    (r) => r.type === "consumesApi" && r.sourceRef === "component:default/client" && r.targetRef === "api:default/svc-api"
  );
  assert.equal(forward.length, 1, "expected exactly one edge, got " + forward.length + ": " + JSON.stringify(forward));

  // The merged edge must carry every derivation route that found it, otherwise
  // merging has silently thrown away the second, independent observation.
  const via = forward[0].attributes.via;
  assert.ok(Array.isArray(via), "expected `via` to be a sorted list, got " + JSON.stringify(via));
  assert.ok(via.includes("reviewed-override"), "lost the override route: " + JSON.stringify(via));
  assert.ok(via.some((v) => v !== "reviewed-override"), "lost the source-reference route: " + JSON.stringify(via));
  assert.deepEqual([...via].sort(), via, "via must be sorted for determinism");
  assert.ok(forward[0].provenanceIds.length >= 2, "merged edge lost provenance");

  // The inverse must exist exactly once too, or the graph asserts a one-way edge.
  const inverse = g.relations.filter(
    (r) => r.type === "apiConsumedBy" && r.sourceRef === "api:default/svc-api" && r.targetRef === "component:default/client"
  );
  assert.equal(inverse.length, 1, "expected exactly one inverse edge, got " + inverse.length);
});

test("adversarial: attributes that name a specific instance keep edges apart", (t) => {
  // The counterpart to the test above, and the reason `via` is excluded from a
  // relation's identity while `route` is not. One scheduler pointing at two
  // routes of the same API is two real edges; merging them would erase a fact
  // the repository genuinely states, and for a scheduler the route is the only
  // thing that tells an agent which job to look at.
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG
      .replace("    - service/**/agentdoc.yaml", "    - service/**/agentdoc.yaml\n    - worker/agentdoc.yaml")
      .replace("adapters:\n  - node", "adapters:\n  - wrangler\n  - node"),
    extra: {
      "worker/package.json": JSON.stringify({ name: "@t/worker", version: "1.0.0" }),
      "worker/agentdoc.yaml":
        'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: worker\n  description: "Runs the scheduled jobs."\nspec:\n  type: service\n  system: s1\n',
      "worker/wrangler.toml":
        'name = "worker"\n' +
        '[vars]\n' +
        'CRON_A = "https://svc.example.com/api/cron/a"\n' +
        'CRON_B = "https://svc.example.com/api/cron/b"\n',
      // The API provider implements both routes; the scheduler does not own them.
      "service/src/cron.ts": 'export const A = "/api/cron/a";\nexport const B = "/api/cron/b";\n',
    },
  });
  commitAll(dir);
  cli(dir, ["compile"]); // throws on failure, which is the assertion
  const g = graphOf(dir);
  // Guard the setup itself, before the assertion that depends on it. A
  // `.replace` that does not match leaves the adapter disabled, and an
  // assertion on an empty list then passes for the wrong reason.
  assert.ok(
    read(dir, "agentdoc/agentdoc.config.yaml").includes("- wrangler"),
    "the wrangler adapter was not enabled; this test would pass vacuously"
  );

  // `schedules` runs scheduler -> provider; its inverse `scheduledBy` runs
  // provider -> scheduler. Both must carry one edge per route.
  const routes = g.relations
    .filter((r) => r.type === "schedules" && r.sourceRef === "component:default/worker")
    .map((r) => r.attributes.route)
    .sort();
  assert.deepEqual(routes, ["/api/cron/a", "/api/cron/b"], "distinct routes must stay distinct edges: " + JSON.stringify(routes));

  const inverse = g.relations
    .filter((r) => r.type === "scheduledBy" && r.targetRef === "component:default/worker")
    .map((r) => r.attributes.route)
    .sort();
  assert.deepEqual(inverse, ["/api/cron/a", "/api/cron/b"], "inverse must mirror: " + JSON.stringify(inverse));
});

test("adversarial: a reviewed override stops applying when its cited evidence is rewritten", (t) => {
  // A REVIEWED_OVERRIDE is the highest-authority input the model accepts, and the
  // only thing that can falsify it is the evidence it cites. If that evidence can
  // be rewritten while the override survives, a stale human judgement is silently
  // promoted to fact and the graph ships a digest matching no file. This is the
  // same discipline warning acceptances already applied, for the same reason.
  const dir = baseFixture(t, {
    extra: {
      "client/agentdoc.yaml": 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: client\n  description: "Consumes the published surface."\nspec:\n  type: service\n  system: s1\n',
      "client/package.json": JSON.stringify({ name: "@t/client", version: "1.0.0" }),
      "client/src/index.ts": "export const N = 1;\n",
    },
  });
  const withOverride = () => DEFAULT_CONFIG
    .replace("    - service/**/agentdoc.yaml", "    - service/**/agentdoc.yaml\n    - client/agentdoc.yaml")
    .replace("reviewedOverrides: []",
      "reviewedOverrides:\n" +
      "  - fact: api-consumer\n" +
      "    subject: component:default/client\n" +
      "    target: api:default/svc-api\n" +
      '    reason: "The client calls the published surface over HTTP."\n' +
      '    reviewWhen: "when the client is generated from the contract."\n' +
      "    evidence:\n" +
      evidence(dir, ["client/src/index.ts"]));
  write(dir, "agentdoc/agentdoc.config.yaml", withOverride());
  commitAll(dir);

  // Baseline: the override applies.
  assert.equal(compile(dir).errors.length, 0, "baseline override should be clean");

  // The cited evidence is rewritten. The override must stop applying.
  write(dir, "client/src/index.ts", "export const N = 2;\n");
  commitAll(dir);
  const res = compile(dir);
  const stale = res.errors.filter((e) => e.code === "AGENTDOC_OVERRIDE_STALE");
  assert.equal(stale.length, 1, "expected one stale-override error, got: " + res.errors.map((e) => e.format()).join("\n"));
  assert.match(stale[0].message, /client\/src\/index\.ts/, "the error must name the file: " + stale[0].message);
  assert.match(stale[0].message, /review/, "the error must ask for a review: " + stale[0].message);

  // Updating the digest is the documented repair, and must restore the override.
  write(dir, "agentdoc/agentdoc.config.yaml", withOverride());
  commitAll(dir);
  assert.equal(compile(dir).errors.length, 0, "re-pinning the digest should restore the override");
});

test("adversarial: a reviewed override must state when it is re-examined", (t) => {
  // A review that names no re-examination condition is a review that is never
  // revisited. A default string here would be the same sentence on every
  // override: a review condition that conditions nothing, reported as though it
  // were real.
  const dir = baseFixture(t, {
    extra: {
      "client/agentdoc.yaml": 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: client\n  description: "Consumes the published surface."\nspec:\n  type: service\n  system: s1\n',
      "client/package.json": JSON.stringify({ name: "@t/client", version: "1.0.0" }),
      "client/src/index.ts": "export const N = 1;\n",
    },
  });
  write(dir, "agentdoc/agentdoc.config.yaml", DEFAULT_CONFIG
    .replace("    - service/**/agentdoc.yaml", "    - service/**/agentdoc.yaml\n    - client/agentdoc.yaml")
    .replace("reviewedOverrides: []",
      "reviewedOverrides:\n" +
      "  - fact: api-consumer\n" +
      "    subject: component:default/client\n" +
      "    target: api:default/svc-api\n" +
      '    reason: "The client calls the published surface over HTTP."\n' +
      "    evidence:\n" +                      // no reviewWhen
      evidence(dir, ["client/src/index.ts"])));
  commitAll(dir);
  const res = compile(dir);
  assert.ok(
    res.errors.some((e) => e.code === "AGENTDOC_SCHEMA" && /reviewWhen/.test(e.message)),
    "an override without reviewWhen must be rejected: " + res.errors.map((e) => e.format()).join("\n")
  );
});


test("adversarial: two declared clients of one Resource stay two edges", (t) => {
  // `via` records the mechanism that found an edge; a configured matcher name is
  // data about *which* dependency it is. When the name was encoded in `via` it
  // fell outside the relation's identity, so a component depending on two
  // declared clients of the same Resource type merged into one edge and the
  // graph stated one dependency where the repository declares two.
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG,
  });
  // Configure two declared clients, both resolving to the single logical-dataset
  // Resource the fixture already declares.
  // Two declared clients, both resolving to the single logical-dataset Resource
  // the fixture already declares.
  const declared =
    "  externalDependencies:\n" +
    "    - match: ^pg$\n      name: pg-client\n      mechanism: sdk\n      role: primary store client\n      resourceType: logical-database\n" +
    "    - match: ^redis$\n      name: redis-client\n      mechanism: sdk\n      role: cache client\n      resourceType: logical-database\n";
  write(dir, "agentdoc/agentdoc.config.yaml",
    read(dir, "agentdoc/agentdoc.config.yaml").replace("  contractRoots:", declared + "  contractRoots:"));
  write(dir, "service/package.json", JSON.stringify({
    name: "@t/svc", version: "1.0.0", main: "dist/index.js",
    scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
    dependencies: { pg: "^8.13.1", redis: "^4.0.0" },
  }));
  commitAll(dir);
  cli(dir, ["compile"]); // throws on failure, which is the assertion
  const g = graphOf(dir);
  // Only the declared-client edges are under test; the migrations-derived edge
  // to the same Resource is a separate fact and must not be conflated with them.
  const edges = g.relations.filter(
    (r) => r.type === "usesResource" && r.sourceRef === "component:default/svc" && r.attributes.client !== undefined
  );
  const clients = edges.map((r) => r.attributes.client).sort();
  assert.equal(edges.length, 2, "two declared clients of one Resource must stay two edges, got: " + JSON.stringify(edges));
  assert.deepEqual(clients, ["pg-client", "redis-client"], "each edge must name its own client: " + JSON.stringify(clients));
  for (const e of edges) {
    assert.ok(
      (e.attributes.via || []).includes("declared-client"),
      "via must record the route that found the edge: " + JSON.stringify(e.attributes)
    );
  }

  // The same dependency can also be reached by a *mechanism* route — here the
  // migrations+connection extractor, which is how the fixture's own database
  // dependency is detected. Both routes describe one dependency, so they must
  // merge. When only the declared route carried the instance key, the two had
  // different identities and one dependency shipped as two edges: the same
  // duplication the identity rule exists to prevent, arriving by another door.
  // This fixture declares TWO clients of `logical-database`, so no mechanism
  // route can name one without guessing — and guessing is what the authority
  // model forbids. The helper must therefore decline, and the migration-derived
  // edge stands on its own with no `client` key. What is asserted is that the
  // *declared* routes each kept their own key, which is the case that regressed.
  const migrations = g.relations.filter(
    (r) => r.type === "usesResource" && r.sourceRef === "component:default/svc" &&
      (r.attributes.via || []).includes("migrations+connection")
  );
  assert.equal(migrations.length, 1, "the migrations route must not multiply: " + JSON.stringify(migrations));
  assert.equal(
    migrations[0].attributes.client, undefined,
    "with an ambiguous resourceType the mechanism route must not pick a client: " + JSON.stringify(migrations[0].attributes)
  );

  const inverse = g.relations.filter(
    (r) => r.type === "resourceUsedBy" && r.sourceRef === "resource:default/svc-postgres" && r.targetRef === "component:default/svc"
  );
  const perClient = new Set(inverse.map((r) => r.attributes.client).filter(Boolean));
  assert.deepEqual([...perClient].sort(), ["pg-client", "redis-client"], "the inverse must mirror each client: " + JSON.stringify(inverse));
});

test("adversarial: a reviewed override stays REVIEWED_OVERRIDE when corroborated", (t) => {
  // The relation and the assertion describe the same fact, so they must not
  // disagree about its authority. Labeling a relation's evidence by strength
  // relabelled a reviewed override that a source reference had corroborated as
  // AUTHORED — the strongest class in the model — while its assertion still read
  // REVIEWED_OVERRIDE. The graph then understated its own highest-authority
  // input, which is the failure mode the authority model exists to prevent.
  const dir = baseFixture(t, {
    extra: {
      "client/agentdoc.yaml": 'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: client\n  description: "Consumes the published surface."\nspec:\n  type: service\n  system: s1\n',
      "client/package.json": JSON.stringify({ name: "@t/client", version: "1.0.0" }),
      "client/src/index.ts": "// see ../../contracts/svc.openapi.yaml\nexport const N = 1;\n",
    },
  });
  write(dir, "agentdoc/agentdoc.config.yaml", DEFAULT_CONFIG
    .replace("    - service/**/agentdoc.yaml", "    - service/**/agentdoc.yaml\n    - client/agentdoc.yaml")
    .replace("reviewedOverrides: []",
      "reviewedOverrides:\n" +
      "  - fact: api-consumer\n" +
      "    subject: component:default/client\n" +
      "    target: api:default/svc-api\n" +
      '    reason: "The client calls the published surface over HTTP."\n' +
      '    reviewWhen: "when the client is generated from the contract."\n' +
      "    evidence:\n" +
      evidence(dir, ["client/src/index.ts"])));
  commitAll(dir);
  cli(dir, ["compile"]); // throws on failure, which is the assertion
  const g = graphOf(dir);

  const rel = g.relations.find(
    (r) => r.type === "consumesApi" && r.sourceRef === "component:default/client" && r.targetRef === "api:default/svc-api"
  );
  assert.ok(rel, "expected the merged consumesApi edge");

  // Both routes must be present, so this is genuinely a corroborated edge and
  // not a case where the override silently did not apply.
  assert.ok((rel.attributes.via || []).includes("reviewed-override"), "the override route is missing: " + JSON.stringify(rel.attributes));
  assert.ok(rel.provenanceIds.length >= 2, "expected corroborating provenance, got " + rel.provenanceIds.length);

  assert.equal(
    rel.evidenceClass, "REVIEWED_OVERRIDE",
    "a corroborated reviewed override must not be relabelled AUTHORED: " + rel.evidenceClass
  );

  // And the graph must agree with itself: the assertion for the same fact.
  const assertion = g.assertions.find((a) => a.subject === "component:default/client" && a.key.startsWith("api-consumer."));
  assert.ok(assertion, "expected an api-consumer assertion for the client");
  assert.equal(
    assertion.evidenceClass, "REVIEWED_OVERRIDE",
    "assertion and relation disagree about the same fact: " + assertion.evidenceClass
  );
  assert.equal(rel.evidenceClass, assertion.evidenceClass, "the graph contradicts itself about one fact");
});

// ── degradeOnStale is a gate-time judgement, never compile-time ──────────
test("adversarial: degradeOnStale degrades a stale election at gate time, not inside the graph", (t) => {
  const staleObs = OBSERVATION.replace("2099-01-01", "2020-01-01");
  const degradeRule = SCHEDULE_RULE.replace(
    '      reviewWhen: "Review when the scheduler configuration changes."',
    '      reviewWhen: "Review when the scheduler configuration changes."\n      degradeOnStale: unresolved'
  );
  const dir = baseFixture(t, {
    config: DEFAULT_CONFIG.replace("  rules: []", degradeRule).replace("  - openapi", "  - openapi\n  - wrangler"),
    extra: {
      "agentdoc/observations/production.yaml": staleObs,
      "agentdoc/observations/production/evidence.json": EVIDENCE,
      // The manifest claims a different schedule than the runtime reported, so
      // there is a real contradiction and a real election to degrade.
      "service/wrangler.toml": 'name = "svc"\nmain = "src/index.ts"\n\n[triggers]\ncrons = ["5 4 * * *"]\n',
    },
  });
  commitAll(dir, "observation + degrade rule");

  // Compile must not consult the wall clock: identical inputs give identical
  // bytes on any day. The election stands in the graph; degradation is a
  // gate-time verdict.
  const res = compile(dir);
  assert.equal(res.errors.length, 0, res.errors.map((e) => e.format()).join("\n"));
  const c = res.graph.conflicts.find((x) => x.key === "schedule.cron");
  assert.ok(c, "expected a schedule.cron conflict");
  assert.equal(c.status, "resolved", "compile must keep the election — staleness is a gate-time judgement");
  assert.ok(!/days old/.test(c.election.rationale || ""), "wall-clock phrasing leaked into the graph");

  cli(dir, ["compile"]);
  const check = cliFails(dir, ["check"]);
  assert.ok(check && /OBSERVATION_STALE/.test(check.stderr), "stale observation must fail the gate");
  const allowed = cliFails(dir, ["check", "--allow-stale-observations"]);
  assert.ok(allowed, "degradeOnStale:unresolved must fail the gate on a stale election");
  assert.match(allowed.stderr, /degrade to unresolved/);
});
