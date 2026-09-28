# agentdoc — portable documentation & software-catalog system

Zero runtime dependencies. One Node runtime. Everything the system needs is in
this directory: the compiler, the schemas, the adapters, the templates, the CI
gate, the fixtures and the evaluations.

```
node agentdoc/bin/agentdoc.mjs init      # write a configuration skeleton
node agentdoc/bin/agentdoc.mjs audit     # classify every fact in the repo
node agentdoc/bin/agentdoc.mjs compile   # build the graph
node agentdoc/bin/agentdoc.mjs query apps/foo
node agentdoc/bin/agentdoc.mjs check     # CI gate
```

## What it is

A documentation and catalog system for an AI agent working in a real
repository. It exists to answer one question cheaply and correctly:

> I am about to change *this*. What do I need to know, what must I keep
> consistent, and which command proves it?

It does that by compiling the repository into one deterministic graph, and by
routing a path or an entity to the minimum context that covers it.

## The idea it is built on

Three different kinds of claim get conflated in most repositories, and the
confusion is the single largest source of wrong agent behaviour:

| what | who says it | how it fails |
|---|---|---|
| what the repository **claims** | authored docs, config, manifests | drifts, is aspirational, is not tested |
| what can be **derived** from code | imports, manifests, contracts | heuristic, incomplete, wrong about intent |
| what was **observed** in a running system | schedulers, bindings, live APIs | goes stale, disagrees with intent |

This system keeps them apart. A claim carries an evidence class, a confidence,
and a pointer to its evidence. When two classes disagree about the same fact,
the disagreement is **surfaced as a conflict**, not reconciled. There is no
global precedence order, because authority depends on the fact: the committed
manifest is authoritative for *intent*, the live scheduler is authoritative for
*what fires*, and the canonical contract is authoritative for the *desired wire
surface* while a live probe is authoritative for *what is deployed today*.

The default is fail-closed. A fact with no governing authority rule and
disagreeing evidence is an error, and no gate will pass while it stands.

## Five modes

| mode | command | what it does |
|---|---|---|
| CREATE | `init`, `scaffold` | inventory an undocumented repo and generate a skeleton from what it can prove |
| MIGRATE | `audit` | inventory four truth sources, classify every fact, list what must not be authored |
| VALIDATE | `validate`, `compile`, `check` | prove the graph matches the repository it claims to describe |
| QUERY | `query` | route minimal context for a path or entity; refuse a stale graph |
| MAINTAIN | `impact` | say which components, contracts, docs and gates a change touches |

## Install

Drop this directory into a repository as `agentdoc/`, then:

```bash
node agentdoc/bin/agentdoc.mjs init     # writes agentdoc/agentdoc.config.yaml + doc skeleton
$EDITOR agentdoc/agentdoc.config.yaml   # review the layout, adapters, and the COMMENTED-OUT
                                        # authority rules: init makes no governance decision
node agentdoc/bin/agentdoc.mjs audit    # what is provable, what is not
node agentdoc/bin/agentdoc.mjs compile  # build the graph
node agentdoc/bin/agentdoc.mjs check    # must pass before anything is committed
```

Every command works from any subdirectory, and every command works in a
checkout with no git.

Then wire CI using `templates/ci.yml`, and tell your agent to read
[`SKILL.md`](SKILL.md).

Requires Node 18+ (developed against 22/24). No network, no database, no
service.

## Documentation

| file | covers |
|---|---|
| [SKILL.md](SKILL.md) | how an agent uses the system |
| [SPEC.md](SPEC.md) | the normative specification: entities, graph, determinism |
| [AUTHORITY.md](AUTHORITY.md) | evidence classes, conflict semantics, elections |
| [PROVENANCE.md](PROVENANCE.md) | evidence records, pointers, secret handling |
| [QUERY.md](QUERY.md) | the context router, budgets, freshness refusal |
| [MIGRATION.md](MIGRATION.md) | CREATE and MIGRATE workflows |
| [CI.md](CI.md) | the drift gate and its failure modes |
| [ADAPTERS.md](ADAPTERS.md) | writing an adapter, and what must never live in one |
| [EVALS.md](EVALS.md) | the routing benchmark and pre-registered thresholds |

## Fixtures and the golden corpus

- `fixtures/a-node-ts-postgres` — single Node/TypeScript service, REST, Postgres, GitHub Actions.
- `fixtures/b-go-multi-service` — multi-service Go repository, protobuf contracts, shared library, resources.
- `fixtures/c-alt-monorepo` — deliberately *not* `apps/`+`packages/`+`workers/`, mixed runtimes, inconsistent pre-existing docs.
- `examples/koda` — the profile that represents a large, mature, TypeScript+Go monorepo, including the runtime-observation conflicts that motivated the authority model.

## Licence of the design

The architecture, the fail-closed discipline, the provenance model and the
warning-acceptance mechanism are extracted from a production catalog system
that proved them at scale. The namespace, schemas, adapters, CLI and authority
model here are new and neutral.
