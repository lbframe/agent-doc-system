# Koda golden corpus

A profile of this system applied to a repository shaped like the reference
project: a `pnpm` monorepo of TypeScript web applications and Go services under
`apps/`, `packages/` and `workers/`, with OpenAPI and OIDC contracts, an event
subject catalog, a platform worker with scheduled triggers, and a runtime
observation that contradicts the committed manifest.

It is a **fixture**, not a copy. It contains enough to prove that discovery,
authority, conflicts, provenance, acceptances, journeys, verification and
routing all work on a monorepo of this shape, without duplicating a
production repository into a bundle.

## What it demonstrates

| capability | where |
|---|---|
| monorepo discovery across three roots | `agentdoc/agentdoc.config.yaml` |
| the Koda-specific surface reduced to one configuration file | `agentdoc/agentdoc.config.yaml` |
| TypeScript + Go in one graph | `repo/apps/*`, `repo/workers/koda-cron` |
| a descriptor co-located at each unit root | `repo/**/catalog-info.yaml` |
| OpenAPI contracts and a codegen consumer | `repo/contracts/*.openapi.yaml` |
| OIDC with a validated discovery path | `agentdoc/apis.yaml` |
| a declared event catalog with a reserved subject | `repo/packages/authz-catalog/notify.json` |
| runtime bindings, crons and trigger targets | `repo/workers/koda-cron/wrangler.toml` |
| a logical database resolved from migrations and pool evidence | `agentdoc/resources.yaml` |
| reviewed warning acceptances with pinned evidence digests | `agentdoc/agentdoc.config.yaml` |
| journeys | `agentdoc/journeys.yaml` |
| runtime observation with a durable evidence bundle | `agentdoc/observations/` |

## The four incident classes

`agentdoc/observations/production.yaml` records what a production scheduler and
upload API actually reported during a recovery window. It is committed here so
the divergences are reproducible.

1. **The repository declares a binding set the runtime does not have.** The
   manifest declares `CRON_STATE` and a cross-deployment service binding; the
   platform reports only `CRON_STATE`. Conflict on `binding.declared` and
   `binding.kind`.
2. **A schedule described as daily is really an hourly trigger with hour
   gating.** The manifest declares one daily expression; the scheduler evaluates
   an hourly trigger gated to hour 3 plus a daily one. Conflict on
   `schedule.cron`, `OBSERVED_RUNTIME` elected by rule, the contradicted value
   kept in the graph.
3. **An external API does not accept what the repository assumed.** A live probe
   of the upload API accepted `presign`, `confirm`, `complete` and rejected an
   `annotations` field. Recorded as an `OBSERVED_RUNTIME` `contract.supports`
   fact.
4. **Recovered runtime intentionally differs from the governed state.** The KV
   binding was deliberately retained during recovery so scheduled state was not
   lost, while the governed target state does not contain it. Recorded with
   prose semantics rather than being flattened into a boolean.

The correct output is a graph that *shows* these distinctions, not one that
merges them.

## Running it

With the `agentdoc` CLI on PATH (installed globally, or `npm link` in this
checkout):

```bash
cd examples/koda/repo
agentdoc validate
agentdoc compile
agentdoc check
agentdoc query workers/koda-cron
agentdoc impact contracts/teacher-ingest.openapi.yaml
agentdoc eval routing
```

## The profile is one file

Everything Koda-specific lives in `agentdoc/agentdoc.config.yaml`: the ref
namespace, the three descriptor globs, the canonical contract root, the event
subject prefix, the adapter set, and six authority rules with their rationales.
Delete that file and the engine has no idea this repository is called Koda.
