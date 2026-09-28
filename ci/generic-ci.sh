#!/usr/bin/env sh
# The drift gate, runner-agnostic. Any CI system that can run a shell can run
# this. Exit status is the contract.
set -eu

AGENTDOC="node agentdoc/bin/agentdoc.mjs"

echo "==> validate"
$AGENTDOC validate

echo "==> compile"
$AGENTDOC compile

echo "==> check (freshness, determinism, time gates)"
$AGENTDOC check

echo "==> check (clean source required)"
$AGENTDOC check --require-clean

echo "==> unit and adversarial tests"
node --test agentdoc/tests/*.test.mjs

echo "==> routing evaluation"
if [ -f agentdoc/evals/run-all.mjs ]; then
  node agentdoc/evals/run-all.mjs
else
  $AGENTDOC eval routing
fi

echo "agentdoc: all gates passed"
