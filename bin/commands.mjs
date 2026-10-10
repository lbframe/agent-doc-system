// Command and flag declarations.
//
// One table drives three things: which flags a command accepts, how they are
// parsed, and what `agentdoc <command> --help` prints. Parsing and help read
// the same rows, so they cannot drift. A flag that is not declared for the
// command it is given to is a usage error, never silently ignored: a
// misspelled gate flag (`check --strcit`) must not turn into a green,
// non-strict gate.

const JSON_FLAG = { json: { desc: "print the machine-readable report" } };
// Commands whose output is always JSON accept --json too, as a no-op, so a
// script that says what it expects is not rejected for being explicit.
const JSON_ALWAYS = { json: { desc: "accepted for explicitness; the output is always JSON" } };

export const COMMANDS = {
  init: {
    synopsis: "agentdoc init [--force]",
    summary: "write a configuration and documentation skeleton",
    flags: { force: { desc: "overwrite files that already exist" }, ...JSON_ALWAYS },
  },
  audit: {
    synopsis: "agentdoc audit",
    summary: "inventory the repository and classify every fact (JSON report)",
    flags: { ...JSON_ALWAYS },
  },
  scaffold: {
    synopsis: "agentdoc scaffold [--write]",
    summary: "generate a CREATE-mode skeleton from the audit (dry run by default)",
    flags: { write: { desc: "write the proposed files instead of listing them" }, ...JSON_ALWAYS },
  },
  validate: {
    synopsis: "agentdoc validate",
    summary: "sources, schemas and semantic checks",
    flags: {},
  },
  compile: {
    synopsis: "agentdoc compile [--require-clean]",
    summary: "deterministic graph build (atomic write)",
    flags: { "require-clean": { desc: "refuse when catalog inputs differ from HEAD" } },
  },
  check: {
    synopsis: "agentdoc check [--strict] [--require-clean] [--allow-stale-observations]",
    summary: "freshness, determinism and gate check",
    flags: {
      strict: { desc: "also fail on every warning not accepted in warningAcceptances (the end-of-MIGRATE gate)" },
      "require-clean": { desc: "refuse a graph built from inputs that differ from HEAD" },
      "allow-stale-observations": { desc: "let observations past maxAgeDays through, applying each rule's degradeOnStale" },
    },
  },
  query: {
    synopsis: "agentdoc query <path|ref> [--md] [--json] [--budget section=n,...]",
    summary: "route minimal context for a task",
    flags: {
      md: { desc: "compact markdown context (the default)" },
      ...JSON_FLAG,
      budget: { value: "section=n,...", desc: "cap sections, e.g. relations=10,verification=4; truncation is reported" },
      "require-clean": { desc: "refuse a graph built from inputs that differ from HEAD" },
      "allow-stale-observations": { desc: "let observations past maxAgeDays through, applying each rule's degradeOnStale" },
    },
  },
  impact: {
    synopsis: "agentdoc impact <paths...> | agentdoc impact --diff <git-ref>",
    summary: "what a change forces you to keep consistent",
    flags: {
      diff: { value: "git-ref", desc: "use the files changed since <git-ref> instead of paths" },
      from: { value: "git-ref", desc: "alias of --diff" },
      ...JSON_ALWAYS,
    },
  },
  eval: {
    synopsis: "agentdoc eval routing [--json]",
    summary: "agent-routing evaluation against registered scenarios (SKIP when the repo has none)",
    flags: { ...JSON_FLAG },
  },
  "pin-evidence": {
    synopsis: "agentdoc pin-evidence [--json]",
    summary: "verify digests pinned by reviewed overrides",
    flags: { ...JSON_FLAG },
  },
  doctor: {
    synopsis: "agentdoc doctor [--project]",
    summary: "machine self-check: is this CLI install healthy",
    flags: { project: { desc: "also check the current project's catalog health" }, ...JSON_ALWAYS },
  },
};

// Accepted by every command.
const COMMON_FLAGS = { help: { desc: "show this help" } };

export function flagsOf(cmd) {
  return { ...(COMMANDS[cmd] ? COMMANDS[cmd].flags : {}), ...COMMON_FLAGS };
}

export class UsageError extends Error {}

// Parse argv (without the command) against the command's declaration.
// Returns { flags: Map(name -> true|string), positional }.
export function parseArgs(cmd, args) {
  const declared = flagsOf(cmd);
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h") { flags.set("help", true); continue; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    const spec = declared[name];
    if (!spec) throw new UsageError(unknownFlagMessage(cmd, name));
    if (!spec.value) {
      if (eq >= 0) throw new UsageError("agentdoc " + cmd + ": --" + name + " does not take a value");
      flags.set(name, true);
      continue;
    }
    let v = eq >= 0 ? a.slice(eq + 1) : args[i + 1];
    if (eq < 0) {
      if (v === undefined || v.startsWith("--")) v = "";
      else i++;
    }
    if (!v) throw new UsageError("agentdoc " + cmd + ": --" + name + " requires a value (" + spec.value + ")");
    flags.set(name, v);
  }
  return { flags, positional };
}

function unknownFlagMessage(cmd, name) {
  const own = Object.keys(flagsOf(cmd));
  const near = own
    .map((f) => [f, distance(f, name)])
    .filter(([f, d]) => d <= Math.max(1, Math.floor(f.length / 3)))
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))[0];
  const elsewhere = Object.keys(COMMANDS).filter((c) => c !== cmd && COMMANDS[c].flags[name]);
  let hint = "";
  if (near) hint = " (did you mean --" + near[0] + "?)";
  else if (elsewhere.length) hint = " (--" + name + " is accepted by: " + elsewhere.join(", ") + ")";
  return "agentdoc " + cmd + ": unknown flag --" + name + hint +
    "\nrun `agentdoc " + cmd + " --help` for the flags this command accepts";
}

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // Adjacent transposition: `strcit` is one slip away from `strict`.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

export function commandHelp(cmd) {
  const c = COMMANDS[cmd];
  const flags = flagsOf(cmd);
  const rows = Object.entries(flags).map(([name, spec]) => ["--" + name + (spec.value ? " <" + spec.value + ">" : ""), spec.desc]);
  const width = Math.max(...rows.map((r) => r[0].length));
  return [
    "usage: " + c.synopsis,
    "",
    c.summary,
    "",
    "flags:",
    ...rows.map(([f, d]) => "  " + f.padEnd(width) + "  " + d),
    "",
    "Exit codes: 0 ok, 1 failure, 2 usage.",
    "",
  ].join("\n");
}
