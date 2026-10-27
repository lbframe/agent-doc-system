# BENCHMARK

Two measurements back the numbers in the README. Both are reproducible from a
checkout. Neither involves a model, so phrasing cannot move them.

## Routing quality: `node evals/run-all.mjs`

The routing evaluation is described in [EVALS.md](EVALS.md). It has 30 scenarios
on six repositories (Node, TypeScript, Go, Rust and Python), with thresholds
registered on 2026-09-28 and not moved since. For each scenario, it compares
the context `agentdoc query` + `agentdoc impact` returns with what an agent
gets by reading only the component it is changing.

| | reading the touched component | AgentDoc |
|---|---|---|
| facts the change needs, retrieved | 58% | **100%** |
| retrieved facts that are unrelated (noise) | 40% | **8.7%** |
| share of the repository's checks returned (selectivity) | 100% | **46%** (29% on the golden corpus) |
| context size vs. reading the whole catalog | — | **−70%** |

Every check a scenario requires is in AgentDoc's answer (verification recall
1.0). The baseline never misses one either, because it runs every check in the
repository. Selectivity is therefore the meaningful comparison: the share of
the repository's checks the answer contains, counting everything the agent is
shown. It is reported, not gated; small corpora inflate it, and a
one-component corpus scores 100% because there is nothing to narrow.

The size reduction is measured on the golden corpus (`examples/koda`). The
smaller fixtures hold fewer than 100 facts, so the harness reports their
reduction but does not aggregate it.

## Fresh setup on public repositories: `node scripts/bench/run.mjs`

[`scripts/bench/run.mjs`](../scripts/bench/run.mjs) clones each repository in
[`repos.json`](../scripts/bench/repos.json) at a pinned commit, then does the
following:

1. Runs `agentdoc init` and `agentdoc scaffold --write`.
2. Fills in the one line AgentDoc refuses to decide: each component's placement.
3. Counts every other edit a human would need before the catalog validates. That
   number is the "setup ok" column, and the target is zero.
4. Compiles three times, and checks that the graph is byte-identical.
5. For one production source file per component, measures the `agentdoc query`
   answer (about 4 characters per token) and the `agentdoc impact` result.

Measured with AgentDoc 1.2.0 on Node 24, on a 2019 Intel Core i9 laptop (load average about 4):

| repository | files | setup ok | components | dependency edges | checks | setup + first compile | compile | deterministic | `query` answer, median / max |
|---|---|---|---|---|---|---|---|---|---|
| [tokio-rs/axum](https://github.com/tokio-rs/axum) @ 86aa615 (Rust) | 505 | yes | 4 | 11 | 9 | 1.0 s | 0.5 s | yes | ~151 / 153 tokens |
| [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) @ 5a4d576 (Python, TS) | 5,142 | yes | 8 | 9 | 5 | 4.6 s | 1.9 s | yes | ~112 / 144 tokens |
| [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template) @ f4bcfab (Python, TS) | 252 | yes | 3 | 0 | 9 | 1.0 s | 0.4 s | yes | ~100 / 126 tokens |
| [t3-oss/create-t3-turbo](https://github.com/t3-oss/create-t3-turbo) @ 8f945b7 (TypeScript) | 141 | yes | 13 | 47 | 25 | 1.0 s | 0.4 s | yes | ~158 / 263 tokens |

Timings depend on the machine and its load, so run the script yourself. The
other columns are deterministic for a given AgentDoc version and commit.

### What these numbers do not say

- A `query` answer is a map of what to read, what the change reaches, and which
  checks to run. It does not replace the code, so its size is not a "tokens
  saved" figure.
- "Checks" counts the commands AgentDoc can prove from the repository. For
  example, pydantic-ai's tests live outside the package roots, so AgentDoc
  records none for those packages rather than guess one.
- Four repositories are a smoke test of the setup path, not a survey.
