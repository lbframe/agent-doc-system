// Change impact.
//
// When an agent edits a file, the question is not "what does this file do" but
// "what must I keep consistent, and which gate proves it". This answers that
// from the graph alone, so the answer is available before any exploration.
import path from "node:path";
import { ContextIndex } from "./query.mjs";

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
  if (/(^|\/)migrations?\//.test(p)) return "resource";
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
    if (!idx.byRef.has(ref)) return;
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
    if (kind === "resource") resources.add(p);
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

  // Changing a component reaches the components that depend on it, and the
  // components it schedules or is scheduled by. Two hops: a direct dependent
  // and a dependent-of-a-dependent is the practical blast radius; beyond that
  // the graph stops being a routing aid and becomes a dump.
  for (const start of [...affectedComponents.keys()]) {
    for (let hop = 0; hop < 2; hop++) {
      for (const r of graph.relations) {
        if (r.type === "buildDependencyOf" || r.type === "testDependencyOf" || r.type === "buildDependsOn" || r.type === "testDependsOn") {
          if (r.targetRef === start) add(r.sourceRef, "depends on a changed component");
          if (r.sourceRef === start) add(r.targetRef, "a dependent of a changed component");
        }
        if (r.type === "schedules" || r.type === "scheduledBy" || r.type === "runtimeCalls" || r.type === "runtimeCalledBy") {
          if (r.sourceRef === start) add(r.targetRef, "connected to a changed component by " + r.type);
          if (r.targetRef === start) add(r.sourceRef, "connected to a changed component by " + r.type);
        }
      }
    }
  }

  // A dependency manifest change reaches both directions of the edge.
  for (const d of dependencyPaths) {
    for (const r of graph.relations) {
      if (r.type !== "buildDependsOn" && r.type !== "testDependsOn") continue;
      if (r.attributes?.package === path.basename(d)) {
        add(r.sourceRef, "dependency manifest " + d + " changed");
        add(r.targetRef, "depended on by a component whose manifest changed");
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

  // A resource change reaches every component bound to it. Matched on the full
  // ref or on a path that lies under the Resource's own source root, so a
  // Resource ref and its migration directory both reach the same components.
  for (const r of resources) {
    const refMatch = r.match(/^[a-z]+:[^/]+\/(.+)$/);
    const refName = refMatch ? refMatch[1] : null;
    for (const rel of graph.relations) {
      if (rel.type !== "usesResource" && rel.type !== "resourceUsedBy") continue;
      const bound = rel.type === "usesResource" ? rel.targetRef : rel.sourceRef;
      const user = rel.type === "usesResource" ? rel.sourceRef : rel.targetRef;
      const name = bound.split("/").slice(1).join("/");
      if ((refName && name === refName) || r.includes(name)) {
        add(user, "resource change touches " + bound);
      }
    }
  }

  const refs = [...affectedComponents.keys()].sort();
  const verification = graph.verification.filter((v) => v.componentRefs.some((r) => refs.includes(r)));
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
