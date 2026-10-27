# EVALS

Does routing an agent through this system retrieve the *right* context, and less
noise than exploring the repository unaided?

## What is measured

The question is not "does it compile". A catalog can compile perfectly and still
route an agent into the wrong corner of the repository. The measurement is
retrieval quality on the same scenarios for three retrieval systems.

**baseline-targeted** — the historical, graph-assisted reference: the touched
entity, its subtree, directly connected entities, documents, events and checks,
plus the original repository-wide documentation sweep. It reads compiled
relations and authority facts. It is not an agent without AgentDoc.

**baseline-search** — a deterministic model of an agent with file reads and
text search over the working tree, starting at the touched paths. It searches
for importers and importees to a fixed point, then reads the reached components'
docs, manifests and checks. It has no compiled graph or compiler-derived
relations. Its complete heuristics are below.

**catalog** — what `agentdoc query` returns for the touched paths, plus the
context of the components `impact` says are affected.

**baseline-full** is retained only as a size yardstick: all graph entities,
relations, event subjects, checks and documents. It is a graph inventory, not
unaided repository exploration.

No model is involved. Retrieval sets are compared as sets. All systems and the
noise closure use `evals/facts.mjs`: resource links use `uses:` / `usedBy:`, API
links use `provides:` / `consumes:` / `provider:` / `consumer:`, and component
and placement links use bare entity refs. A relation also identifies its other
endpoint, as query's neighbour summaries do. Inverse edges respect direction.
An API subject supplies `provides:<its-ref>`, as query does. Documents use
`doc:` throughout, including the old targeted sweep (formerly `repodoc:`).
Compiler relation names are not separate facts. Tests pin this vocabulary.

## Metrics

| metric | definition |
|---|---|
| recall | fraction of the scenario's ground-truth facts retrieved by each system |
| critical recall | the same, restricted to critical context: constraints, conflicts, observations, resources, API boundaries, event subjects |
| verification recall | fraction of the scenario's verification expectations returned; 1 when there are no expectations, for every system |
| check selectivity | distinct recommended check IDs / distinct check IDs in the repository graph (`verification` + `gates`); reported only, not gated; lower means fewer checks recommended |
| precision | `1 - irrelevance` |
| irrelevance (noise) | fraction of retrieved facts outside the graph's one-hop closure of the touched entities |
| retrieval reduction | `1 - catalog facts / baseline-full facts` |

Scenario verification expectations accept `verify:<command>` and
`verify-id:<check-id>`. Use check IDs when multiple components have the same
command (for example `go test ./...`), so the library's own check cannot stand in
for a dependent's. Retrieved context includes the entity refs already returned
in query's neighbour summaries, even when those neighbours are dependencies and
therefore absent from impact's affected components.

Check selectivity counts the union of checks returned by queries for touched
and impact-affected entities (`verification.items` and `globalGates`), plus
impact's `recommendedVerification`. It measures the returned lists, respecting
their output caps. IDs deduplicate repeated recommendations while preserving
separate scoped checks that happen to share a command. With no checks in the
graph, selectivity is 1 (there is nothing to narrow). Corpus values are scenario
means; the aggregate is scenario-weighted across corpora. Both CLI reports
include per-scenario values in their `--json` output.

Targeted baseline verification recall is 1 by construction: its verification strategy
runs every graph verification entry and repository gate, so it cannot miss a
registered expectation. Empty expectations also score 1 on both sides. Its
check selectivity is therefore 1. Search discovers its own checks; it does not
inherit this union. Selectivity is the meaningful comparison of
how much routing narrows the check set, read alongside catalog verification
recall so that omitting a required check is not mistaken for an improvement.

`recall` is a scenario mean. `microRecall` instead divides total fact hits by
total truth facts; per-scenario hit/total counts make this independently
recomputable. Aggregate micro-recall uses these raw counts, not corpus means.
The legacy JSON keys remain: catalog metrics are at the top level, targeted
metrics are under `baseline`, and search metrics are under `searchBaseline`.

