# MIGRATION

Two workflows. CREATE for a repository with no catalog; MIGRATE for an
established one. Both start with the same audit; MIGRATE adds a source-of-truth
mapping and a reviewed-ambiguity list that a human must work through.

## Choosing

| situation | mode |
|---|---|
| no `agentdoc/` directory, small or new repository | CREATE |
| no `agentdoc/`, large or established repository | MIGRATE |
| an existing catalog, documentation that has drifted | MIGRATE |
| a catalog that is stale but structurally sound | MAINTAIN |

The test is not size. It is whether the repository has documentation that
*claims* things. Claims need verifying; that is migration work regardless of how
few components there are.

## The audit

```bash
node agentdoc/bin/agentdoc.mjs audit
```

`audit` runs even when the repository cannot compile, and reports compilation
failures as part of the report. It inventories four sources of truth
independently:

1. **manifests and code** — what can be derived;
2. **machine-readable contracts** — what boundaries are declared;
3. **authored documentation** — what someone believed;
4. **authoritative external systems** — what is deployed, via ObservationSets.

## The report

```json
{
  "inventory":  { "files", "units", "entities", "components", "apis", "relations", "contracts", "documentationFiles", "observations", "verification" },
  "facts":      [ { "fact": "component:default/teacher placement.system", "classification": "DERIVED", "evidence": ["authored"] } ],
  "counts":     { "CONFIRMED": 4, "DERIVED": 38 },
  "contradictions": [ ... ],
  "documentationContradictions": [ ... ],
  "reviewedAmbiguity": [ ... ],
  "documentation": { "orphanDocs", "undocumentedComponents", "unverifiedComponents" },
  "contracts":  { "inventory", "unclaimed" },
  "observations": [ { "id", "capturedAt", "maxAgeDays", "environment" } ],
  "scaffold":   { "files", "summary", "rule" }
}
```

### Classification

Every major fact lands in exactly one class:

| class | meaning | may be authored? |
|---|---|---|
| `CONFIRMED` | two or more independent sources agree | yes |
| `DERIVED` | deterministically derivable from the repository | yes, once reviewed |
| `OBSERVED` | read from an authoritative external system | **no** — it belongs in an ObservationSet |
| `CONFLICT` | sources disagree and no authority rule settles it | **no** — needs a human |
| `UNRESOLVED` | neither the repository nor an external system answers it | **no** — needs a human |

**Uncertainty is never promoted to authored truth.** This is the rule the whole
report exists to enforce.

### Documentation contradictions

Two checks run against claims the graph actually owns, and only those. A document
saying "we use Kafka" is not checkable until a Resource descriptor says what the
Kafka thing is; a document saying "there is no edge component" is checkable
immediately, and is `NEGATED_COMPONENT`. A port claim in a document linked to a
component is `PORT_MISMATCH` when the source binds a different port, and
`UNLINKED_PORT_CLAIM` when the document is linked to nothing and therefore cannot
be checked at all.

The rule for extending this: only check vocabulary the graph owns. A check that
guesses is a check that cries wolf.

### Reviewed ambiguity

The list a human must work through:

| kind | what a human decides |
|---|---|
| `EVENT_WITHOUT_PRODUCER` | is this subject reserved, or is a producer missing? |
| `COMPONENT_OWNERSHIP` | which system or domain owns this? |
| `UNCLAIMED_CONTRACT` | which API owns this contract, or is it dead? |
| `REVIEWED_OVERRIDE` | is this interpretation still true? |
| `NEGATED_COMPONENT`, `PORT_MISMATCH`, `UNLINKED_PORT_CLAIM` | which source is right? |

## CREATE

```bash
node agentdoc/bin/agentdoc.mjs init          # configuration + doc skeleton
$EDITOR agentdoc/agentdoc.config.yaml        # layout, namespace, adapters
node agentdoc/bin/agentdoc.mjs audit         # what is provable
node agentdoc/bin/agentdoc.mjs scaffold --write
$EDITOR '**/agentdoc.yaml'                   # every generated description
node agentdoc/bin/agentdoc.mjs validate
node agentdoc/bin/agentdoc.mjs compile
node agentdoc/bin/agentdoc.mjs check
```

