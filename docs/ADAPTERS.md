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
| `requirements` | declared normative requirements (`subject`, `key`, `value`, `source`, `satisfiedBy`, `expects`) an adapter may derive the implementation side of |
| `unitByPkgName`, `unitByGoModule`, `unitByCrateName` | cross-unit resolution built before extraction |
| `unitByPythonDist`, `unitByPythonImport` | Python distribution names (PEP 503) and import names, built before extraction |
| `errors.push({ code, message })` | a hard error, collected rather than thrown |

For per-unit source inventories, use `sourceFiles(repo, unit.root)` or
`repo.walkUnit(unit.root, directory = unit.root)`. Discovery computes ownership
once from eligible units: these scans prune nested unit roots, so a file belongs
only to its deepest enclosing unit. `repo.ownsUnitPath(unit.root, path)` applies
the same boundary to custom traversals. Keep `repo.walk` for repository-wide
discovery and authored inputs; explicit cross-unit references can still be read.

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
| `rust` | `Cargo.toml` (`[package]`), workspace `members` (including a workspace below the repository root) | crate roots, path, workspace, and `[patch]`/`[replace]` dependency edges, `cargo test`/`cargo clippy` |
| `python` | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt` | distribution graph, import edges, evidence-backed test and static commands |
| `openapi` | `*.openapi.y[a]ml` | operation inventory, deterministic consumers |
| `protobuf` / `graphql` | contract files | method/type inventory, consumers |
| `oidc` | discovery-path literals | OIDC client consumers |
| `github-actions` | repository-root `.github/workflows` (not a unit marker; a nested one is ignored, as GitHub ignores it) | component-scoped checks and repository gates |
| `dockerfile` | `Dockerfile`, `Containerfile` | deployable evidence |
| `deploy-config` | `fly.toml`, `Procfile`, … | deployable evidence |
| `wrangler` | `wrangler.toml/json` | bindings, crons, service bindings, trigger targets |
| `database` | migrations, ORM config, pool evidence | logical-database ownership, or a candidate |
| `object-store` | bucket literals | logical-dataset edges, or an ambiguity |
| `cache` | cache client evidence | cache bindings |
| `events` | subject literals, declared constants, event-contract files | producers, consumers, reserved subjects |
| `ansible` | playbooks (YAML lists of plays) | deployable evidence, installed paths and managed services, the DERIVED side of provisioning requirements |

`generic` is always on. Everything else is opt-in through `adapters: [...]`, and
an unknown name is `AGENTDOC_CONFIG`, not a silent no-op.

### `ansible`

Reads playbooks under a unit root and follows what they reach — plays,
`roles:`, `include_role`/`import_role`, `include_tasks`/`import_tasks`,
`import_playbook`, `block`/`rescue`/`always` — inside the repository only.
Nothing is executed and no Jinja is evaluated.

| it derives | from |
|---|---|
| an installed path | `copy`/`template`/`get_url`/`git`/`synchronize` `dest`, `unarchive` `dest`/`creates`, `pip` `virtualenv`, `file` with `state: directory\|touch\|link\|hard`, `lineinfile`/`blockinfile` with `create: true`, a command's literal `creates` |
| a managed service | `systemd`, `systemd_service`, `service` `name` |

The inventory lands on the component as `derived.provisioning`. For a normative
requirement on that component with `satisfiedBy: [ansible]` and an `expects`
(`installs: <path>` or `service: <name>`), it adds a `DERIVED` fact on the
requirement key:

| value | confidence | when |
|---|---|---|
| `provided` | deterministic | a reachable task without `when` installs the path (or a path below it), or manages the service |
| `provided` | candidate | the only matching task is conditional (`when`, `rescue`, a conditional role or include) |
| `absent` | deterministic | no reachable task matches **and** every reachable task is transparent |
| `absent` | candidate | no task matches, but something opaque was reached |

**What it cannot see, and therefore never rules out:** a command
(`shell`/`command`/`script`/`raw`) without a literal `creates`; a module it does
not model (`apt`, `dnf`, `package`, collections, …); a templated path or a
`loop`; a role, include or imported playbook that is not in the repository or is
templated; a file that does not parse. Any of these makes an absence a
candidate, which is never elected — the requirement stays
`AGENTDOC_REQUIREMENT_UNVERIFIED` and the diagnostic names what was opaque.
Inventory files, `group_vars`/`host_vars` and variables are not read.

### `rust`

Reads `Cargo.toml`. A `[package]` is a unit. A virtual workspace manifest (only
`[workspace]`) is not. Nothing is executed, and `Cargo.lock` is not read.

| it derives | from |
|---|---|
| `languages: rust`, `runtimes: rust` | the package manifest |
| deployable | `[[bin]]`, `src/main.rs`, or a `src/bin/` directory |
| importable | `[lib]` or `src/lib.rs`; both shapes when both are present |
| `buildDependsOn` | `[dependencies]`, `[build-dependencies]`, and `[target.<cfg>.dependencies]` / `[target.<cfg>.build-dependencies]`, when the entry is a `path`, `workspace = true` resolved through the nearest `[workspace.dependencies]`, or a `[patch.<registry>]` / `[replace]` path redirect to a sibling inside the repository. A production `use`, `extern crate`, or `<crate>::` path (`-` and `_` are the same ident) adds provenance to that edge; it never creates one |
| `testDependsOn` | `[dev-dependencies]` and target-specific dev-dependencies, resolved the same way |
| `hasTests` | a `tests/` directory, or `#[test]` / `#[cfg(test)]` in a `.rs` file |
| verification | `cargo test -p <name>` (unit) and `cargo clippy -p <name>` (static) |

