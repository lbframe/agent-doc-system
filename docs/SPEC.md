# SPEC

Normative specification of the agent documentation system. Where this document
and the code disagree, the code is the defect.

## 1. Purpose

Given a repository, the system produces one deterministic graph that answers,
for any source path or entity: what this is, what it depends on, what depends
on it, what it must not violate, and which command proves a change correct.

## 2. Namespace and versioning

| artefact | identity |
|---|---|
| entity descriptor | `apiVersion: agentdoc.dev/v1` |
| configuration | `apiVersion: agentdoc.dev/config/v1` |
| observation set | `apiVersion: agentdoc.dev/observation/v1` |
| journeys | `schemaVersion: agentdoc.dev/journeys/v1` |
| compiled graph | `schemaVersion: agentdoc.dev/graph/v1` |
| JSON Schema ids | `agentdoc.dev/schema/<name>.json` |
| compiler | `agentdoc-compiler@<semver>` |

**Evolution rules.**

- The major version in `apiVersion` changes only on a breaking change to the
  descriptor shape. The compiler accepts exactly one major version and refuses
  anything else with `AGENTDOC_API_VERSION`; a future format is never half-read.
- Every schema is `additionalProperties: false`. An unknown field is
  `AGENTDOC_UNKNOWN_FIELD`, not a silently ignored key.
- Forward evolution happens through the per-entity `extensions` object, which is
  typed as free-form and ignored by every core rule — including the prohibited
  field check, so the escape hatch is genuinely usable for exactly the
  slow-drifting metadata that has no home in an entity.
- The compiled graph records `schemaVersion`, `compiler.name`,
  `compiler.version` and `compiler.adapters`. Freshness refuses a graph built by
  a different compiler or schema.
- Schema files ship with the compiler, not with the target repository. A
  project cannot loosen validation by editing a schema. Their content hashes are
  folded into the graph input hash, so upgrading a schema invalidates every
  graph compiled against the old one.

## 3. Source dialect

Authored sources are a strict YAML 1.2 subset, parsed by `core/yaml.mjs`:

- supported: multi-document streams, block mappings, block sequences, plain and
  quoted scalars, flow sequences and mappings of scalars, literal and folded
  block scalars, comments, and YAML 1.2 core scalar resolution.
- rejected with a dedicated code: anchors, aliases, custom tags, merge keys,
  environment interpolation, duplicate mapping keys, tab indentation,
  non-UTF-8 input, complex keys, and any nesting the parser would have to guess
  at.

The rationale is that authored descriptors are templates plus human review, and
ambiguity in them is a defect rather than a feature.

## 4. Entity model

Five entity kinds, and five only. Journeys, events, external dependencies,
capabilities, verification entries, gates, contracts, assertions and
observations are **not** entities and may never appear as a relation endpoint.

```
Domain    a bounded area of the product with its own vocabulary
System    a responsibility inside a domain, grouping components
Component a deployable or importable software unit
API       a durable cross-component boundary with one canonical contract
Resource  a logical thing shared or owned across components
```

An entity carries: a stable ref, `metadata` (name, one-sentence description,
optional labels), an optional `spec`, and an `extensions` bag. Every entity is
authored in exactly one file, and the location is validated.

**Ref format:** `<kind>:<namespace>/<name>`, e.g. `component:default/teacher`.
The namespace comes from the configuration, so two repositories in one graph
never collide.

### Why no further entities

A `Team`, `Milestone` or `Tag` entity was considered and rejected: none of them
can be derived, none of them changes a fact in the graph, and all three would
need a lifecycle and an owner — the two things this system deliberately refuses
to model, because they are the fields that drift fastest and carry the least
architectural meaning. Ownership is expressed by placement; lifecycle belongs
in version control.

## 5. Facts, evidence and confidence

A **fact** is a claim about one `(subject, key)` pair. `key` is a dotted
name, optionally namespaced, e.g. `schedule.cron`, `binding.declared`,
`contract.supports`, `component.deployable`, `placement.system`,
`resource.ownership`. `core/authority/facts.mjs` documents the semantics of the
well-known keys.

Every fact carries an **evidence class** and a **confidence**:

| evidence class | meaning |
|---|---|
| `AUTHORED` | explicitly declared and intentionally maintained in this repository |
| `DERIVED` | deterministically extracted from committed inputs |
| `OBSERVED_RUNTIME` | read from an authoritative external or running system |
| `EXTERNAL_STANDARD` | the canonical authority is a published standard |
| `REVIEWED_OVERRIDE` | a reviewer approved an interpretation |
| `UNRESOLVED` | known ambiguity that must not become truth |

| confidence | meaning |
|---|---|
| `direct` | read straight from the named authority system |
| `deterministic` | a reproducible function of committed inputs |
| `declared` | asserted by a human-maintained document |
| `reviewed` | a reviewer signed off on an interpretation |
| `candidate` | heuristic; **never** allowed to become an elected fact |

See `AUTHORITY.md` for the full semantics and the conflict model.

## 6. Relations

