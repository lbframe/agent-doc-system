# AgentDoc

![AgentDoc — Give coding agents the context they actually need](docs/assets/readme/agentdoc-hero.webp)

**Give coding agents the context they actually need.**

AgentDoc turns your codebase, docs, contracts, and runtime evidence into a context layer your coding agent can query before it changes anything.

[![npm](https://img.shields.io/npm/v/agent-doc-system.svg)](https://www.npmjs.com/package/agent-doc-system) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-43853d.svg)](https://nodejs.org/)

## Give this to your coding agent

Paste this into your agent **from the repository you want to use AgentDoc on**:

```text
Set up AgentDoc for this repository and use it as the context layer for your work.

AgentDoc: https://github.com/lbframe/agent-doc-system

1. Read INSTALL_FOR_AGENTS.md and install or upgrade the AgentDoc CLI.
2. Read skills/agent-doc-system/SKILL.md.
3. Run agentdoc doctor --project and agentdoc audit.
4. Use the appropriate CREATE or MIGRATE workflow for this repository.
5. Do not invent ownership, architecture, authority rules, or product intent. Ask me only for decisions AgentDoc cannot safely derive.
6. Finish setup with agentdoc validate, agentdoc compile, and agentdoc check.
7. From now on, use agentdoc query and agentdoc impact before changes, then agentdoc check after changes.
8. Report anything unresolved or conflicting instead of guessing.
```

That is the intended onboarding path: **give the prompt to the agent, let AgentDoc build the context layer, and keep using it during development.**

## Why AgentDoc?

Coding agents can read code. The hard part is knowing **what matters for this change**.

Important context is scattered across code, documentation, API contracts, architectural decisions, CI rules, and production reality. Agents either load too much or miss something important.

AgentDoc gives them a map.

- **Query the right context** for a file or component.
- **See the blast radius** before changing code.
- **Detect drift** between code and documentation.
- **Surface conflicts** instead of silently guessing.
- **Verify constraints in CI** before stale knowledge becomes trusted context.

![AgentDoc in action — query, impact, check](docs/assets/readme/agentdoc-in-action.webp)

## Three commands, one workflow

```bash
agentdoc query src/payments/webhook.ts
agentdoc impact src/payments/webhook.ts
agentdoc check
```

`query` tells the agent what it needs to know. `impact` shows what the change can affect. `check` verifies that the repository still agrees with itself.

## Why not just AGENTS.md or RAG?

![Why AgentDoc](docs/assets/readme/why-agentdoc.webp)

AgentDoc is not another documentation file and it is not just semantic search.

It combines **authored intent**, **facts derived from code**, and **runtime observations** without pretending they are the same thing. When sources disagree, AgentDoc surfaces the conflict instead of choosing a convenient answer.

## From repository knowledge to agent-ready context

AgentDoc turns scattered repository knowledge into task-specific context your coding agent can query, verify, and act on.

![How AgentDoc works](docs/assets/readme/how-agentdoc-works.webp)

## What it understands

AgentDoc reads manifests, contracts and configuration. It never runs your toolchain.

Support comes from adapters and from built-in contract validation (AsyncAPI needs no adapter).
- `agentdoc init` picks `node`, `go`, `rust`, `python`, `dockerfile` and `wrangler` from the files it finds.
- It always includes `database`, `openapi`, `events` and `github-actions`.
- Add the others in `agentdoc/agentdoc.config.yaml`.

| area | supported |
|---|---|
| languages & packages | Node (npm, pnpm workspaces, Turborepo), TypeScript, Go (modules, `go.work`), Rust (Cargo packages and workspaces), Python (`pyproject.toml` with PEP 621 or Poetry, uv workspaces, `setup.cfg` / `setup.py`, `requirements*.txt`) |
| contracts | OpenAPI, protobuf, GraphQL, AsyncAPI, OIDC discovery |
| deployment & CI | Dockerfile / Containerfile, `fly.toml`, `Procfile` and similar deploy configs, Cloudflare Wrangler, Ansible playbooks, GitHub Actions |
| resources | databases (migrations, ORM config, connection evidence), caches, object stores, event subjects |

For each language, AgentDoc derives:

- the units;
- whether each one is deployable or importable;
- dependency edges between sibling units;
- verification commands taken from the repository's own evidence (`go test`, `cargo test -p`, `pytest`, `python -m unittest`, npm scripts, …).

What every adapter derives, and what it deliberately cannot see, is in [docs/ADAPTERS.md](docs/ADAPTERS.md).

## By the numbers

Measured, reproducible, and with no model in the loop. Method and caveats are in [docs/BENCHMARK.md](docs/BENCHMARK.md).

- **The right context: 100% vs. 58%.** Across 30 routing scenarios (Node, Go, Rust, Python), `query` + `impact` retrieves every fact the change needs. Reading only the touched component retrieves 58%. Noise stays under 9%, against 40%. Every check the change requires is in the answer, and that answer holds about half of the repository's checks (29% on the largest corpus), not all of them. The thresholds were fixed before the first run and have not moved since.
- **Seconds to map a real repository.** A fresh `init` → `scaffold` → `compile` takes 0.7–4.9 s on four public repositories, from 141 to 5,142 files (axum, pydantic-ai, full-stack-fastapi-template, create-t3-turbo). No edit was needed beyond choosing each component's placement.
- **A briefing, not a dump.** A `query` answer is about 90–260 tokens: what the change reaches, what to read, and which checks to run.
- **The same graph every time.** Compiles are byte-identical, and CI can verify it.
- **Small and strict.** Zero runtime dependencies, a 280 kB package, 21 adapters, and 709/709 cases on the official TOML 1.0 conformance suite.

## Install manually

Requires Node.js 22+.

```bash
npm install -g agent-doc-system
agentdoc doctor
```

Then, inside a repository:

```bash
agentdoc audit
```

AgentDoc also ships with an Agent Skill at [`skills/agent-doc-system/`](skills/agent-doc-system/SKILL.md).

## Documentation

- [Getting started & migration](docs/MIGRATION.md)
- [Authority & conflicts](docs/AUTHORITY.md)
- [CI & verification](docs/CI.md)
- [Specification](docs/SPEC.md)
- [Adapters](docs/ADAPTERS.md)
- [Benchmark](docs/BENCHMARK.md)
- [Agent Skill](skills/agent-doc-system/SKILL.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) © 2026 lbframe
