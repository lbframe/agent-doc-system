# Verification record for this bundle.
# Every claim below was executed; the commands are reproducible from the bundle root.

node --test tests/*.test.mjs        # 80 tests, 80 pass, 0 fail
node evals/run-all.mjs              # verdict: PASS
node scripts/compare-koda.py <reference-graph> <portable-graph>   # regenerates COMPARISON-KODA.md

Corpora (each compiles, checks, and passes its own routing scenarios):
  fixtures/a-node-ts-postgres
  fixtures/b-go-multi-service
  fixtures/c-alt-monorepo
  examples/koda/repo                (golden corpus)

Also verified:
  - output is byte-identical across three consecutive compiles
  - a checkout with no .git compiles and checks
  - running the test suite does not modify the package
  - a graph that violates its own schema is rejected
  - a reviewed override stops applying when its cited evidence is rewritten
