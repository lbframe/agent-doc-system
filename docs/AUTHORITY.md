# AUTHORITY

The model that distinguishes what the repository claims, what can be derived
from it, and what was actually observed running.

## Why this exists

A catalog that merges these three produces confident, confident-looking wrong
answers. Every one of the following is a real failure mode this model is built
to make impossible to hide:

- the presumed production binding source is not the real authority;
- a binding assumed to be missing is actually four;
- a schedule described as daily is an hourly trigger with hour gating;
- an external upload API is assumed to accept a field the deployed API rejects;
- recovered runtime state intentionally differs from the governed target state.

Each of these is, mechanically, the same event: **two evidence classes made
claims about the same fact, and the catalog quietly picked one.**

## Evidence classes

### `AUTHORED`

Explicitly declared and intentionally maintained in this repository: catalog
descriptors, architecture documents, ADRs, canonical contracts, configuration
manifests, declared ownership.

- **Strengths:** states intent; reviewed; versioned with the decision.
- **Failure modes:** drifts; states what *should* be, not what *is*; a config
  file is a claim about deployment, not a deployment.
- **Never sufficient** for a claim about what is currently running.

### `DERIVED`

Facts deterministically extracted from committed inputs: package dependencies,
imports, routes, runtime bindings, CI checks, service calls, events, database
usage, artifact shape.

- **Strengths:** reproducible; anyone can re-derive it; cannot silently rot.
- **Failure modes:** heuristic; incomplete; a consumer of a contract that goes
  through a generated client may not name the contract file; absence of evidence
  is not evidence of absence.
- **A derivation whose result is ambiguous must degrade to a diagnostic, not to
  a fact.** An ambiguous bucket literal produces `AGENTDOC_BINDING_AMBIGUOUS`,
  not a guessed resource edge.

### `OBSERVED_RUNTIME`

Facts read from an authoritative external or running system: deployed
configuration, real scheduler state, live bindings, cloud provider capabilities,
the actual production version, external API behaviour.

Every observation carries:

```
source            the authority system, e.g. platform-scheduler
timestamp         when it was read, ISO-8601 UTC
environment       which environment it describes
retrieval method  the command or API used
evidence          a durable, committed, secret-free reference
freshness         maxAgeDays, a promise the observation must keep
supersedes        the observation set it replaces, if any
```

Observations are committed to the repository. That is deliberate: an observation
nobody can reproduce is an anecdote, and an anecdote does not belong in a graph
that claims to describe reality.

**An observation can never overwrite an authored fact.** It is added to the same
`(subject, key)` group, and the authority engine decides what happens. Without a
rule, the disagreement is an error.

### `EXTERNAL_STANDARD`

Standards whose canonical authority is outside the repository: OIDC discovery,
OpenAPI, protocol specifications, provider API schemas.

- The desired wire surface is `AUTHORED` (the contract file) or
  `EXTERNAL_STANDARD` (the specification).
- What a live deployment accepts is `OBSERVED_RUNTIME`.
- These routinely disagree, and that disagreement is the point.

### `REVIEWED_OVERRIDE`

A human-approved interpretation, used when deterministic discovery cannot
resolve a fact. It is bounded and must be justified:

```
fact      which kind of fact is being asserted
subject   the entity ref
target    the entity ref, where applicable
reason    why this is true, in one sentence
evidence  file paths under a mapped component's source root, or the contract
```

Evidence must live under a mapped component's source root or be the declared
contract. A reviewed override therefore cannot assert something no file in the
repository can corroborate. Overrides additionally produce a `REVIEWED_OVERRIDE`
fact, so the interpretation is a first-class citizen of the conflict machinery
rather than a bypass.

### `UNRESOLVED`

Known ambiguity. It must not become truth, must not be silently dropped, and
must not be resolved by picking a plausible answer.

Two sources of unresolved facts:

1. **Contradiction with no governing rule.** An error.
2. **Only heuristic candidates.** A warning; the candidates never become elected
   facts. Migration authority alone does not establish database ownership; a
   library that ships migrations but owns no pool gets a warning and a candidate,
   not an invented `usesResource` edge.

## Confidence

A separate axis from evidence class, recording *how* the claim was obtained:

| confidence | meaning |
|---|---|
| `direct` | read straight from the named authority system |
| `deterministic` | a reproducible function of committed inputs |
| `declared` | asserted by a human-maintained document |
| `reviewed` | a reviewer signed off |
| `candidate` | heuristic; never elected |

`candidate` is enforced mechanically, not by convention: an assertion whose only
evidence is a candidate stays `status: candidate`, and the group is reported as
an ambiguity.

## Authority rules

A rule says which evidence class is authoritative **for one key**, for a
subject matching a pattern.

