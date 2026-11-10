// Change impact.
//
// When an agent edits a file, the question is not "what does this file do" but
// "what must I keep consistent, and which gate proves it". This answers that
// from the graph alone, so the answer is available before any exploration.
import { ContextIndex } from "./query.mjs";
import { dependentScope, verificationForChange } from "./dependents.mjs";
import { canonicalPath, ownsPath, longestOwner } from "./paths.mjs";

// Changed paths are compared in the graph's canonical form (git's: no "./").
// A path that is not repository-relative is kept verbatim so it is reported
// as unmatched rather than silently rewritten.
const canonical = (p) => canonicalPath(p) ?? p;

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
//   - every migration directory: declared on a logical-database    -> resource
//     Resource (`spec.migrationPaths`), or detected per component
//     by the database adapter (`derived.migrationDirs`)
function classify(graph, p, idx, migrations) {
  for (const c of graph.contracts) if (c.ref === p) return "contract";
  for (const e of graph.entities) {
    const d = e.derived || {};
    for (const x of d.docs || []) if (x === p) return "documentation";
    for (const x of d.constraints || []) if (x === p) return "documentation";
    for (const x of d.runbooks || []) if (x === p) return "documentation";
  }
  if (/\.(md|mdx|adoc|rst|txt)$/.test(p)) return "documentation";
  if (migrationHit(migrations, p)) return "resource";
  // Kept as a fallback, and the one name-based rule left: before the graph
  // recorded migration directories this regex was the whole classification,
  // and it still has to answer where nothing is recorded — a repository that
  // does not enable the database adapter, a migration directory deeper than
  // the adapter's bounded walk, a graph built by hand. Dropping it would change
  // the answer for those repositories; what the graph records only adds to it.
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

// Migration directories recorded in the graph, with what made them one.
function migrationDirs(graph) {
  const declared = new Map(); // path -> Resource ref
  const detected = new Map(); // path -> { componentRef, via }
  for (const e of graph.entities) {
    if (e.kind === "Resource") {
      for (const p of e.entity?.spec?.migrationPaths || []) declared.set(p, e.ref);
    }
    if (e.kind === "Component") {
      for (const d of e.derived?.migrationDirs || []) detected.set(d.path, { componentRef: e.ref, via: d.via || [] });
    }
  }
  return { declared, detected };
}

// The migration directory a path is under, by whole path segments, the most
// specific first. An authored declaration beats a detected directory: it names
// the database, where detection only names the component whose bindings say
// which database it is.
function migrationHit(migrations, p) {
  if (!migrations) return null;
  const d = longestOwner(migrations.declared.keys(), p);
  if (d) return { dir: d, resourceRef: migrations.declared.get(d), how: "declared on " + migrations.declared.get(d) };
  const x = longestOwner(migrations.detected.keys(), p);
  if (!x) return null;
  const { componentRef, via } = migrations.detected.get(x);
  // A directory found by its conventional name is exactly what the fallback
  // regex already classified; only a directory nothing but the graph knows
  // about is worth a reason of its own.
  const conventional = via.every((v) => v === "directory-name" || v === "alembic-versions");
  return { dir: x, componentRef, conventional, how: "detected from " + via.join(", ") + " in " + componentRef };
}

export function impact(graph, changedPaths) {
  const idx = new ContextIndex(graph);
  const migrations = migrationDirs(graph);
  const migrationReasons = new Map(); // Resource ref -> Set(reason)
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
  const matchedVerification = new Set();

  for (const raw of changedPaths) {
    const p = canonical(raw);
    const entity = idx.resolve(p);
    // A Resource is not a component. Adding it to `affectedComponents` put a
    // `resource:` ref in a list an agent reads as "components you must check",
    // while the components actually bound to it went unmentioned.
    if (entity && entity.kind === "Component") add(entity.ref, "direct file change inside " + entity.ref);
    else unmatched.push(p);
    const kind = classify(graph, p, idx, migrations);
    if (kind === "contract") contracts.add(p);
    if (kind === "documentation") docs.add(p);
    if (kind === "resource") {
      const hit = migrationHit(migrations, p);
      const because = (ref) => {
        if (!hit || hit.conventional) return;
        if (!migrationReasons.has(ref)) migrationReasons.set(ref, new Set());
        migrationReasons.get(ref).add("migration " + p + " changes " + ref + " (migration directory " + hit.dir + ", " + hit.how + ")");
      };
      if (hit?.resourceRef) {
        // Authored: the declaration names the database, whichever component
        // owns the file and whatever that component is bound to.
        resources.add(hit.resourceRef);
        because(hit.resourceRef);
      } else {
        resources.add(entity?.kind === "Resource" ? entity.ref : p);
        // Migration authority is not ownership. Only follow an existing binding
        // from the component containing this migration to a logical database.
        const owner = hit?.componentRef ?? (entity?.kind === "Component" ? entity.ref : null);
        if (owner) {
          for (const rel of graph.relations) {
            const bound = rel.type === "usesResource" && rel.sourceRef === owner ? rel.targetRef
              : rel.type === "resourceUsedBy" && rel.targetRef === owner ? rel.sourceRef : null;
            if (idx.byRef.get(bound)?.entity.spec.type === "logical-database") {
              resources.add(bound);
              because(bound);
            }
          }
        }
      }
    }
    if (kind === "verification") verificationPaths.add(p);
    if (kind === "input") dependencyPaths.add(p);
    if (ownsPath("agentdoc", p)) catalogPaths.add(p);
  }

  // A check's configuration is evidence of the components it covers, even
  // when the file lives outside every component root (for example CI). Add
  // these before taking the seeds so their dependents' checks follow too.
  for (const v of graph.verification) {
    for (const p of verificationPaths) {
      if (!v.configPaths?.includes(p)) continue;
      matchedVerification.add(p);
      for (const ref of v.componentRefs) add(ref, "verification configuration " + p + " changed");
    }
  }
  const gates = graph.gates.filter((g) => g.configPaths?.some((p) => verificationPaths.has(p)));
  for (const g of gates) for (const p of g.configPaths) if (verificationPaths.has(p)) matchedVerification.add(p);

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
        for (const reason of migrationReasons.get(bound) || []) add(user, reason);
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
    unmatchedFiles: unmatched.filter((p) => !matchedVerification.has(p)).sort(),
    affectedComponents: refs.map((ref) => ({ ref, reasons: [...affectedComponents.get(ref)].sort() })),
    affectedContracts: [...contracts].sort(),
    affectedDocs: [...docs].sort(),
    affectedResources: [...resources].sort(),
    affectedInputs: [...dependencyPaths].sort(),
    affectedVerification: [...verificationPaths].sort(),
    affectedGates: gates.map((v) => ({ id: v.id, tier: v.tier, command: v.command })),
    affectedCatalog: [...catalogPaths].sort(),
    catalogSourceChanged: catalogPaths.size > 0,
    // Any file the compiler read is a graph input: changing it invalidates the
    // committed graph even when no descriptor changed.
    graphWillBeStale: graphAffected(graph, changedPaths),
    recommendedVerification: [...verification, ...gates].map((v) => ({ id: v.id, tier: v.tier, command: v.command })).slice(0, 25),
    recommendedVerificationTotal: verification.length + gates.length,
    recommendedVerificationTruncated: verification.length + gates.length > 25,
    openConflicts: conflicts.map((c) => ({ id: c.id, subject: c.subject, key: c.key, status: c.status, kind: c.kind })),
    relatedJourneys: journeys.map((j) => ({ id: j.id, description: j.description })),
  };
}

function graphAffected(graph, changedPaths) {
  const inputs = new Set(graph.provenance.map((p) => p.path));
  const paths = changedPaths.map(canonical);
  for (const p of paths) if (inputs.has(p)) return true;
  const idx = new ContextIndex(graph);
  return paths.some((p) => idx.resolve(p));
}
