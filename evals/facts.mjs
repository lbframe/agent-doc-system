// The scoring vocabulary is independent of how a retrieval system found a fact.
export function fact(type, value) {
  return type === "ref" ? value : type + ":" + value;
}

const RELATIONS = {
  usesResource: ["uses", "usedBy"],
  resourceUsedBy: ["usedBy", "uses"],
  providesApi: ["provides", "provider"],
  apiProvidedBy: ["provider", "provides"],
  consumesApi: ["consumes", "consumer"],
  apiConsumedBy: ["consumer", "consumes"],
};

export function addRelationFacts(out, type, other, direction = "out") {
  // Holding a relation also identifies its other endpoint, as query's
  // neighbour summaries do. Component and placement links use bare refs.
  out.add(fact("ref", other));
  const labels = RELATIONS[type];
  if (labels) out.add(fact(labels[direction === "in" ? 1 : 0], other));
}

export function addGraphRelations(out, graph, ref) {
  for (const r of graph.relations) {
    if (r.sourceRef === ref) addRelationFacts(out, r.type, r.targetRef);
    if (r.targetRef === ref) addRelationFacts(out, r.type, r.sourceRef, "in");
  }
}
