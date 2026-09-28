---
name: agent-doc-system
description: Use when working in a repository that has an agentdoc software catalog, or when asked to create, migrate, validate, query or maintain one. Routes an agent to the minimum correct context for a change, and keeps documentation honest about what the code says versus what a running system says.
---

# agentdoc

A documentation and software-catalog system for an agent working in a real
repository. It compiles the repository into one deterministic graph and routes
a path or an entity to the minimum context needed to change it safely.

## When to invoke this skill

Invoke it when **any** of these is true:

- The repository contains `agentdoc/agentdoc.config.yaml`. It is already
  installed; you are using it.
- You are about to change a file in a repository and need to know what else
  must change with it.
- You were asked to "document this", "set up a catalog", "audit the docs",
  "find out what depends on X", or "why doesn't this work in production".
- You are reviewing a change and want to know which contracts, constraints and
  checks it should have touched.

Do **not** invoke it to write prose. The system routes facts; the prose lives
in the files it points at.

## The one thing to understand first

Three kinds of claim get conflated, and the confusion is the main way an agent
goes wrong:

| kind | who makes it | how it fails |
|---|---|---|
| what the repository **claims** | authored docs, config, manifests | drifts; states intent, not fact |
| what is **derived** from code | imports, manifests, contracts | incomplete; cannot know intent |
| what was **observed** running | schedulers, bindings, live APIs | goes stale; disagrees with intent |

The system keeps them apart. A fact carries an evidence class, a confidence and
a pointer to its evidence. When two classes disagree, the disagreement is
**surfaced**, not reconciled. There is no global precedence order: authority
depends on the fact. A committed manifest is authoritative for *intent*; a live
scheduler is authoritative for *what fires*.

**Your obligation:** never present a claim from one class as if it came from
another. If the graph reports a conflict, say so. If a fact is unresolved, say
that too.

## The five modes

| mode | when | command |
|---|---|---|
| CREATE | undocumented repository | `node agentdoc/bin/agentdoc.mjs init` then `scaffold --write` |
| MIGRATE | established repository, scattered docs | `node agentdoc/bin/agentdoc.mjs audit` |
| VALIDATE | before committing, in CI | `validate` → `compile` → `check` |
| QUERY | before and during a change | `query <path-or-ref>` |
| MAINTAIN | after a change | `impact <paths>` |

Full detail: `MIGRATION.md`. Query semantics: `QUERY.md`. Gates: `CI.md`.

## The loop you should run

```bash
# 1. What am I about to touch, and what does that reach?
node agentdoc/bin/agentdoc.mjs impact <files I will change>

# 2. What do I need to know?
node agentdoc/bin/agentdoc.mjs query <path>          # compact
node agentdoc/bin/agentdoc.mjs query <path> --json   # full

# 3. Make the change.

# 4. What must I keep consistent?
node agentdoc/bin/agentdoc.mjs impact <files I changed>

# 5. Prove it.
node agentdoc/bin/agentdoc.mjs validate && node agentdoc/bin/agentdoc.mjs check
```

If `check` fails, the committed graph no longer describes the repository. Do not
work around it: run `compile`, review the diff, and commit the graph.

## Auditing a repository you have never seen

1. `node agentdoc/bin/agentdoc.mjs init` — writes a configuration skeleton and
   the documentation hierarchy. It guesses nothing it cannot see.
2. Read `agentdoc/agentdoc.config.yaml`. Set `namespace`, fix
   `componentDescriptors` to match the real layout, and enable the adapters for
   the technologies present. `adapters: []` is a valid but useless starting
   point: with no adapter, a component descriptor is an unsupported claim and
   compilation fails on purpose.
   `init` also writes three example authority rules **commented out**. Uncomment
   only the ones you can justify, and write the rationale in your own words. An
   authority rule says which class of evidence wins for a key; that is a
   governance decision, and the scaffolder does not make it for you.
3. `node agentdoc/bin/agentdoc.mjs audit` — inventories the repository, the
   documentation, the contracts and the deployed systems, and classifies every
   fact `CONFIRMED` / `DERIVED` / `OBSERVED` / `CONFLICT` / `UNRESOLVED`.
4. Read `reviewedAmbiguity` and `documentationContradictions` in the report.
   These need a human. Everything else you can resolve from the repository.
5. `node agentdoc/bin/agentdoc.mjs scaffold --write` — writes descriptors for
   what it can prove. Read every generated description and fix the ones that are
   wrong: a generated description is a statement about artifact evidence, not a
   product claim.
6. `validate` → `compile` → `check`.

**Do not trust existing documentation.** In MIGRATE mode it is evidence of what
someone once believed, and the audit will tell you where that belief now
contradicts the code.

## Choosing CREATE versus MIGRATE

- **CREATE** — no catalog exists. The repository may still have documentation;
  treat it as unverified input, not as truth.
