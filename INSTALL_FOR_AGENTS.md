# Install AgentDoc — instructions for an AI coding agent

This document has exactly one job: get the `agentdoc` CLI installed and verified
on the current machine. It is **not** a project workflow. Do not look for a
project root, do not run `init`, `audit`, `scaffold`, or `check`, do not create
`.agentdoc/` or `agentdoc/`, and do not modify any software project. The task
ends when the CLI is installed and verified.

## 1. Inspect the environment

```bash
uname -a            # OS and architecture
echo "$SHELL"       # current shell
node --version      # is Node present, and which major
npm --version       # is npm present
command -v git      # is git present (needed to install from GitHub)
```

## 2. Ensure a supported Node

AgentDoc requires **Node 22 or newer** (22, 24 and 26 are the tested
baselines). If `node` is missing or older than 22, install or switch to a
supported release using whatever the machine already has — `nvm`, `fnm`,
`mise`, `brew`, or the package manager — then re-check `node --version`.

If no Node toolchain exists and none can be installed without a human (for
example a managed machine), stop and report that prerequisite.

## 3. Install or upgrade the CLI

Canonical install, from the AgentDoc GitHub repository:

```bash
npm install -g github:lbframe/agent-doc-system
```

The command is idempotent: run it again to upgrade to the latest `main`.
If a specific ref is required, append it: `github:lbframe/agent-doc-system#<ref>`.

The package has zero runtime dependencies. If `npm install -g` fails on
permissions, do **not** use `sudo`; fix the npm global prefix instead
(`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`),
or report the blocker.

## 4. Verify the binary resolves

```bash
command -v agentdoc     # must print a path
agentdoc --version      # must print a version
agentdoc doctor         # machine self-check; must exit 0
```

`agentdoc doctor` reports the Node version, the schema bundle and the compiler
version, and fails if the installation itself is unhealthy. It never requires a
project — run it from anywhere.

## 5. Report and stop

Report the installed version and that `doctor` passed. The installation task is
complete. Do not proceed into any repository, catalog, or migration work.
