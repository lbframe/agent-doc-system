# Releasing agent-doc-system

A release is a manual act, and it happens in two parts:

1. **A reviewed release PR** sets the version on `main`. It covers the
   version bump, the changelog section and the recompiled graphs.
2. **A manual dispatch** of [`.github/workflows/release.yml`](.github/workflows/release.yml)
   publishes that version. The workflow publishes to npm with provenance,
   tags the commit and creates the GitHub release.

Nothing publishes on a push, a merge, a tag or a schedule. The workflow never
commits, bumps or edits a file. It reads the version already on `main`, and
the `version` you type acts as a confirmation. npm authentication uses
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no
npm token exists anywhere.

## 1. The release PR

Work on a branch named `release/vX.Y.Z` and open a PR against `main`, as
[#26](https://github.com/lbframe/agent-doc-system/pull/26) did for v1.2.0.

- [ ] **Bump the version** in `package.json` **and** `COMPILER_VERSION` in
      `core/graph.mjs`. The compiler version is the package version. A graph
      compiled by one release is refused by the next with
      `AGENTDOC_COMPILER_MISMATCH`. The workflow fails if the two differ.
- [ ] **Changelog** ([Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)):
      rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today, UTC). Add
      a new empty `## [Unreleased]` above it. Update the compare links at the
      bottom:
      ```
      [Unreleased]: https://github.com/lbframe/agent-doc-system/compare/vX.Y.Z...HEAD
      [X.Y.Z]: https://github.com/lbframe/agent-doc-system/compare/vPREVIOUS...vX.Y.Z
      ```
      The section becomes the GitHub release body word for word, with the
      `[#NN]` link definitions it uses appended. Write it for users. To
      preview it:
      ```sh
      node scripts/release/changelog-notes.mjs X.Y.Z
      ```
- [ ] **Pinned-tag examples**: point `github:lbframe/agent-doc-system#vX.Y.Z`
      at the new tag in `docs/CI.md`, `docs/ci/github-actions.yml` and
      `templates/ci.yml`.
- [ ] **Commit the bump**, then **recompile the shipped graphs**. A graph
      records the commit it was compiled at, so compile after the bump is
      committed, as v1.2.0 did in `faef4c7` and then `e7ce91f`:
      ```sh
      root=$(git rev-parse --show-toplevel)
      for repo in fixtures/a-node-ts-postgres fixtures/b-go-multi-service \
                  fixtures/c-alt-monorepo fixtures/e-rust-workspace \
                  fixtures/f-python-workspace examples/koda/repo; do
        (cd "$root/$repo" \
          && node "$root/bin/agentdoc.mjs" compile \
          && node "$root/bin/agentdoc.mjs" check --require-clean)
      done
      git add '*.agentdoc/graph.json'
      git commit -m "chore(release): recompile shipped graphs for X.Y.Z"
      ```
      Only the compiler version, the source commit and the input hash should
      change. Review any other diff. The workflow fails if a committed graph
      still carries the old compiler version.
- [ ] `node --test tests/*.test.mjs` and `node evals/run-all.mjs` pass.
- [ ] Review, fix what the review finds (v1.2.0 needed `ea7c113`), and merge.

## 2. Trigger the release

Always do a dry run first. It runs every guard, the full CI on the exact
commit and `npm publish --dry-run`. It also prints the release notes in the
run summary, and it publishes, tags and releases nothing.

```sh
gh workflow run release.yml --ref main -f version=X.Y.Z -f dry_run=true
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Read the notes in the run summary. If they look right, run the release:

```sh
gh workflow run release.yml --ref main -f version=X.Y.Z
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

You can also start it from the Actions tab: **release** → **Run workflow**,
branch `main`.

Then check the result:

```sh
npm view agent-doc-system@X.Y.Z version gitHead
gh release view vX.Y.Z
npm install -g agent-doc-system@X.Y.Z && agentdoc --version
```

### What the workflow checks and does

