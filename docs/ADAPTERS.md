# ADAPTERS

An adapter knows one technology's vocabulary. It does not know your repository.

## The contract

```js
class MyAdapter extends Adapter {
  static adapterName = "my-technology";

  constructor() { super({ name: "my-technology", version: "1.0.0", kind: "unit-marker" }); }

  // Unit-marker adapters: does this directory host a unit of my kind?
  detect(ctx, root) { return { path: root + "/manifest.toml", shape: "deployable" }; }

  // Contribute workspace member roots the descriptor globs cannot know about.
  roots(ctx) { return [{ root: "modules/a", importable: true }]; }

  // Per-unit extraction. Return plain data; the pipeline merges it.
  extract(ctx, unit) { return { languages: new Set(["mylang"]), bindings: [...] }; }

  // Contract indexing. Runs once, after every unit is known.
  contracts(ctx) { ctx.addContract({ apiRef, ref, operations: [...] }); }
  }
}
```

Available on `ctx`:

| member | purpose |
|---|---|
| `repo` | tracked repository access (`readText`, `exists`, `isDir`, `walk`, `git`, `diffPaths`) |
| `cfg` | the parsed configuration |
| `refs` | `refFor`, `kindOfRef`, `isValidRef` for this repository's namespace |
| `prov.add(class, path, extractor, subjects)` | create a provenance record |
| `diagnostics.push({ severity, code, message, ... })` | a warning or an error |
| `addFact(subject, key, value, { evidenceClass, confidence, provRecs, semantics, observed, review })` | record a claim |
| `addEdge(type, sourceRef, targetRef, attributes, provRecs, evidenceClass)` | propose a relation |
| `addEvent(pattern, role, componentRef, provRec, contract)` | an event subject |
| `addExternal / addCapability` | indexes |
| `addVerification({ id, componentRefs, tier, command, configPaths, provRecs })` | a component-scoped check |
| `addGate({ id, tier, command, configPaths, provRecs })` | a repository-scoped check |
| `transitiveDependencies(ref)` | manifest-declared dependencies, order-independent |
| `productionDependencies(ref)` | production dependency names, for client-of-resource rules |
| `deferSecondPass(fn)` | run after every unit is known |
| `unitByPkgName`, `unitByGoModule` | cross-unit resolution built before extraction |
| `errors.push({ code, message })` | a hard error, collected rather than thrown |

## The three rules

### 1. An adapter may not know the repository

No folder names, no project names, no domain vocabulary, no provider names, no
event prefixes, no organisation. A `koda.` subject prefix is configuration
(`discovery.eventPatternPrefixes`), not code. A `dist/` directory is a generated
directory, not a component.

If you catch yourself writing a project name in an adapter, the fact belongs in
`agentdoc.config.yaml`.

### 2. An adapter may not assert

An adapter extracts. It does not decide. If your extractor can produce two
answers, it must produce **neither** and a diagnostic:

```js
if (matches.length > 1) {
  ctx.diagnostics.push({ severity: "warning", code: "AGENTDOC_BINDING_AMBIGUOUS", ... });
  return;                       // not: pick matches[0]
}
```

A candidate that is the only candidate is still a candidate, and candidates are
never elected. Migration authority is not database ownership. A folder that
looks like a service is not a service.

### 3. Every fact needs evidence

Anything an adapter adds carries provenance records it created itself. If you
cannot name the file a fact came from, you cannot add the fact.

## Shipped adapters

| adapter | recognises | contributes |
|---|---|---|
| `generic` | — | health-route literals, a single-port fact |
| `node` | `package.json` | importability, npm dependency edges, script tiers |
| `pnpm` | `pnpm-workspace.yaml` | workspace member roots |
| `turborepo` | `turbo.json` (nearest ancestor) | per-package task commands |
| `typescript` | `tsconfig.json` | language, project references, file-router routes |
| `go` | `go.mod`, `go.work` | module roots, module graph, `go test`/`go vet` |
| `openapi` | `*.openapi.y[a]ml` | operation inventory, deterministic consumers |
| `asyncapi` | `*.asyncapi.y[a]ml` | validated as an AsyncAPI document by the same adapter |
| `asyncapi` / `protobuf` / `graphql` | contract files | method/type inventory, consumers |
| `oidc` | discovery-path literals | OIDC client consumers |
| `github-actions` | `.github/workflows` | component-scoped checks and repository gates |
| `dockerfile` | `Dockerfile`, `Containerfile` | deployable evidence |
| `deploy-config` | `fly.toml`, `Procfile`, … | deployable evidence |
| `wrangler` | `wrangler.toml/json` | bindings, crons, service bindings, trigger targets |
| `database` | migrations, ORM config, pool evidence | logical-database ownership, or a candidate |
| `object-store` | bucket literals | logical-dataset edges, or an ambiguity |
| `cache` | cache client evidence | cache bindings |
| `events` | subject literals, declared constants, event-contract files | producers, consumers, reserved subjects |

`generic` is always on. Everything else is opt-in through `adapters: [...]`, and
an unknown name is `AGENTDOC_CONFIG`, not a silent no-op.

## Enabling

Adapters only cost what they read. Start with what the repository demonstrably
uses; add more when the audit says a fact is missing. Enabling every adapter is
not free and not always right: `events` with no `eventPatternPrefixes` falls back
to a conservative three-segment subject shape, which is right for subject-based
brokers and wrong for a repository that uses dotted identifiers for something
else entirely.

## Determinism

An adapter is a pure function of the checkout and the configuration.

- Sort everything. `Set` iteration order is insertion order, which depends on
  the order files were read.
- Never read a clock, an environment variable outside the repository, a random
  value, or an absolute path. The determinism guard scans the graph's structure
  for exactly these, and compilation fails if one appears.
- Do not depend on execution order. `transitiveDependencies` and
  `unitByPkgName` are computed from manifests before extraction; use them rather
  than reading `ctx.edges`.
- Bump `version` when behaviour changes. It is part of the graph input hash, so
  an upgrade invalidates every graph — which is correct, because the graph
  changes.

## Testing an adapter

1. Build a fixture with the smallest repository the adapter must recognise, plus
   one ambiguity it must refuse.
2. Assert the exact diagnostics and error codes, not message text.
3. Assert that two compiles produce identical bytes.
4. Assert the provenance: every added record names a real file and a real hash.

The adversarial suite (`tests/adversarial.test.mjs`) is the model: inject a
defect, assert the right code.

## What the core still knows

The engine's *layout* knowledge is empty: no folder name, no provider, no domain
vocabulary. It does, however, know the shape of a manifest filename in three
places, and those are the honest exceptions worth naming:

- `core/compile.mjs` builds a manifest pre-pass over `package.json`, `go.mod`
  and `go.work`, so `unitByPkgName`, `unitByGoModule` and
  `transitiveDependencies` are available to every adapter regardless of
  execution order.
- `core/impact.mjs` classifies a changed file by consulting the compiled graph —
  its contracts, its provenance paths, its extractor identities — rather than a
  hand-written list of technology filenames. A list would silently under-report
  for every repository that is not Node-and-Go.
- `core/discover.mjs` has a default list of directories that are never units
  (`agentdoc`, `docs`, `scripts`, `.github`), overridable through
  `discovery.notUnitRoots`.

Each is a place a future change should push outward, not a licence to add more.

## Adding one to a project

Adapters live in the compiler, not in the project, precisely so a project cannot
extend the fact model into something unreviewable. If your technology is not
covered, the honest options are to describe the boundary with a canonical
contract and a `reviewedOverride`, or to contribute an adapter upstream.
