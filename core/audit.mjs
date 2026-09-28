// Repository audit and migration report.
//
// MIGRATE mode does not trust documentation. It inventories four sources of
// truth — the repository's manifests and code, its machine-readable contracts,
// its authored documentation, and its authoritative external systems — and then
// reports, per fact, which of these supports it. Every major fact lands in
// exactly one class:
//
//   CONFIRMED   two or more independent sources agree
//   DERIVED     deterministically derivable from the repository
//   OBSERVED    read from an authoritative external system
//   CONFLICT    sources disagree and no authority rule settles it
//   UNRESOLVED  the repository cannot answer, and neither can we
//
// Uncertainty is never promoted to authored truth. `agentdoc scaffold` writes
// only CONFIRMED and DERIVED facts; OBSERVED stays in an ObservationSet;
// CONFLICT and UNRESOLVED go into the reviewed-ambiguity list for a human.
import { classifyContractFile } from "./contracts.mjs";
import { ContextIndex } from "./query.mjs";
import { expandGlob, isRepoPath } from "./fsx.mjs";

const DOC_EXT = /\.(md|mdx|adoc|rst|txt)$/;

export function audit(repo, cfg, res) {
  const graph = res.graph;
  const idx = new ContextIndex(graph);
  const classes = new Map(); // fact -> class
  const note = (fact, cls, why) => {
    if (!classes.has(fact)) classes.set(fact, { cls, why: [] });
    const cur = classes.get(fact);
    if (cls === "CONFLICT" || cls === "UNRESOLVED") cur.cls = cls;
    if (why) cur.why.push(why);
  };

  // 1. entities: confirmed when corroborated by a real artifact on disk
  for (const e of graph.entities) {
    const f = e.ref;
    if (e.kind === "Component") {
      const unit = res.discovery.units.find((u) => u.component && u.component.ref === e.ref);
      const markers = (unit && unit.markers) || [];
      if (markers.length >= 1) note(f, "CONFIRMED", "descriptor + " + markers.map((m) => m.adapter).join(","));
      else note(f, "UNRESOLVED", "descriptor exists but no artifact evidence was found in " + (e.derived?.sourcePath || "?"));
    } else if (e.kind === "API") {
      const cref = e.entity.spec.contract?.ref;
      if (e.entity.spec.type === "oidc") note(f, "CONFIRMED", "oidc surface validated against provider source and discovery path");
      else if (cref && repo.exists(cref)) {
        const consumers = graph.relations.filter((r) => r.type === "consumesApi" && r.targetRef === f);
        note(f, consumers.length ? "CONFIRMED" : "DERIVED", "canonical contract " + cref + (consumers.length ? " with " + consumers.length + " discovered consumer(s)" : " with no discovered consumer"));
      } else note(f, "UNRESOLVED", "API has no resolvable canonical contract");
    } else {
      note(f, "DERIVED", "authored placement entity");
    }
  }

  // 2. facts and conflicts
  for (const a of graph.assertions) {
    const f = a.subject + " " + a.key;
    if (a.evidenceClass === "OBSERVED_RUNTIME") note(f, "OBSERVED", a.observed ? a.observed.sourceSystem + " at " + a.observed.at : "runtime");
    else if (a.status === "unresolved") note(f, "UNRESOLVED", "no deterministic resolution");
    else if (a.status === "candidate") note(f, "UNRESOLVED", "heuristic candidate only");
    else if (a.evidenceClass === "AUTHORED") note(f, "DERIVED", "authored");
    else if (a.confidence === "deterministic") note(f, "DERIVED", "deterministic extraction");
    else note(f, "DERIVED", a.evidenceClass);
  }
  for (const c of graph.conflicts) {
    const f = c.subject + " " + c.key;
    // A divergence a rule settled is a known fact with a documented basis, not
    // something awaiting a human. Reporting it as CONFLICT would put settled
    // questions in the reviewed-ambiguity list forever.
    const settled = c.status === "resolved" || c.status === "accepted";
    note(f, settled ? "DERIVED" : "CONFLICT",
      c.kind + ": " + (c.detail || "") + " (" + c.status +
      (settled ? ", elected " + (c.election.basis || "?") + " by " + (c.election.ruleId || "?") : "") + ")");
  }

  // 3. relations
  for (const r of graph.relations) {
    if (r.type === "partOf" || r.type === "hasPart" || r.type === "providesApi" || r.type === "apiProvidedBy") continue;
    const f = r.type + " " + r.sourceRef + " -> " + r.targetRef;
    note(f, r.evidenceClass === "REVIEWED_OVERRIDE" ? "DERIVED" : "DERIVED", r.evidenceClass);
  }

  // 4. documentation inventory
  // The configured documentation hierarchy is documentation too. A PRODUCT.md
  // nobody routes to is an orphan, and saying so is the point.
  //
  // The exemption below is narrow on purpose. Only the fixed repository-wide
  // roles are exempt, because only those are repository-wide *by definition*:
  // they are reached from the configuration rather than from a component. Any
  // other configured path could just as easily name a component-scoped file, and
  // exempting those would let a real orphan be silenced by pointing at it in
  // configuration. A `docs.architecture` entry that resolves inside a component
  // root is therefore reported, not excused.
  const HIERARCHY_FILE_ROLES = new Set(["product", "architecture", "constraints"]);
  // Only file-shaped roles become entries. The `*Dir` keys are handled by the
  // loop below; letting one through as a "document" makes `exists: true` for a
  // directory, which is a check that can never fail.
  const configured = Object.entries(cfg.docs || {})
    .filter(([role]) => !role.endsWith("Dir"))
    .map(([role, p]) => ({ role, path: p, configured: true }));
  // Directory-shaped roles are enumerated rather than listed as a single entry:
  // a directory is not a document, and reporting it as one is a dead check.
  for (const [role, key] of [["adr", "adrDir"], ["runbook", "runbookDir"]]) {
    const dir = (cfg.docs || {})[key];
    if (!dir) continue;
    if (repo.isDir(dir)) {
      for (const f of repo.walk(dir)) if (DOC_EXT.test(f)) configured.push({ role, path: f, configured: false });
    } else {
      // A directory role that does not exist is reported through `exists:false`
      // below, so it needs no separate flag here.
      configured.push({ role, path: dir, configured: false });
    }
  }
  const unitRoots = new Set(res.discovery.units.map((u) => u.root));
  const insideComponent = (p) => {
    for (const r of unitRoots) if (p === r || p.startsWith(r + "/")) return r;
    return null;
  };

  // The audit reports; it does not gate. These are therefore collected as audit
  // findings on the report rather than pushed into the compile-time diagnostics,
  // where a `warning` would be gated by `check` and a migration could not even
  // see what it is being asked to fix. Each is emitted with the same code a
  // compile-time gate would use, so the vocabulary is shared.
  const docFindings = [];
  const docInventory = [];
  for (const f of repo.walk("")) {
    if (!DOC_EXT.test(f)) continue;
    const owners = graph.entities.filter((e) => {
      const d = e.derived || {};
      return (d.docs || []).includes(f) || (d.constraints || []).includes(f) || (d.runbooks || []).includes(f);
    }).map((e) => e.ref);
    const role = (configured.find((h) => h.path === f) || {}).role || null;
    docInventory.push({ path: f, linkedTo: owners.sort(), role });
  }

  // Built from the *configured* list, not from the walk, so a configured path
  // that does not exist is reported. Filtering the walk made `exists` a constant
  // `true`, which is the one thing a reader would want it to catch.
  const hierarchyDocs = configured.map((h) => ({
    role: h.role,
    path: h.path,
    exists: repo.exists(h.path),
    // The component root this path sits inside, when it sits inside one. A
    // repository-wide role that resolves inside a component is the case worth
    // reporting, so this is computed for every entry rather than only for the
    // ones that look exempt.
    componentScoped: insideComponent(h.path),
  }));

  const exempt = (d) => {
    if (d.linkedTo.length) return true;
    if (d.role && HIERARCHY_FILE_ROLES.has(d.role) && !insideComponent(d.path)) return true;
    return false;
  };
  const orphanDocs = docInventory.filter((d) => !exempt(d)).map((d) => d.path);
  for (const d of docInventory.filter((x) => !exempt(x))) {
    docFindings.push({
      severity: "warning",
      code: "AGENTDOC_DOC_ORPHANED",
      subject: d.path,
      refs: [d.path],
      message:
        "document is claimed by no component" +
        (d.role ? " and its configured role (" + d.role + ") is not a repository-wide role" : "") +
        ". Link it from a component descriptor, or remove it.",
    });
  }
  for (const h of hierarchyDocs) {
    if (!h.exists) {
      docFindings.push({
        severity: "warning",
        code: "AGENTDOC_DOC_ORPHANED",
        subject: h.path,
        refs: [h.path],
        message: "configured documentation path does not exist: " + h.path,
      });
    } else if (h.componentScoped) {
      docFindings.push({
        severity: "warning",
        code: "AGENTDOC_DOC_ORPHANED",
        subject: h.path,
        refs: [h.path],
        message:
          "configured as repository-wide documentation (" + h.role + ") but resolves inside component " +
          h.componentScoped + ". Either move it or claim it from that component's descriptor.",
      });
    }
  }

  // 5. contract inventory
  const claimedContracts = new Set(
    graph.entities.filter((e) => e.kind === "API" && e.entity.spec.contract?.ref).map((e) => e.entity.spec.contract.ref)
  );
  const contractInventory = [];
  const scanRoots = new Set([
    ...(cfg.discovery.contractRoots || []),
    ...graph.entities.filter((e) => e.kind === "API" && e.entity.spec.contract?.ref).map((e) => e.entity.spec.contract.ref.split("/").slice(0, -1).join("/")),
  ]);
  for (const r of scanRoots) {
    if (!r || !repo.isDir(r)) continue;
    for (const f of repo.walk(r)) {
      if (!classifyContractFile(f)) continue;
      contractInventory.push({ path: f, claimedBy: claimedContracts.has(f) ? "yes" : "no" });
    }
  }
  const unclaimedContracts = contractInventory.filter((c) => c.claimedBy === "no").map((c) => c.path);

  // 6. events without producers
  const unresolvedEvents = graph.interfaces.events.filter((e) => e.resolution === "unresolved").map((e) => e.pattern);

  // 7. components without documentation or verification
  const undocumented = graph.entities
    .filter((e) => e.kind === "Component")
    .filter((e) => !((e.derived || {}).docs || []).length)
    .map((e) => e.ref);
  const unverified = graph.entities
    .filter((e) => e.kind === "Component")
    .filter((e) => !graph.verification.some((v) => v.componentRefs.includes(e.ref)))
    .map((e) => e.ref);

  const ambiguousOwnership = graph.conflicts
    .filter((c) => c.status === "unresolved" && c.key.startsWith("placement."))
    .map((c) => c.subject);

  const staleObservations = graph.observations.map((o) => ({
    id: o.id, capturedAt: o.capturedAt, maxAgeDays: o.maxAgeDays, environment: o.environment,
  }));

  // ── 8. documentation claims that contradict what the graph owns ─────────
  // Only claims about vocabulary the graph actually owns are checked. A doc
  // saying "there is no edge component" is checkable and worth failing on; a
  // doc saying "we use Kafka" is not, because the graph has no opinion until a
  // Resource descriptor says so.
  const docContradictions = [];
  const knownNames = new Map();
  for (const e of graph.entities) knownNames.set(normaliseName(e.name), e.ref);
  const portByComponent = new Map();
  for (const a of graph.assertions) {
    if (a.key === "component.port" && a.status === "elected") portByComponent.set(a.subject, a.value);
  }
  for (const d of docInventory) {
    if (!/\.(md|mdx|adoc|rst)$/.test(d.path)) continue;
    const owners = d.linkedTo;
    let text;
    try {
      text = repo.readText(d.path);
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\b(?:there (?:is|are)|we have)\s+no\s+([a-z][a-z0-9-]{2,30})\b/gi)) {
      const ref = knownNames.get(normaliseName(m[1]));
      if (ref) {
        docContradictions.push({
          kind: "NEGATED_COMPONENT",
          doc: d.path,
          claim: m[0].trim(),
          contradicts: ref,
          detail: "the document denies a component the graph proves exists",
        });
      }
    }
    for (const m of text.matchAll(/\bport\s*(\d{4,5})\b/gi)) {
      const claimed = Number(m[1]);
      for (const owner of owners) {
        const actual = portByComponent.get(owner);
        if (actual !== undefined && actual !== claimed) {
          docContradictions.push({
            kind: "PORT_MISMATCH",
            doc: d.path,
            claim: m[0].trim(),
            contradicts: owner,
            detail: "the document states port " + claimed + "; the source binds port " + actual,
          });
        }
      }
      if (!owners.length) {
        docContradictions.push({
          kind: "UNLINKED_PORT_CLAIM",
          doc: d.path,
          claim: m[0].trim(),
          contradicts: null,
          detail: "the document states a port but is not linked to any component, so the claim cannot be checked",
        });
      }
    }
  }

  // How many production dependencies exist that nobody classified as an
  // external service. Reported as a number, not as hundreds of warnings: the
  // decision of which third-party service is architectural belongs to a human.
  const declared = new Set((cfg.discovery.externalDependencies || []).map((x) => x.name));
  const unclassified = new Set();
  for (const e of graph.entities) {
    if (e.kind !== "Component") continue;
    const unit = res.discovery.units.find((u) => u.component && u.component.ref === e.ref);
    if (!unit) continue;
    for (const d of Object.keys((unit.pkg || {}).dependencies || {})) {
      const norm = String(d).replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (declared.has(norm)) continue;
      if (graph.externalDependencies.some((x) => x.componentRef === e.ref)) continue;
      unclassified.add(d);
    }
  }

  const rows = [...classes.entries()].map(([fact, v]) => ({ fact, classification: v.cls, evidence: v.why.slice(0, 4) }));
  rows.sort((a, b) => (a.fact < b.fact ? -1 : 1));
  const counts = rows.reduce((acc, r) => { acc[r.classification] = (acc[r.classification] || 0) + 1; return acc; }, {});

  return {
    inventory: {
      files: repo.walk("").length,
      units: res.discovery.units.length,
      eligibleUnits: res.discovery.eligible.length,
      entities: graph.entities.length,
      components: graph.entities.filter((e) => e.kind === "Component").length,
      apis: graph.entities.filter((e) => e.kind === "API").length,
      resources: graph.entities.filter((e) => e.kind === "Resource").length,
      relations: graph.relations.length,
      events: graph.interfaces.events.length,
      contracts: contractInventory.length,
      documentationFiles: docInventory.length,
      observations: graph.observations.length,
      verification: graph.verification.length + graph.gates.length,
    },
    facts: rows,
    counts,
    contradictions: [
      ...graph.conflicts.filter((c) => c.status === "unresolved").map((c) => ({ kind: c.kind, subject: c.subject, key: c.key, status: c.status, detail: c.detail || null, election: c.election })),
      ...docContradictions,
    ],
    settledDivergences: graph.conflicts
      .filter((c) => c.status !== "unresolved")
      .map((c) => ({ kind: c.kind, subject: c.subject, key: c.key, status: c.status, basis: c.election.basis, ruleId: c.election.ruleId })),
    documentationContradictions: docContradictions,
    reviewedAmbiguity: [
      ...unresolvedEvents.map((pattern) => ({ kind: "EVENT_WITHOUT_PRODUCER", subject: pattern })),
      ...ambiguousOwnership.map((ref) => ({ kind: "COMPONENT_OWNERSHIP", subject: ref })),
      ...unclaimedContracts.map((p) => ({ kind: "UNCLAIMED_CONTRACT", subject: p })),
      ...docContradictions.map((c) => ({ kind: c.kind, subject: c.doc + ": " + c.claim })),
      ...(cfg.reviewedOverrides || []).map((o) => ({ kind: "REVIEWED_OVERRIDE", subject: o.subject + " " + o.fact })),
    ],
    documentation: {
      findings: docFindings,
      hierarchy: hierarchyDocs,
      orphanDocs: orphanDocs.sort(),
      undocumentedComponents: undocumented.sort(),
      unverifiedComponents: unverified.sort(),
    },
    contracts: { inventory: contractInventory.sort((a, b) => (a.path < b.path ? -1 : 1)), unclaimed: unclaimedContracts.sort() },
    observations: staleObservations,
    unclassifiedDependencies: {
      count: unclassified.size,
      sample: [...unclassified].sort().slice(0, 40),
      // A count a human must triage, stated once rather than as one warning per
      // package: 600 rows of the same decision is not information. The code is
      // in ACCEPTABLE_WARNING_CODES so the *triage* can be recorded with pinned
      // evidence once someone has done it — without which no valid acceptance
      // could ever be written, and the code would be decoration.
      code: "AGENTDOC_EXTERNAL_DEPENDENCY_UNCLASSIFIED",
      subject: null,
      message:
        unclassified.size + " third-party dependencies are not classified as external services. " +
        "Add them under discovery.externalDependencies, or confirm they are not architectural. " +
        "Every npm import is not an external service; saying which ones are is a human decision.",
    },
    unresolvedRefs: graph.conflicts.filter((c) => c.status === "unresolved").map((c) => c.subject + " " + c.key),
  };
}

