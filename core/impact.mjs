// Change impact.
//
// When an agent edits a file, the question is not "what does this file do" but
// "what must I keep consistent, and which gate proves it". This answers that
// from the graph alone, so the answer is available before any exploration.
import { ContextIndex } from "./query.mjs";
import { dependentScope, verificationForChange } from "./dependents.mjs";

// The affected-file classification is derived from the compiled graph, not from
// a hand-written list of technology filenames. A list would go stale for every
// repository that is not Node-and-Go, and `impact` would silently under-report
// there — which is worse than not answering.
//
// Sources of truth, all from the graph:
//   - the canonical contract of every API entity                  -> contract
//   - every file the compiler read                                 -> input
//   - every extractor identity, which names the technology        -> dependency /
//                                                                    verification
//   - every documentation and constraint path on an entity         -> documentation
function classify(graph, p, idx) {
  for (const c of graph.contracts) if (c.ref === p) return "contract";
  for (const e of graph.entities) {
    const d = e.derived || {};
    for (const x of d.docs || []) if (x === p) return "documentation";
    for (const x of d.constraints || []) if (x === p) return "documentation";
    for (const x of d.runbooks || []) if (x === p) return "documentation";
  }
  if (/\.(md|mdx|adoc|rst|txt)$/.test(p)) return "documentation";
  if (/(^|\/)(migrations?|alembic\/versions)\//.test(p)) return "resource";
  // A Resource named directly — by ref, or by the descriptor file that declares
  // it — is a resource change. Without this, `impact resource:default/x` reported
  // nothing at all, and a change to a dataset's owner was invisible. The loop
  // below that walks `usesResource` was written for exactly this case and could
  // never run, because nothing ever populated `resources` for a Resource entity.
  const entity = idx && idx.resolve(p);
  if (entity && entity.kind === "Resource") return "resource";
  if (/\.ya?ml$/.test(p) && /\.github\/workflows\//.test(p)) return "verification";
  const inputs = new Set(graph.provenance.map((x) => x.path));
  if (inputs.has(p)) return "input";
  return null;
}

export function impact(graph, changedPaths) {
  const idx = new ContextIndex(graph);
  const affectedComponents = new Map(); // ref -> Set(reason)
  const add = (ref, reason) => {
    if (idx.byRef.get(ref)?.kind !== "Component") return;
    if (!affectedComponents.has(ref)) affectedComponents.set(ref, new Set());
    affectedComponents.get(ref).add(reason);
  };

  const contracts = new Set();
  const docs = new Set();
  const resources = new Set();
  const verificationPaths = new Set();
  const dependencyPaths = new Set();
  const catalogPaths = new Set();
  const unmatched = [];

  for (const raw of changedPaths) {
    const p = raw.replace(/^\.\//, "");
    const entity = idx.resolve(p);
    // A Resource is not a component. Adding it to `affectedComponents` put a
    // `resource:` ref in a list an agent reads as "components you must check",
    // while the components actually bound to it went unmentioned.
    if (entity && entity.kind === "Component") add(entity.ref, "direct file change inside " + entity.ref);
    else unmatched.push(p);
    const kind = classify(graph, p, idx);
    if (kind === "contract") contracts.add(p);
    if (kind === "documentation") docs.add(p);
    if (kind === "resource") {
      resources.add(entity?.kind === "Resource" ? entity.ref : p);
      // Migration authority is not ownership. Only follow an existing binding
      // from the component containing this migration to a logical database.
      if (entity?.kind === "Component") {
        for (const rel of graph.relations) {
          const bound = rel.type === "usesResource" && rel.sourceRef === entity.ref ? rel.targetRef
            : rel.type === "resourceUsedBy" && rel.targetRef === entity.ref ? rel.sourceRef : null;
          if (idx.byRef.get(bound)?.entity.spec.type === "logical-database") resources.add(bound);
        }
      }
    }
    if (kind === "verification") verificationPaths.add(p);
    if (kind === "input") dependencyPaths.add(p);
    if (p.startsWith("agentdoc/")) catalogPaths.add(p);
  }

  // A contract change reaches its provider and every consumer.
  for (const c of contracts) {
    for (const api of graph.entities.filter((e) => e.kind === "API")) {
      if (api.entity.spec.contract?.ref !== c) continue;
      for (const r of graph.relations.filter((r) => (r.type === "providesApi" && r.targetRef === api.ref) || (r.type === "consumesApi" && r.targetRef === api.ref))) {
        add(r.sourceRef, "affected by contract " + c);
      }
    }
  }

  // A documentation change reaches the component that owns it.
  for (const d of docs) {
    for (const e of graph.entities) {
      const d2 = e.derived || {};
      if ((d2.docs || []).includes(d) || (d2.constraints || []).includes(d) || (d2.runbooks || []).includes(d)) {
        add(e.ref, "owns documentation " + d);
      }
      if (e.entity.spec?.context && Object.values(e.entity.spec.context).flat().includes(d)) add(e.ref, "declared context link " + d);
    }
  }

  // A resource change reaches every component bound to that exact Resource.
  // Never match a name as a substring of a migration path.
  for (const r of resources) {
    for (const rel of graph.relations) {
      if (rel.type !== "usesResource" && rel.type !== "resourceUsedBy") continue;
      const bound = rel.type === "usesResource" ? rel.targetRef : rel.sourceRef;
      const user = rel.type === "usesResource" ? rel.sourceRef : rel.targetRef;
      if (r === bound) {
        add(user, "resource change touches " + bound);
      }
    }
  }

  // Preserve the existing direct runtime/schedule context, then follow only
  // reverse build/test edges. Dependencies remain context in query's explicitly
  // typed relations; they are never affected components just for being inputs.
  const directlyAffected = [...affectedComponents.keys()];
  for (const start of directlyAffected) {
    for (const r of graph.relations) {
      if (r.type === "schedules" || r.type === "scheduledBy" || r.type === "runtimeCalls" || r.type === "runtimeCalledBy") {
        if (r.sourceRef === start) add(r.targetRef, "connected to a changed component by " + r.type);
        if (r.targetRef === start) add(r.sourceRef, "connected to a changed component by " + r.type);
      }
    }
  }
  const seeds = [...affectedComponents.keys()];
  for (const ref of dependentScope(graph, seeds).keys()) {
    if (!affectedComponents.has(ref)) add(ref, "depends on a changed component");
  }

  const refs = [...affectedComponents.keys()].sort();
  const verification = verificationForChange(graph, seeds, directlyAffected);
  const conflicts = graph.conflicts.filter((c) => refs.includes(c.subject));
  const journeys = graph.journeys.filter((j) => j.components.some((r) => refs.includes(r)));

  return {
    changedFiles: changedPaths.slice().sort(),
    unmatchedFiles: unmatched.sort(),
    affectedComponents: refs.map((ref) => ({ ref, reasons: [...affectedComponents.get(ref)].sort() })),
    affectedContracts: [...contracts].sort(),
    affectedDocs: [...docs].sort(),
    affectedResources: [...resources].sort(),
    affectedInputs: [...dependencyPaths].sort(),
    affectedVerification: [...verificationPaths].sort(),
    affectedCatalog: [...catalogPaths].sort(),
    catalogSourceChanged: catalogPaths.size > 0,
    // Any file the compiler read is a graph input: changing it invalidates the
    // committed graph even when no descriptor changed.
    graphWillBeStale: graphAffected(graph, changedPaths),
    recommendedVerification: verification.map((v) => ({ id: v.id, tier: v.tier, command: v.command })).slice(0, 25),
    recommendedVerificationTotal: verification.length,
    recommendedVerificationTruncated: verification.length > 25,
    openConflicts: conflicts.map((c) => ({ id: c.id, subject: c.subject, key: c.key, status: c.status, kind: c.kind })),
    relatedJourneys: journeys.map((j) => ({ id: j.id, description: j.description })),
  };
}

function graphAffected(graph, changedPaths) {
  const inputs = new Set(graph.provenance.map((p) => p.path));
  for (const p of changedPaths) if (inputs.has(p)) return true;
  const idx = new ContextIndex(graph);
  return changedPaths.some((p) => idx.resolve(p));
}
