#!/usr/bin/env node
// Release guards for .github/workflows/release.yml.
//
// Every decision is a pure function, unit-tested in tests/release.test.mjs.
// The CLI wraps them with the I/O the workflow needs (git, the npm registry,
// GITHUB_OUTPUT) and reports failures as GitHub `::error::` annotations.
//
// Subcommands (inputs come from the environment, never from argv, so the
// workflow can pass `${{ inputs.* }}` through `env:` only):
//   preflight  every guard; writes tag_state and npm_state to GITHUB_OUTPUT
//   tag        remote tag state only; writes tag_state
//   npm        registry state only; writes npm_state
//   npm-cli    fails unless `npm --version` >= 11.5.1 (trusted publishing)
//   env        fails if NPM_TOKEN or NODE_AUTH_TOKEN is set
// Environment: RELEASE_VERSION, GITHUB_REF, GITHUB_SHA, GITHUB_OUTPUT.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractReleaseNotes, NotesError } from "./changelog-notes.mjs";

// One error may carry several independent failures, reported one per line.
export class GuardError extends Error {
  constructor(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list.join("\n"));
    this.messages = list;
  }
}

export const RELEASE_REF = "refs/heads/main";
export const MIN_NPM_FOR_TRUSTED_PUBLISHING = "11.5.1";
export const FORBIDDEN_TOKEN_VARS = ["NPM_TOKEN", "NODE_AUTH_TOKEN"];
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

// The regular expression published with SemVer 2.0.0 (semver.org, FAQ).
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const FULL_SHA = /^[0-9a-f]{40}$/;

export function checkRef(ref) {
  if (ref !== RELEASE_REF) {
    throw new GuardError(`releases are dispatched from ${RELEASE_REF} only; this run is on ${JSON.stringify(ref ?? "")}`);
  }
}

/**
 * The typed version must be a plain SemVer release equal to package.json and
 * to the compiler version (a graph is stamped with the compiler version, and a
 * mismatch would ship a CLI that rejects graphs it compiled itself).
 */
export function checkVersion({ input, packageVersion, compilerVersion }) {
  const errors = [];
  const m = SEMVER.exec(input ?? "");
  if (!m) {
    errors.push(`version ${JSON.stringify(input ?? "")} is not valid SemVer 2.0.0 (expected X.Y.Z, without a leading "v")`);
  } else if (m[4] !== undefined || m[5] !== undefined) {
    // Publishing a pre-release without a dist-tag would move npm `latest` and
    // the GitHub "latest" release to it.
    errors.push(`version ${input} has a pre-release or build suffix; this workflow publishes stable X.Y.Z releases only`);
  }
  if (input !== packageVersion) {
    errors.push(`version ${JSON.stringify(input ?? "")} does not match package.json version ${JSON.stringify(packageVersion)} at this commit; merge the release PR first`);
  }
  if (compilerVersion !== undefined && compilerVersion !== packageVersion) {
    errors.push(`COMPILER_VERSION in core/graph.mjs is ${JSON.stringify(compilerVersion)} but package.json is ${JSON.stringify(packageVersion)}; the compiler version is the package version`);
  }
  if (errors.length) throw new GuardError(errors);
}

export function checkTokenEnv(env) {
  const set = FORBIDDEN_TOKEN_VARS.filter((k) => env[k] !== undefined);
  if (set.length) {
    throw new GuardError(`${set.join(" and ")} must not be set: releases authenticate to npm with trusted publishing (OIDC), never a long-lived token`);
  }
}

/** Committed graphs must have been recompiled by the version being released. */
export function checkShippedGraphs(graphs, version) {
  const stale = graphs.filter((g) => g.compilerVersion !== version);
  if (stale.length) {
    throw new GuardError(
      `shipped graphs were not recompiled for ${version}:\n` +
      stale.map((g) => `  ${g.path} (compiler ${g.compilerVersion ?? "unknown"})`).join("\n"),
    );
  }
}

/**
 * Decide from `git ls-remote --tags` output whether tag `name` is absent or
 * already points at `sha`. Throws when it points elsewhere.
 * @returns {"absent" | "same"}
 */
export function classifyRemoteTag(lsRemoteOutput, name, sha) {
  if (!FULL_SHA.test(sha ?? "")) throw new GuardError(`not a full commit SHA: ${JSON.stringify(sha)}`);
  const ref = `refs/tags/${name}`;
  let object;
  let peeled;
  for (const line of lsRemoteOutput.split("\n")) {
    const [oid, r] = line.trim().split(/\s+/);
    if (r === ref) object = oid;
    else if (r === ref + "^{}") peeled = oid;
  }
  if (object === undefined) return "absent";
  const commit = peeled ?? object;
  if (commit === sha) return "same";
  throw new GuardError(`tag ${name} already exists on the remote at ${commit}, not at ${sha}`);
}

/** Commit recorded in an npm SLSA provenance statement, if any. */
export function commitFromProvenance(statement) {
  const deps = statement?.predicate?.buildDefinition?.resolvedDependencies;
  const commit = Array.isArray(deps) ? deps.find((d) => d?.digest?.gitCommit)?.digest.gitCommit : undefined;
  return typeof commit === "string" ? commit : undefined;
}

/**
 * Decide from the registry whether `version` is unpublished, or was published
 * from `sha` (a re-run after a later step failed).
 * @param {object|null} manifest  the version manifest, or null on 404
 * @param {string} sha
 * @param {string} [attestedCommit]  commit from the provenance attestation
 * @returns {"absent" | "published-same"}
 */
