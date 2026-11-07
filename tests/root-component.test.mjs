// Issue #50: a component whose descriptor sits at the repository root owns the
// files no more specific component owns. Path ownership is decided on
// canonical repository-relative paths (git's form: no "./"), by path segment,
// and the longest owning prefix wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { write, git, cli, cliFails, graphOf } from "./helpers.mjs";
import { canonicalPath, ownsPath, joinPath, longestOwner, REPO_ROOT } from "../core/paths.mjs";
import { ContextIndex, queryContext, contractCovers } from "../core/query.mjs";
import { impact } from "../core/impact.mjs";

const ROOT_REF = "component:repro/root-tooling";
const NESTED_REF = "component:repro/nested-tooling";

const descriptor = (name) => `apiVersion: agentdoc.dev/v1
kind: Component
metadata:
  name: ${name}
  description: "Repository tooling for native routing reproduction."
spec:
  type: other
  placementRationale: "Tooling without a deployable artifact."
`;

// The exact reproduction from issue #50, optionally without the root
// descriptor and with extra adapters or files.
function repro(t, { rootDescriptor = true, adapters = "[]", extra = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-root-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  const descriptors = rootDescriptor ? "    - agentdoc.yaml\n    - tooling/agentdoc.yaml\n" : "    - tooling/agentdoc.yaml\n";
  write(dir, "agentdoc/agentdoc.config.yaml", `apiVersion: agentdoc.dev/config/v1
namespace: repro
discovery:
  componentDescriptorName: agentdoc.yaml
  componentDescriptors:
${descriptors}  centralDescriptors:
    - agentdoc/resources.yaml
adapters: ${adapters}
authority:
  rules: []
output:
  graph: .agentdoc/graph.json
  observations: agentdoc/observations
`);
  if (rootDescriptor) write(dir, "agentdoc.yaml", descriptor("root-tooling"));
  write(dir, "tooling/agentdoc.yaml", descriptor("nested-tooling"));
  write(dir, "vite.config.ts", "export default {}");
  write(dir, "tooling/config.ts", "export default {}");
  for (const [rel, content] of Object.entries(extra)) write(dir, rel, content);
  write(dir, ".gitignore", ".agentdoc/");
  git(dir, ["add", "."]);
  return dir;
}

const queried = (dir, needle) => JSON.parse(cli(dir, ["query", needle, "--json"])).query.resolved;
const impacted = (dir, ...paths) => JSON.parse(cli(dir, ["impact", ...paths]));
const affected = (report) => report.affectedComponents.map((c) => c.ref);

test("root component: issue #50 repro validates, compiles and passes check --strict", (t) => {
  const dir = repro(t);
  cli(dir, ["validate"]);
  cli(dir, ["compile"]);
  cli(dir, ["check", "--strict"]);
  const graph = graphOf(dir);
  assert.equal(graph.entities.find((e) => e.ref === ROOT_REF).derived.sourcePath, REPO_ROOT, "sourcePath keeps its meaning");
});

test("root component: query resolves a root file with and without ./", (t) => {
  const dir = repro(t);
  cli(dir, ["compile"]);
  assert.equal(queried(dir, "vite.config.ts"), ROOT_REF);
  assert.equal(queried(dir, "./vite.config.ts"), ROOT_REF);
  assert.match(cliFails(dir, ["query", "component:repro/nope"]).stderr, /AGENTDOC_REF_UNRESOLVED/,
    "an unknown ref is not a root-owned path");
});

test("root component: impact reports the root component for both spellings", (t) => {
  const dir = repro(t);
  cli(dir, ["compile"]);
  for (const p of ["vite.config.ts", "./vite.config.ts"]) {
    const r = impacted(dir, p);
    assert.deepEqual(r.unmatchedFiles, [], p);
    assert.deepEqual(affected(r), [ROOT_REF], p);
  }
});

test("root component: a nested component keeps precedence over the root", (t) => {
  const dir = repro(t);
  cli(dir, ["compile"]);
  for (const p of ["tooling/config.ts", "./tooling/config.ts", "tooling"]) {
    assert.equal(queried(dir, p), NESTED_REF, p);
  }
  const r = impacted(dir, "tooling/config.ts");
  assert.deepEqual(r.unmatchedFiles, []);
  assert.deepEqual(affected(r), [NESTED_REF]);
  const both = impacted(dir, "vite.config.ts", "tooling/config.ts");
  assert.deepEqual(both.unmatchedFiles, []);
  assert.deepEqual(affected(both), [NESTED_REF, ROOT_REF]);
});

test("root component: without a root descriptor a root file stays unmatched", (t) => {
  const dir = repro(t, { rootDescriptor: false });
  cli(dir, ["compile"]);
  for (const p of ["vite.config.ts", "./vite.config.ts"]) {
    const failed = cliFails(dir, ["query", p]);
    assert.ok(failed, p + " must not resolve");
    assert.match(failed.stderr, /AGENTDOC_REF_UNRESOLVED/);
    const r = impacted(dir, p);
    assert.deepEqual(r.unmatchedFiles, ["vite.config.ts"], p);
    assert.deepEqual(affected(r), [], p);
  }
  assert.equal(queried(dir, "tooling/config.ts"), NESTED_REF);
});

test("root component: paths derived for a root unit are canonical, never ./-prefixed", (t) => {
  const dir = repro(t, {
    adapters: "[node, typescript, dockerfile, generic, deploy-config, go, turborepo, cache]",
    extra: {
      "README.md": "# Root\n",
      "package.json": JSON.stringify({ name: "root", private: true, scripts: { test: "vitest run" } }),
      "tsconfig.json": "{}",
      "Dockerfile": "FROM node:22-alpine",
    },
  });
  cli(dir, ["compile"]);
  cli(dir, ["check", "--strict"]);
  const text = JSON.stringify(graphOf(dir));
  assert.doesNotMatch(text, /"\.\//, "no graph path may carry a ./ prefix");
  const derived = graphOf(dir).entities.find((e) => e.ref === ROOT_REF).derived;
  assert.deepEqual(derived.docs, ["README.md"]);
  // A root documentation file routes to its owner as documentation, and a root
  // manifest is recognised as a compiler input.
  assert.equal(queried(dir, "README.md"), ROOT_REF);
  const doc = impacted(dir, "README.md");
  assert.deepEqual(doc.affectedDocs, ["README.md"]);
  assert.ok(doc.affectedComponents.find((c) => c.ref === ROOT_REF).reasons.includes("owns documentation README.md"));
  const manifest = impacted(dir, "./package.json");
  assert.deepEqual(manifest.unmatchedFiles, []);
  assert.deepEqual(manifest.affectedInputs, ["package.json"]);
  assert.equal(manifest.graphWillBeStale, true);
});

test("paths: canonical form drops ./ and trailing /, keeps the root as one value", () => {
  assert.equal(canonicalPath("./a/b"), "a/b");
  assert.equal(canonicalPath("a//b/"), "a/b");
  assert.equal(canonicalPath("a/./b"), "a/b");
  assert.equal(canonicalPath("././a"), "a");
  for (const root of ["", ".", "./", "./."]) assert.equal(canonicalPath(root), REPO_ROOT, JSON.stringify(root));
  for (const bad of ["../a", "a/../b", "/etc/passwd", "C:/x", "C:\\x", null, undefined, 3]) {
    assert.equal(canonicalPath(bad), null, JSON.stringify(bad));
  }
});

test("paths: ownership is by path segment, and the root owns every repository path", () => {
  assert.equal(ownsPath("src", "src"), true);
  assert.equal(ownsPath("src", "src/x.ts"), true);
  assert.equal(ownsPath("src", "./src/x.ts"), true);
  assert.equal(ownsPath("src", "src2/x.ts"), false, "src must not own src2/x");
  assert.equal(ownsPath("src", "srcx"), false);
  assert.equal(ownsPath("src/a", "src"), false);
  assert.equal(ownsPath(".", "vite.config.ts"), true);
  assert.equal(ownsPath("", "a/b"), true);
  assert.equal(ownsPath(".", "../outside"), false, "the root never owns a path outside the repository");
  assert.equal(ownsPath(".", "/abs"), false);
  assert.equal(ownsPath("src", "src/../etc"), false);
});

test("paths: joinPath never produces a ./ path", () => {
  assert.equal(joinPath(".", "package.json"), "package.json");
  assert.equal(joinPath("", "package.json"), "package.json");
  assert.equal(joinPath("svc", "package.json"), "svc/package.json");
  assert.equal(joinPath("svc/", "src/app"), "svc/src/app");
});

test("paths: the longest owning prefix wins and the root is the last resort", () => {
  const owners = [".", "a", "ab", "a/b"];
  assert.equal(longestOwner(owners, "a/x.ts"), "a", "a one-character root sibling must not lose to the root");
  assert.equal(longestOwner(owners, "a/b/x.ts"), "a/b");
  assert.equal(longestOwner(owners, "ab/x.ts"), "ab");
  assert.equal(longestOwner(owners, "abc/x.ts"), ".");
  assert.equal(longestOwner(owners, "x.ts"), ".");
  assert.equal(longestOwner(["a"], "x.ts"), null);
  assert.equal(longestOwner(["."], "../x.ts"), null);
});

// A synthetic graph exercises the index directly: a single-character sibling of
// the root, the src/src2 boundary, and an event contract owned by a nested
// component rather than by the root that also contains it.
function syntheticGraph() {
  const comp = (name, sourcePath) => ({
    ref: "component:t/" + name, kind: "Component", name,
    entity: { metadata: { name, description: name }, spec: {} },
    sourcePaths: [], derived: { sourcePath, docs: [], constraints: [], runbooks: [] },
  });
  const api = {
    ref: "api:t/svc", kind: "API", name: "svc",
    entity: { metadata: { name: "svc", description: "svc" }, spec: { contract: { ref: "contracts/svc.openapi.yaml" } } },
    sourcePaths: [],
  };
  return {
    entities: [comp("root", "."), comp("a", "a"), comp("src", "src"), comp("events", "libs/events"), api],
    relations: [], contracts: [{ ref: "contracts/svc.openapi.yaml", apiRef: "api:t/svc" }], provenance: [], verification: [], gates: [], conflicts: [], journeys: [],
    assertions: [], observations: [], diagnostics: [], capabilities: [], externalDependencies: [],
    interfaces: { events: [{ pattern: "order.created", producers: [], consumers: [], resolution: "declared", contract: { ref: "libs/events/order.json" } }] },
  };
}

test("index: resolution is segment-aware and longest-prefix, with the root as fallback", () => {
  const idx = new ContextIndex(syntheticGraph());
  const owner = (p) => idx.resolve(p)?.ref;
  assert.equal(owner("a/x.ts"), "component:t/a");
  assert.equal(owner("src/x.ts"), "component:t/src");
  assert.equal(owner("src2/x.ts"), "component:t/root", "src must not own src2/x");
  assert.equal(owner("./src2/x.ts"), "component:t/root");
  assert.equal(owner("libs/events/order.json"), "component:t/events");
  assert.equal(owner("x.ts"), "component:t/root");
  assert.equal(owner("../x.ts"), undefined);
});

test("index: an explicit contract claim outranks the root fallback", () => {
  const idx = new ContextIndex(syntheticGraph());
  assert.equal(idx.resolve("contracts/svc.openapi.yaml").ref, "api:t/svc");
  assert.equal(idx.resolve("./contracts/svc.openapi.yaml").ref, "api:t/svc");
  assert.equal(idx.resolve("contracts/other.yaml").ref, "component:t/root");
});

test("index: a ref-shaped needle that names no entity is not a root-owned path", () => {
  const idx = new ContextIndex(syntheticGraph());
  assert.equal(idx.resolve("component:t/missing"), null);
  assert.equal(idx.resolve("component:t/src").ref, "component:t/src");
});

test("index: contract coverage is file, directory or module prefix, never a raw prefix", () => {
  assert.equal(contractCovers("proto/events", "proto/events.proto"), true);
  assert.equal(contractCovers("proto/events", "proto/events/v1/a.proto"), true);
  assert.equal(contractCovers("proto/events", "proto/events"), true);
  assert.equal(contractCovers("proto/events", "proto/events2.proto"), false);
  assert.equal(contractCovers("proto/events", "proto/eventsx/a.proto"), false);
  assert.equal(contractCovers("events", "events.go"), true);
  assert.equal(contractCovers("events", "./events.go"), true);
  assert.equal(contractCovers("events", "lib/events.go"), false);
});

test("query: a root component does not claim an event catalog a nested library owns", () => {
  const g = syntheticGraph();
  assert.deepEqual(queryContext(g, "libs/events/order.json").events.items.map((e) => e.pattern), ["order.created"]);
  assert.deepEqual(queryContext(g, "vite.config.ts").events.items, []);
  g.entities = g.entities.filter((e) => e.ref !== "component:t/events");
  assert.deepEqual(queryContext(g, "vite.config.ts").events.items.map((e) => e.pattern), ["order.created"],
    "with no nested owner, the root owns the catalog file");
});

test("index: without a root component, an unowned path resolves to nothing", () => {
  const g = syntheticGraph();
  g.entities = g.entities.filter((e) => e.derived?.sourcePath !== ".");
  const idx = new ContextIndex(g);
  assert.equal(idx.resolve("src2/x.ts"), null);
  assert.deepEqual(impact(g, ["src2/x.ts"]).unmatchedFiles, ["src2/x.ts"]);
});
