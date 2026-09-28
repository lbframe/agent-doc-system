# QUERY

The context router. Its job is **routing**, not documentation concatenation: for
a path or an entity, return the smallest set of facts an agent needs to work
safely on that subject, and refuse to answer from a stale graph.

## Contract

```bash
agentdoc query <repo-path|entity-ref> [--json] [--md]
```

Resolution order:

1. an exact entity ref;
2. a documentation or constraint file a descriptor links, even outside the
   component's source root;
3. a directory that is exactly a unit root;
4. the longest unit root that is a prefix of the path;
5. a canonical contract file, which routes to the API entity that claims it.

If nothing resolves, the command fails with `AGENTDOC_REF_UNRESOLVED` and exits
non-zero. It never falls back to "the nearest component" or to a global dump.

## Freshness refusal

`query` re-compiles in memory, reads the committed graph, and refuses it unless
`inputHash` and `dirty` agree. (The recorded commit is provenance, not a gate —
see `CI.md`.) Time-dependent gates run first: a
stale observation is reported as `AGENTDOC_OBSERVATION_STALE` before anything
else, because "your observation is 5 years old" and "rebuild the graph" send the
reader to completely different places.

There is no silent fallback. `--allow-stale-observations` exists as an explicit
override and is visible in the command line.

## What comes back

```json
{
  "query":       { "needle": "...", "resolved": "component:default/teacher" },
  "entity":      { "ref", "kind", "name", "description", "spec", "sourcePaths", "derived" },
  "placement":   { "systems": [], "domains": [] },
  "relations":   { "items": [ { "type", "direction", "other", "evidenceClass", "attributes" } ], "total", "truncated" },
  "neighbours":  [ { "ref", "kind", "name", "description" } ],
  "apis":        { "provided": [], "consumed": [], "provider", "consumers", "contract" },
  "events":      { "items": [], "total", "truncated" },
  "resources":   { "used": [], "usedBy": [] },
  "externalDependencies": { "items": [], "total", "truncated" },
  "capabilities": { "items": [], "total", "truncated" },
  "constraints": { "docs": [], "constraints": [], "runbooks": [] },
  "verification": { "items": [ { "id", "tier", "command", "configPaths" } ], "total", "truncated" },
  "journeys":    { "items": [], "total", "truncated" },
  "journeyPeers": [ "component:default/..." ],
  "contracts":   { "items": [], "total", "truncated" },
  "authority": {
    "conflicts":   { "items": [ { "key", "kind", "status", "election", "assertions" } ] },
    "assertions":  { "items": [] },
    "observations":[ { "id", "environment", "sourceSystem", "collector", "capturedAt", "facts" } ]
  },
  "provenance":  { "items": [] },
  "globalGates": [ { "id", "tier", "command" } ],
  "truncated":   [ "relations", "events" ]
}
```

## Rules that matter

**Contracts are pointers, not copies.** `contracts[].ref` is the canonical
contract; `operations` is the inventory an agent needs to find a handler without
reading the whole specification.

**Critical context is separated from the rest.** `authority.conflicts`,
`authority.observations` and `constraints.constraints` are the things that cause
the most damage when missed, and the markdown rendering puts them under explicit
headings: `CONFLICTS (do not assume one is true)`, `RUNTIME OBSERVATIONS`,
`CONSTRAINTS`.

**Both sides of a conflict are printed.** A conflicted assertion shows its
evidence class, its confidence and its value. The contradicted value is never
withheld.

**A contract subject carries the provider's and consumers' checks.** Changing an
endpoint is proved by running their suites, so `verification` for an API subject
is the union over the provider and its consumers.

**Journey peers are named.** If a component appears in a journey, the other
components in that journey are in scope and are listed explicitly rather than
left for the agent to rediscover.

**Budgets are reported, never silent.** Every capped section returns
`{ items, total, truncated }`, and the top-level `truncated` lists every section
that was cut — including the nested `authority.conflicts` and
`authority.assertions`, reported as `authority.conflicts` and so on. A section is
never quietly shortened.

**Review commitments are surfaced.** `reviewCommitments` collects every conflict
election, accepted warning and reviewed override with the condition under which
it must be re-examined. A review condition nobody can see is a review condition
nobody performs. Where no condition was recorded — a conflict settled with no
governing authority rule — the entry says so explicitly rather than pointing at a
record that does not exist.

**Budgets are adjustable.** The defaults are deliberately generous, because a
one-hop route returns a handful of relations and a tight cap would truncate
everything. When an agent is working in a constrained context it can say so:

```bash
agentdoc query component:default/api --budget relations=10,verification=4
```

Limits are positive integers. Every capped section then reports
`{ items, total, truncated }` and the top-level `truncated` names each one, so
the slice is never mistaken for the whole.

## Default budgets

| section | cap |
|---|---|
| relations | 40 |
| events | 20 |
| externalDependencies | 15 |
| capabilities | 10 |
| verification | 12 |
| journeys | 10 |
| conflicts | 20 |
| assertions | 25 |
| provenance | 20 |
| contracts | 10 |

## Markdown rendering

`--md` (the default) produces a compact block suitable for a prompt or a human:

```
# component:default/koda-cron (Component)
Triggers governed endpoints on a platform schedule and owns no business logic.
- source: workers/koda-cron
- system: system:default/scheduler
- CONSTRAINTS: workers/koda-cron/CONSTRAINTS.md
- verify:
  - [unit] vitest run
- CONFLICTS (do not assume one is true):
  - schedule.cron [contradiction/resolved]
    - DERIVED/deterministic: "0 3 * * *"
    - OBSERVED_RUNTIME/direct: "0 * * * *,3 0 * * *"
- RUNTIME OBSERVATIONS:
  - production via platform-scheduler at 2026-09-27T18:40:00Z (evidence …)
```

## Change impact

```bash
agentdoc impact <paths...>
agentdoc impact --diff <git-ref>
```

Impact answers a question about the working tree, so it compiles in memory and
does not require a fresh committed graph. Using it before rebuilding is the
point.

It reports: affected components with the reason each was reached, affected
contracts, documentation, resources, deployment manifests, verification and
catalog sources; whether the graph will be invalidated; the recommended
verification commands; any open conflicts on the affected subjects; and related
journeys.

Reachability rules: a contract change reaches its provider and every consumer; a
component change reaches its transitive dependents two hops out, and everything
connected to it by a runtime call or a schedule. Two hops is deliberate — a
third hop is where the graph stops being a routing aid and becomes a dump.

## Using it in a prompt

Ask for `--md` and give the output to the agent as-is. Two rules keep it
honest:

1. Do not summarise a conflict away. If the context contains a `CONFLICTS`
   block, the agent must be told about it.
2. If the context contains `UNRESOLVED` or a conflict with `basis: none`, the
   correct agent behaviour is to say so and stop, not to choose a side.
