# BENCHMARK

Two measurements are reproducible from a checkout. Neither involves a model;
both depend on the measurement rules described here.

## Routing quality: `node evals/run-all.mjs`

The routing evaluation is described in [EVALS.md](EVALS.md). It has 30 scenarios
on six repositories (Node, TypeScript, Go, Rust and Python), with thresholds
registered on 2026-09-28 and not moved since. For each scenario, it compares
the context `agentdoc query` + `agentdoc impact` returns with what an agent
gets without routing.

The measured systems are catalog routing, a corrected graph-assisted targeted
reference, and working-tree search. Their current results appear below. The
pre-registered thresholds and scenario truth are unchanged.

### Correction: the fact-recall comparison is withdrawn

Until 2026-10-27 this page, the README and the 1.2.0 release notes reported
that AgentDoc retrieves 100% of the facts a change needs, against 58% for a
baseline that reads only the touched component, with noise under 9% against
40%. That comparison does not hold, and it is withdrawn.

- The targeted baseline already holds almost every expected fact, under a
  different label from the ground truth. It records `usesResource:<ref>` where
  the truth says `uses:<ref>`, and `buildDependencyOf:<ref>` where the truth
  names the component `<ref>`. Relabelled, it retrieves about 99% of the
  expected facts.
- The baseline also takes those relations from the compiled graph, which an
  agent without AgentDoc does not have. A fair baseline has to find them with
  search over the repository's files.

The search comparison is now measured. The targeted reference's corrected
micro-recall is 100/101 (99.01%); its scenario-mean recall is 99.17%. The
100%-versus-58% comparison remains withdrawn.

### Search baseline

`baseline-search` starts with touched files, searches source/manifests for
import names and local paths in both directions to a fixed point, and reads
the reached components' docs and checks. Contracts, endpoint strings, event
subjects and resource evidence are found in working-tree files. Catalog
descriptors supply only component identity and path ownership. Retrieval never
reads the compiled graph or compiler relations. All naming guesses, exclusions
and check conventions are listed in [EVALS.md](EVALS.md#search-baseline-heuristics).

| Corpus (scenarios) | System | Mean recall | Noise | Check selectivity |
|---|---|---:|---:|---:|
| Koda (9) | baseline-targeted (corrected) | 100.00% | 41.23% | 100.00% |
| Koda (9) | baseline-search | 71.90% | 71.55% | 100.00% |
| Koda (9) | catalog | 100.00% | 4.02% | 28.79% |
| Node/TS (3) | baseline-targeted (corrected) | 100.00% | 17.86% | 100.00% |
| Node/TS (3) | baseline-search | 91.67% | 30.64% | 83.33% |
| Node/TS (3) | catalog | 100.00% | 0.00% | 100.00% |
| Go (4) | baseline-targeted (corrected) | 93.75% | 28.94% | 100.00% |
| Go (4) | baseline-search | 83.33% | 26.01% | 100.00% |
| Go (4) | catalog | 100.00% | 5.88% | 66.67% |
| Mixed monorepo (4) | baseline-targeted (corrected) | 100.00% | 37.82% | 100.00% |
| Mixed monorepo (4) | baseline-search | 100.00% | 41.25% | 100.00% |
| Mixed monorepo (4) | catalog | 100.00% | 5.88% | 54.17% |
| Rust (4) | baseline-targeted (corrected) | 100.00% | 48.25% | 100.00% |
| Rust (4) | baseline-search | 100.00% | 32.81% | 83.33% |
| Rust (4) | catalog | 100.00% | 0.00% | 25.00% |
| Python (6) | baseline-targeted (corrected) | 100.00% | 46.70% | 100.00% |
| Python (6) | baseline-search | 100.00% | 23.68% | 41.67% |
| Python (6) | catalog | 100.00% | 0.00% | 41.67% |
| Aggregate (30) | baseline-targeted (corrected) | 99.17% | 38.83% | 100.00% |
| Aggregate (30) | baseline-search | 88.51% | 42.61% | 84.44% |
| Aggregate (30) | catalog | 100.00% | 2.77% | 46.42% |

These are scenario means, aggregated by scenario count. Search micro-recall is
85/101 (84.16%), compared with 100/101 (99.01%) for corrected targeted and
101/101 for catalog routing. All three systems retrieve every scenario-required
verification expectation. Selectivity counts distinct registered check IDs,
including repository gates, after matching search's discovered scoped commands.

Search matches catalog fact recall in 21 of 30 scenarios, including all Rust,
Python and mixed-monorepo scenarios. It beats catalog recall in none. The
remaining misses include authored placement, authority conflicts/runtime
observations, and API identities/roles not recoverable by these lexical rules.
Its broad closure can also overreach through shared endpoint strings. This is
a comparison of deterministic retrieval rules on authored corpora, not an agent
session, a limit on search quality, or evidence of time/token savings. Noise is
scored against the catalog's one-hop graph closure and can penalize useful
source facts absent from that graph.

The unchanged relative recall gate passes: corrected targeted ties catalog in
five corpora and trails it in Go. All applicable gates pass. Normalization also
changes noise and deduplicates fact counts: the full Koda inventory now has 86
facts, below the unchanged 100-fact size floor. Aggregate retrieval reduction
is **not measured**, so the former 70% size figure is not a current result.

## Fresh setup on public repositories: `node scripts/bench/run.mjs`

[`scripts/bench/run.mjs`](../scripts/bench/run.mjs) clones each repository in
[`repos.json`](../scripts/bench/repos.json) at a pinned commit, then does the
following:

1. Runs `agentdoc init` and `agentdoc scaffold --write`.
2. Fills in the one line AgentDoc refuses to decide: each component's placement.
3. Counts every other edit a human would need before the catalog validates. That
   number is the "setup ok" column, and the target is zero.
4. Compiles three times, and checks that the graph is byte-identical.
5. For each component with a matching file, samples the first tracked source
   file whose path does not contain `test` (benchmarks and examples may be
   included). It measures the `agentdoc query` answer, at about 4 characters per
   token, and the `agentdoc impact` result.

Measured with AgentDoc 1.2.0 on Node 24, on a 2019 Intel Core i9 laptop (load average about 4):

| repository | files | setup ok | components | dependency edges | checks | init + scaffold + median compile | median compile | deterministic | `query` answer, median / max |
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
