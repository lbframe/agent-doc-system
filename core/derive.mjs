// Generic derivation: per-unit facts that hold for any language or toolchain.
//
// Everything technology-specific is delegated to adapters. This file owns only
// facts that can be read from a directory listing alone: the conventional docs
// that exist, the unit's deployable/importable shape, and the ownership of the
// source root itself.
import path from "node:path";
import { assertRepoPath } from "./fsx.mjs";
import { CODES } from "./codes.mjs";

const DEFAULT_DOC_CANDIDATES = ["README.md", "ARCHITECTURE.md", "AGENTS.md", "CONTRIBUTING.md", "DESIGN.md", "OVERVIEW.md"];
const DEFAULT_CONSTRAINT_CANDIDATES = ["CONSTRAINTS.md", "INVARIANTS.md"];
const DEFAULT_RUNBOOK_CANDIDATES = ["RUNBOOK.md", "OPERATIONS.md", "ONCALL.md"];

export function genericFacts(ctx, unit) {
  const { repo, cfg, prov, compRef } = ctx;
  const root = unit.root;
  const derived = { sourcePath: root };

  // ── artifact shape ────────────────────────────────────────────────────────
  const shapeProv = unit.markers.map((m) => prov.add("observed", m.path, "discovery:" + m.adapter, ["der:" + compRef + ":/artifact"]));
  prov.add("observed", ctx.descriptorPath(unit), "descriptor-locator", ["der:" + compRef + ":/sourcePath"]);
  if (shapeProv.length) {
    ctx.addFact(compRef, "component.deployable", unit.deployable, { evidenceClass: "DERIVED", confidence: "deterministic", provRecs: shapeProv });
    ctx.addFact(compRef, "component.importable", unit.importable, { evidenceClass: "DERIVED", confidence: "deterministic", provRecs: shapeProv });
  }

  // ── conventional docs ─────────────────────────────────────────────────────
  const docNames = cfg.discovery.docCandidates || DEFAULT_DOC_CANDIDATES;
  const constraintNames = cfg.discovery.constraintCandidates || DEFAULT_CONSTRAINT_CANDIDATES;
  const runbookNames = cfg.discovery.runbookCandidates || DEFAULT_RUNBOOK_CANDIDATES;
  const docs = [];
  const constraints = [];
  const runbooks = [];
  for (const n of docNames) {
    const p = root + "/" + n;
    if (repo.exists(p)) { docs.push(p); prov.add("observed", p, "docs-extractor", ["der:" + compRef + ":/docs"]); }
  }
  for (const n of constraintNames) {
    const p = root + "/" + n;
    if (repo.exists(p)) { constraints.push(p); prov.add("observed", p, "docs-extractor", ["der:" + compRef + ":/constraints"]); }
  }
  for (const n of runbookNames) {
    const p = root + "/" + n;
    if (repo.exists(p)) { runbooks.push(p); prov.add("observed", p, "docs-extractor", ["der:" + compRef + ":/runbooks"]); }
  }
  const spec = ctx.componentEntity().doc.spec || {};
  for (const p of spec.context?.docs || []) { docs.push(p); prov.add("declared", ctx.descriptorPath(unit), "descriptor-reader", ["der:" + compRef + ":/docs"]); }
  for (const p of spec.context?.constraints || []) { constraints.push(p); prov.add("declared", ctx.descriptorPath(unit), "descriptor-reader", ["der:" + compRef + ":/constraints"]); }
  for (const p of spec.context?.runbooks || []) { runbooks.push(p); prov.add("declared", ctx.descriptorPath(unit), "descriptor-reader", ["der:" + compRef + ":/runbooks"]); }

  const uniq = (a) => [...new Set(a)].sort();
  derived.docs = uniq(docs);
  derived.constraints = uniq(constraints);
  derived.runbooks = uniq(runbooks);
  derived.markers = unit.markers.map((m) => ({ adapter: m.adapter, path: m.path })).sort((a, b) => (a.path < b.path ? -1 : 1));

  return derived;
}

// The declared component type must be corroborated by the artifact shape the
// repository actually shows. Preserved from the reference implementation: an
// authored claim that a library is deployable is a documentation bug.
const DEPLOYABLE_TYPES = ["service", "worker", "job", "web-app", "static-site", "infrastructure"];
const IMPORTABLE_TYPES = ["library", "contract-library", "cli"];

export function checkArtifactType(entity, unit) {
  const t = entity.doc.spec.type;
  const out = [];
  if (DEPLOYABLE_TYPES.includes(t) && !unit.deployable) {
    out.push({
      severity: "error",
      code: CODES.ARTIFACT_TYPE,
      message: "component '" + entity.name + "' declares type '" + t + "' but no deployable artifact evidence was found in its source root",
      refs: [entity.ref],
      paths: [entity.file],
    });
  }
  if (IMPORTABLE_TYPES.includes(t) && !unit.importable) {
    out.push({
      severity: "error",
      code: CODES.ARTIFACT_TYPE,
      message: "component '" + entity.name + "' declares type '" + t + "' but no importable artifact evidence was found in its source root",
      refs: [entity.ref],
      paths: [entity.file],
    });
  }
  if (["library", "contract-library", "cli"].includes(t) && unit.deployable && !unit.importable) {
    out.push({
      severity: "warning",
      code: CODES.ARTIFACT_TYPE,
      message: "component '" + entity.name + "' declares a library type but the root also shows deployable evidence; verify the authored type",
      refs: [entity.ref],
      paths: [entity.file],
    });
  }
  return out;
}

export function assertContextPaths(paths, file, ref) {
  for (const p of paths) assertRepoPath(p, file);
}
