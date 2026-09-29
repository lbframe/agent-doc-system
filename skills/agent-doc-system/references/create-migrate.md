# CREATE and MIGRATE

Two onboarding workflows. CREATE for a repository with no catalog; MIGRATE for
an established one. Both start with the same audit; MIGRATE adds a
source-of-truth mapping and a reviewed-ambiguity list a human must work
through.

## Choosing

| situation | mode |
|---|---|
| no `agentdoc/` directory, small or new repository | CREATE |
| no `agentdoc/`, large or established repository | MIGRATE |
| an existing catalog, documentation that has drifted | MIGRATE |

The test is not size. It is whether the repository has documentation that
*claims* things. Claims need verifying — that is migration work regardless of
how few components there are.

## CREATE

```bash
cd <repository root>
agentdoc doctor --project          # expect configurationFound: false for now
agentdoc init                      # config skeleton + documentation hierarchy
$EDITOR agentdoc/agentdoc.config.yaml
agentdoc audit                     # what is provable, what is not
agentdoc scaffold                  # dry run: what it would write
agentdoc scaffold --write          # write descriptors for provable units
$EDITOR '**/agentdoc.yaml'         # review every generated description
agentdoc validate && agentdoc compile && agentdoc check
```

`init` writes `agentdoc/agentdoc.config.yaml`, the central descriptor files
(`domains.yaml`, `systems.yaml`, `apis.yaml`, `resources.yaml`),
`agentdoc/journeys.yaml`, the documentation hierarchy under `docs/`, the
observations README, and a CI workflow. It writes **project data only** — it
never copies the agentdoc implementation into the repository.

In `agentdoc.config.yaml`:

- Set `namespace`, fix `discovery.componentDescriptors` to match the real
  layout, and enable the adapters for the technologies present. `adapters: []`
  is a valid but useless starting point: with no adapter, a component
  descriptor is an unsupported claim and compilation fails on purpose.
- Three example authority rules are written **commented out**. Uncomment only
  the ones you can justify, with the rationale in your own words. An authority
  rule is a governance decision; the scaffolder does not make it for you.

A generated description is a statement about artifact evidence, not a product
claim. Read every one and fix the ones that are wrong. The scaffolder never
chooses a `system` or `domain`: placement is an ownership decision, so the
generated descriptor carries a commented `placementRationale` prompt instead.

## The audit report

`agentdoc audit` runs even when the repository cannot compile, and inventories
four truth sources independently: derivable facts, machine-readable contracts,
authored documentation, and ObservationSets. Key fields:

| field | meaning |
|---|---|
| `facts` | every major fact classified `CONFIRMED` / `DERIVED` / `OBSERVED` / `CONFLICT` / `UNRESOLVED` |
| `contradictions`, `documentationContradictions` | where sources disagree |
| `reviewedAmbiguity` | the list a human must decide |
| `documentation.orphanDocs` | documents nothing will ever route to |
| `documentation.undocumentedComponents` | components an agent will get wrong |
| `contracts.unclaimed` | contract files no API descriptor owns |
| `scaffold` | what the scaffolder proposes to write |

`OBSERVED` facts cannot be authored — they belong in an ObservationSet under
`agentdoc/observations/`. `CONFLICT` and `UNRESOLVED` need a human.

## MIGRATE

```bash
agentdoc init
# set componentDescriptors to the real layout; enable the right adapters
agentdoc audit > migration-report.json
```

Then, in order:

1. **Source-of-truth mapping.** For each major claim, record which inventory
   supports it. Anything supported by none goes to `reviewedAmbiguity`.
2. **Contradictions.** Work `contradictions` and `documentationContradictions`.
   Each needs a human decision: fix the docs, fix the code, or add an authority
   rule saying which class wins for that key.
3. **Orphan docs.** Link each to a component via `context.docs`, or delete it.
4. **Missing docs.** Work `undocumentedComponents` / `unverifiedComponents`.
5. **Stale contracts.** Point the API descriptor at the current contract file.
6. **Ownership.** Placement from code where unambiguous, from a human elsewhere.
7. **Catalog.** `scaffold --write`, review every generated file.
8. **Gate.** `validate` → `compile` → `check`, then install CI.

**Do not trust existing documentation.** The single most common migration
failure is copying existing prose into descriptions. If you cannot write a
one-sentence present-tense statement of a component's current purpose, the
purpose is not understood yet — that discovery is the point.

The full workflow contract is `docs/MIGRATION.md` in the agentdoc repository.
