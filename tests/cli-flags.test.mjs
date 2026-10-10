// CLI flag declarations (issue #7).
//
// A flag the CLI does not know used to be ignored, so `check --strcit` ran a
// plain, non-strict check and exited 0. Flags are now declared per command in
// bin/commands.mjs; these tests pin that an undeclared flag is a usage error,
// that every command documents exactly what it accepts, and that the CLI
// cannot read a flag its help does not show.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SYSTEM_ROOT, baseFixture } from "./helpers.mjs";
import { COMMANDS, flagsOf, commandHelp } from "../bin/commands.mjs";

const BIN = path.join(SYSTEM_ROOT, "bin", "agentdoc.mjs");

function run(args, cwd = SYSTEM_ROOT) {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("CLI: a misspelled gate flag is a usage error with a suggestion, not a green gate", (t) => {
  const dir = baseFixture(t, {});
  run(["compile"], dir);
  const r = run(["check", "--strcit"], dir);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /unknown flag --strcit/);
  assert.match(r.stderr, /did you mean --strict\?/);
  assert.match(r.stderr, /agentdoc check --help/);
});

test("CLI: a flag valid for another command is rejected and says where it belongs", () => {
  const r = run(["query", "--strict", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --strict \(--strict is accepted by: check\)/);
});

test("CLI: rejection happens before any work, for every command", () => {
  for (const cmd of Object.keys(COMMANDS)) {
    const r = run([cmd, "--definitely-not-a-flag"]);
    assert.equal(r.status, 2, cmd + ": " + r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp("agentdoc " + cmd + ": unknown flag"));
  }
});

test("CLI: value flags need a value and boolean flags refuse one", () => {
  let r = run(["query", "x", "--budget"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--budget requires a value/);
  r = run(["check", "--strict=yes"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--strict does not take a value/);
});

test("CLI: every command has its own --help listing exactly the flags it accepts", () => {
  for (const cmd of Object.keys(COMMANDS)) {
    for (const args of [[cmd, "--help"], [cmd, "-h"], ["help", cmd]]) {
      const r = run(args);
      assert.equal(r.status, 0, args.join(" ") + ": " + r.stderr);
      assert.equal(r.stdout, commandHelp(cmd), args.join(" "));
    }
    const listed = [...commandHelp(cmd).split("flags:")[1].matchAll(/^ {2}--([a-z-]+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(listed, Object.keys(flagsOf(cmd)).sort(), cmd);
    assert.match(commandHelp(cmd), new RegExp("^usage: " + COMMANDS[cmd].synopsis.replace(/[[\]|.*+?()]/g, "\\$&")));
  }
});

test("CLI: global help, version and unknown commands are unchanged", () => {
  for (const a of ["--help", "-h", "help"]) {
    const r = run([a]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /agentdoc --version/);
  }
  assert.match(run(["--version"]).stdout, /^agentdoc \d/);
  assert.equal(run(["no-such-command"]).status, 2);
  assert.equal(run([]).status, 2);
});

test("CLI: the global usage names every command and points at per-command help", () => {
  const usage = fs.readFileSync(path.join(SYSTEM_ROOT, "bin", "usage.txt"), "utf8");
  for (const cmd of Object.keys(COMMANDS)) assert.match(usage, new RegExp("agentdoc " + cmd + "\\b"), cmd);
  assert.match(usage, /agentdoc <command> --help/);
});

test("CLI: every flag the CLI reads is declared, and every declared flag is read", () => {
  const src = fs.readFileSync(BIN, "utf8");
  // No second way to read argv: a flag read outside opt() would be invisible
  // to both the rejection and the help.
  assert.doesNotMatch(src, /(?<!parsed\.)\bflags\.has\(|\bflag\(|argv\.includes\(/);
  const read = new Set([...src.matchAll(/\bopt\("([a-z-]+)"\)/g)].map((m) => m[1]));
  const declared = new Set(Object.keys(COMMANDS).flatMap((c) => Object.keys(COMMANDS[c].flags)));
  for (const f of read) if (f !== "help") assert.ok(declared.has(f), "read but declared by no command: --" + f);
  for (const c of Object.keys(COMMANDS)) {
    for (const [f, spec] of Object.entries(COMMANDS[c].flags)) {
      if (/always JSON/.test(spec.desc)) continue;
      assert.ok(read.has(f), c + " declares --" + f + " but the CLI never reads it");
    }
  }
});