`-p <name>` is the whole scope of the recorded command. Cargo, run at a virtual
workspace root, has no current package; `-p` is what makes the command mean
this crate rather than every member. `configPaths` is that crate's
`Cargo.toml`.

Workspace roots come from every `Cargo.toml` that has `[workspace]`, not only
the one at the repository root. The search is bounded to five directories
down, stays inside the repository, and does not enter `discovery.notUnitRoots`,
`discovery.generatedDirs`, dot-directories, or `test` / `tests` / `examples` /
`example`. `members` minus `exclude` are still relative to the manifest that
declares them; `*` matches one path segment, and a member that leaves the
repository is ignored. `workspace = true` resolves against the nearest
enclosing workspace. A virtual manifest (no `[package]`) is not a unit and is
not scaffolded. A manifest that has both `[package]` and `[workspace]` is a
unit, the same as any other package. Scaffold types a crate from its shape: deployable-only
(`[[bin]]`, `src/main.rs`, `src/bin/`) is `service`, importable-only is
`library`, and a crate that is both follows the usual rule (deployable wins,
so `service`).

The manifest route and a corroborating import share the target crate's
package name as their edge key, so one dependency is one edge. A rename
(`package = "…"`) is the crates.io name; the `use` path is the table key.
`[patch.<registry>]` and `[replace]` contribute only when the value is a
`path` that stays inside the repository and the package is already a
dependency. A path and a patch that name two different siblings is
`AGENTDOC_BINDING_AMBIGUOUS` and no edge is created.

**What it cannot see, and therefore never invents:** a dependency that exists
only as a `use`, `extern crate`, or `<crate>::` path. Rust will not link a
crate the manifest does not declare, and a local module (`mod engine;
engine::run()`) is the same spelling as a crate path, so an import that the
manifest did not already resolve creates no edge. An import whose ident
matches two sibling crates (`foo-bar` and `foo_bar` are both `foo_bar`) is
`AGENTDOC_BINDING_AMBIGUOUS` and still creates no edge. Also invisible: a
`Cargo.lock` resolution or any version requirement that merely shares a name
with a sibling; a workspace member outside the repository; a workspace
manifest deeper than the search bound; a `#[cfg(test)]` or `#[test]` item,
which is not a production import; a duplicate package name, which is not
elected either. A `Cargo.toml` this TOML reader rejects yields
`AGENTDOC_YAML_PARSE` and no dependency edges. The unit is still recognised when a `[package]` header is present, so
a parse failure is not an empty unit and not a crash. Char literals and
lifetimes are not strings: a lifetime does not hide the imports after it, and
a `"` string that spans lines does not leak the idents inside it.

### `python`

Reads a unit's Python manifest and its `import` / `from` statements. It does
not run Python, resolve a lockfile, or inspect a virtualenv.

