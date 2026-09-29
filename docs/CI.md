# CI

The graph is a build artifact. The gate proves the committed one is identical to
a fresh compile, so drift fails in CI rather than in a review three weeks later.

## The gate

```yaml
name: agentdoc
on:
  pull_request:
  push:
    branches: [main]
jobs:
  agentdoc:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      # Pin a tag for reproducibility, e.g. github:lbframe/agent-doc-system#v1.0.0 —
      # a compiler upgrade intentionally invalidates every committed graph.
      - run: npm install -g github:lbframe/agent-doc-system
      - run: agentdoc validate
      - run: agentdoc compile
      - run: agentdoc check
      - run: agentdoc check --require-clean
      - run: agentdoc eval routing
```

`agentdoc init` writes this workflow to `.github/workflows/agentdoc.yml` (from
`templates/ci.yml` in the CLI package). The same file is kept at
`docs/ci/github-actions.yml` for reference.

`fetch-depth: 0` is recommended: `--diff <ref>` needs history, and `dirty` is
more meaningful against a real `HEAD`.

**What freshness actually checks.** The input hash (every byte the compiler
read, plus every existence probe, directory listing and walk) and the dirty flag
(whether a compiler input differs from `HEAD`). It deliberately does **not**
compare the graph's recorded commit with `HEAD`: committing the graph changes
`HEAD`, so a commit-equality gate could never be satisfied by a committed graph.
The commit is recorded as provenance — which checkout produced this graph — not
as a gate.

Two things to decide per repository:

- **Commit the graph or ignore it.** Both work. Committing it makes the
  architecture reviewable in the pull request, which is valuable in a mature
  repository. Ignoring it keeps diffs small. The gate works either way, because
  the workflow compiles before checking.
- **Run the routing evaluation or not.** `agentdoc eval routing` skips cleanly
  on a repository with no registered scenarios, so it is safe to run
  everywhere. The aggregate gate over every corpus (`node evals/run-all.mjs`)
  is development tooling — it belongs to this repository's own CI, not to a
  project that merely uses the catalog.

## Failure modes worth knowing

The full list is `core/codes.mjs`; these are the ones an operator meets. A
YAML or schema error names its file and line and needs no table.


| code | what happened | what to do |
|---|---|---|
| `AGENTDOC_STALE_GRAPH` | committed bytes differ from a fresh compile | `compile`, review the graph diff, commit |
| `AGENTDOC_GRAPH_FRESHNESS` | the input hash or the dirty flag disagrees | rebuild; if the input changed, review the change first |
| `AGENTDOC_COMPILER_MISMATCH` | graph built by another compiler version | `compile` and commit; the diff is the upgrade's real effect |
| `AGENTDOC_GRAPH_SCHEMA` | graph schema changed | `compile` and commit |
| `AGENTDOC_GRAPH_MISSING` | no graph at the configured path | `compile` |
| `AGENTDOC_DIRTY_SOURCE` | a catalog input differs from `HEAD` | commit the input, then recompile |
| `AGENTDOC_OBSERVATION_STALE` | an observation passed `maxAgeDays` | re-observe, or restate the fact as authored intent if the divergence is intended |
| `AGENTDOC_CONFLICT_UNRESOLVED` | two classes disagree and no rule governs the key | add an authority rule, or ask a human |
| `AGENTDOC_WARNING_ACCEPTANCE` | an acceptance no longer matches, or its evidence moved | review the disposition, then update the digests |
| `AGENTDOC_SECRET` | secret-shaped input or output | remove the credential; never redact-and-continue |
| `AGENTDOC_NONDETERMINISTIC` | a host path or unsourced timestamp reached the graph | file a defect; this is a compiler bug |
| `AGENTDOC_CONTRACT_UNCLAIMED` | a contract file no API claims | point an API at it, or delete it |
| `AGENTDOC_COMPONENT_UNCORROBORATED` | a descriptor no adapter can corroborate | fix the location, or enable the right adapter |
| `AGENTDOC_BINDING_AMBIGUOUS` | a client matches several Resources of one type | declare which, or review and add an override |
| `AGENTDOC_CONTRACT_SYNTAX` | a contract file is not valid for its declared type | fix the contract; do not change its type |
| `AGENTDOC_OIDC_DISCOVERY` | the provider does not expose its discovery path | fix the provider or the descriptor |
| `AGENTDOC_DUPLICATE_IDENTITY` | two entities claim the same kind and name | rename one |
| `AGENTDOC_COMPILER_MISMATCH` | the compiler was upgraded | `compile` and commit |
| `AGENTDOC_OVERRIDE_STALE` | a reviewed override's cited evidence changed | review the interpretation, then `pin-evidence` and update the digest |
| `AGENTDOC_VERIFICATION_UNTIERED` | a check task has no recognisable tier | name the task, or extend the adapter |

## Ordering inside `check`

1. compilation errors;
2. time-dependent gates (observation staleness, election degradation);
3. graph freshness (`--require-clean`, input hash, compiler/schema versions);
4. byte-for-byte comparison.

Step 2 precedes step 3 on purpose. "Your observation is five years old" and
"rebuild the graph" send the reader to completely different places, and when
both are true the first is the one that matters.

## Merge discipline

- A PR that changes a compiler input must include the recompiled graph. `impact`
  tells you which files are inputs.
- A PR that changes an authority rule must explain why that class is
  authoritative for that key. `rationale` and `reviewWhen` are mandatory, and a
  reviewer should read them.
- A PR that adds a warning acceptance is a reviewed decision. The evidence
  digests are pinned; if the evidence later moves, the acceptance stops
  matching and forces a new review. That is the mechanism working, not failing.
- Never hand-edit `.agentdoc/graph.json`. The gate rejects it, and it would be
  wrong anyway.

## Local parity

```bash
agentdoc validate
agentdoc compile
agentdoc check --require-clean
```

The same commands, the same codes, the same exit status. There is no CI-only
behaviour.

## Other CI systems

The gate is four commands and an exit code. Any runner works:

```sh
set -e
agentdoc validate
agentdoc compile
agentdoc check --require-clean
```

`ci/generic-ci.sh` (next to this document) is exactly that, plus a clear
failure when the `agentdoc` CLI is not installed on the runner.
