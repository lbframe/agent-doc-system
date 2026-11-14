# Task context protocol

`prepare`, `expand` and `refresh` accept one JSON request on stdin (or `--request file`) and emit one compact JSON packet plus a newline. They operate on the current working tree and do not require a committed graph. They never execute repository verification commands.

```sh
printf '%s\n' '{"task":"Change the engine API","paths":["crates/engine"],"intent":"change-contract","budget":{"tokens":4096,"encoding":"o200k_base"}}' | agentdoc prepare
```

Intents are `implement` (default), `change-contract`, `debug-runtime` and `review`. The first implementation conservatively retains the same obligation closure across intents. The packet contains typed, versioned records, evidence references, selected checks, analysis limitations and stale runtime observation IDs. It does not infer that unsupported or dynamic dependencies are absent.

Document selection currently follows component ownership and impact, rather
than file-specific document filters. All declared references remain eligible,
including lists longer than twelve entries; the token budget governs delivery,
not what the repository may declare. Constraints are critical obligations;
ordinary documentation and runbooks remain available through continuation.

## Budget and continuation

The exact serialized output, including its final newline, metadata and continuation, is counted using pinned `js-tiktoken@1.0.21`. Select `o200k_base` or `cl100k_base` explicitly to match the encoding used by your model; AgentDoc does not guess model tokenization. The supported budget is 256–1,000,000 tokens. A budget too small for the envelope or next indivisible record fails with `AGENTDOC_CONTEXT_BUDGET` and must be increased.

`delivery.partial` and `delivery.criticalOmitted` report incomplete delivery. Critical obligations are selected first, but a partial page must never be interpreted as the complete check or constraint list. Follow `continuation` until it is null:

```json
{"packet":"<64-character packet reference>","offset":8,"tokens":8192}
```

Pass that object to `agentdoc expand`. Continuations are tied to the original request, snapshot and protocol. A changed graph or runtime freshness state rejects expansion with `AGENTDOC_CONTEXT_STALE`; use `refresh` or `prepare`. Larger budgets allow reading a long constraint document without silently shortening it.

## Session refresh

```json
{"packet":"<previous packet reference>","acknowledged":["<retained record ID>"]}
```

Send this to `agentdoc refresh`. Acknowledge only records still present in the agent's active context. Without acknowledgements, all records are delivered again. `reset:true` also requests full delivery. Refresh emits new or changed records, explicit retractions and active critical obligations. Critical records are repeated even if acknowledged. The resulting delta has its own packet reference and continuation.

The harness must apply retractions, replace changed versions and manage its active context. Merely appending delta messages does not bound the model's history. Following a lost or compacted session, request a reset. A changed snapshot conservatively invalidates prior execution evidence.

Packets are stored locally under `.agentdoc/context/`, excluded from compiler inputs. Treat references as local to a repository. The JavaScript API exposes `forget(root, packet)` to remove a retained packet. At most 64 packets are retained per repository; older continuations may require preparing again. The caller can delete packets sooner; packet files are not published with the repository.

## Checks and evidence

A recommended shell command is not an execution result. In this initial protocol, checks expose `execution.status:"requires-context"` and `cwd:null` when the compiler has not established a working directory. Resolve that context from the check's owner and evidence before executing it. Identical command text for different checks remains distinct.

Constraint and document records carry their content and a content fingerprint. Other records carry graph provenance identifiers or paths. Facts retain their authority data; contradictory claims are not merged into one assumed truth. Stale observations are marked explicitly and must not be treated as current production evidence.

## Cache and compatibility

`cache:false` in a prepare request bypasses persistent compilation reuse. The full compiler remains the correctness reference. Cache reuse is conservative and does not imply extractor-level incremental recompilation. Protocol version `agentdoc.dev/context/v1` is separate from graph version `agentdoc.dev/graph/v1`.

Existing `query` and `impact` keep their established freshness policies. See [QUERY.md](QUERY.md) for those commands.

## Importing check execution results from JavaScript

The result API accepts reports produced by the harness after execution. It does
not run the command or independently observe its execution. Each report must name
a registered check and its exact command, an explicit repository-relative working
directory, a runner name/version, and a status matching its exit code:

```json
{
  "snapshot": { "graphHash": "<graphHash from the prepared packet>" },
  "checkId": "<registered check ID>",
  "command": "<exact registered command>",
  "cwd": "service",
  "status": "succeeded",
  "exitCode": 0,
  "runner": { "name": "<harness name>", "version": "<harness version>" }
}
```

Use `failed` with a positive integer exit code for a failed execution. A
recommendation, missing working directory or disagreement between the status and
exit code is refused. Store the report under `.agentdoc/executions/` so writing
execution evidence does not itself change the source snapshot. The report's
`graphHash` must be the snapshot actually used for the run, not a new snapshot
captured after unrelated edits.

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  importCheckResults, validResultsForSnapshot, forgetSession, clearSessions,
} from 'agent-doc-system/core/session/results.mjs';

// root is the repository root; packet is its prepared context packet.
const reportPath = '.agentdoc/executions/check.json';
const bytes = fs.readFileSync(path.join(root, reportPath));
const report = JSON.parse(bytes.toString('utf8'));
const { checkId, command, cwd, status, exitCode, runner } = report;
importCheckResults(root, {
  session: 'change-engine',
  snapshot: packet.snapshot,
  results: [{ checkId, command, cwd, status, exitCode, runner, evidence: {
    path: reportPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  } }],
});

const results = validResultsForSnapshot(root, 'change-engine', packet.snapshot);
const successes = results.filter(result => result.status === 'succeeded');
forgetSession(root, 'change-engine'); // Returns whether a result record existed.
clearSessions(root); // Removes all retained result sessions; returns their count.
```

Import verifies the current graph, registered command and hash-pinned JSON report.
Reads verify them again: a changed graph, changed evidence, unavailable execution
directory or expired runtime observation invalidates prior results. Both valid
successes and valid failures are returned; the harness must inspect `status`.
All import validation errors use `AGENTDOC_SESSION_RESULT`.

Session names contain 1–64 ASCII letters, digits, underscores or hyphens and start
with a letter or digit. Result records live under
`.agentdoc/sessions/check-results/`, independently of context packets. Cleanup
removes result records only; it preserves context packets and execution reports.
Use the context API's `forget(root, packet)` separately when dropping a packet.

## TypeScript symbol candidates from JavaScript

The optional symbol experiment indexes only explicitly requested TypeScript
files. It returns declarations and reference candidates with source line/column
locations and a SHA-256 content fingerprint:

```js
import { indexTypeScriptSymbols } from 'agent-doc-system/core/context/symbols.mjs';

const candidates = indexTypeScriptSymbols(root, ['src/api.ts', 'src/consumer.ts']);
for (const file of candidates.files) {
  // file.path, file.sha256, file.declarations, file.references
}
```

Supported paths end in `.ts`, `.tsx`, `.mts` or `.cts`; paths escaping the
repository, including through a symlink, are refused. The experiment masks
comments and quoted text, but does not resolve lexical scopes, imports,
overloads, dynamic references, regex literals or template interpolation. Its
output always declares `coverage.partial:true` and
`coverage.checkSelection:"unchanged"`. Use candidates to navigate source, never
to infer that an unlisted dependency is absent or to remove a required check.
The experiment is a JavaScript API and is not enabled by the default context
commands.
