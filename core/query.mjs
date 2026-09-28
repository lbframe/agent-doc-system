// Context router.
//
// The job is routing, not documentation concatenation. Given a source path or
// an entity ref, return the smallest set of facts an agent needs to work
// safely on that subject — and refuse to answer from a stale graph.
//
// Everything returned is budgeted: relations, interfaces, resources, journeys
// and verification entries are all capped, with the overflow reported rather
// than silently dropped, so an agent can see that it is seeing a slice.
import { AgentDocError, CODES } from "./codes.mjs";
import { assertNoSecretsInText } from "./secrets.mjs";

const DEFAULT_BUDGET = {
  relations: 40,
  events: 20,
  externals: 15,
  capabilities: 10,
  verification: 12,
  journeys: 10,
  conflicts: 20,
  assertions: 25,
  provenance: 20,
  contracts: 10,
};

export class ContextIndex {
  constructor(graph) {
    this.graph = graph;
    this.byRef = new Map(graph.entities.map((e) => [e.ref, e]));
    this.byPath = new Map();
    for (const e of graph.entities) {
      const sp = e.derived && e.derived.sourcePath;
      if (!sp) continue;
      this.byPath.set(sp, e);
      // Longest path first so a nested path resolves to its own component
      // rather than to a parent.
    }
    // Documentation and constraint files a descriptor links resolve to their
    // component, even when they live outside the source root. Following a
    // stale document to the code it describes is exactly the migration case.
    this.byDoc = new Map();
    for (const e of graph.entities) {
      const ctxPaths = [
        ...(((e.entity.spec || {}).context || {}).docs || []),
        ...(((e.entity.spec || {}).context || {}).constraints || []),
        ...(((e.entity.spec || {}).context || {}).runbooks || []),
        ...(e.derived || {}).docs || [],
        ...(e.derived || {}).constraints || [],
        ...(e.derived || {}).runbooks || [],
      ];
      for (const p of ctxPaths) if (!this.byDoc.has(p)) this.byDoc.set(p, e);
    }
    this.paths = [...this.byPath.keys()].sort((a, b) => b.length - a.length);
    this.relationsByRef = new Map();
    for (const r of graph.relations) {
      if (!this.relationsByRef.has(r.sourceRef)) this.relationsByRef.set(r.sourceRef, []);
      if (!this.relationsByRef.has(r.targetRef)) this.relationsByRef.set(r.targetRef, []);
      this.relationsByRef.get(r.sourceRef).push(r);
      this.relationsByRef.get(r.targetRef).push(r);
    }
  }

