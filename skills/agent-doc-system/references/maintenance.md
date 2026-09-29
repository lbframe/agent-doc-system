# Maintaining the catalog

## The gate

`agentdoc check` is the contract. Inside it, in order:

1. compilation errors;
2. time-dependent gates (an observation older than its `maxAgeDays`);
3. graph freshness and byte comparison against a fresh deterministic compile;
4. `--require-clean` (catalog inputs must match `HEAD`).

Step 2 precedes step 3 on purpose: "your observation is five years old" and
"rebuild the graph" send the reader to different places, and when both are true
the first is the one that matters.

## Discipline

- Any PR that changes a compiler input must recompile and commit the graph.
  `agentdoc impact <paths>` tells you which files are inputs.
- Never hand-edit `.agentdoc/graph.json`. The gate rejects it, and it would be
  wrong anyway.
- A change to a warning acceptance is a deliberate act: the acceptance pins the
  evidence digests it was written against, and changing the evidence
  invalidates it on purpose.
- An observation is a promise about freshness. Re-observe before `maxAgeDays`,
  or restate the fact as authored intent if the divergence is intended.
- Schema and compiler versions are recorded in the graph. Upgrading the CLI
  invalidates every graph; recompile, review the diff, commit.
- `agentdoc pin-evidence` reports which reviewed-override digests are current
  so stale evidence can be re-pinned without computing SHA-256 by hand.

## CI

`agentdoc init` writes `.github/workflows/agentdoc.yml`: validate, compile,
check, `check --require-clean`. The runner installs the CLI
(`npm install -g github:lbframe/agent-doc-system`). Any other runner works the
same way — the gate is four commands and an exit code; `docs/CI.md` in the
repository lists the failure codes and what each one asks of you.

## Packaging final evidence

When you finish a task in a cataloged repository, hand over:

1. `agentdoc check` output (must pass).
2. `agentdoc query <path> --json` for each surface you touched.
3. `agentdoc impact <changed files>` showing what you kept consistent.
4. For any conflict you encountered: both values, their evidence, the election,
   and your recommendation.
5. Anything left `UNRESOLVED`, stated as unresolved.

Do not summarise a conflict away. The value of this system is that it tells you
when you do not know something.
