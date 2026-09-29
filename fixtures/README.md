# Portability fixtures

Three synthetic repositories, each tagged so the routing evaluation only runs
its own scenarios against it.

| fixture | shape | what it is for |
|---|---|---|
| `a-node-ts-postgres` | one Node/TypeScript service, REST, Postgres, GitHub Actions | the simplest thing that should work |
| `b-go-multi-service` | multi-service Go, protobuf, shared library, resources | contracts that are not HTTP |
| `c-alt-monorepo` | `backend`/`frontend`/`shared`/`edge`, mixed runtimes, stale docs | the engine must not assume `apps`+`packages`+`workers` |

Each is a self-contained cataloged repository: its own
`agentdoc/agentdoc.config.yaml` and committed graph inputs, tracked in this
repository's history. The tag lives in `.agentdoc-fixture.json`.

Commands below assume the `agentdoc` CLI is on PATH — installed globally
(`npm install -g github:lbframe/agent-doc-system`) or via `npm link` in this
checkout.

```bash
cd fixtures/c-alt-monorepo
agentdoc validate && agentdoc compile && agentdoc check
agentdoc query edge/wrangler.toml
agentdoc audit          # finds the stale legacy documentation
```

## The one that matters most

`c-alt-monorepo` is the portability proof. Its layout shares nothing with the
reference project: no `apps/`, no `packages/`, no `workers/`, a Go backend and
a TypeScript frontend and edge worker in one repository, a wire contract
directory named `wire`, and a `legacy-docs/` directory whose claims contradict
the code.

```bash
agentdoc audit | jq '.documentationContradictions, .documentation.orphanDocs'
```

It reports a negated component claim, a port mismatch, an unlinked port claim,
and two orphan documents — all derived from the graph, none of it hard-coded for
this fixture.