  // A contract file resolves to the API entity that claims it, so "change this
  // endpoint" routes to the boundary rather than to nothing.
  contractFor(needle) {
    const norm = needle.replace(/^\.\//, "").replace(/\/+$/, "");
    let best = null;
    for (const c of (this.graph.contracts || [])) {
      if (norm === c.ref || norm.startsWith(c.ref)) {
        if (!best || c.ref.length > best.ref.length) best = c;
      }
    }
    return best;
  }
  resolve(needle) {
    if (this.byRef.has(needle)) return this.byRef.get(needle);
    const norm = needle.replace(/^\.\//, "").replace(/\/+$/, "");
    if (this.byDoc.has(norm)) return this.byDoc.get(norm);
    if (this.byPath.has(norm)) return this.byPath.get(norm);
    for (const p of this.paths) {
      if (norm === p || norm.startsWith(p + "/")) return this.byPath.get(p);
    }
    for (const p of this.paths) {
      if (needle.startsWith(p + "/")) return this.byPath.get(p);
    }
    if (this.byDoc.has(needle)) return this.byDoc.get(needle);
    const c = this.contractFor(needle);
    return c ? this.byRef.get(c.apiRef) || null : null;
  }
}

function contractsOf(graph) {
  return graph.contracts || [];
}

export function queryContext(graph, needle, opts = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(opts.budget || {}) };
  const idx = new ContextIndex(graph);
  const entity = idx.resolve(needle);
  if (!entity) {
    throw new AgentDocError(
      CODES.REF_UNRESOLVED,
      "no entity resolves for '" + needle + "' — run `agentdoc audit` to see what the catalog knows about this repository"
    );
  }
  const ref = entity.ref;
  const g = graph;
  const take = (arr, n) => ({ items: arr.slice(0, n), total: arr.length, truncated: arr.length > n });

  const relations = idx.relationsByRef.get(ref) || [];
  const neighbourRefs = new Set();
  for (const r of relations) neighbourRefs.add(r.targetRef);

  const placement = relations
    .filter((r) => (r.type === "partOf" || r.type === "hasPart") && (r.sourceRef === ref || r.targetRef === ref))
    .map((r) => (r.sourceRef === ref ? r.targetRef : r.sourceRef));
  const systems = [...new Set(placement.filter((p) => p.startsWith("system:")))];
  const domains = [...new Set(placement.filter((p) => p.startsWith("domain:")))];

  // For a component these are the APIs it serves; for an API entity the subject
  // *is* the provided surface.
  const providedApis = entity.kind === "API"
    ? [ref]
    : g.relations.filter((r) => r.type === "providesApi" && r.sourceRef === ref).map((r) => r.targetRef);
  const consumedApis = g.relations.filter((r) => r.type === "consumesApi" && r.sourceRef === ref).map((r) => r.targetRef);
  // When the subject IS an API, the interesting question is who consumes it.
  const apiConsumers = entity.kind === "API"
    ? g.relations.filter((r) => r.type === "consumesApi" && r.targetRef === ref).map((r) => r.sourceRef)
    : [];

  const providerOf = (apiRef) => {
    const r = g.relations.find((x) => x.type === "apiProvidedBy" && x.sourceRef === apiRef);
    return r ? r.targetRef : null;
  };
  const apiProvider = entity.kind === "API" ? providerOf(ref) : null;

  const apiRefs = new Set([...providedApis, ...consumedApis]);
  const srcPath = (entity.derived && entity.derived.sourcePath) || null;
  const events = g.interfaces.events.filter(
    (e) =>
      e.producers.includes(ref) ||
      e.consumers.includes(ref) ||
      // A contract library that ships the subject catalog owns those subjects,
      // even when another component is the one that subscribes to them.
      (srcPath && e.contract && e.contract.ref.startsWith(srcPath + "/"))
  );
  const externals = g.externalDependencies.filter((e) => e.componentRef === ref);
  const capabilities = g.capabilities.filter((e) => e.componentRef === ref);
  // For a contract subject, the checks that matter are the provider's and the
  // consumers': changing an endpoint is proved by running their suites.
  const verificationScope = entity.kind === "API"
    ? [ref, ...apiConsumers, ...(apiProvider ? [apiProvider] : [])]
    : [ref];
  const verification = g.verification.filter((e) => e.componentRefs.some((r) => verificationScope.includes(r)));
  const journeys = g.journeys.filter((j) => j.components.includes(ref));
  const contracts = g.contracts.filter((c) => c.apiRef && apiRefs.has(c.apiRef));
  const conflicts = g.conflicts.filter((c) => c.subject === ref);
  const assertions = g.assertions.filter((a) => a.subject === ref);
  const resources = g.relations
    .filter((r) => r.type === "usesResource" && r.sourceRef === ref)
    .map((r) => r.targetRef);
  const affectedByResources = g.relations
    .filter((r) => r.type === "usesResource" && r.targetRef === ref)
    .map((r) => r.sourceRef);

  const provIds = new Set();
  const collect = (obj) => {
    for (const id of obj.provenanceIds || []) provIds.add(id);
  };
  collect(entity);
  relations.forEach(collect);
  events.forEach(collect);
  externals.forEach(collect);
  verification.forEach(collect);
  journeys.forEach(collect);
  contracts.forEach(collect);
  conflicts.forEach(collect);
  assertions.forEach(collect);
  const provenance = g.provenance.filter((p) => provIds.has(p.id));

  const journeyPeers = new Set();
  for (const j of journeys) for (const c of j.components) if (c !== ref) journeyPeers.add(c);

  const neighbourSummaries = [...neighbourRefs]
    .filter((r) => r !== ref)
    .sort()
    .map((r) => {
      const e = idx.byRef.get(r);
      return e ? { ref: r, kind: e.kind, name: e.name, description: e.entity.metadata.description } : { ref: r };
    });

  const out = {
    query: { needle, resolved: ref, namespace: ref.split("/")[0].split(":")[1] },
    entity: {
      ref,
      kind: entity.kind,
      name: entity.name,
      description: entity.entity.metadata.description,
      spec: entity.entity.spec || {},
      sourcePaths: entity.sourcePaths,
      derived: entity.derived || {},
    },
    placement: { systems, domains },
    relations: take(
      relations.map((r) => ({
        type: r.type,
        direction: r.sourceRef === ref ? "out" : "in",
        other: r.sourceRef === ref ? r.targetRef : r.sourceRef,
        evidenceClass: r.evidenceClass,
        attributes: Object.keys(r.attributes || {}).length ? r.attributes : undefined,
        provenanceIds: r.provenanceIds,
      })),
      budget.relations
    ),
    neighbours: neighbourSummaries,
    apis: {
      provided: providedApis.map((a) => ({ api: a, contract: contractRef(g, a) })),
      consumed: consumedApis.map((a) => ({ api: a, provider: providerOf(a), contract: contractRef(g, a) })),
      provider: apiProvider,
      consumers: [...new Set(apiConsumers)].sort(),
      contract: entity.kind === "API" ? contractRef(g, ref) : null,
    },
    events: take(
      events.map((e) => ({ pattern: e.pattern, producers: e.producers, consumers: e.consumers, resolution: e.resolution, contract: e.contract })),
      budget.events
    ),
    resources: { used: resources, usedBy: affectedByResources },
    externalDependencies: take(
      externals.map((e) => ({ name: e.name, role: e.role, mechanism: e.mechanism, evidenceClass: e.evidenceClass })),
      budget.externals
    ),
    capabilities: take(capabilities.map((c) => ({ name: c.name, evidenceClass: c.evidenceClass })), budget.capabilities),
    constraints: {
      docs: (entity.derived && entity.derived.docs) || [],
      constraints: (entity.derived && entity.derived.constraints) || [],
      runbooks: (entity.derived && entity.derived.runbooks) || [],
    },
    verification: take(
      verification.map((v) => ({ id: v.id, tier: v.tier, command: v.command, configPaths: v.configPaths })),
      budget.verification
    ),
    journeys: take(
      journeys.map((j) => ({ id: j.id, description: j.description, components: j.components })),
      budget.journeys
    ),
    // A journey is a claim that these components act together. Touching one of
    // them means the others are in scope, and naming them is cheaper for the
    // agent than rediscovering the coupling.
    journeyPeers: [...journeyPeers].sort(),
    contracts: take(contracts, budget.contracts),
    authority: {
      conflicts: take(
        conflicts.map((c) => ({
          id: c.id, key: c.key, kind: c.kind, status: c.status,
          detail: c.detail, election: c.election,
          assertions: c.assertionIds.map((id) => {
            const a = g.assertions.find((x) => x.id === id);
            return a ? { id: a.id, evidenceClass: a.evidenceClass, confidence: a.confidence, value: a.value, status: a.status, semantics: a.semantics, observed: a.observed } : { id };
          }),
        })),
        budget.conflicts
      ),
      assertions: take(
        assertions.map((a) => ({
          id: a.id, key: a.key, value: a.value, evidenceClass: a.evidenceClass,
          confidence: a.confidence, status: a.status, semantics: a.semantics,
        })),
        budget.assertions
      ),
      observations: g.observations
        .filter((o) => o.facts.some((f) => f.subject === ref))
        .map((o) => ({
          id: o.id, environment: o.environment, sourceSystem: o.sourceSystem,
          collector: o.collector, capturedAt: o.capturedAt, maxAgeDays: o.maxAgeDays,
          evidenceBundle: o.evidenceBundle,
          facts: o.facts.filter((f) => f.subject === ref),
        })),
    },
    provenance: take(provenance.map((p) => ({ id: p.id, class: p.class, path: p.path, extractor: p.extractor.name, contentHash: p.contentHash })), budget.provenance),
    globalGates: g.gates.map((x) => ({ id: x.id, tier: x.tier, command: x.command })),
    // Everything a reviewer committed to re-examining, in one place. A review
    // condition nobody can see is a review condition nobody performs.
    reviewCommitments: [
      ...g.conflicts
        .filter((c) => c.status !== "unresolved")
        .map((c) => ({
          kind: c.kind, subject: c.subject, key: c.key, status: c.status,
          basis: c.election.basis, ruleId: c.election.ruleId,
          // The governing authority rule's own re-examination condition. When
          // there is no rule the fact stayed unresolved, and `null` says exactly
          // that — it is not a missing value to be papered over with a pointer
          // to a record that was never written.
          reviewWhen: c.election.reviewWhen ?? null,
        })),
      ...g.diagnostics
        .filter((d) => d.acceptance)
        .map((d) => ({
          kind: d.code, subject: d.subject || null, status: "accepted",
          classification: d.acceptance.classification,
          reason: d.acceptance.reason, reviewWhen: d.acceptance.reviewWhen,
        })),
      ...g.assertions
        .filter((a) => a.review)
        .map((a) => ({
          kind: "reviewed-override", subject: a.subject, key: a.key, status: a.status,
          reason: a.review.reason, reviewWhen: a.review.reviewWhen,
        })),
    ],
  };
  // Truncation is reported for every capped section, including the nested ones
  // inside `authority`. A silently shortened conflict list is the most damaging
  // cut this command could make.
  out.truncated = [];
  for (const [k, v] of Object.entries(out)) {
    if (v && typeof v === "object" && v.truncated) out.truncated.push(k);
    if (k === "authority" && v) {
      for (const [ak, av] of Object.entries(v)) {
        if (av && typeof av === "object" && av.truncated) out.truncated.push("authority." + ak);
      }
    }
  }
  assertNoSecretsInText(JSON.stringify(out), "query result");
  return out;
}

function contractRef(graph, apiRef) {
  const e = graph.entities.find((x) => x.ref === apiRef);
  return e ? e.entity.spec.contract : null;
}

// Compact markdown rendering for a prompt or a human. Same routing, less tokens.
export function renderContext(ctx) {
  const L = [];
  const e = ctx.entity;
  L.push("# " + e.ref + " (" + e.kind + ")");
  L.push(e.description);
  if (e.derived.sourcePath) L.push("- source: " + e.derived.sourcePath);
  if (e.derived.runtimes?.length) L.push("- runtimes: " + e.derived.runtimes.join(", "));
  if (e.derived.languages?.length) L.push("- languages: " + e.derived.languages.join(", "));
  if (ctx.placement.systems.length) L.push("- system: " + ctx.placement.systems.join(", "));
  if (ctx.placement.domains.length) L.push("- domain: " + ctx.placement.domains.join(", "));
  if (ctx.apis.provided.length) L.push("- provides: " + ctx.apis.provided.map((a) => a.api).join(", "));
  if (ctx.apis.consumed.length) L.push("- consumes: " + ctx.apis.consumed.map((a) => a.api + " (via " + a.provider + ")").join(", "));
  if (ctx.resources.used.length) L.push("- uses resource: " + ctx.resources.used.join(", "));
  if (ctx.events.items.length) L.push("- events: " + ctx.events.items.map((x) => x.pattern + " [" + x.resolution + "]").join(", "));
  if (ctx.externalDependencies.items.length) L.push("- external: " + ctx.externalDependencies.items.map((x) => x.name + " (" + x.role + ")").join(", "));
  if (ctx.capabilities.items.length) L.push("- capabilities: " + ctx.capabilities.items.map((x) => x.name).join(", "));
  if (ctx.constraints.constraints.length) L.push("- CONSTRAINTS: " + ctx.constraints.constraints.join(", "));
  if (ctx.constraints.docs.length) L.push("- docs: " + ctx.constraints.docs.join(", "));
  if (ctx.constraints.runbooks.length) L.push("- runbooks: " + ctx.constraints.runbooks.join(", "));
  if (ctx.verification.items.length) {
    L.push("- verify:");
    for (const v of ctx.verification.items) L.push("  - [" + v.tier + "] " + v.command);
  }
  if (ctx.journeys.items.length) L.push("- journeys: " + ctx.journeys.items.map((j) => j.id).join(", "));
  if (ctx.authority.conflicts.items.length) {
    L.push("- CONFLICTS (do not assume one is true):");
    for (const c of ctx.authority.conflicts.items) {
      L.push("  - " + c.key + " [" + c.kind + "/" + c.status + "] " + (c.detail || ""));
      for (const a of c.assertions) L.push("    - " + a.evidenceClass + "/" + a.confidence + ": " + JSON.stringify(a.value));
    }
  }
  if (ctx.reviewCommitments.length) {
    L.push("- REVIEW COMMITMENTS (re-check when the condition is met):");
    for (const r of ctx.reviewCommitments) {
      // An absent condition is stated as absent. Printing a pointer to a record
      // that does not exist is worse than printing nothing: it looks actionable
      // and is not.
      const when = r.reviewWhen
        ? r.reviewWhen
        : "NO REVIEW CONDITION RECORDED — " + r.kind + " " + (r.subject || "") + " " + (r.key || "") +
          " is settled with none; re-examine it now";
      L.push("  - " + (r.subject || "repository") + " " + (r.key || r.kind) + ": " + when);
    }
  }
  const obs = ctx.authority.observations;
  if (obs.length) {
    L.push("- RUNTIME OBSERVATIONS:");
    for (const o of obs) L.push("  - " + o.environment + " via " + o.sourceSystem + " at " + o.capturedAt + " (evidence " + o.evidenceBundle + ")");
  }
  const neighbours = ctx.neighbours.filter((n) => n.ref !== e.ref);
  if (neighbours.length) L.push("- neighbours: " + neighbours.map((n) => n.ref).join(", "));
  return L.join("\n");
}
