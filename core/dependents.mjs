// Change routing follows dependency edges in reverse. Normalize inverse edges
// here so query and impact agree even when the graph includes both spellings.
function reverseEdges(graph) {
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
  // Sorted so that every walk below is independent of relation order.
  for (const list of reverse.values()) list.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.unitOnly - b.unitOnly));
  return reverse;
}

export function dependentScope(graph, seeds) {
  const reverse = reverseEdges(graph);

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

// Shortest distance, in dependency hops, from the nearest seed to each dependent,
// with the seed reached and the next component on the way to it. Breadth-first
// over the same reverse edges as dependentScope, so the two always agree on
// which components are reached. Distance orders results; it never removes one:
// how far a dependent is says how likely it is to break, not whether it can.
export function dependentDistances(graph, seeds) {
  const reverse = reverseEdges(graph);
  const out = new Map();
  for (const ref of [...new Set(seeds)].sort()) out.set(ref, { distance: 0, seed: ref, next: null });
  const queue = [...out.keys()];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const here = out.get(current);
    for (const edge of reverse.get(current) || []) {
      if (out.has(edge.ref)) continue;
      out.set(edge.ref, { distance: here.distance + 1, seed: here.seed, next: current });
      queue.push(edge.ref);
    }
  }
  return out;
}

export function verificationForChange(graph, seeds, priorityRefs = seeds) {
  const own = new Set(priorityRefs);
  const scope = dependentScope(graph, seeds);
  const distance = dependentDistances(graph, seeds);
  // The changed components' own checks first, then by how close the checked
  // component is to the change, so a truncated list keeps the nearest.
  const rank = (v) => v.componentRefs.some((ref) => own.has(ref))
    ? 0
    : 1 + Math.min(...v.componentRefs.filter((ref) => scope.has(ref)).map((ref) => distance.get(ref)?.distance ?? Infinity));
  return graph.verification
    .filter((v) => v.componentRefs.some((ref) => scope.has(ref) && (!scope.get(ref) || v.tier === "unit")))
    .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