| it derives | from |
|---|---|
| deployable | `[project.scripts]`, `[project.gui-scripts]`, `[tool.poetry.scripts]`, a `console_scripts` entry point, `__main__.py`, `manage.py`, or an ASGI/WSGI app object (`app` / `application` assigned from `FastAPI`, `Flask`, `Starlette`, `Litestar`, `Sanic` or `Quart`, or a call to `get_asgi_application` / `get_wsgi_application`) |
| importable | a build backend (`[build-system] build-backend`, or `setup.py` / `setup.cfg`) and a package |
| the import name | an explicit package list (`[tool.setuptools] packages`, `[tool.poetry] packages`, `[tool.hatch.build.targets.wheel] packages`); otherwise the distribution name with `-` turned into `_` when that directory exists; otherwise the only package directory |
| `buildDependsOn` | `[project] dependencies`, `[tool.uv.sources]` (`path`, or `workspace = true` resolved against the nearest enclosing uv workspace), Poetry `path`, `-e <dir>` in a production `requirements*.txt`, or a production `import` / `from` of a sibling's import name |
| `testDependsOn` | `[dependency-groups]`, `[project.optional-dependencies]` groups named dev/test/lint/type, `[tool.poetry.group.*]`, or a requirements file whose name contains `dev` or `test` |
| `languages` / `runtimes` | the manifest. `requiresPython` only when `requires-python`, `python_requires`, or Poetry's `python` dependency is written down |
| `pytest` | a pytest dependency or group, `[tool.pytest.ini_options]`, `pytest.ini`, or `conftest.py` |
| `python -m unittest discover` | test modules that import `unittest`, and only when nothing above proves pytest |
| `ruff check` / `mypy` | the tool declared as a dependency or configured (`[tool.ruff]`, `ruff.toml`, `[tool.mypy]`, `mypy.ini`) |

`uv run` or `poetry run` is prefixed only when that lockfile contains a
`name = "<tool>"` entry. Both lockfiles proving the same tool is ambiguous:
the command is left unprefixed. PEP 508 extras, versions and markers are
parsed and not evaluated. Two import packages and no explicit list, or two
units publishing the same distribution or import name, produce
`AGENTDOC_BINDING_AMBIGUOUS` and no cross-unit link.

An import under `if TYPE_CHECKING:` is still an import. The adapter does not
evaluate control flow, so the name is classified like any other import:
`buildDependsOn` when it resolves to a sibling, or `testDependsOn` when the
manifest puts that distribution in a dev group. It is not a separate edge.

A uv workspace manifest is read at the repository root and below it, to a
fixed depth, in path order, staying inside the repository. `notUnitRoots` and
generated directories are not searched. `workspace = true` names the member of
the nearest enclosing workspace whose distribution name matches; another unit
with the same name is not substituted. Every declared member that has a Python
manifest is a unit, including one with no build backend and no entrypoint.
Its shape is still only the evidence, so scaffold writes `other` when the
manifest is neither deployable nor importable. A manifest that only declares
the workspace, with no distribution of its own, is not a unit.

A `.py` file uses the shared source inventory and is indexed for the deepest
eligible unit that contains it. Package, entrypoint and test discovery use the
same ownership boundaries; workspace-member discovery remains repository-wide. A
parent unit does not gain an import edge from a file that lives in a nested
member.

An import is not evidence of a sibling when the importing unit itself provides
that top-level module or package — at the unit root, under `src/`, or in the
importing file's own directory. If a sibling publishes the same import name,
the result is `AGENTDOC_BINDING_AMBIGUOUS` and no edge.

**What it cannot see:** a namespace package with no `__init__.py`; a
`setup.py` dependency that is not a list of string literals; a `requirements`
file pulled in with `-r` / `-c`; a lockfile's resolved versions; a PDM
workspace; a workspace manifest deeper than the search bound.

`asyncapi` is a contract **type** (declared on an API descriptor, validated by
the contract layer), not an adapter — there is no `asyncapi` entry in
`adapters: [...]`.

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
  and `go.work`, and, when the `rust` adapter is enabled, over `Cargo.toml`.
  `unitByPkgName`, `unitByGoModule`, `unitByCrateName` and
  `transitiveDependencies` are available to every adapter regardless of
  execution order. Cargo is probed only when `rust` is enabled: an existence
  probe is part of the input hash, and probing `Cargo.toml` in every unit
  would change every graph that does not ask for it.
- The same pre-pass reads a Python manifest (`pyproject.toml`, otherwise
  `setup.cfg` / `setup.py` / `requirements*.txt`) into `unitByPythonDist` and
  `unitByPythonImport`, and feeds those siblings into `dependencyMap` and
  `productionDependencies`, only when the `python` adapter is enabled. Each
  unit root is then listed so `requirements*.txt` is visible; that listing is
  part of the input hash. A repository that does not enable `python` is not
  probed, and its graph does not change.
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
