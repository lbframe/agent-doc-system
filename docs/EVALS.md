# EVALS

Does routing an agent through this system retrieve the *right* context, and less
noise than exploring the repository unaided?

## What is measured

The question is not "does it compile". A catalog can compile perfectly and still
route an agent into the wrong corner of the repository. The measurement is
retrieval quality, on the same scenarios, for two retrieval systems.

**baseline-targeted** — what an agent that has no catalog and looks only where
the change is: the touched component, its subtree, its relations, its documents
and its checks.

**baseline-full** — what an agent with no routing ends up holding: every entity,
every relation, every event subject, every check, every document in the
repository. This is the honest cost of "just read the repository", and it is the
size yardstick for reduction.

**catalog** — what `agentdoc query` returns for the touched paths, plus the
context of the components `impact` says are affected.

No model is involved. Retrieval sets are compared as sets, so the measurement
is deterministic and cannot be moved by phrasing.

## Metrics

| metric | definition |
|---|---|
| recall | fraction of the scenario's ground-truth facts the catalog retrieved |
| critical recall | the same, restricted to critical context: constraints, conflicts, observations, resources, API boundaries, event subjects |
| verification recall | fraction of the checks that must be run, that were returned |
| precision | `1 - irrelevance` |
| irrelevance (noise) | fraction of retrieved facts outside the graph's one-hop closure of the touched entities |
| retrieval reduction | `1 - catalog facts / baseline-full facts` |

### Why noise is measured against reachability, not against the truth set

The first definition of noise was the complement of truth recall. It is
degenerate: a scenario lists the handful of facts that matter, so any
*additional legitimate* fact — a sibling constraint, a second check, an adjacent
contract — is scored as noise. The metric rewarded returning almost nothing.

It was replaced, before any repository other than the golden corpus was
measured, with a question that does not depend on the truth set at all:

> did routing drag in anything the graph itself says is unrelated?

Relevance is the **one-hop** graph closure of the touched entities, computed
from the compiled graph. The metric therefore cannot be satisfied by inflating a
truth set, and it is not satisfied by returning less either — that shows up as
recall. Recall is still measured against the truth sets, unchanged.

"One hop" is load-bearing and is enforced. An earlier implementation took the
transitive closure, which on the golden corpus grows to nearly the whole
repository; a router that returned *every fact in the repository* then scored as
precise, because everything was technically adjacent to something. The metric
was measuring its own closure, not the router.

## Thresholds

Pre-registered in `evals/thresholds.json`, dated, and not moved since:

```json
{ "minRecall": 0.9, "minCriticalRecall": 0.95, "minVerificationRecall": 0.8,
  "minPrecision": 0.75, "maxNoise": 0.6, "minRetrievalReduction": 0.4,
  "minRecallOverBaseline": 0.9 }
```

Two additional gates use the same numbers:

- **recall must not be worse than baseline-targeted.** A catalog that retrieves
  less than reading the component would be worthless.
- **recall must be at least 0.9 × baseline-full recall.** Routing must not be
  meaningfully worse than reading everything.

### Where the gate is applied

- **Aggregate** (`node evals/run-all.mjs`) applies every threshold,
  **and fails if any single corpus fails or is missing**. A corpus that is
  missing fails the gate outright: silently scoring three repositories and
  reporting PASS would be a gate that shrinks when the system shrinks. The two
  relative-baseline checks are evaluated per corpus and folded into the
  aggregate's failure list; the aggregate does not re-derive them, so they are
  lost if a corpus never runs — which is why a missing corpus is itself a
  failure. A per-corpus failure is folded into the aggregate exit
  code, so a broken fixture cannot print FAIL and still exit 0. This is the
  system-level claim.
- **Per repository** (`agentdoc eval routing`) applies every threshold except
  retrieval reduction, which is reported as *not measured* when the whole-repo
  baseline holds fewer than 100 facts. A one-component repository has almost
  nothing to route away from; failing it would be punishing the fixture for
  being small. The floor and the reasoning are in `evals/harness.mjs`.

## Corpora and scenarios

| corpus | scenarios | what it proves |
|---|---|---|
| `examples/koda` (golden corpus) | 9 | monorepo discovery, TypeScript + Go, `apps`/`packages`/`workers`, OpenAPI, OIDC, runtime calls, resources, events, verification, journeys, warning acceptances, authority conflicts |
| `fixtures/a-node-ts-postgres` | 3 | single Node/TypeScript service, REST, Postgres, GitHub Actions |
| `fixtures/b-go-multi-service` | 4 | multi-service Go, protobuf contracts, shared library, resources |
| `fixtures/c-alt-monorepo` | 4 | a layout that is deliberately not `apps`+`packages`+`workers`, mixed runtimes, inconsistent pre-existing documentation |

Scenarios are repository-scoped: a scenario only runs against the corpus it was
written for, declared by a `repository` tag in a `.agentdoc-fixture.json` at the
repository root. Expectations from one fixture can never leak into another's
score.

### Scenario families

The golden corpus covers, in order: modify one API consumer; change a database
schema; change authentication; add an event producer; modify a worker binding;
change a cross-component endpoint; change a shared package; change a runtime
cron; debug a production mismatch.

The synthetic fixtures add: change an API contract; change a write path; change
the only-writer rule; break an end-to-end journey; change an edge worker's flush
schedule; follow stale documentation while debugging; change a subject vocabulary
shared across runtimes; add an operation to a contract.

## Running it

```bash
agentdoc eval routing --json      # one repository (from a corpus directory)
node evals/run-all.mjs            # aggregate gate — source checkout only
node evals/run-all.mjs --json     # machine-readable
```

`run-all.mjs` iterates the corpora in `fixtures/` and `examples/`, so it only
exists in a source checkout; it is not part of the installed CLI's job.

## What the evaluation changed

The evaluation is a tool, not a ceremony. Running it against the golden corpus
exposed real defects that no unit test had:

- contract files did not route (changing an endpoint resolved to nothing);
- a scheduled trigger did not resolve to the component serving the target route,
  so "who does this cron call?" had no answer;
- event subjects defined in a shared package were not credited to the component
  that published them;
- a documentation file linked by a descriptor did not route to its component, so
  stale documentation was unreachable — precisely the migration case;
- the noise metric was degenerate (above), and the `transitiveClosure` variant
  that replaced it briefly was worse;
- migration directories were matched by a fixed list of framework conventions
  rather than by the stable fact that the directory is called `migrations`;
- cross-unit resolution depended on adapter execution order;
- a repository path was resolved against the process working directory, so the
  same commit compiled differently depending on where the compiler ran.

Each was fixed in the engine, not by relaxing a threshold.

## Honest limitations

- Ground truth is hand-authored per scenario. It is written from the
  repository's own manifests and contracts, not from the system's output, but it
  is still a human judgement about what matters.
- The baseline is a model of unassisted exploration, not a record of a real
  agent session. It is generous to the baseline by construction (baseline-full
  is everything), which makes the reduction claim conservative.
- `retrievalReduction` is a fact-count proxy, not a token count. It does not
  weight a long constraint file against a short ref.
- Scenarios touch one or two files. A change spanning twenty files is not
  measured.
