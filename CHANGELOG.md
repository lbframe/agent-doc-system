# Changelog

All notable changes to AgentDoc are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
compiler version is the package version: a graph compiled by one release is
refused by the next with `AGENTDOC_COMPILER_MISMATCH` until it is recompiled.

## [Unreleased]

## [1.2.0] - 2026-10-27

Rust and Python are now supported at the same level as Node and Go. Before
this release, a Cargo crate or a Python package was invisible to the compiler:
`agentdoc audit` reported zero units, and a hand-written descriptor produced a
component with no language, no dependency edges and no verification commands.

The release also fixes how a change is routed. `impact` and `query` now follow
the components that depend on the changed one, not the ones it depends on, and
recommend those dependents' checks.

### Added

- **`rust` adapter** ([#17]). Reads `Cargo.toml` and never runs Cargo or reads
  `Cargo.lock`.
  - A `[package]` is a unit. `[[bin]]`, `src/main.rs` or `src/bin/` make it
    deployable; `[lib]` or `src/lib.rs` make it importable.
  - Workspace members come from every `[workspace]` manifest, including one
    below the repository root (`rust/Cargo.toml` next to other languages).
  - Sibling crates become `buildDependsOn` / `testDependsOn` edges when the
    manifest says so: a `path`, `workspace = true` resolved through the nearest
    `[workspace.dependencies]`, or a `[patch.<registry>]` / `[replace]` path
    redirect inside the repository. `use`, `extern crate` and `<crate>::` paths
    add provenance to those edges but never create one, because Rust cannot
    use a crate the manifest does not declare.
  - Verification commands: `cargo test -p <name>` and `cargo clippy -p <name>`.
  - Resource vocabulary: sqlx, diesel (`diesel.toml`), tokio-postgres,
    deadpool, sea-orm, the `redis` crate and `aws-sdk-s3`.
- **`python` adapter** ([#18]). Reads `pyproject.toml` (PEP 621 and Poetry),
  `setup.cfg`, `setup.py` and `requirements*.txt`. It never runs Python,
  resolves a lockfile or inspects a virtualenv.
  - Shape comes from evidence. An entrypoint (`[project.scripts]`,
    `__main__.py`, `manage.py`, an ASGI/WSGI app object) makes a unit
    deployable; a build backend plus a package makes it importable.
  - uv workspace members come from the repository root and from workspaces
    below it. A member with no build backend is still a unit.
  - Sibling packages become edges from `[project] dependencies`,
    `[tool.uv.sources]`, Poetry `path` dependencies, `-e <dir>` requirements,
    and `import` / `from` statements. Dev groups and dev/test extras give
    `testDependsOn`. An import that the importing unit provides itself, such
    as a local `utils.py`, is not read as a sibling.
  - Verification commands are derived only from evidence: `pytest`,
    `python -m unittest discover` for unittest-only suites, `ruff check` and
    `mypy`. `uv run` / `poetry run` is prefixed only when the lockfile names
    the tool.
  - Also derived: `requiresPython` when declared, and Alembic migrations as
    database evidence.
  - Resource vocabulary: SQLAlchemy, asyncpg, psycopg, Django `DATABASES`,
    `redis.Redis` and boto3.
- `agentdoc init` enables `rust` and `python` when it finds their manifests.
  `agentdoc scaffold` names crates and distributions from their manifests and
  types them from their artifact shape: `service`, `library`, or `other` when
  neither is proven. A virtual Cargo or uv workspace manifest is not scaffolded.
- A reproducible benchmark, `scripts/bench/run.mjs` ([docs/BENCHMARK.md]).
  It clones four public repositories at pinned commits, runs a fresh
  `init` → `scaffold` → `compile`, counts every hand edit the setup still
  needs (zero for all four), checks that the graph is byte-identical across
  compiles, and measures `query` answers.
- Rust and Python sample repositories (`fixtures/e-rust-workspace`,
  `fixtures/f-python-workspace`), checked in CI and used to test context
  routing ([#23]).

### Changed

- **Change routing follows dependents** ([#30], [#25]).
  - A change to a component reaches the components that depend on it,
    transitively, through reverse `buildDependsOn` / `testDependsOn` edges.
    Before, `impact` also listed the components it depends on as affected,
    and stopped after two hops.
  - Dependencies stay visible as typed relations in `query`. They are no
    longer reported as affected components.
  - `query` and `impact` recommend the dependents' checks after the changed
    component's own: every tier for build dependents, unit checks only for test
    dependents.
  - `impact` adds `recommendedVerificationTotal` and
    `recommendedVerificationTruncated`, so a capped list is never mistaken for
    the whole.
- **`query` markdown shows an entity's context** ([#28]). Resources and
  Systems now list their `docs`, `CONSTRAINTS` and `runbooks`, as components
  already did. Constraints are never capped by default. Docs and runbooks show
  12 paths each, and `--budget docs=…,constraints=…,runbooks=…` sets explicit
  caps with a `[truncated: x of y]` marker.
- **`discovery.notUnitRoots` excludes a whole subtree from inferred units**
  ([#27]). An adapter marker or a scaffold proposal at or below an excluded
  root is no longer a unit. A hand-written descriptor below an excluded root
  is still honoured. A descriptor exactly at an excluded root is refused with
  a message that names the exclusion.
- **GitHub Actions checks are scoped to the components they run for**
  ([#29]). A step becomes a component check only when its command is a
  recognised test, lint or build invocation, scoped by `working-directory`,
  `cd <dir> &&`, a path argument, a package selector (`--filter`, turbo, nx,
  `make -C`) or a `paths:` filter. Anything else is a repository gate.
  - Before, every step was attached to every component whose path or package
    name appeared anywhere in the workflow, including multi-line ops scripts.
    A shell `test -n` was also recorded as a unit test.
  - `impact` on a workflow file now names the components and gates derived
    from it, plus their dependents' checks.
- **The TOML reader conforms to TOML 1.0** ([#18], [#31]). It reads
  `Cargo.toml`, `pyproject.toml` and `wrangler.toml`, and passes every case of
  the official [toml-test](https://github.com/toml-lang/toml-test) 1.0.0
  suite: 208 valid and 501 invalid documents. Before, it rejected valid
  documents, such as multi-line strings and lowercase date-time delimiters,
  which lost every fact in the file. It also accepted invalid ones, such as a
  trailing comma in an inline table or a table declared twice. Invalid TOML
  is rejected with `AGENTDOC_YAML_PARSE`.

### Fixed

- **A unit nested inside another unit no longer leaks its facts into the
  parent** ([#21]). Every per-unit scan stops at nested units, so each file
  belongs to the deepest unit that contains it. Before, an enclosing unit also
  claimed its nested unit's health routes, ports, capabilities, resource and
  migration evidence, imports, contract consumers, TypeScript routes, Ansible
  playbooks and test markers. This affects any layout with nested units, such
  as a service containing a tool package, a Cargo root package with member
  crates below it, or a uv workspace root with its own `[project]`.
- An Alembic `alembic/versions` directory was listed as a migration location
  but never recognised. It now counts as migration evidence. The evidence file
  is a qualifying `alembic.ini` or `[tool.alembic]` configuration when one
  exists, and otherwise a revision file.
- A changed migration, including an Alembic revision, now lists the logical
  database its component uses in `impact`'s `affectedResources` ([#30]).
  Before, the list stayed empty.
- The audit no longer reports a document as orphaned when it is linked only
  from a Resource's or System's `context` ([#28]).
- `agentdoc scaffold --write` no longer writes descriptors into directories
  listed in `discovery.notUnitRoots` ([#27]).
- **A fresh setup compiles without hand edits** ([#37], [#38]).
  - `scaffold` now types every unit from its artifact evidence: `service`,
    `library`, or `other` when neither is proven. Before, a Node app without
    `exports` or `main`, or a Go module, was written as `library` and failed
    `validate` straight away.
  - `init` now discovers descriptors with the `*/**/agentdoc.yaml` glob
    instead of an explicit list, and `scaffold` covers every unit an adapter
    declares, including workspace members under `examples/`.
  - On the four public repositories used for benchmarking (tokio-rs/axum,
    pydantic/pydantic-ai, fastapi/full-stack-fastapi-template and
    t3-oss/create-t3-turbo), `init` + `scaffold --write` + `compile` now pass
    with no edits other than choosing each component's placement.

### Upgrading

- The compiler version is now `1.2.0`. A graph committed with 1.1.0 fails
  `agentdoc check` with `AGENTDOC_COMPILER_MISMATCH`. Run `agentdoc compile`
  and commit the graph.
- An existing catalog keeps its adapter list. To use the new adapters, add
  `rust` and/or `python` to `adapters:` in `agentdoc/agentdoc.config.yaml`,
  then run `agentdoc audit`: units that were invisible appear as
  `AGENTDOC_COVERAGE_ZERO` until they have a descriptor.
  `agentdoc scaffold --write` writes those descriptors.
- If your repository has nested units, recompiling removes facts that were
  wrongly attributed to an enclosing component. Review the affected facts,
  dependency edges and verification commands, and any descriptor or document
  that relied on them.
- Tools that read `impact --json` will see fewer `affectedComponents`
  (dependencies are gone) and more `recommendedVerification` entries
  (dependents' checks).
- A unit inferred below a `notUnitRoots` entry, with no descriptor, is no
  longer reported as `AGENTDOC_COVERAGE_ZERO`. If it should be a component,
  write its descriptor, or remove the directory from `notUnitRoots`.
- If your workflows run checks for specific components, recompiling changes
  which checks are attached to which component. Review the diff: checks that
  were attached only because a path was mentioned elsewhere in the workflow
  move to repository gates.
- Recompiling always updates the compiler version, source commit and input
  hash. Review the other derived changes, especially in repositories with
  nested units, Alembic migrations or Wrangler TOML manifests: a manifest the
  old TOML reader could not parse now yields facts.

## [1.1.0] - 2026-10-18

### Added

- **MIGRATE gates normative requirements and section coverage** ([#5]).
  Documentation checks now state their real scope, and the strict gate refuses
  unverified requirements.
- **`ansible` adapter** ([#6]). Reads playbooks without running anything and
  derives installed paths and managed services. A requirement with
  `satisfiedBy: [ansible]` and the new `expects` field
  (`installs: <path>` | `service: <name>`) is checked against them, so a missing
  install ends in a conflict instead of `AGENTDOC_REQUIREMENT_UNVERIFIED`.
- `agentdoc <command> --help` lists each command's flags and exit codes ([#7]).

### Changed

- **The CLI rejects unknown flags** ([#7]) and names the closest valid flag. A
  typo such as `check --strcit` no longer silently runs a non-strict check.
  Scripts that passed flags a command does not accept now exit 2.

### Fixed

- A committed graph passes CI ([#11]). `check` no longer fails with
  `AGENTDOC_GRAPH_FRESHNESS` after `compile` on a clean checkout, where the
  graph file itself was counted as a changed input.
- A nested `.github/workflows` directory no longer fails `validate` ([#12]).
  Only the repository-root directory is read, as GitHub does.

### Upgrading

- A graph committed with 1.0.0 fails `agentdoc check` with
  `AGENTDOC_COMPILER_MISMATCH` until it is recompiled.

## [1.0.0] - 2026-09-29

First public release.

### Added

- The machine-installed `agentdoc` CLI for Node 22, 24 and 26, with zero
  runtime dependencies.
- A deterministic repository graph: repeated compiles of the same tree are
  byte-identical.
- Evidence separation between AUTHORED documentation, DERIVED facts extracted
  from code, and OBSERVED runtime evidence.
- A fail-closed authority model: contradictions surface as conflicts and are
  never silently overwritten.
- `agentdoc query`, which routes minimal, budgeted context for a task, and
  `agentdoc impact`, which reports what a change forces you to keep consistent.
- CREATE and MIGRATE workflows through `init`, `audit`, `scaffold`,
  `validate`, `compile` and `check`.
- `agentdoc doctor` for machine diagnostics, and `agentdoc doctor --project`
  for project health.
- An Agent Skill under `skills/agent-doc-system/`.

[Unreleased]: https://github.com/lbframe/agent-doc-system/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/lbframe/agent-doc-system/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/lbframe/agent-doc-system/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/lbframe/agent-doc-system/releases/tag/v1.0.0
[docs/BENCHMARK.md]: docs/BENCHMARK.md
[#5]: https://github.com/lbframe/agent-doc-system/issues/5
[#6]: https://github.com/lbframe/agent-doc-system/issues/6
[#7]: https://github.com/lbframe/agent-doc-system/issues/7
[#11]: https://github.com/lbframe/agent-doc-system/issues/11
[#12]: https://github.com/lbframe/agent-doc-system/issues/12
[#17]: https://github.com/lbframe/agent-doc-system/issues/17
[#18]: https://github.com/lbframe/agent-doc-system/issues/18
[#21]: https://github.com/lbframe/agent-doc-system/issues/21
[#23]: https://github.com/lbframe/agent-doc-system/issues/23
[#25]: https://github.com/lbframe/agent-doc-system/issues/25
[#27]: https://github.com/lbframe/agent-doc-system/issues/27
[#28]: https://github.com/lbframe/agent-doc-system/issues/28
[#29]: https://github.com/lbframe/agent-doc-system/issues/29
[#30]: https://github.com/lbframe/agent-doc-system/issues/30
[#31]: https://github.com/lbframe/agent-doc-system/issues/31
[#37]: https://github.com/lbframe/agent-doc-system/issues/37
[#38]: https://github.com/lbframe/agent-doc-system/issues/38
