#!/usr/bin/env sh
# The drift gate, runner-agnostic. Any CI system that can run a shell can run
# this. The `agentdoc` CLI must be installed on the runner beforehand; exit
# status is the contract.
set -eu

if ! command -v agentdoc >/dev/null 2>&1; then
  echo "agentdoc: CLI not on PATH — install it first:" >&2
  echo "  npm install -g github:lbframe/agent-doc-system" >&2
  exit 1
fi

echo "==> validate"
agentdoc validate

echo "==> compile"
agentdoc compile

echo "==> check (freshness, determinism, time gates)"
agentdoc check

echo "==> check (clean source required)"
agentdoc check --require-clean

echo "==> routing evaluation (skips cleanly when no scenarios are registered)"
agentdoc eval routing

echo "agentdoc: all gates passed"