export function classifyNpmVersion(manifest, sha, attestedCommit) {
  if (manifest === null || manifest === undefined) return "absent";
  const id = `${manifest.name}@${manifest.version}`;
  const recorded = manifest.gitHead ?? attestedCommit;
  if (recorded === undefined) {
    throw new GuardError(`${id} is already on npm and records no commit (no gitHead, no provenance); it was not published by this workflow`);
  }
  if (recorded !== sha) {
    throw new GuardError(`${id} is already on npm, published from ${recorded}, not from ${sha}`);
  }
  return "published-same";
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).slice(0, 3).map(Number);
  const pb = String(b).split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

export function checkNpmCli(npmVersion) {
  if (!SEMVER.test(npmVersion ?? "") || compareVersions(npmVersion, MIN_NPM_FOR_TRUSTED_PUBLISHING) < 0) {
    throw new GuardError(`npm ${npmVersion} is too old: trusted publishing needs npm >= ${MIN_NPM_FOR_TRUSTED_PUBLISHING}`);
  }
}

// ---------------------------------------------------------------------------
// I/O for the workflow.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Workflow command data must escape %, CR and LF.
const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

function setOutput(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new GuardError(`${name} is not set`);
  return v;
}

function remoteTagState(version, sha) {
  const out = execFileSync("git", ["ls-remote", "--tags", "origin"], { cwd: ROOT, encoding: "utf8" });
  return classifyRemoteTag(out, `v${version}`, sha);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new GuardError(`GET ${url} failed: HTTP ${res.status}`);
  return res.json();
}

async function npmState(name, version, sha) {
  const registry = DEFAULT_REGISTRY;
  const manifest = await getJson(`${registry}/${name.replace("/", "%2F")}/${encodeURIComponent(version)}`);
  let attested;
  if (manifest && manifest.gitHead === undefined && manifest.dist?.attestations?.url) {
    const body = await getJson(manifest.dist.attestations.url);
    for (const a of body?.attestations ?? []) {
      const payload = a?.bundle?.dsseEnvelope?.payload;
      if (!payload) continue;
      attested ??= commitFromProvenance(JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
    }
  }
  return classifyNpmVersion(manifest, sha, attested);
}

function shippedGraphs() {
  const files = execFileSync("git", ["ls-files", "--", "*.agentdoc/graph.json"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => f && !f.startsWith("tests/"));
  return files.map((f) => {
    const graph = JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
    return { path: f, compilerVersion: graph?.compiler?.version };
  });
}

async function preflight() {
  const version = process.env.RELEASE_VERSION ?? "";
  const sha = requireEnv("GITHUB_SHA");
  const pkg = readPackage();
  const { COMPILER_VERSION } = await import(pathToFileURL(path.join(ROOT, "core", "graph.mjs")).href);
  const errors = [];
  const run = async (label, fn) => {
    try {
      const r = await fn();
      console.log(`ok    ${label}${r ? `: ${r}` : ""}`);
      return r;
    } catch (e) {
      if (!(e instanceof GuardError || e instanceof NotesError)) throw e;
      console.log(`FAIL  ${label}`);
      errors.push(...(e.messages ?? [e.message]));
      return undefined;
    }
  };
  await run("dispatched from main", () => checkRef(process.env.GITHUB_REF));
  await run("no npm token in the environment", () => checkTokenEnv(process.env));
  await run(`version ${version} = package.json = compiler`, () =>
    checkVersion({ input: version, packageVersion: pkg.version, compilerVersion: COMPILER_VERSION }));
  // The remaining checks only make sense for a well-formed version.
  if (SEMVER.test(version)) {
    await run(`CHANGELOG.md has a dated, non-empty ${version} section`, () => {
      extractReleaseNotes(fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), version);
    });
    await run("shipped graphs recompiled", () => checkShippedGraphs(shippedGraphs(), version));
    const tag = await run(`tag v${version} absent or at ${sha}`, () => remoteTagState(version, sha));
    const npm = await run(`${pkg.name}@${version} absent or published from ${sha}`, () => npmState(pkg.name, version, sha));
    if (tag) setOutput("tag_state", tag);
    if (npm) setOutput("npm_state", npm);
  }
  if (errors.length) throw new GuardError(errors);
}

async function main(cmd) {
  switch (cmd) {
    case "preflight":
      return preflight();
    case "tag":
      return setOutput("tag_state", remoteTagState(requireEnv("RELEASE_VERSION"), requireEnv("GITHUB_SHA")));
    case "npm":
      return setOutput("npm_state", await npmState(readPackage().name, requireEnv("RELEASE_VERSION"), requireEnv("GITHUB_SHA")));
    case "npm-cli": {
      const v = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
      checkNpmCli(v);
      return console.log(`npm ${v} (>= ${MIN_NPM_FOR_TRUSTED_PUBLISHING})`);
    }
    case "env":
      return checkTokenEnv(process.env);
    default:
      throw new GuardError("usage: guards.mjs preflight|tag|npm|npm-cli|env");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((e) => {
    const known = e instanceof GuardError || e instanceof NotesError;
    const messages = known ? (e.messages ?? [e.message]) : [`unexpected: ${e.stack ?? e}`];
    for (const msg of messages) console.log(`::error::${escapeData(msg)}`);
    process.exit(1);
  });
}
