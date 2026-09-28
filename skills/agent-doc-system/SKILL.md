---
name: agent-doc-system
description: Use AgentDoc to create, migrate, query, validate, and maintain an agent-oriented software catalog and documentation system for a codebase. Use when architectural context, dependency impact, documentation drift, provenance, authority conflicts, or repository documentation migration matters.
---

# AgentDoc

AgentDoc is a machine-installed CLI (`agentdoc`) that compiles a repository into
one deterministic graph and routes a path or entity to the minimum context
needed to change it safely. This skill teaches you how to operate it.

## Prerequisite

The CLI must already be installed on this machine:

```bash
agentdoc --version
```

If that fails, AgentDoc is not installed. Stop, report the missing prerequisite,
and point the user at `INSTALL_FOR_AGENTS.md` in the agent-doc-system
repository. Do not clone the source repository into the user's project — the
CLI is installed on the machine, never vendored into a project.

## When to use it

- The repository contains `agentdoc/agentdoc.config.yaml` — a catalog exists
  and you are using it.
- You are about to change files and need to know what else must stay
  consistent.
- You were asked to document a repository, audit its docs, find what depends
  on X, or explain why production disagrees with the manifest.

Do not use it to write prose. The system routes facts; prose lives in the files
it points at.

## The mental model

Three kinds of claim get conflated in most repositories, and the confusion is
the main way an agent goes wrong:

| kind | who makes it | how it fails |
|---|---|---|
| what the repository **claims** | authored docs, config, manifests | drifts; states intent, not fact |
| what is **derived** from code | imports, manifests, contracts | incomplete; cannot know intent |
| what was **observed** running | schedulers, bindings, live APIs | goes stale; disagrees with intent |

A fact carries an evidence class, a confidence, and a pointer to its evidence.
When classes disagree, the disagreement is **surfaced as a conflict**, not
reconciled. There is no global precedence order: authority depends on the fact.

**Your obligation:** never present a claim from one class as if it came from
another. If the graph reports a conflict or an unresolved fact, say so.

## Pick the workflow

| workflow | when | entry point |
|---|---|---|
| CREATE | no `agentdoc/` config exists | `agentdoc init`, then `scaffold --write` |
| MIGRATE | established repo, scattered or stale docs | `agentdoc audit`, then work the report |
| VALIDATE | before committing, in CI | `agentdoc validate` → `compile` → `check` |
| QUERY | before and during a change | `agentdoc query <path-or-ref>` |
| MAINTAIN | after a change | `agentdoc impact <paths>` |

CREATE versus MIGRATE is not about size: a repository whose existing docs make
*claims* is a migration, because those claims must be verified. Details:
[references/create-migrate.md](references/create-migrate.md).

## The normal loop

```bash
agentdoc impact <files I will change>   # what this reaches
agentdoc query <path>                   # minimum context, compact
agentdoc query <path> --json            # full payload
# ... make the change ...
agentdoc impact <files I changed>       # what must stay consistent
agentdoc validate && agentdoc check     # prove it
```

If `check` fails, the committed graph no longer describes the repository. Do
not work around it: run `agentdoc compile`, review the diff, commit the graph.

## Rules that are never optional

- **Never vendor the CLI.** A project gets `agentdoc/` project data (config,
  descriptors, observations) and `.agentdoc/graph.json` — never a copy of the
  agentdoc source tree (`core/`, `adapters/`, `schemas/`, `bin/`, `tests/`).
- **Never promote uncertainty.** Heuristic guesses do not become authored
  facts; they become `reviewedOverrides` with evidence, or they stay out.
- **Never reconcile a conflict by editing one side.** Add an authority rule for
  the key, or report both values to a human. Details:
  [references/authority-and-conflicts.md](references/authority-and-conflicts.md).
- **Never write a secret** into a descriptor, observation, evidence bundle or
  commit message. Validation fails on secret-shaped input *and* output.
- **Never hand-edit `.agentdoc/graph.json`.** The gate rejects it, and it would
  be wrong anyway.
- **Do not trust existing documentation.** In MIGRATE it is evidence of what
  someone once believed; the audit says where that belief contradicts the code.

## Deeper references

| file | covers |
|---|---|
| [references/cli.md](references/cli.md) | every command, flag and exit code |
| [references/create-migrate.md](references/create-migrate.md) | the two onboarding workflows and the audit report |
| [references/authority-and-conflicts.md](references/authority-and-conflicts.md) | evidence classes, elections, secrets, descriptors |
| [references/maintenance.md](references/maintenance.md) | keeping the catalog true: gates, freshness, evidence handover |

The normative specification (`docs/SPEC.md`, `docs/AUTHORITY.md`,
`docs/PROVENANCE.md`, `docs/QUERY.md`, `docs/MIGRATION.md`, `docs/CI.md`) lives
in the agent-doc-system repository — read it when a rule here needs the full
contract behind it.