| Stage | Check or step | On failure or re-run |
|---|---|---|
| Guard | The dispatch ref is `refs/heads/main`. | Fails. |
| Guard | `version` is SemVer 2.0.0, stable (no pre-release or build suffix), and equals `package.json` and `COMPILER_VERSION`. | Fails. |
| Guard | `CHANGELOG.md` has a non-empty `## [X.Y.Z] - YYYY-MM-DD` section. | Fails. |
| Guard | Every committed `.agentdoc/graph.json` carries compiler `X.Y.Z`. | Fails. |
| Guard | Tag `vX.Y.Z` is absent on the remote, or points at this commit. | Fails if the tag is elsewhere. Skips the tag step if it is already here. |
| Guard | `agent-doc-system@X.Y.Z` is absent on npm, or was published from this commit (`gitHead`, else the provenance commit). | Fails if it came from another commit. Skips the publish if it came from this one. |
| Guard | Neither `NPM_TOKEN` nor `NODE_AUTH_TOKEN` is set. | Fails. |
| Gate | The full `ci.yml` (test matrix, evals, corpora gates, determinism) runs on the same commit. | The publish job does not start. |
| Publish | npm ≥ 11.5.1, then `npm publish --access public --provenance`. | Skipped if already published from this commit. |
| Publish | Annotated tag `vX.Y.Z` on the exact commit. | Skipped if it already exists there. |
| Publish | GitHub release `AgentDoc vX.Y.Z`, marked latest, body taken from the changelog. | Updated if it already exists. |

Only the publish job holds `contents: write` and `id-token: write`. It runs in
the `release` environment, and only one release run at a time can be in
progress.

## 3. One-time setup (maintainer, by hand)

These settings live outside the repository, so the workflow cannot create
them. The first real release fails until they exist. A dry run does not
need them.

- [ ] **npm trusted publisher.** On npmjs.com, open package
      `agent-doc-system` → **Settings** → **Trusted Publisher** → **GitHub
      Actions**, and enter:
      - Organization or user: `lbframe`
      - Repository: `agent-doc-system`
      - Workflow filename: `release.yml`
      - Environment name: `release`
- [ ] **GitHub environment.** In the repository, open **Settings** →
      **Environments** → **New environment**, named `release`. Under
      **Deployment branches and tags**, choose **Selected branches and tags**
      and add only `main`. Optionally, add yourself as a required reviewer,
      so every publish waits for an explicit approval.
- [ ] **After the first successful release** (optional, recommended): on
      npmjs.com, open package `agent-doc-system` → **Settings** →
      **Publishing access** and choose **Require two-factor authentication
      and disallow tokens**. Trusted publishing keeps working. Revoke any old
      npm automation or publish tokens.

## 4. When a run fails partway

Every step after the gates is idempotent. The publish job re-reads the state
of npm and of the tag before it acts, so it never publishes twice and never
moves a tag.

- **A guard failed.** Nothing happened. Fix the cause and dispatch again:
  open a PR if the version, changelog or graphs are wrong, or dispatch from
  `main` if the run used the wrong ref.
- **The CI gate failed.** Nothing was published. Fix the cause on `main`
  through a PR, then dispatch again. The new run tests and releases the new
  `main` commit, which still carries version X.Y.Z.
- **The publish job failed** (npm, the tag or the release). Open the run and
  choose **Re-run failed jobs**. Do not dispatch a new run: a re-run uses the
  same commit, and the publish job skips what an earlier attempt already
  did. GitHub allows re-runs for 30 days.
  - If the publish failed with `ENEEDAUTH`, a 403 or an OIDC error, check
    the trusted-publisher fields in section 3 and the `release` environment
    name, then re-run.
- **A new dispatch after `main` moved** fails safely. If X.Y.Z is already on
  npm from the older commit, the npm guard refuses to release a different
  commit under the same version.
- **The run can no longer be re-run** (after 30 days, or the workflow is
  broken). If npm already holds X.Y.Z from commit `SHA`, finish by hand from
  a clean checkout of `SHA`:
  ```sh
  git tag -a vX.Y.Z SHA -m "AgentDoc vX.Y.Z" && git push origin vX.Y.Z
  node scripts/release/changelog-notes.mjs X.Y.Z \
    --base-url https://github.com/lbframe/agent-doc-system/blob/vX.Y.Z > notes.md
  gh release create vX.Y.Z --verify-tag --title "AgentDoc vX.Y.Z" --notes-file notes.md --latest
  ```
- **A broken version reached npm.** npm only allows unpublishing within 72
  hours, and a version number can never be reused. Prefer
  `npm deprecate agent-doc-system@X.Y.Z "<reason>"` followed by a patch
  release.
