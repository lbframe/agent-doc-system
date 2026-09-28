// Client-of-resource resolution.
//
// A component that depends on a declared external service also *uses* the
// resource that service fronts, when exactly one authored Resource of the
// declared type exists. A message-bus client binds to the event bus; a cache
// client to the cache.
//
// The mapping is declared in configuration rather than inferred, because
// "this npm package talks to our bus" is a fact about the project, not about
// the package. When more than one Resource of the type exists the fact is left
// unresolved: an ambiguous match must never become an edge.

const POOL_HINT = /(createPool|new Pool|pg\.Pool|pgxpool|sql\.Open|mysql\.createConnection|Pool\(|DataSource|prisma\.(datasource|client)|DATABASE_URL|DB_DSN|redis|minio|Client\()/;

export function resolveClientResources(ctx, unit, compRef, provRec) {
  const declared = ctx.externalMatchers().filter((x) => x.resourceType);
  if (!declared.length) return [];
  // The rule is "this unit depends on this service", so it is tested against
  // the unit's production dependency names, not against its source text.
  const deps = ctx.productionDependencies(compRef);
  if (!deps.length) return [];
  const out = [];
  for (const x of declared) {
    if (!deps.some((d) => x.re.test(d))) continue;
    const cands = ctx.sources.entities.filter(
      (e) => e.kind === "Resource" && e.doc.spec.type === x.resourceType
    );
    if (cands.length !== 1) {
      if (cands.length > 1) {
        ctx.diagnostics.push({
          severity: "warning",
          code: "AGENTDOC_BINDING_AMBIGUOUS",
          subject: compRef,
          refs: [compRef],
          message:
            "component '" + compRef + "' depends on " + x.name + " and there are " + cands.length +
            " authored Resources of type " + x.resourceType + "; the binding is left unresolved",
          paths: [],
        });
      }
      continue;
    }
    const target = cands[0];
    // The matcher name is *data* — which declared client produced the edge — not
    // a derivation route. Encoding it in `via` would put it outside the relation's
    // identity, so a component depending on two matchers of the same Resource type
    // would merge into one edge and the graph would state the dependency once
    // instead of twice. `via` names the mechanism; `client` names the instance.
    ctx.addEdge("usesResource", compRef, target.ref, { via: "declared-client", client: x.name }, [provRec], "DERIVED");
    ctx.addFact(compRef, "resource.ownership", target.name, {
      evidenceClass: "DERIVED",
      confidence: "deterministic",
      provRecs: [provRec],
      semantics: "the component depends on " + x.name + ", declared as a client of the " + x.resourceType + " Resource",
    });
    out.push(target.ref);
  }
  return out;
}

export { POOL_HINT };
