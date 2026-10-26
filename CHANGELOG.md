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
- Two new corpora: `fixtures/e-rust-workspace` and `fixtures/f-python-workspace`.
  Both are compiled and checked in CI and covered by routing evaluations
  ([#23]).

### Changed

- The TOML reader implements the TOML 1.0 value set. It is used for
  `Cargo.toml`, `pyproject.toml` and `wrangler.toml`. It now reads multi-line
  basic and literal strings, literal strings, offset and local date-times,
  dates, times, hex/octal/binary integers, `inf` / `nan`, and `_` digit
  separators. Invalid TOML is still rejected with `AGENTDOC_YAML_PARSE`.
  Before, a valid value such as `description = """…"""` could fail the file.

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
  but never recognised. It now counts as migration evidence, with
  `alembic.ini` or `[tool.alembic]` as the evidence file.

### Upgrading

- The compiler version is now `1.2.0`. A graph committed with 1.1.0 fails
  `agentdoc check` with `AGENTDOC_COMPILER_MISMATCH`. Run `agentdoc compile`
  and commit the graph.
- An existing catalog keeps its adapter list. To use the new adapters, add
  `rust` and/or `python` to `adapters:` in `agentdoc/agentdoc.config.yaml`,
  then run `agentdoc audit`: units that were invisible appear as
  `AGENTDOC_COVERAGE_ZERO` until they have a descriptor.
  `agentdoc scaffold --write` writes those descriptors.
- If your repository has nested units, the recompiled graph moves facts from
  the parent component to the nested one it belongs to. Review the graph diff,
  and any descriptor or document that relied on the parent carrying those facts.
- A graph that enables neither new adapter, has no nested units and no Alembic
  migrations is unchanged apart from the compiler version and input hash.

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
[#5]: https://github.com/lbframe/agent-doc-system/issues/5
[#6]: https://github.com/lbframe/agent-doc-system/issues/6
[#7]: https://github.com/lbframe/agent-doc-system/issues/7
[#11]: https://github.com/lbframe/agent-doc-system/issues/11
[#12]: https://github.com/lbframe/agent-doc-system/issues/12
[#17]: https://github.com/lbframe/agent-doc-system/issues/17
[#18]: https://github.com/lbframe/agent-doc-system/issues/18
[#21]: https://github.com/lbframe/agent-doc-system/issues/21
[#23]: https://github.com/lbframe/agent-doc-system/issues/23