No relation is ever authored. Placement edges come from authored placement
fields, provider edges from the API descriptor, and everything else from
deterministic extractors or bounded reviewed overrides.

```
partOf / hasPart              Component->System|Domain, System->Domain, Resource->System
providesApi / apiProvidedBy   Component<->API
consumesApi / apiConsumedBy   Component<->API
buildDependsOn / buildDependencyOf
testDependsOn  / testDependencyOf
runtimeCalls   / runtimeCalledBy
usesResource   / resourceUsedBy
schedules      / scheduledBy
```

Every relation is emitted with its inverse, its kind pair is validated, its
attribute keys are checked against a closed per-type whitelist, and duplicates
merge their provenance instead of forking the graph. Every relation carries at
least one provenance id and an evidence class.

## 7. The compiled graph

```
schemaVersion, source{commit, dirty, inputHash}, compiler{name, version, adapters}
entities[]      ref, kind, name, entity, source, sourcePaths[], derived?
relations[]     type, sourceRef, targetRef, evidenceClass, attributes, provenanceIds[]
interfaces.events[]              pattern, producers, consumers, contract, resolution
externalDependencies[]           componentRef, name, role, mechanism, evidenceClass
capabilities[]                   componentRef, name, evidenceClass
verification[]                   id, componentRefs, tier, command, configPaths
gates[]                          id, tier, command          (repository-scoped checks)
contracts[]                      apiRef, ref, operations    (pointer + inventory, never a copy)
journeys[]                       id, description, components
assertions[]                     id, subject, key, value, evidenceClass, confidence, status
conflicts[]                      id, subject, key, kind, status, assertionIds, election
observations[]                   id, environment, sourceSystem, collector, capturedAt, facts[]
provenance[]                     id, class, path, extractor, contentHash, subjects[]
diagnostics[]                    severity, code, message, acceptance?
```

### 7.1 Determinism

The graph is a pure function of the checkout.

- Objects are constructed in schema order; every array is sorted by a total
  order over its identifying key.
- No wall-clock value, host path, username, process id or random id is
  introduced at compile time.
- **Observation timestamps are the one permitted time value**, and only because
  they are read from a committed `ObservationSet`. Before emission, the
  serialized graph is scanned and every timestamp present must be one the
  compiler actually read; anything else fails with `AGENTDOC_NONDETERMINISTIC`.
- The serialized output is scanned for absolute paths, host directories and
  process identity. The scan covers the graph's *structure* — refs, ids, paths,
  hashes, keys, provenance — and not opaque free-text fields, which are copied
  verbatim from committed files and are therefore a pure function of the
  checkout by construction. A repository is free to mention `/tmp` in a CI
  command; a compiler-introduced host path is not.
- Provenance ids are positional over a canonical sort, so they are stable.

`compile` is idempotent: compiling the same checkout twice produces identical
bytes, and `check` proves the committed bytes equal a fresh compile.

### 7.2 Freshness

`source.inputHash` is a length-prefixed hash over:

1. the compiler name and version, the graph schema version, the entity api
   version, the authority-rule count, every enabled adapter's name and version,
   and the content hash of every shipped schema;
2. every file the compiler read, as `path` + content;
3. every existence probe, as path + result;
4. every directory listing, as directory + sorted file list.

Every byte flows through the read tracker, so the record is complete by
construction. A consumer must refuse a graph whose `inputHash` or `dirty` flag
disagrees with the current checkout. There is no fallback.

The recorded `commit` is **provenance, not a gate**: committing the graph changes
`HEAD`, so a commit-equality check could never be satisfied by a committed graph.
What determines whether the graph still describes the repository is the input
hash and the dirty flag. A checkout with no VCS still compiles: the commit
becomes `0000000` and freshness rests on the hash alone.

`dirty` is true when a path that influenced the output differs from `HEAD`,
excluding the generated graph itself.

### 7.3 Time-dependent gates

Observation staleness is time-dependent and is therefore evaluated at gate time
(`check`, `query`), never at compile time. A compile stays a pure function of the
checkout; a gate may legitimately fail because time passed.

## 8. Contracts

Every durable cross-component boundary has exactly one canonical
machine-readable contract, and the graph **points at** it rather than copying
it. Supported dialects, all validated on load:

| type | validation |
|---|---|
| `openapi` | `openapi` 3.0/3.1, `info.title`, `paths`, `components` |
| `asyncapi` | `asyncapi` version, `channels` |
| `protobuf` | `syntax` or `edition`, at least one `service` |
| `graphql` / `graphql-sdl` | at least one type definition |
| `oidc` | a named standard plus an absolute discovery path; the provider must expose that path in its own source |

Two rules enforce the "exactly one" property: a contract file under a
configured `contractRoots` that no API claims is `AGENTDOC_CONTRACT_UNCLAIMED`,
and two APIs claiming the same file is `AGENTDOC_CONTRACT_SHARED`.

Consumers are discovered deterministically: a unit, other than the provider,
that references the contract file from a source or build-configuration file.

## 9. Discovery

