# agentdoc CLI reference

The binary is `agentdoc`, installed once per machine. Every command that
operates on a catalog can be run from any subdirectory of the repository: the
configuration is found by walking up to `agentdoc/agentdoc.config.yaml`. No
command ever needs the agentdoc source tree or a path to it.

Exit codes: `0` ok, `1` failure, `2` usage.

## Meta

```bash
agentdoc --version          # installed version
agentdoc --help             # command list (also: agentdoc <command> --help)
agentdoc doctor             # machine check: is this CLI install healthy
agentdoc doctor --project   # the same, plus the current project's catalog health
```

`doctor` answers "is the CLI itself healthy": supported Node, schema bundle,
compiler version. It never fails because a project is not configured yet.
`doctor --project` additionally checks `agentdoc/agentdoc.config.yaml` exists,
parses, and that the repository root is writable — run it inside a project.

## Onboarding

```bash
agentdoc init [--force]     # write agentdoc/agentdoc.config.yaml + doc skeleton
agentdoc audit              # inventory the repo, classify every fact (JSON)
agentdoc scaffold [--write] # generate descriptors for what can be proven
```

`init` never overwrites an existing file without `--force`, and run inside a
subdirectory of a cataloged repository it writes at the catalog root, not the
current directory. `scaffold` is a dry run without `--write`; with `--write` it
is a superset of `init` — it also installs anything missing from the config,
doc skeleton and CI workflow, not only component descriptors. `audit` works
even when the repository cannot compile yet; it reports the compilation
failures as part of its output.

## Validation

```bash
agentdoc validate                       # sources + schemas + semantic checks
agentdoc compile [--require-clean]      # deterministic graph build, atomic write
agentdoc check [--require-clean] [--allow-stale-observations]
```

`compile` writes `.agentdoc/graph.json` (or the path in `output.graph`).
`check` is the gate: it fails on a stale or hand-edited graph, a compiler or
schema version mismatch, an observation past its declared `maxAgeDays`, and —
with `--require-clean` — catalog inputs that differ from `HEAD`.

## Query and impact

```bash
agentdoc query <path|entity-ref>          # compact markdown context
agentdoc query <path|entity-ref> --json   # full payload
agentdoc query <path> --budget relations=10,verification=4
agentdoc impact <paths...>                # what a change forces consistent
agentdoc impact --diff <git-ref>          # the same, for a commit range
```

`query` refuses a stale graph — it never falls back to one. `impact` answers a
question about the working tree, so it compiles in memory instead: run it
*before* rebuilding.

Entity refs look like `component:<namespace>/<name>` — `query --json` returns
`entity.ref` values you can reuse.

## Maintenance

```bash
agentdoc pin-evidence [--json]   # which pinned evidence digests are current
agentdoc eval routing [--json]   # routing evaluation (meaningful on a source
                                 # checkout; exits SKIP on other repositories)
```

Reviewed overrides pin their evidence by content hash, re-verified on every
compile. `pin-evidence` reports `CURRENT` / `STALE` / `MISSING` per entry so a
digest can be updated without computing SHA-256 by hand. It exits `1` when any
entry is not current.

## Error output

Diagnostics are lines of the form `ERROR <CODE>: <message>` on stderr, with a
JSON stats object. `WARN` lines are non-fatal; `WARN ACCEPTED` lines carry the
acceptance classification and reason. The full code registry is
`core/codes.mjs` in the agentdoc source; the operator-facing table is in
`docs/CI.md` of the repository.