```yaml
authority:
  rules:
    - id: deployed-schedule-is-runtime-truth
      keyPattern: " schedule\\.(cron|enabled|target)$"
      elect: [OBSERVED_RUNTIME]
      rationale: "The committed manifest states intent; only the live scheduler states what fires."
      reviewWhen: "Review when the scheduler configuration changes."
      degradeOnStale: conflict
```

- `keyPattern` is matched against `"<subject> <key>"`; the most specific match
  (longest pattern) wins.
- `elect` may list one to three evidence classes. Naming `UNRESOLVED` is
  rejected at load: electing nothing elects nothing.
- `rationale` is mandatory. A rule nobody can justify is a rule nobody can
  review.
- `reviewWhen` is mandatory.

**There is no default global precedence.** A fact with disagreeing evidence and
no matching rule is an error. This is the single most important property of the
model: silence is not a resolution.

## Election

For a group of assertions on one `(subject, key)`:

1. **Agreement** — all values equal. Every assertion is `elected`. Agreement
   across evidence classes is corroboration, and it is visible as such. If the
   only evidence is a heuristic candidate, the group stays unresolved.
2. **Contradiction** — values differ. The basis is attempted in order:
   - `reviewed-override` — a rule elects `REVIEWED_OVERRIDE` and exactly one
     exists. Status `accepted`. The divergence is still recorded.
   - `authority-rule` — the rule's elect list intersects the present classes in
     exactly one class with exactly one assertion.
   - `superset` — one candidate's value strictly contains every other (for
     example an observed set that is a strict subset of a declared set). The
     superset is elected; the containment is stated.
   - `recency` — only when the rule names `OBSERVED_RUNTIME` and more than one
     dated observation exists. The newest wins, and the rule is cited.
   - otherwise `basis: none`, status `unresolved`, and an **error**.
3. Every non-elected assertion is kept with `status: contradicted` (or
   `candidate`). **The contradicted value stays in the graph.** A system that
   discards the repository's own claim cannot explain the divergence to a human.

## Conflict kinds

| kind | meaning |
|---|---|
| `contradiction` | two evidence classes disagree about the same value |
| `staleness` | two runtime observations disagree; one is out of date |
| `supersession` | a newer observation explicitly replaces an older one |
| `ambiguity` | only heuristic candidates, or an ungoverned disagreement |
| `reviewed-divergence` | a reviewer approved the divergence and it is recorded |

Status is `unresolved`, `resolved` or `accepted`.

## Staleness

An observation is stale when `now - capturedAt > maxAgeDays`. Staleness is
evaluated at gate time, never at compile time, because a compile must stay a
pure function of the checkout.

- `check` and `query` fail closed on a stale observation and name it.
- `--allow-stale-observations` exists as an explicit, visible override.
- `degradeOnStale` lets a rule say what a stale election means: keep the
  election but raise a staleness conflict (`conflict`), or drop to unresolved
  (`unresolved`).

## Worked example

The committed manifest declares:

```toml
[triggers]
crons = ["0 3 * * *"]
```

The platform reports:

```json
{ "triggers": [ { "cron": "0 * * * *", "gate": { "hourEquals": 3 } },
                { "cron": "3 0 * * *", "enabled": true } ] }
```

The observation says, of `schedule.cron`:

> The scheduler evaluates an hourly trigger plus a daily trigger; the hourly
> trigger is gated to hour 3, so the effective daily behaviour is not the
> manifest's single daily expression.

The graph then contains:

```
conflict  component:default/worker  schedule.cron  contradiction  resolved
  assertion AUTHORED/DERIVED   "0 3 * * *"                          contradicted
  assertion OBSERVED_RUNTIME   "0 * * * *,3 0 * * *"                elected
  election  authority-rule / deployed-schedule-is-runtime-truth
```

A query for that component prints both values, marks the election, and points at
the evidence. An agent debugging "the nightly job did not run" sees immediately
that the repository's description of the schedule is not what the scheduler
does — which is the finding. Silently preferring either side would have hidden
it.

## The one place a label is chosen without an election is a *relation's*
`evidenceClass`, and it elects nothing: when its provenance records agree there is
one class and it is reported; when they disagree the edge is reported as
`REVIEWED_OVERRIDE` if a human interpretation is among them, and `DERIVED`
otherwise. Picking by strength would be a global precedence order in a helper, and
it was actively wrong — a reviewed override corroborated by a source reference was
relabelled `AUTHORED`, so the graph understated its own highest-authority input
while the corresponding assertion still read `REVIEWED_OVERRIDE`.

Anti-patterns this model forbids

- A global precedence order (`AUTHORED` always beats `DERIVED`).
- Overwriting an authored value with an observed one because the observed one is
  newer, with no rule.
- Treating a configuration file as evidence of deployment.
- Accepting a warning to silence a conflict.
- Deleting the contradicted assertion after an election.
- Promoting a heuristic candidate because it is the only candidate.