The core has no knowledge of folder names. A directory is a unit when it holds
a component descriptor, when an adapter recognises it from a workspace file, or
when it is listed in `discovery.supplementalRoots`.

- Every discovered unit must have exactly one descriptor at its root, or
  `AGENTDOC_COVERAGE_ZERO`.
- Two descriptors at one root, or a descriptor no adapter can corroborate, is an
  error. A descriptor is a human claim; an uncorroborated claim is a defect.
- The authored `type` is cross-checked against the artifact evidence:
  a `library` with no importable artifact, or a `service` with no deployable
  artifact, is `AGENTDOC_ARTIFACT_TYPE`.

## 10. Provenance

See `PROVENANCE.md`. In summary: every important fact carries at least one
provenance record with a path, a content hash, an extractor identity and RFC
6901 subject pointers into the graph. Classes are `declared`, `observed`,
`validated`, `runtime` and `standard`.

## 11. Diagnostics and warning acceptance

Error-severity diagnostics block publication. Warnings may be **accepted** with
a reviewed disposition carrying `code`, `subject`, `classification`, `reason`,
`reviewWhen`, `observedRefs` and evidence content hashes.

An acceptance must match exactly one current warning, its `observedRefs` must
equal the diagnostic's current refs, and every evidence digest must still match.
If the evidence changes, the acceptance stops matching and compilation fails:
a review is forced, not inherited. Acceptance can never downgrade an error, and
only the codes in `ACCEPTABLE_WARNING_CODES` may be accepted.

## 12. Commands

| command | contract |
|---|---|
| `init [--force]` | write a configuration and documentation skeleton; never clobber unless `--force` |
| `scaffold [--write]` | generate descriptors from provable evidence; dry run by default |
| `audit` | classify every fact; runs even when the repository cannot compile |
| `validate` | sources, schemas, semantic checks; no artifact written |
| `compile [--require-clean]` | deterministic build, atomic replace |
| `check [--require-clean] [--allow-stale-observations]` | freshness, determinism, time gates |
| `query <path\|ref> [--json] [--md]` | route context; refuses a stale graph |
| `impact <paths> \| --diff <ref>` | change impact; compiles in memory |
| `eval routing [--json]` | routing evaluation; `SKIP` when the repository has no scenarios |
| `pin-evidence [--json]` | check the digests pinned by reviewed overrides |
| `doctor` | environment self-check: node version, schema bundle, git, writability |

Exit codes: `0` ok, `1` failure, `2` usage.

## 13. Error codes

Every failure carries a stable `AGENTDOC_*` code, a path or ref when relevant,
and an actionable message. Codes are listed in `core/codes.mjs` and are part of
the contract: tests and CI match on identity, never on message text.

## 14. Source schema dialect

Schemas use the JSON Schema 2020-12 subset the shipped validator implements:
`$ref` (bundle ids and `#/$defs/...`), `$defs`, `type`, `const`, `enum`,
`required`, `properties`, `additionalProperties`, `patternProperties`, `items`,
`prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`,
`pattern`, `minimum`, `maximum`, `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/
`else`, `propertyNames`, `minProperties`.

Two things follow, and both are enforced rather than asserted:

- **No unsupported keyword can be used.** A test walks every shipped schema at
  every position where a schema may appear, against the validator's own
  exported keyword set, and fails on anything else. `format` is deliberately
  *not* in that set, so a schema author who reaches for `format: date-time`
  gets a failure rather than a validator that quietly does nothing.
- **`entities[].entity` and `entities[].derived` are opaque payloads** in the
  graph schema. The authored half is validated against its per-kind entity
  schema at input time, which is where a malformed descriptor must be caught;
  re-validating the same document against the graph schema would be a second
  source of truth for the same constraint. Every other graph surface is closed
  (`additionalProperties: false`).

## 15. Dependencies

None. The YAML subset parser, the JSON Schema validator, the TOML reader, the
glob matcher, the hashing and the deterministic serializer are all in-tree.
Node 22 or newer. No network, no service, no hosted anything.

## Reviewed overrides are re-verified, and so are their review conditions

A `REVIEWED_OVERRIDE` is the highest-authority input the model accepts, and the
only thing that can falsify it is the evidence it cites. So each override:

- must state `reviewWhen` — the condition under which it is re-examined. A
  review with no re-examination condition is a review that is never revisited,
  and a defaulted string would be the same sentence on every override: a review
  condition that conditions nothing, reported as though it were real;
- pins its evidence by content hash (`{path, sha256}`), and those digests are
  re-verified on every compile. If a cited file changes, compilation fails with
  `AGENTDOC_OVERRIDE_STALE` and the interpretation must be reviewed before the
  digest is updated. A digest that is recorded but never compared is decoration;
  `agentdoc pin-evidence` reports which digests are current so the repair is
  possible without computing SHA-256 by hand.

The same discipline applies to accepted warnings, for the same reason. An
authority rule's own `reviewWhen` travels onto the conflict it settles, so
`query`'s `reviewCommitments` surface reports a real condition or says plainly
that none was recorded — never a pointer to a record that does not exist.
