# Verification record for this repository.
# Every claim below was executed; the commands are reproducible from the repo root.

node --test tests/*.test.mjs        # unit, adversarial, mode and packaging tests
node evals/run-all.mjs              # aggregate routing gate — verdict: PASS

Corpora (each compiles, checks, and passes its own routing scenarios):
  fixtures/a-node-ts-postgres
  fixtures/b-go-multi-service
  fixtures/c-alt-monorepo
  examples/koda/repo                (golden corpus)

Distribution (covered by tests/packaging.test.mjs):
  npm pack produces a tarball whose installed `agentdoc` binary runs
  --version, --help, doctor, init, doctor --project, audit and
  eval routing with no access to the source checkout.

Also verified:
  - output is byte-identical across three consecutive compiles
  - a checkout with no .git compiles and checks
  - running the test suite does not modify the package
  - a graph that violates its own schema is rejected
  - a reviewed override stops applying when its cited evidence is rewritten
  - `agentdoc init` creates project data only — never a copy of the CLI
  - a catalog nested inside a larger checkout is not dirtied by outer-repo churn

Comparison regeneration (requires the reference graph, kept out of the repo):
  python3 scripts/compare-koda.py <reference-graph> <portable-graph>
