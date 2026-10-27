// Change routing follows dependency edges in reverse. Normalize inverse edges
// here so query and impact agree even when the graph includes both spellings.
export function dependentScope(graph, seeds) {
  const reverse = new Map();
  for (const r of graph.relations) {
    let dependency, dependent;
    if (r.type === "buildDependsOn" || r.type === "testDependsOn") {
      dependency = r.targetRef;
      dependent = r.sourceRef;
    } else if (r.type === "buildDependencyOf" || r.type === "testDependencyOf") {
      dependency = r.sourceRef;
      dependent = r.targetRef;
    } else continue;
    if (!reverse.has(dependency)) reverse.set(dependency, []);
    reverse.get(dependency).push({ ref: dependent, unitOnly: r.type.startsWith("test") });
  }

  // false means all tiers; true means only unit checks. An all-build route
  // upgrades a prior test-only route, including its downstream dependents.
  const scope = new Map(seeds.map((ref) => [ref, false]));
  const queue = [...scope.keys()];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const edge of reverse.get(current) || []) {
      const unitOnly = scope.get(current) || edge.unitOnly;
      if (!scope.has(edge.ref) || (scope.get(edge.ref) && !unitOnly)) {
        scope.set(edge.ref, unitOnly);
        queue.push(edge.ref);
      }
    }
  }
  return scope;
}

export function verificationForChange(graph, seeds, priorityRefs = seeds) {
  const own = new Set(priorityRefs);
  const scope = dependentScope(graph, seeds);
  const rank = (v) => v.componentRefs.some((ref) => own.has(ref)) ? 0 : 1;
  return graph.verification
    .filter((v) => v.componentRefs.some((ref) => scope.has(ref) && (!scope.get(ref) || v.tier === "unit")))
    .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
