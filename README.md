# agentdoc — portable documentation & software-catalog system

Zero runtime dependencies. One Node runtime. AgentDoc compiles a repository
into one deterministic graph and routes a path or an entity to the minimum
context needed to change it safely.

It exists to answer one question cheaply and correctly, for an AI coding agent
or a human reviewer:

> I am about to change *this*. What do I need to know, what must I keep
> consistent, and which command proves it?

It does that while keeping three kinds of claim apart — what the repository
*claims*, what can be *derived* from code, and what was *observed* running —
and surfacing their disagreements as conflicts instead of guessing.

## Install the CLI

The CLI is installed once per machine. Requires Node 22 or newer (22, 24 and
26 are the tested baselines).

```bash
npm install -g github:lbframe/agent-doc-system

agentdoc --version
agentdoc doctor        # machine self-check
```

Unpinned installs track `main`. For reproducible CI, pin a tag or commit:
`github:lbframe/agent-doc-system#v1.0.0`.

The install footprint is the CLI only — `bin/`, `core/`, `adapters/`,
`schemas/`, `templates/`, `evals/`, docs and the agent skill. Nothing is ever
copied into a project that uses AgentDoc.

### Have an AI agent install it for you

Paste this into a capable coding agent:

```text
Install AgentDoc on this machine from:
https://github.com/lbframe/agent-doc-system

Read INSTALL_FOR_AGENTS.md from that repository and follow it completely.

Do not initialize, inspect, migrate, or modify any software project as part of
this installation task.

When finished, verify the AgentDoc CLI and report the installed version.
```

[`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md) contains the procedure.

## Use it in a project

From the repository root:

```bash
cd my-project
agentdoc doctor --project   # is there a catalog here, and is it healthy
agentdoc audit              # inventory the repo, classify every fact
```

Then follow the workflow the audit implies:

| workflow | when | entry point |
|---|---|---|
| CREATE | no catalog exists | `agentdoc init`, then `agentdoc scaffold --write` |
| MIGRATE | established repo, scattered or stale docs | `agentdoc audit`, work the report |
| VALIDATE | before committing, in CI | `agentdoc validate` → `compile` → `check` |
| QUERY | before and during a change | `agentdoc query <path-or-ref>` |
| MAINTAIN | after a change | `agentdoc impact <paths>` |

AgentDoc writes **project data only**: `agentdoc/` (configuration and
descriptors you own), `docs/` skeleton files, `.agentdoc/graph.json` (the
compiled artifact), and a CI workflow. The CLI source is never vendored into
your repository.

## Use it with an AI agent

The agent skill is [`skills/agent-doc-system/`](skills/agent-doc-system/SKILL.md).
Install that directory as a skill in your agent harness. It teaches the agent
when to use the CLI, the evidence-class model, the working loop, and the
integrity rules — with deeper material under `skills/agent-doc-system/references/`.

## What it is built on

Most repositories conflate three different kinds of claim, and the confusion
is the single largest source of wrong agent behaviour:

| what | who says it | how it fails |
|---|---|---|
| what the repository **claims** | authored docs, config, manifests | drifts, is aspirational, is not tested |
| what can be **derived** from code | imports, manifests, contracts | heuristic, incomplete, wrong about intent |
| what was **observed** in a running system | schedulers, bindings, live APIs | goes stale, disagrees with intent |

A claim carries an evidence class, a confidence, and a pointer to its evidence.
When two classes disagree about the same fact, the disagreement is **surfaced
as a conflict**, not reconciled. There is no global precedence order, because
authority depends on the fact: the committed manifest is authoritative for
*intent*, the live scheduler is authoritative for *what fires*, and the
canonical contract is authoritative for the *desired wire surface* while a
live probe is authoritative for *what is deployed today*.

The default is fail-closed. A fact with no governing authority rule and
disagreeing evidence is an error, and no gate passes while it stands.

## Documentation

| file | covers |
|---|---|
| [`skills/agent-doc-system/SKILL.md`](skills/agent-doc-system/SKILL.md) | how an agent uses the system |
| [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) | machine installation, for an AI agent |
| [docs/SPEC.md](docs/SPEC.md) | the normative specification: entities, graph, determinism |
| [docs/AUTHORITY.md](docs/AUTHORITY.md) | evidence classes, conflict semantics, elections |
| [docs/PROVENANCE.md](docs/PROVENANCE.md) | evidence records, pointers, secret handling |
| [docs/QUERY.md](docs/QUERY.md) | the context router, budgets, freshness refusal |
| [docs/MIGRATION.md](docs/MIGRATION.md) | CREATE and MIGRATE workflows |
| [docs/CI.md](docs/CI.md) | the drift gate and its failure modes |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | writing an adapter, and what must never live in one |
| [docs/EVALS.md](docs/EVALS.md) | the routing benchmark and pre-registered thresholds |
| [docs/COMPARISON-KODA.md](docs/COMPARISON-KODA.md) | measured comparison against the reference corpus |

## Fixtures and the golden corpus

- `fixtures/a-node-ts-postgres` — single Node/TypeScript service, REST, Postgres, GitHub Actions.
- `fixtures/b-go-multi-service` — multi-service Go repository, protobuf contracts, shared library, resources.
- `fixtures/c-alt-monorepo` — deliberately *not* `apps/`+`packages/`+`workers/`, mixed runtimes, inconsistent pre-existing docs.
- `examples/koda` — the profile that represents a large, mature, TypeScript+Go monorepo, including the runtime-observation conflicts that motivated the authority model.

## Development

```bash
node --test tests/*.test.mjs   # unit, adversarial and mode tests
node evals/run-all.mjs         # aggregate routing evaluation (gate)
npm run selfcheck              # agentdoc doctor, from the source checkout
```

## Licence of the design

The architecture, the fail-closed discipline, the provenance model and the
warning-acceptance mechanism are extracted from a production catalog system
that proved them at scale. The namespace, schemas, adapters, CLI and authority
model here are new and neutral.