`init` writes `agentdoc/agentdoc.config.yaml`, the four central descriptor
files, `agentdoc/journeys.yaml`, the documentation hierarchy
(`docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/CONSTRAINTS.md`,
`docs/adr/`), the observations README, and a CI workflow. It never overwrites an
existing file.

`scaffold` is a dry run unless `--write` is passed.

### What the scaffolder will and will not do

It writes a component descriptor only for a unit it can name from the
repository — a package name, a module path, or a directory name. It writes a
description that is a template sentence naming the artifact evidence. It does
**not** choose a system or a domain, because placement is an ownership decision
no extractor can make; the generated descriptor carries a commented
`placementRationale` prompt instead.

That is deliberate. A scaffolder that guesses ownership produces a catalog
nobody trusts.

## MIGRATE

```bash
node agentdoc/bin/agentdoc.mjs init
# set componentDescriptors to the real layout; enable the right adapters
node agentdoc/bin/agentdoc.mjs audit > migration-report.json
```

Then, in order:

1. **Source-of-truth mapping.** For each major claim, record which of the four
   inventories supports it. Anything supported by none goes to
   `reviewedAmbiguity`.
2. **Contradiction detection.** Work `contradictions` and
   `documentationContradictions`. Each one needs a human decision: fix the
   documentation, fix the code, or record an authority rule saying which class
   wins for that key.
3. **Orphan documentation.** `documentation.orphanDocs`. For each: link it to a
   component via `context.docs`, or delete it. An orphan is a document nothing
   will ever route to.
4. **Missing documentation.** `documentation.undocumentedComponents` and
   `documentation.unverifiedComponents`. These are the components an agent will
   get wrong.
5. **Stale contracts.** `contracts.unclaimed`, and any contract whose consumers
   changed. Point the API descriptor at the current file; do not duplicate it.
6. **Ownership reconstruction.** Placement comes from the code where the code is
   unambiguous (a service that only ever talks to one identity provider), and
   from a human everywhere else.
7. **Catalog proposal.** `scaffold` lists what it would write.
8. **Migration.** `scaffold --write`, then review every generated file.
9. **Validation.** `validate` → `compile` → `check`.

### Do not trust the documentation

The single most common migration failure is copying existing prose into
descriptions. The audit exists to find out how much of that prose is still true.
A description is a one-sentence present-tense statement of current purpose; if
you cannot write one, the component's purpose is not understood yet, and that is
worth discovering before documenting it.

## Documentation hierarchy

| kind | belongs there | must not |
|---|---|---|
| `PRODUCT.md` | what it is, for whom, what it does not do | describe components |
| `ARCHITECTURE.md` | why the shape is what it is | enumerate components or contracts |
| `CONSTRAINTS.md` | repository-wide rules, one rule one reason one check | restate a component's constraints |
| `docs/adr/NNNN-*.md` | one decision, its consequences, superseded not edited | be a design document |
| `<component>/CONSTRAINTS.md` | rules for that component only | duplicate a repository-wide rule |
| `<component>/README.md` | how to run it, what it is for | restate the catalog |
| runbooks | operational procedure | contain architectural decisions |
| `agentdoc/observations/` | what a live system said, with evidence | contain credentials |
| the graph | topology, contracts, events, checks, conflicts | contain prose |

**The duplication rule.** A fact lives in exactly one place. Elsewhere, point at
it. If `ARCHITECTURE.md` lists the components, it will be wrong within a month,
and `agentdoc query` will be right. The architecture document explains *why*;
the graph says *what*.

## Finishing

```bash
node agentdoc/bin/agentdoc.mjs validate && node agentdoc/bin/agentdoc.mjs check
node agentdoc/bin/agentdoc.mjs eval routing
git add -A && git commit
```

Then install CI (`CI.md`) so the next drift is caught by a gate rather than by a
review.