Search returns scoped `(componentRef, command)` pairs without graph check IDs.
Only the scorer matches these pairs to graph verification entries and gates,
then counts their IDs for selectivity and `verify-id:` expectations. A root
command matches only a repository-scoped check. Identical commands in different
components remain distinct. Unregistered commands remain retrieved facts and
can contribute noise, but do not select a registered ID. Read selectivity with
verification recall; a low value can mean a missed check.

### Search baseline heuristics

`evals/baseline-search.mjs` imports only filesystem/path utilities, the existing
YAML/TOML syntax readers and the shared fact helper. It never invokes adapters,
routing, a package manager, a model or a shell search. The following rules are
fixed independently of scenario truth:

1. **Working tree.** Walk regular files in sorted name order, including
   uncommitted files. Do not follow symlinks. Skip `.git`, `.agentdoc`,
   `node_modules`, `.venv`, `venv`, `__pycache__`, `target`, `dist`, `build` and
   `.next`, and any `graph.json`. Read JS/TS (including CJS/MJS/JSX/TSX), Go,
   Rust, Python, proto, SQL, Markdown, RST, TXT, JSON, YAML, TOML, INI, CFG,
   MOD, WORK, LOCK and Dockerfile text; skip NUL-containing files. This is a
   literal exclusion list, not `.gitignore` or a tracked-file snapshot.
2. **Ownership only.** YAML documents with `apiVersion: agentdoc.dev/...`
   are excluded from search. For `Component` documents only, take the metadata
   name/namespace as identity, the descriptor directory as source root, and
   string arrays under `spec.context` as owned document paths. Explicit document
   ownership wins, otherwise the longest component root wins. No placement,
   relations, API/resource declarations, journeys, observations or authority
   rules are used. Other files under `agentdoc/` are excluded too.
3. **Import names.** Read each component's root `package.json` name, Cargo
   package name and its underscore spelling, `go.mod` module path, Python
   distribution names, and top-level Python packages with `__init__.py` or
   `__main__.py` (under the root or `src/`). These are search terms, not
   compiler-resolved units. A component without an import name can still own
   touched paths and participate through relative imports or endpoint strings.
4. **Importers and importees.** Search source for JS/TS `from`, `import` and
   `require` quoted specifiers; Go quoted strings; Rust `use`, `extern crate`
   and `name::`; Python line-leading `import` / `from` names. Match exact names
   or slash/dot subpaths. Search manifests for names at word/path boundaries,
   and for local `path =`, `file:` and `link:` dependencies relative to that
   manifest. Relative source specifiers are resolved against their file's
   directory and mapped to an owner. Rust names declared with `mod` in the
   same file are suppressed; Python imports with a matching local `.py` file
   anywhere in the importing component are suppressed. Ambiguous sibling names
   may reach multiple components. There is no symbol resolver, alias resolver
   or full import grammar (for example Python comma imports are incomplete).
5. **Fixed point.** Import evidence connects components in both directions.
   Start with owners of touched files (or explicitly touched component refs),
   add all importers and importees, and repeat until no component is added.
   API/endpoint text links described next participate in the same closure.
   There is no hop limit or output cap.
6. **APIs and endpoints.** Read OpenAPI YAML `info.title` and `paths`, and
   protobuf `service` names. A lowercase hyphenated title plus `-api` (without
   duplicating an existing `-api` suffix) names an OpenAPI fact; a hyphenated
   service name names a protobuf fact. CamelCase boundaries are split. These
   labels are guesses, not lookups in the API catalog; namespaces default to
   `default`. Find readers by literal contract file paths in component files.
   Find providers by exact endpoint strings in source, Next-style
   `/app/<path>/route.ts` files, or `Register<Service>Server` text. Contract
   readers/providers are connected. Touching a contract seeds them and emits
   the API ref and `provides:` fact; reached readers/providers emit API roles,
   with a provider excluded from the consumer set. Other API kinds, dynamic
   routes, semantic serving roles and arbitrary catalog names are not inferred.
   Also connect source/TOML files sharing an exact slash-prefixed endpoint or
   HTTP(S) URL pathname; Next `route.js`/`route.ts` paths count. Ignore `/`.
   Hostnames are ignored. Common paths such as `/api/health` can consequently
   connect unrelated services; the measured noise includes this overreach.
