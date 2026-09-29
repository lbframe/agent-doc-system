# Evidence, authority and conflicts

## The three evidence classes

| class | source | may be authored? |
|---|---|---|
| `AUTHORED` | a file in the repository you can point at | yes |
| `DERIVED` | a deterministic extractor produces it | yes, once reviewed |
| `OBSERVED_RUNTIME` | an `agentdoc/observations/*.yaml` ObservationSet, written after actually reading the external system | **no** — it belongs in an ObservationSet |
| `REVIEWED_OVERRIDE` | a reviewed human interpretation, citing pinned evidence | yes, with `reviewWhen` and evidence digests |

There is no global precedence order. The committed manifest is authoritative
for *intent*; a live scheduler is authoritative for *what fires*; the canonical
contract is authoritative for the *desired wire surface* while a live probe is
authoritative for *what is deployed today*. Which class wins is decided per
fact key, by an explicit authority rule.

## When you cannot establish a fact

- **Heuristic guess** — do not write it. Add a `reviewedOverrides` entry with a
  `reason`, a `reviewWhen`, and file-level `evidence` (path + sha256, via
  `agentdoc pin-evidence`), or leave it out.
- **Two sources disagree** — do not pick one. Either add an authority rule that
  says which class is authoritative *for that key*, or report the contradiction
  to a human. Fail-closed is the default: a disagreeing fact with no governing
  rule is an error, and no gate passes while it stands.
- **Product or ownership decision** — ask. Do not infer ownership from folder
  names.

## Handling a reported conflict

`agentdoc query <ref> --json` returns `authority.conflicts`. For each one:

1. Read `election.basis` and `election.ruleId`. `basis: none` means no rule
   governs this fact and the system refused to choose.
2. Both values stay in the graph. Report both to the human, with their evidence
   pointers, and say which one the system elected and why.
3. If the right answer is "the runtime wins for this key", add an authority
   rule with `elect: [OBSERVED_RUNTIME]`, a `rationale`, and a `reviewWhen`.
   Do not edit the observation to match the manifest, and do not edit the
   manifest to match the observation.

## Secrets

Never write a credential, token, key or credentialed URL into a descriptor, an
observation, an evidence bundle, or a commit message. `agentdoc validate`
fails on secret-shaped input, and the output scanner fails on secret-shaped
output too. Observations cite a committed, secret-free evidence bundle by
repository-relative path — a temp path, a console URL with a session token, or
a screenshot filename is not evidence.

## Writing descriptors

The templates ship with the CLI (`templates/` in the package). The rules that
matter:

- A Component descriptor lives at the root of the unit it describes, named by
  `discovery.componentDescriptorName` (conventionally `agentdoc.yaml`).
- `metadata.description` is **one sentence, present tense**, ending in `.`,
  `!` or `?`. It says what the component is *for*.
- Placement is exactly one of `system`, `domain`, or `placementRationale`.
- Every durable cross-component boundary has exactly one canonical
  machine-readable contract, and exactly one API descriptor pointing at it.
  Default to OpenAPI 3.1 for JSON HTTP; a protocol's native schema is equally
  valid.
- You never author a relation. Placement and API provider edges come from the
  descriptor; everything else is derived or reviewed.

The full model is `docs/AUTHORITY.md` and `docs/PROVENANCE.md` in the agentdoc
repository.
