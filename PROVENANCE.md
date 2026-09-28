# PROVENANCE

Every important fact in the compiled graph is traceable to evidence. This
document defines what a provenance record is, how it is produced, and the rules
that keep evidence free of secrets.

## The record

```json
{
  "id": "p-0075",
  "class": "observed",
  "path": "workers/koda-cron/wrangler.toml",
  "extractor": { "name": "platform-manifest-extractor", "version": "1.0.0" },
  "contentHash": "sha256:9f2c...",
  "location": { "lineStart": 5, "lineEnd": 7, "jsonPointer": "/facts/2" },
  "subjects": ["/entities/9/derived/bindings/0", "/conflicts/2"]
}
```

| field | meaning |
|---|---|
| `id` | positional over a canonical sort, so ids are stable for a given input set |
| `class` | how the evidence was obtained (below) |
| `path` | repository-relative; never absolute, never outside the checkout |
| `extractor` | which component read it, and at what version |
| `contentHash` | `sha256:` of the file bytes as read |
| `location` | optional: line range or JSON pointer, when the evidence is narrower than the file |
| `subjects` | RFC 6901 pointers into this graph that the record proves |

## Classes

| class | meaning | typical extractor |
|---|---|---|
| `declared` | the file states the fact outright | `descriptor-reader`, `placement-extractor` |
| `reviewed` | a human interpretation recorded in configuration, not derivable from a file | `override-extractor` |
| `observed` | the file shows the fact | `manifest-extractor`, `import-extractor`, `ci-extractor` |
| `validated` | two independent files agree | `api-contract-extractor`, `oidc-extractor` |
| `runtime` | read from an external system | `observation:<collector>` |
| `standard` | the authority is a published standard | `standard-extractor` |

`runtime` records are the only ones whose path is not a source file of the
repository under analysis in the ordinary sense: they point at the committed
evidence bundle the observation cites.

`reviewed` exists so that a human interpretation is not filed as `declared`.
Filed that way it mapped to `AUTHORED` — the strongest class — so a reviewed
override corroborated by a source reference was relabelled `AUTHORED` on the
merged edge, and the graph understated its own highest-authority input. The class
is not an election either: elections happen per fact in the authority model, and a
provenance class must not decide one on its own.

## Coverage rules

- Every relation, external dependency, capability, verification entry, gate,
  journey, contract, conflict and assertion carries at least one
  `provenanceIds` entry.
- Every entity carries provenance for its authored fields and, for components,
  for its derived block.
- A relation, index entry or fact with no provenance is a compiler defect. The
  pipeline fails with `AGENTDOC_PROVENANCE` rather than emitting it.

## Subject resolution

Extractors emit symbolic subjects while they run (`rel:pending`,
`ass:pending`, `evt:<pattern>`, …) and the compiler binds them to concrete
pointers once the whole graph exists. This is why an extractor's output does not
depend on how many other extractors ran first.

A subject that never binds is an error: `AGENTDOC_PROVENANCE`. The single
exception is evidence whose candidate edge or fact was *dropped* (an unresolved
reviewed override, a rejected candidate). Those records are removed and the
count is reported as `droppedProvenance` in the compile stats, so a regression
here is visible rather than silent.

## Input hashing

`source.inputHash` covers:

1. compiler and graph-schema versions, entity api version, authority-rule count,
   every enabled adapter's name and version, and the content hash of every
   shipped schema;
2. every file the compiler read — path and content, length-prefixed;
3. every existence probe — path and result;
4. every directory listing — directory and sorted file list.

Every byte the compiler reads flows through a single tracked read path, so the
record is complete by construction rather than by remembering to register files.
A change to any input changes the hash; `check` refuses a graph whose hash
disagrees.

## Secrets

Two independent layers, because derivation can synthesise a secret-shaped string
that no source scan would have caught.

**Layer 1 — sources.** Every authored or observed document is scanned before it
can influence any output. Refusal is `AGENTDOC_SECRET`, with the JSON pointer.

**Layer 2 — outputs.** The serialized graph, every audit report, every query
payload and every eval report is scanned again before it is written or printed.
Refusal is `AGENTDOC_SECRET` and the command exits non-zero. Nothing is written
partially.

Detected shapes include private-key headers, cloud access-key ids, provider
token prefixes, JWT-shaped triples, URLs with embedded credentials, `Bearer`
tokens, and `secret: value` / `token = value` style assignments.

**Commands are redacted, not dropped.** A verification command is a routing
index, not a credential transport. An inline assignment whose name contains
`SECRET`, `TOKEN`, `PASSWORD`, `PASSPHRASE`, `API_KEY`, `PRIVATE_KEY`,
`CREDENTIAL` or `ACCESS_KEY` keeps its name and loses its value:

```
DATABASE_URL=postgres://u:p@host/db vitest run
  ->  DATABASE_URL=[REDACTED] vitest run
```

The redaction marker itself is not treated as a secret, so a redacted command
remains runnable and printable.

**Observations.** An `evidenceBundle` must be a committed, repository-relative
file. A temp path, a console URL with a session token, or a screenshot filename
is not evidence. The environment identifier is constrained to a slug; nothing in
an observation may be a credential.

## What is deliberately not provenance

- **Confidence.** A heuristic derivation is still traceable; `confidence:
  candidate` says it may not be elected. Provenance and confidence answer
  different questions.
- **Ownership.** Placement is an authored fact with a `declared` record, not a
  derived one. The extractor identity tells you who read it, not who decided it.