7. **Docs and events.** Read all text belonging to reached components. Markdown,
   RST and TXT files count as `doc:`, except a basename containing `constraint`
   gives `constraint:` and a path containing `runbook` gives `runbook:`.
   In source lines mentioning subject, event, topic, publish or subscribe
   (case insensitive), quoted lowercase-leading dotted strings with at least
   three segments count as events. There are no configured event prefixes or
   compiler event contracts. Imports reach a shared subject's defining file.
8. **Resources and externals.** PostgreSQL URL schemes, `sql.Open("postgres"`,
   `pg`, `psycopg`, `asyncpg`, `sqlx`, `diesel`, or SQL files under `migrations/`
   suggest `resource:default/<component-name>-postgres`. The word `redis`
   suggests `<component-name>-redis`. TOML-style `bucket =` / `queue_name =`
   string literals supply their slugged names. These guesses emit resource refs
   and `uses:`; no catalog resource names are read. Plain environment variable
   names without one of these signals are insufficient to identify a resource.
   External names come from Node dependency maps, Cargo dependency tables,
   Go requirements, Python project dependencies/extras/dev groups and
   requirements text. Names already identifying local units are excluded.
   Conditional dependencies and comments are not semantically evaluated.
9. **Checks.** Node scripts whose names mention test/lint/typecheck/check,
   clippy/vet/pytest/ruff/mypy/unittest return their literal commands; root Turbo
   tasks with those names generate `turbo run <task> --filter=<package>` for
   reached packages. A Go manifest suggests `go test ./...` and `go vet ./...`;
   a Cargo package suggests `cargo test -p <name>` and `cargo clippy -p <name>`.
   Python component text mentioning pytest, ruff or mypy suggests that command
   (`ruff check` for ruff); the nearest ancestor uv/Poetry lockfile selects
   `uv run` / `poetry run`. Unittest without pytest suggests the standard-library
   command `python -m unittest discover`. These are conventional suggestions,
   not proof the checks pass. GitHub Actions YAML run steps are split by lines:
   check-like lines select reached components through explicit package names
   or step/job working directories; unscoped root lines are repository checks.
   Filtered commands, `cd` and matrix expressions without a resolved scope are
   skipped. Expressions, shell semantics and workflow matrices are not expanded.
   Checks deduplicate by component and command.
10. **No hidden knowledge.** There is no scenario-specific branch, truth-set
    lookup or graph membership filter in retrieval. Unsupported constructs may
    miss facts; naming guesses may add facts absent from the graph. Search does
    not infer placement, runtime observations or authority conflicts from code.

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

## Measured comparison (2026-10-27)

Values are scenario means; the aggregate weights corpora by scenario count.
Recall is higher-is-better; noise and check selectivity are lower-is-better
when read alongside recall. All three systems have verification recall 1.0 on
these scenarios.

| Corpus (scenarios) | System | Mean recall | Noise | Check selectivity |
|---|---|---:|---:|---:|
| Koda (9) | baseline-targeted (corrected) | 100.00% | 41.23% | 100.00% |
| Koda (9) | baseline-search | 71.90% | 71.55% | 100.00% |
| Koda (9) | catalog | 100.00% | 4.02% | 28.79% |
| Node/TS (3) | baseline-targeted (corrected) | 100.00% | 17.86% | 100.00% |
| Node/TS (3) | baseline-search | 91.67% | 30.64% | 83.33% |
| Node/TS (3) | catalog | 100.00% | 0.00% | 100.00% |
| Go (4) | baseline-targeted (corrected) | 93.75% | 28.94% | 100.00% |
| Go (4) | baseline-search | 83.33% | 26.01% | 100.00% |
| Go (4) | catalog | 100.00% | 5.88% | 66.67% |
| Mixed monorepo (4) | baseline-targeted (corrected) | 100.00% | 37.82% | 100.00% |
| Mixed monorepo (4) | baseline-search | 100.00% | 41.25% | 100.00% |
| Mixed monorepo (4) | catalog | 100.00% | 5.88% | 54.17% |
| Rust (4) | baseline-targeted (corrected) | 100.00% | 48.25% | 100.00% |
| Rust (4) | baseline-search | 100.00% | 32.81% | 83.33% |
| Rust (4) | catalog | 100.00% | 0.00% | 25.00% |
| Python (6) | baseline-targeted (corrected) | 100.00% | 46.70% | 100.00% |
| Python (6) | baseline-search | 100.00% | 23.68% | 41.67% |
| Python (6) | catalog | 100.00% | 0.00% | 41.67% |
| Aggregate (30) | baseline-targeted (corrected) | 99.17% | 38.83% | 100.00% |
| Aggregate (30) | baseline-search | 88.51% | 42.61% | 84.44% |
| Aggregate (30) | catalog | 100.00% | 2.77% | 46.42% |