export function scaffoldProposal(repo, cfg, report) {
  const files = [];
  const docCandidates = repo.walk("").filter((f) => DOC_EXT.test(f) && f.split("/").length <= 3).sort();
  files.push({
    path: "agentdoc/agentdoc.config.yaml",
    action: "create",
    why: "the system has no configuration yet; this is the entry point",
  });
  files.push({ path: "agentdoc/journeys.yaml", action: "create-if-used", why: "journeys are the only cross-component narrative the graph cannot derive" });
  files.push({ path: "agentdoc/domains.yaml", action: "scaffold", why: "domains group systems; propose from module names, confirm with a human" });
  files.push({ path: "agentdoc/systems.yaml", action: "scaffold", why: "systems group components with a shared responsibility" });
  files.push({ path: "agentdoc/apis.yaml", action: "scaffold", why: "one API descriptor per canonical contract" });
  files.push({ path: "agentdoc/resources.yaml", action: "scaffold", why: "one Resource per logical database, dataset, bus or queue" });
  for (const d of docCandidates.slice(0, 200)) {
    files.push({ path: d, action: "review", why: "existing documentation must be linked to a component or declared an orphan" });
  }
  return {
    files,
    summary: {
      toCreate: files.filter((f) => f.action === "create").length,
      toScaffold: files.filter((f) => f.action === "scaffold").length,
      toReview: files.filter((f) => f.action === "review").length,
      // `counts` only carries classifications that are actually present, so an
    // absent key means zero, not undefined. Summing the raw keys produced
    // `null` on the flagship migration target — the one number in the
    // proposal that says what must not be authored.
    mustNotBeAuthored: (report.counts.CONFLICT || 0) + (report.counts.UNRESOLVED || 0),
    },
    rule: "only CONFIRMED and DERIVED facts may be written as authored descriptors; OBSERVED facts go to an ObservationSet; CONFLICT and UNRESOLVED stay in the reviewed-ambiguity list",
  };
}

function normaliseName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/(api|service|worker|app|module|package|lib|library)$/g, "");
}

export { expandGlob, isRepoPath };
