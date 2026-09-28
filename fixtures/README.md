# Portability fixtures

Three synthetic repositories, each tagged so the routing evaluation only runs
its own scenarios against it.

| fixture | shape | what it is for |
|---|---|---|
| `a-node-ts-postgres` | one Node/TypeScript service, REST, Postgres, GitHub Actions | the simplest thing that should work |
| `b-go-multi-service` | multi-service Go, protobuf, shared library, resources | contracts that are not HTTP |
| `c-alt-monorepo` | `backend`/`frontend`/`shared`/`edge`, mixed runtimes, stale docs | the engine must not assume `apps`+`packages`+`workers` |

Each is a real repository: it has its own git history, its own
`agentdoc/agentdoc.config.yaml`, and its own committed graph inputs. The tag
lives in `.agentdoc-fixture.json`.

```bash
cd fixtures/c-alt-monorepo
node ../../bin/agentdoc.mjs validate && node ../../bin/agentdoc.mjs compile && node ../../bin/agentdoc.mjs check
node ../../bin/agentdoc.mjs query edge/wrangler.toml
node ../../bin/agentdoc.mjs audit          # finds the stale legacy documentation
```

## The one that matters most

`c-alt-monorepo` is the portability proof. Its layout shares nothing with the
reference project: no `apps/`, no `packages/`, no `workers/`, a Go backend and
a TypeScript frontend and edge worker in one repository, a wire contract
directory named `wire`, and a `legacy-docs/` directory whose claims contradict
the code.

```bash
node ../../bin/agentdoc.mjs audit | jq '.documentationContradictions, .documentation.orphanDocs'
```

It reports a negated component claim, a port mismatch, an unlinked port claim,
and two orphan documents — all derived from the graph, none of it hard-coded for
this fixture.