- **MIGRATE** — a catalog exists, or the repository is large and established
  enough that unassisted exploration is expensive. Same audit, plus a
  source-of-truth mapping and a reviewed-ambiguity list you must work through
  with a human.

## Discovering evidence without inventing it

You may assert a fact as **authored** only when you can point at a file in the
repository. You may assert it as **derived** only when a deterministic extractor
produces it. You may assert it as **observed** only from an
`agentdoc/observations/*.yaml` ObservationSet, and only if you actually read the
external system.

When you cannot establish a fact:

- If it is a heuristic guess, do not write it. Add a `reviewedOverrides` entry
  with a `reason` and file-level `evidence`, or leave it out.
- If two sources disagree, do not pick one. Either add an authority rule that
  says which class is authoritative *for that key*, or accept the failure and
  report the contradiction to a human.
- If it is a product or ownership decision, ask. Do not infer ownership from
  folder names.

**Secrets.** Never write a credential, token, key or authenticated URL into a
descriptor, an observation, an evidence bundle, or a commit message. Validation
fails on secret-shaped input, and it fails on the *output* too. Observations
cite a committed, secret-free evidence bundle by repository-relative path.

## Creating descriptors

`templates/` holds one file per kind. The rules that matter:

- A Component descriptor lives at the root of the unit it describes, named by
  `discovery.componentDescriptorName`.
- `metadata.description` is **one sentence, present tense**, ending in `.`, `!`
  or `?`. It says what the component is *for*.
- Placement is exactly one of `system`, `domain`, or `placementRationale`.
- Every durable cross-component boundary has exactly one canonical
  machine-readable contract, and exactly one API descriptor pointing at it.
  Default to OpenAPI 3.1 for JSON HTTP; a protocol's native schema is equally
  valid.
- You never author a relation. Placement and API provider edges come from the
  descriptor; everything else is derived or reviewed.

## Handling conflicts

`query --json` returns `authority.conflicts`. For each one:

1. Read `election.basis` and `election.ruleId`. `basis: none` means no rule
   governs this fact and the system refused to choose.
2. Both values stay in the graph. Report both to the human, with the evidence
   pointers, and say which one the system elected and why.
3. If the right answer is "the runtime wins for this key", add an authority rule
   with `elect: [OBSERVED_RUNTIME]` and a `reviewWhen`. Do not edit the
   observation to match the manifest, and do not edit the manifest to match the
   observation.

## Compiling, querying, validating

```bash
node agentdoc/bin/agentdoc.mjs validate   # sources + schemas + semantic checks
node agentdoc/bin/agentdoc.mjs compile    # deterministic graph, atomic write
node agentdoc/bin/agentdoc.mjs check      # freshness + determinism + time gates
node agentdoc/bin/agentdoc.mjs query apps/foo/src/bar.ts
```

`check` is the gate. It fails on a stale graph, a hand-edited graph, a
compiler or schema mismatch, a dirty source under `--require-clean`, and an
observation that has aged past its declared `maxAgeDays`. It never falls back
to a stale graph, and neither does `query`.

## Installing CI

Copy `templates/ci.yml` to `.github/workflows/agentdoc.yml` and adjust the
Node version. The gate is four steps: validate, compile, check, and
`check --require-clean`. A stale graph fails in CI, not three weeks later in a
review. See `CI.md`.

## Maintaining the system

- Any PR that changes a compiler input must recompile and commit the graph.
  `impact` tells you which files are inputs.
- Any change to a warning acceptance must be a deliberate act: the acceptance
  pins the evidence digests it was written against, and changing the evidence
  invalidates it on purpose.
- An observation is a promise about freshness. Re-observe before `maxAgeDays`,
  or restate the fact as authored intent if the divergence is intended.
- Schema and compiler versions are part of the graph. Upgrading either
  invalidates every graph; recompile and review the diff.

## Packaging final evidence

When you finish a task, hand over:

1. `agentdoc check` output (must pass).
2. `agentdoc query <path> --json` for each surface you touched.
3. `agentdoc impact <changed files>` showing what you kept consistent.
4. For any conflict you encountered: both values, their evidence, the election,
   and your recommendation.
5. Anything left `UNRESOLVED`, stated as unresolved.

Do not summarise a conflict away. The value of this system is that it tells you
when you do not know something.

## Reference

| file | covers |
|---|---|
| `SPEC.md` | normative specification: entities, graph, determinism, freshness |
| `AUTHORITY.md` | evidence classes, conflict semantics, elections |
| `PROVENANCE.md` | evidence records, pointers, secret handling |
| `QUERY.md` | the context router, budgets, refusals |
| `MIGRATION.md` | CREATE and MIGRATE workflows, the report format |
| `CI.md` | the drift gate and its failure modes |
| `ADAPTERS.md` | writing an adapter, and what must never live in one |
| `EVALS.md` | the routing benchmark and its pre-registered thresholds |