Corrected targeted micro-recall is **100/101 = 0.9901** (mean recall 0.9917).
Its only missing truth fact is `component:default/ingest` in b-04. Search
micro-recall is **85/101 = 0.8416** (mean recall 0.8851); catalog micro- and
mean recall are both 1.0. These averages answer different questions and should
not be interchanged.

Search matches catalog recall in 21 scenarios: koda-04, koda-07, a-02, a-03,
b-01, b-03, b-04, c-01, c-02, c-03, c-04, e-01, e-02, e-03, e-04, f-01,
f-02, f-03, f-04, f-05 and f-06. It exceeds catalog recall in none.

The label correction removes the old recall gap against targeted retrieval.
Search recovers all expected facts in many import-related changes, but misses
some catalog identity/placement and authority facts. Its broad fixed point
also reads unrelated context, especially through common endpoint strings in
Koda. These numbers compare deterministic retrieval rules on small authored
corpora; they do not establish an agent productivity or token-saving benefit,
or an upper bound on search. Noise is judged by the catalog's graph closure,
so it is not independent evidence that every extra source fact is irrelevant.

`recallNotWorseThanTargetedBaseline` still **passes**: catalog and corrected
targeted recall tie in five corpora; catalog is higher in Go. Every other
applicable pre-registered gate passes. No threshold or scenario changed and
search has no new gate. Normalizing the vocabulary changes noise and deduplicates
fact counts, so old noise/size figures are not directly comparable. The largest
full inventory now has 86 facts (Koda), below the unchanged 100-fact floor.
Aggregate retrieval reduction is therefore **not measured** (`null`), with no
corpus included in that aggregate. Per-corpus raw ratios remain reported.

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
| `fixtures/e-rust-workspace` | 4 | Cargo workspace, shared crate and its dependent, member manifest, local module, ambiguous crate names |
| `fixtures/f-python-workspace` | 6 | uv workspace, shared library and its dependent, member manifest, shadowed import, nested workspace, Alembic database, unittest |

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
shared across runtimes; add an operation to a contract. The Rust workspace adds
a shared crate, the manifest that declares its dependents, a local module that
shares a name with another crate, and a hyphenated crate beside its underscored
twin. The Python workspace adds a shared library, a service manifest, an import
shadowed by a local module, a nested workspace member, an Alembic migration
bound to its database, and a job whose check is `python -m unittest discover`.

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
- Search is one explicit model of exploration, not a record of an agent
  session or an upper bound on what search can find. Its import and endpoint
  closure deliberately errs toward reading more; different heuristics can
  produce different recall and noise.
- The targeted baseline's old label mismatch is corrected. It still reads the
  compiled graph, so its near-perfect recall does not measure unaided search.
  The former 100%-versus-58% comparison remains withdrawn; see
  [BENCHMARK.md](BENCHMARK.md#correction-the-fact-recall-comparison-is-withdrawn).
- Noise is judged by the catalog's one-hop graph closure, including for search.
  Useful source facts absent from that graph can count as noise, and legitimate
  transitive importer context can fall outside one hop. This is not an
  independent ground truth for irrelevant work or an agent time/token metric.
- `retrievalReduction` is a fact-count proxy, not a token count. It does not
  weight a long constraint file against a short ref.
- Scenarios touch one or two files. A change spanning twenty files is not
  measured.
