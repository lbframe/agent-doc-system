// The canonical compilation pipeline. One code path for validate, compile,
// check, query, impact and audit — locally and in CI. No behaviour depends on
// how it was invoked.
import { AgentDocError, CODES, collect } from "./codes.mjs";
import { Repo, computeInputHash, sha256Hex } from "./fsx.mjs";
import { loadSchemaBundle, loadConfig, loadDescriptors, loadJourneys, loadObservations, loadReviewedOverrides, makeRefs, CONFIG_PATH } from "./descriptors.mjs";
import { discoverUnits, matchComponents } from "./discover.mjs";
import { genericFacts, checkArtifactType } from "./derive.mjs";
import { buildRelations } from "./relations.mjs";
import { buildIndexes, checkContractCoverage } from "./indexes.mjs";
import { ProvRegistry } from "./provenance.mjs";
import { ingestObservations } from "./observations.mjs";
import { FactStore } from "./facts.mjs";
import { AuthorityEngine, resolveAssertions } from "./authority/engine.mjs";
import { PROV_TO_EVIDENCE } from "./authority/classes.mjs";
import { redactCommand } from "./secrets.mjs";
import { formatErrors } from "./jsonschema.mjs";
import { validateContractFile } from "./contracts.mjs";
import { sourceFiles, importSpecifiers } from "./sourcescan.mjs";
import { applyWarningAcceptances } from "./acceptances.mjs";
import { loadAdapters } from "../adapters/index.mjs";
import {
  COMPILER_NAME, COMPILER_VERSION, GRAPH_SCHEMA_VERSION,
  assembleGraph, serializeGraph, finalizeSerialization, subjectResolver,
} from "./graph.mjs";

export const ADAPTER_VERSION_INPUT_PREFIX = "adapter:";

export class CompileResult {
  constructor() {
    this.errors = [];
    this.diagnostics = [];
    this.graph = null;
    this.serialized = null;
    this.stats = {};
    this.ctx = null;
  }
}

function earlyOut(res, extra = {}) {
  res.stats = { ...(res.stats || {}), ...extra };
  return res;
}

export function compile(root, opts = {}) {
  const res = new CompileResult();
  // A peek load, only to read the generated-directory list: a project that keeps
  // build output in a directory this build does not know about must be able to
  // say so.
  let cfgGeneratedDirs = opts.generatedDirs;
  try {
    const peek = loadConfig(new Repo(root, { noGit: true }), loadSchemaBundle().bundle);
    if (Array.isArray(peek.discovery.generatedDirs)) cfgGeneratedDirs = peek.discovery.generatedDirs;
  } catch {
    // No configuration, or an invalid one: the real load below reports it.
  }
  const repo = new Repo(root, { noGit: opts.noGit, generatedDirs: cfgGeneratedDirs });
  let bundle;
  let schemaInputs;
  try {
    ({ bundle, versionInputs: schemaInputs } = loadSchemaBundle());
  } catch (e) {
    if (e instanceof AgentDocError) { res.errors.push(e); return earlyOut(res, {}); }
    throw e;
  }
  let cfg;
  try {
    cfg = loadConfig(repo, bundle);
  } catch (e) {
    // A configuration error is reported like any other, so `validate` gives a
    // complete picture instead of dying on the first bad key.
    if (e instanceof AgentDocError) { res.errors.push(e); return earlyOut(res, {}); }
    throw e;
  }
  // Exposed even when the compile later fails: `scaffold` needs the
  // configuration and repo handle precisely in the not-yet-compiling state —
  // a coverage failure is what scaffolding exists to fix.
  res.repo = repo;
  res.cfg = cfg;
  const refs = makeRefs(cfg.namespace);
  const graphPath = cfg.output.graph;

  const sources = loadDescriptors(repo, cfg, bundle, refs);
  res.errors.push(...sources.errors);

  const journeys = loadJourneys(repo, cfg, bundle, sources.byRef);
  res.errors.push(...journeys.errors);

  const observations = loadObservations(repo, cfg, bundle, sources.byRef);
  res.errors.push(...observations.errors);

  const overrides = loadReviewedOverrides(repo, cfg, refs, sources.byRef);
  res.errors.push(...overrides.errors);

  // The review record attached to every REVIEWED_OVERRIDE fact. The reviewer and
  // the date are deliberately not typed in: they are the commit that changed the
  // configuration carrying this record, which is stronger evidence than a string.
  //
  // `reviewWhen` is authorable and required, not defaulted. A fixed string here
  // would be the same sentence on every override, which is a review condition
  // that conditions nothing — and it would be reported as though it were real.
  //
  // The evidence digests are re-verified on every compile. A REVIEWED_OVERRIDE is
  // the highest-authority input the model accepts, and the only thing that can
  // falsify it is the evidence it cites. If that evidence is rewritten or deleted
  // and the override survives, the graph ships a digest that no longer matches any
  // file, and a stale human judgement is silently promoted to fact. This mirrors
  // what `acceptances.mjs` already does for accepted warnings.
  // The digests were verified against the pinned values in
  // `loadReviewedOverrides`, so the record carried into the graph is the
  // author's, already known to be current.
  const reviewed = (o) => ({
    reason: o.reason,
    reviewWhen: o.reviewWhen,
    evidence: o.evidence.map((ev) => ({ path: ev.path, sha256: ev.sha256 })),
  });

  res.errors.push(...checkContractCoverage({ repo, cfg, sources }));

  for (const api of sources.entities.filter((e) => e.kind === "API")) {
    collect(() => validateContractFile(repo, bundle, api), res.errors);
  }
  res.errors.push(...validateOidcProviders({ repo, sources, discovery: null }));

  if (res.errors.length) {
    return earlyOut(res, { entities: sources.entities.length });
  }

  let adapters;
  try {
    adapters = loadAdapters(cfg.adapters || []);
  } catch (e) {
    if (e instanceof AgentDocError) {
      res.errors.push(e);
      return earlyOut(res, { entities: sources.entities.length });
    }
    throw e;
  }
  const discovery = discoverUnits(repo, cfg, adapters);
  // Eligibility is the compiler's own answer to "which directories are units" —
  // exposed on the result so scaffold can write descriptors for exactly these
  // roots rather than re-deriving them from filesystem markers.
  res.discovery = discovery;
  const match = matchComponents(discovery.eligible, sources.entities.filter((e) => e.kind === "Component"));
  res.errors.push(...match.errors);

  // OIDC discovery must be exposed by the provider's own source. Re-check now
  // that component -> unit bindings are known.
  res.errors.push(...validateOidcProviders({ repo, sources, discovery }));

  if (res.errors.length) {
    return earlyOut(res, { entities: sources.entities.length, units: discovery.eligible.length });
  }

  const prov = new ProvRegistry(repo);
  const diagnostics = [];
  const facts = new FactStore();
  const edges = [];
  const events = new Map();
  const externals = new Map();
  const capabilities = new Map();
  const verification = new Map();

  const ctx = {
    repo, cfg, refs, bundle, prov, diagnostics, facts,
    sources: { ...sources, journeys: journeys.journeys }, discovery, journeys: journeys.journeys, journeysPath: journeys.path,
    observations, overrides: overrides.overrides,
    edges, events, externals, capabilities, verification,
    errors: [],
    unitByComponent: new Map(),
    secondPasses: [],
  };
  ctx.errors = res.errors;

  const addEdge = (type, sourceRef, targetRef, attributes, provRecs, evidenceClass) => {
    const key = type + "|" + sourceRef + "|" + targetRef + "|" + JSON.stringify(attributes || {});
    let e = edges.find((x) => x.key === key);
    if (!e) {
      e = { key, type, sourceRef, targetRef, attributes: attributes || {}, provs: new Set(), evidenceClass: evidenceClass || "DERIVED" };
      edges.push(e);
    }
    for (const p of provRecs) if (p) e.provs.add(p);
    if (evidenceClass === "REVIEWED_OVERRIDE") e.evidenceClass = "REVIEWED_OVERRIDE";
    return e;
  };
  const addEvent = (pattern, role, compRef, provRec, contract) => {
    if (!events.has(pattern)) events.set(pattern, { producers: new Set(), consumers: new Set(), provs: new Set(), contract: contract || null });
    const ev = events.get(pattern);
    if (role === "producer") ev.producers.add(compRef);
    else ev.consumers.add(compRef);
    if (contract) ev.contract = contract;
    if (provRec) ev.provs.add(provRec);
  };
  const addExternal = (compRef, name, mechanism, role, provRec, evidenceClass) => {
    const key = compRef + "|" + name;
    if (!externals.has(key)) {
      externals.set(key, { componentRef: compRef, name, mechanism, role, evidenceClass: evidenceClass || "DERIVED", provs: new Set() });
    }
    externals.get(key).provs.add(provRec);
  };
  const addCapability = (compRef, name, provRec, evidenceClass) => {
    const key = compRef + "|" + name;
    if (!capabilities.has(key)) {
      capabilities.set(key, { componentRef: compRef, name, evidenceClass: evidenceClass || "DERIVED", provs: new Set() });
    }
    capabilities.get(key).provs.add(provRec);
  };
  const addVerification = (v) => {
    if (!v.componentRefs || v.componentRefs.length === 0) return;
    // A verification command is a routing index, not a credential transport.
    v = { ...v, command: redactCommand(String(v.command || "").trim()).slice(0, 600) };
    if (!verification.has(v.id)) verification.set(v.id, { ...v, provs: new Set(), componentRefs: new Set(v.componentRefs) });
    const cur = verification.get(v.id);
    for (const p of v.provRecs || []) cur.provs.add(p);
    for (const r of v.componentRefs) cur.componentRefs.add(r);
  };
  const gates = new Map();
  const addGate = (g) => {
    g = { ...g, command: redactCommand(String(g.command || "").trim()).slice(0, 600) };
    if (!gates.has(g.id)) gates.set(g.id, { ...g, provs: new Set() });
    for (const p of g.provRecs || []) gates.get(g.id).provs.add(p);
  };
  ctx.addEdge = addEdge;
  ctx.addEvent = addEvent;
  ctx.addExternal = addExternal;
  ctx.addCapability = addCapability;
  ctx.addVerification = addVerification;
  ctx.addGate = addGate;
  ctx.gates = gates;
  ctx.deferSecondPass = (fn) => ctx.secondPasses.push(fn);
  ctx.unitForRoot = (root) => discovery.units.find((u) => u.root === root);
  ctx.primaryEventContract = () => {
    const ec = (cfg.discovery.eventContracts || [])[0];
    if (!ec) return null;
    return { format: ec.format === "code" ? "code" : "declared-catalog", ref: ec.path };
  };
  ctx.addFact = (subject, key, value, opts) => facts.add({ subject, key, value, ...opts });

  // External-service classification is declared, never inferred. Compiled once
  // so every adapter sees the same matchers in the same order.
  const externalMatchers = ((cfg.discovery.externalDependencies || []).map((x) => {
    let re;
    try {
      re = new RegExp(x.match);
    } catch {
      throw new AgentDocError(CODES.CONFIG, "external dependency pattern is not a valid regular expression: " + x.match);
    }
    return { re, name: x.name, mechanism: x.mechanism, role: x.role, resourceType: x.resourceType || null };
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  ctx.externalMatchers = () => externalMatchers;

  // The declared client name that owns a Resource of the given type, when exactly
  // one does.
  //
  // A component depending on a `redis` client can reach one Resource two ways: a
  // `cache-client` route that spots the import, and a `declared-client` route
  // that matches the configured external dependency. Those are the same
  // dependency. When only the declared route carried `client`, the two had
  // different identities and never merged, so one dependency shipped as two
  // edges — the very duplication the identity rule exists to prevent.
  //
  // Keyed on the Resource's type rather than on a package name, because the
  // mechanism adapters detect by pattern over file *text* and have no package
  // name to match against. Returns undefined when the type is unclaimed or
  // ambiguous, and the mechanism edge then stands alone rather than guessing.
  ctx.clientKeyForResourceType = (resourceType) => {
    if (!resourceType) return undefined;
    const claims = externalMatchers.filter((x) => x.resourceType === resourceType);
    return claims.length === 1 ? claims[0].name : undefined;
  };

  // ── manifest pre-pass: identify each unit's package / module namespace ────
  // Done before extraction so cross-unit resolution never depends on the order
  // in which units happen to be processed.
  for (const unit of discovery.eligible) {
    const pkgPath = unit.root + "/package.json";
    if (repo.exists(pkgPath)) {
      try {
        const pkg = repo.readJson(pkgPath);
        unit.pkgName = typeof pkg.name === "string" ? pkg.name : null;
        unit.pkg = pkg;
      } catch {
        res.errors.push(new AgentDocError(CODES.SCHEMA, "package.json is not valid JSON: " + pkgPath, { path: pkgPath }));
      }
    }
    const gomodPath = unit.root + "/go.mod";
    if (repo.exists(gomodPath)) {
      const m = /^module\s+(\S+)/m.exec(repo.readText(gomodPath));
      unit.goModule = m ? m[1] : null;
    }
  }
  const unitByPkgName = new Map();
  const unitByGoModule = new Map();
  for (const unit of discovery.eligible) {
    if (unit.pkgName && !unitByPkgName.has(unit.pkgName)) unitByPkgName.set(unit.pkgName, unit);
    if (unit.goModule && !unitByGoModule.has(unit.goModule)) unitByGoModule.set(unit.goModule, unit);
  }
  ctx.unitByPkgName = unitByPkgName;
  ctx.unitByGoModule = unitByGoModule;

  // Manifest-declared unit dependencies, computed before any adapter runs so
  // that cross-unit reasoning never depends on adapter execution order.
  // Production dependency names per unit, so a "depends on this service" rule
  // matches a dependency name rather than a blob of source.
  const productionDependencies = new Map();
  const dependencyMap = new Map();
  for (const unit of discovery.eligible) {
    if (!unit.component) continue;
    const deps = new Set();
    const pkg = unit.pkg || {};
    productionDependencies.set(unit.component.ref, [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);
    for (const d of [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]) {
      const t = unitByPkgName.get(d);
      if (t && t.component && t.component.ref !== unit.component.ref) deps.add(t.component.ref);
    }
    if (unit.goModule) {
      const gomod = repo.exists(unit.root + "/go.mod") ? repo.readText(unit.root + "/go.mod") : "";
      const goReqs = [...gomod.matchAll(/^\s*(?:require\s+)?([a-z0-9.]+\.[a-z0-9./-]+)\s+v[0-9]/gm)].map((m) => m[1]);
      productionDependencies.set(unit.component.ref, [...(productionDependencies.get(unit.component.ref) || []), ...goReqs]);
      for (const m of gomod.matchAll(/^\s*(?:require\s+)?([a-z0-9.]+\.[a-z0-9./-]+)\s+v[0-9]/gm)) {
        const t = unitByGoModule.get(m[1]);
        if (t && t.component && t.component.ref !== unit.component.ref) deps.add(t.component.ref);
      }
    }
    dependencyMap.set(unit.component.ref, deps);
  }
  ctx.dependencyMap = dependencyMap;
  ctx.productionDependencies = (ref) => productionDependencies.get(ref) || [];
  ctx.transitiveDependencies = (ref) => {
    const out = new Set([ref]);
    const stack = [ref];
    while (stack.length) {
      const cur = stack.pop();
      for (const d of dependencyMap.get(cur) || []) {
        if (!out.has(d)) { out.add(d); stack.push(d); }
      }
    }
    return out;
  };

  // ── cross-unit import index (language-neutral scan, adapter-specific use) ─
  const importIndex = buildImportIndex(repo, discovery);
  ctx.importIndex = importIndex;

  // ── per-unit derivation ──────────────────────────────────────────────────
  const derivedMap = new Map();
  for (const unit of discovery.eligible) {
    const comp = unit.component;
    if (!comp) continue;
    const compRef = comp.ref;
    ctx.unitByComponent.set(compRef, unit);
    const unitCtx = {
      ...ctx,
      compRef,
      unitImports: importIndex.byUnit.get(unit) || new Map(),
      descriptorPath: () => comp.file,
      componentEntity: () => comp,
    };
    const d = genericFacts(unitCtx, unit);
    for (const a of adapters) {
      if (a.extract) {
        try {
          const extra = a.extract(unitCtx, unit) || {};
          mergeDerived(d, extra);
        } catch (e) {
          if (e instanceof AgentDocError) res.errors.push(e);
          else throw e;
        }
      }
    }
    d.runtimes = [...(d.runtimes || new Set())].sort();
    d.languages = [...(d.languages || new Set())].sort();
    derivedMap.set(compRef, d);
    diagnostics.push(...checkArtifactType(comp, unit));
    // Authored-field provenance for every entity, not just components.
    prov.add("declared", comp.file, "descriptor-reader", [
      "ent:" + compRef, "entf:" + compRef + ":/apiVersion", "entf:" + compRef + ":/kind",
      "entf:" + compRef + ":/metadata", "entf:" + compRef + ":/metadata/name",
      "entf:" + compRef + ":/metadata/description", "entf:" + compRef + ":/spec",
    ]);
  }
  for (const e of sources.entities) {
    if (e.kind === "Component") continue;
    const subjects = [
      "ent:" + e.ref, "entf:" + e.ref + ":/apiVersion", "entf:" + e.ref + ":/kind",
      "entf:" + e.ref + ":/metadata", "entf:" + e.ref + ":/metadata/name",
      "entf:" + e.ref + ":/metadata/description",
    ];
    if (e.doc.spec !== undefined) subjects.push("entf:" + e.ref + ":/spec");
    prov.add("declared", e.file, "descriptor-reader", subjects);
  }

  // ── contract adapters run once, after every unit is known ───────────────
  const contractOut = [];
  ctx.addContract = (rec) => {
    if (!rec || !rec.apiRef || !rec.ref) return;
    // A contract entry is a pointer, but the pointer itself is a claim about the
    // repository and is corroborated by the file it names.
    contractOut.push({ ...rec, provs: new Set([prov.add("observed", rec.ref, "contract-extractor", ["ctr:" + rec.apiRef])]) });
  };
  for (const a of adapters) {
    if (!a.contracts) continue;
    try {
      a.contracts(ctx);
    } catch (e) {
      if (e instanceof AgentDocError) res.errors.push(e);
      else throw e;
    }
  }
  for (const e of ctx.errors) if (!res.errors.includes(e)) res.errors.push(new AgentDocError(e.code, e.message, { path: e.path }));

  // ── second pass: cross-unit resolutions that need the full picture ──────
  const byPlatformName = new Map();
  for (const u of discovery.eligible) if (u.platformName) byPlatformName.set(u.platformName, u);
  for (const fn of ctx.secondPasses) {
    try {
      fn({ byPlatformName });
    } catch (e) {
      if (e instanceof AgentDocError) res.errors.push(e);
      else throw e;
    }
  }

  // ── authored placement facts ─────────────────────────────────────────────
  for (const e of sources.entities) {
    const spec = e.doc.spec || {};
    const mk = () => prov.add("declared", e.file, "placement-extractor", ["ass:pending"]);
    if ((e.kind === "Component" || e.kind === "System") && spec.domain) {
      facts.add({ subject: e.ref, key: "placement.domain", value: spec.domain, evidenceClass: "AUTHORED", confidence: "declared", provRecs: [mk()] });
    }
    if ((e.kind === "Component" || e.kind === "Resource") && spec.system) {
      facts.add({ subject: e.ref, key: "placement.system", value: spec.system, evidenceClass: "AUTHORED", confidence: "declared", provRecs: [mk()] });
    }
  }

  // ── reviewed overrides → relations and facts ─────────────────────────────
  const overrideEdges = [];
  for (const o of overrides.overrides) {
    // Which pending subject the evidence must resolve to depends on whether
    // this override produces a relation or a fact.
    const producesRelation = o.fact === "runtime-call" || o.fact === "api-consumer" || o.fact === "external-dependency-role";
    const subject = producesRelation ? "rel:pending" : "ass:pending";
    const provs = [
      ...o.evidence.map((ev) => prov.add("declared", ev.path, "override-extractor", [subject])),
      prov.add("reviewed", CONFIG_PATH, "override-extractor", [subject]),
    ];
    if (o.fact === "runtime-call") {
      const attrs = { transport: o.transport, contractRef: o.contractRef };
      if (o.deliverySemantics) attrs.deliverySemantics = o.deliverySemantics;
      overrideEdges.push({ type: "runtimeCalls", sourceRef: o.subject, targetRef: o.target, attributes: attrs, provs });
      facts.add({
        subject: o.subject, key: "runtime-call." + String(o.target).split("/")[1], value: attrs,
        evidenceClass: "REVIEWED_OVERRIDE", confidence: "reviewed", provRecs: provs,
        semantics: o.reason,
        review: reviewed(o),
      });
    } else if (o.fact === "api-consumer") {
      overrideEdges.push({ type: "consumesApi", sourceRef: o.subject, targetRef: o.target, attributes: { via: "reviewed-override" }, provs });
      facts.add({
        subject: o.subject, key: "api-consumer." + String(o.target).split("/")[1], value: String(o.target),
        evidenceClass: "REVIEWED_OVERRIDE", confidence: "reviewed", provRecs: provs, semantics: o.reason,
        review: reviewed(o),
      });
    } else if (o.fact === "external-dependency-role") {
      const rec = externals.get(o.subject + "|" + o.target);
      if (!rec) {
        res.errors.push(new AgentDocError(
          CODES.RELATION_KIND,
          "external-dependency-role override targets no observed external dependency: " + o.subject + " -> " + o.target,
          { path: CONFIG_PATH, ref: o.subject }
        ));
      } else {
        rec.role = o.role;
        rec.evidenceClass = "REVIEWED_OVERRIDE";
        for (const p of provs) rec.provs.add(p);
        facts.add({
          subject: o.subject, key: "external-role." + o.target, value: o.role,
          evidenceClass: "REVIEWED_OVERRIDE", confidence: "reviewed", provRecs: provs, semantics: o.reason,
          review: reviewed(o),
        });
      }
    } else if (o.fact === "binding") {
      facts.add({
        subject: o.subject, key: "binding.kind", value: o.kind,
        evidenceClass: "REVIEWED_OVERRIDE", confidence: "reviewed", provRecs: provs,
        semantics: o.reason,
        review: reviewed(o),
      });
    } else if (o.fact === "capability") {
      addCapability(o.subject, o.kind, provs[0], "REVIEWED_OVERRIDE");
      facts.add({
        subject: o.subject, key: "capability." + o.kind, value: true,
        evidenceClass: "REVIEWED_OVERRIDE", confidence: "reviewed", provRecs: provs, semantics: o.reason,
        review: reviewed(o),
      });
    } else if (o.fact === "event-producer" || o.fact === "event-consumer") {
      addEvent(o.eventPattern, o.fact === "event-producer" ? "producer" : "consumer", o.subject, provs[0], ctx.primaryEventContract());
      facts.add({
        subject: o.subject, key: "event-role." + o.eventPattern, value: o.fact === "event-producer" ? "producer" : "consumer",
        evidenceClass: "REVIEWED_OVERRIDE", confidence: "reviewed", provRecs: provs, semantics: o.reason,
        review: reviewed(o),
      });
    } else if (o.fact === "component-placement") {
      const key = o.system ? "placement.system" : "placement.domain";
      facts.add({
        subject: o.subject, key, value: o.system || o.domain,
        evidenceClass: "REVIEWED_OVERRIDE", confidence: "reviewed", provRecs: provs,
        semantics: o.reason,
        review: reviewed(o),
      });
    }
  }
  ctx.overrideEdges = overrideEdges;

  // ── observations → OBSERVED_RUNTIME facts ────────────────────────────────
  const observationOut = ingestObservations(ctx);

  // ── authority resolution ─────────────────────────────────────────────────
  const authority = new AuthorityEngine(cfg.authority.rules);

  // Supersession is applied before election: an observation that a later set
  // explicitly replaces does not compete for the election, though it stays in
  // the graph as history.
  // Keyed on capturedAt+environment: batch captures across environments can
  // share a timestamp, and a timestamp-only key would mark the wrong set's
  // facts superseded.
  const supersededAt = new Set();
  for (const o of observationOut) {
    if (o.supersedes) {
      const prior = observationOut.find((x) => x.id === o.supersedes);
      if (prior) supersededAt.add(prior.capturedAt + " " + prior.environment);
    }
  }
  for (const f of facts.facts) {
    if (f.evidenceClass !== "OBSERVED_RUNTIME") continue;
    const fo = f.observed;
    if (!fo || !supersededAt.has(fo.at + " " + fo.environment)) continue;
    f.status = "superseded";
    // Supersession is a claim a human made, so it is a reviewable claim. Silence
    // would let any observation quietly void any other: the code is in
    // ACCEPTABLE_WARNING_CODES precisely so the disposition can be recorded
    // against pinned evidence rather than left implicit.
    diagnostics.push({
      severity: "warning",
      code: "AGENTDOC_OBSERVATION_SUPERSEDED",
      subject: f.subject,
      refs: [f.subject],
      message:
        "runtime observation captured " + (f.observed && f.observed.at) + " was superseded by a later capture " +
        "and no longer competes for the election. It remains in the graph as history. " +
        "Confirm the superseding capture really replaces it.",
    });
  }

  const { conflicts: rawConflicts } = resolveAssertions(facts.facts, authority);
  pushConflictDiagnostics(rawConflicts, diagnostics, facts);

  // ── relations ────────────────────────────────────────────────────────────
  const rel = buildRelations(ctx);
  res.errors.push(...rel.errors);

  // A monorepo task graph and a package script often cover the same tier. Two
  // runnable commands for one check is duplication an agent has to read past, so
  // the preference is explicit and the loser is dropped with its provenance.
  const pref = cfg.discovery.verificationPreference || "task-graph";
  if (pref !== "both") {
    const taskGraphTiers = new Set();
    for (const id of verification.keys()) {
      if (!id.startsWith("tg:")) continue;
      const v = verification.get(id);
      for (const r of v.componentRefs) taskGraphTiers.add(r + "|" + v.tier);
    }
    for (const [id, v] of [...verification.entries()]) {
      if (id.startsWith("tg:") || id.startsWith("ci:")) continue;
      const shadowed = [...v.componentRefs].some((r) => taskGraphTiers.has(r + "|" + v.tier));
      if (!shadowed) continue;
      verification.delete(id);
      // The dropped entry's evidence must stop claiming to prove it, or the
      // provenance record would point at a verification entry that no longer
      // exists.
      for (const p of v.provs) p.subjects.delete("ver:" + id);
    }
  }

  const indexes = buildIndexes(ctx);
  indexes.gates = [...gates.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((g) => ({ id: g.id, tier: g.tier, command: g.command, configPaths: [...(g.configPaths || [])].sort(), provs: g.provs }));
  indexes.contracts = contractOut.slice().sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  res.errors.push(...applyWarningAcceptances(repo, cfg.warningAcceptances || [], diagnostics));

  // Bind pending provenance subjects now that indices exist.
  rel.relations.forEach((r) => {
    const key = r.type + "|" + r.sourceRef + "|" + r.targetRef + "|" + JSON.stringify(r.attributes || {});
    for (const p of r.provs) {
      p.subjects.delete("rel:pending");
      p.subjects.add("rel:" + key);
    }
  });
  for (const f of facts.facts) {
    for (const p of f.provRecs) {
      p.subjects.delete("ass:pending");
      p.subjects.add("ass:" + f.id);
    }
  }
  // Safety net: evidence whose candidate edge or fact was dropped (an
  // unresolved override, a rejected candidate) legitimately has no subject.
  // Records that end up proving nothing are removed rather than left dangling,
  // and the count is reported so a regression here is visible.
  let droppedProvenance = 0;
  for (let i = prov.records.length - 1; i >= 0; i--) {
    const rec = prov.records[i];
    rec.subjects.delete("rel:pending");
    rec.subjects.delete("ass:pending");
    if (rec.subjects.size === 0) {
      prov.records.splice(i, 1);
      droppedProvenance++;
    }
  }

  // error-severity diagnostics block publication
  for (const dg of diagnostics) {
    if (dg.severity === "error") res.errors.push(new AgentDocError(dg.code, dg.message, { path: dg.paths?.[0], ref: dg.refs?.[0] }));
  }
  if (res.errors.length) {
    return earlyOut(res, { entities: sources.entities.length, units: discovery.eligible.length });
  }

  diagnostics.sort((a, b) => {
    const ka = a.severity + "|" + a.code + "|" + (a.paths?.[0] || "") + "|" + a.message;
    const kb = b.severity + "|" + b.code + "|" + (b.paths?.[0] || "") + "|" + b.message;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Nested provenance (bindings/health) needs the finalized ids.
  const skeleton = assembleGraph(sources, rel, indexes, derivedMap, facts, rawConflicts, observationOut, { idOf: new Map(), list: [] }, diagnostics);
  let provFinal;
  try {
    provFinal = prov.finalize(subjectResolver(skeleton));
  } catch (e) {
    res.errors.push(e instanceof AgentDocError ? e : new AgentDocError(CODES.PROVENANCE, e.message));
    return earlyOut(res, { entities: sources.entities.length, units: discovery.eligible.length });
  }
  for (const d of derivedMap.values()) {
    for (const list of [d.bindings || [], d.healthContracts || []]) {
      for (const b of list) {
        b.provenanceIds = [...(b._provs || [])].map((p) => provFinal.idOf.get(p)).filter(Boolean).sort();
        delete b._provs;
      }
    }
  }

  const graph = assembleGraph(sources, rel, indexes, derivedMap, facts, rawConflicts, observationOut, provFinal, diagnostics);
  graph.compiler = { name: COMPILER_NAME, version: COMPILER_VERSION, adapters: adapterStamp(adapters) };

  const commit = repo.headCommit();
  const inputHash = computeInputHash(repo, [
    COMPILER_NAME + "@" + COMPILER_VERSION,
    GRAPH_SCHEMA_VERSION,
    "agentdoc.dev/v1",
    "authority-rules@" + cfg.authority.rules.length,
    ...schemaInputs,
    ...adapters.map((a) => ADAPTER_VERSION_INPUT_PREFIX + a.name + "@" + a.version),
  ]);
  const dirtySet = new Set(repo.dirtyPaths().filter((p) => p !== graphPath));
  const walkedDirs = [...repo.walks.keys()];
  const dirty = [...dirtySet].some(
    (p) =>
      repo.readPaths.has(p) ||
      repo.probes.has(p) ||
      repo.listings.has(p) ||
      walkedDirs.some((d) => (d === "." ? true : p === d || p.startsWith(d + "/")))
  );
  graph.source = { commit, dirty, inputHash };

  const gv = bundle.validator("agentdoc.dev/schema/graph.schema.json");
  const gerrs = gv.validate(graph);
  if (gerrs) {
    res.errors.push(new AgentDocError(
      CODES.GRAPH_SCHEMA,
      "compiled graph violates the graph schema — compiler defect: " + formatErrors(gerrs)
    ));
    return earlyOut(res, { entities: sources.entities.length, units: discovery.eligible.length });
  }

  let serialized;
  try {
    serialized = finalizeSerialization(serializeGraph(graph), graph, {
      // Only timestamps the compiler read out of a committed ObservationSet may
      // appear. This is what keeps compilation a pure function of the checkout.
      allowedTimestamps: observationOut.map((o) => o.capturedAt),
    });
  } catch (e) {
    res.errors.push(e instanceof AgentDocError ? e : new AgentDocError(CODES.NONDETERMINISTIC, e.message));
    return earlyOut(res, { entities: sources.entities.length, units: discovery.eligible.length });
  }

  res.graph = graph;
  res.serialized = serialized;
  res.diagnostics = diagnostics;
  res.graphPath = graphPath;
  res.sources = sources;
  res.indexes = indexes;
  res.facts = facts;
  res.conflicts = graph.conflicts;
  res.stats = {
    entities: graph.entities.length,
    components: graph.entities.filter((e) => e.kind === "Component").length,
    relations: graph.relations.length,
    events: graph.interfaces.events.length,
    externals: graph.externalDependencies.length,
    capabilities: graph.capabilities.length,
    verification: graph.verification.length,
    journeys: graph.journeys.length,
    assertions: graph.assertions.length,
    conflicts: graph.conflicts.length,
    unresolvedConflicts: graph.conflicts.filter((c) => c.status === "unresolved").length,
    observations: graph.observations.length,
    provenance: graph.provenance.length,
    units: discovery.eligible.length,
    acceptedWarnings: diagnostics.filter((d) => d.severity === "warning" && d.acceptance).length,
    unacceptedWarnings: diagnostics.filter((d) => d.severity === "warning" && !d.acceptance).length,
    droppedProvenance,
    inputHash,
    commit,
    dirty,
  };
  return res;
}

// A contradiction that no authority rule can settle is an error: the system
// refuses to route an agent onto a subject whose facts disagree. A divergence
// that a rule or a reviewed override *does* settle is a warning, acceptable
// with review, so the divergence stays visible in the graph either way.
// The review record attached to every REVIEWED_OVERRIDE fact. The reviewer and
// the date are deliberately not typed in: they are the commit that changed the
// configuration carrying this record, which is stronger evidence than a string.
// degradeOnStale is deliberately NOT applied here: a rule's answer to "what
// does a stale election mean" depends on the wall clock, and a compile must be
// a pure function of the checkout. Degradation is evaluated at gate time, in
// the same place observation freshness itself is enforced (see the CLI's
// freshness gate). Serializing a day-count or a degraded status into the graph
// would make identical inputs compile to different bytes on different days.
function pushConflictDiagnostics(rawConflicts, diagnostics, facts) {
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  for (const c of rawConflicts) {
    const values = c.assertionIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((f) => f.evidenceClass + "=" + JSON.stringify(f.value))
      .sort();
    const detail = c.subject + " " + c.key + ": " + values.join(" vs ");
    if (c.kind === "ambiguity" && c.status === "unresolved") {
      diagnostics.push({
        severity: "warning",
        code: CODES.UNRESOLVED_FACT,
        subject: c.subject,
        refs: [c.subject],
        message:
          "unresolved fact — " + detail + ". " + (c.election.rationale || "") +
          ". Author the owning entity, add a reviewed override, or accept with review.",
      });
      continue;
    }
    if (c.status === "unresolved") {
      diagnostics.push({
        severity: "error",
        code: CODES.CONFLICT_UNRESOLVED,
        subject: c.subject,
        refs: [c.subject],
        message:
          "unresolved " + c.kind + " — " + detail + ". " +
          (c.election.rationale || "no authority rule governs this fact") +
          ". Add an authority rule and, if deterministic discovery cannot settle it, a reviewed override.",
      });
    } else {
      diagnostics.push({
        severity: "warning",
        code: "AGENTDOC_CONFLICT_REVIEWED",
        subject: c.subject,
        refs: [c.subject],
        message:
          c.kind + " — " + detail + ". " +
          (c.election.elected
            ? "elected " + c.election.elected.evidenceClass + " via " + c.election.basis + " (rule " + c.election.ruleId + ")"
            : "not elected") +
          ". The contradicted value remains in the graph.",
      });
    }
  }
}

// A Go import is either host.tld/owner/repo/path or host.tld/owner/repo. The
// second form is what a Go *workspace* member uses, and it has only two dots —
// a pattern that requires three silently loses every workspace-only dependency.
const GO_IMPORT_RE = /["`]([a-z0-9]+\.[a-z0-9.-]+\/[a-z0-9./_-]+|[a-z0-9]+\.[a-z0-9]+\.[a-z0-9./-]+)["`]/g;

// Language-neutral scan of every unit's production sources, indexing the
// external specifiers each file mentions. Adapters decide which of those
// specifiers are sibling units and what kind of relation that implies.
function buildImportIndex(repo, discovery) {
  const byUnit = new Map();
  const goPathsByUnit = new Map();
  for (const unit of discovery.eligible) {
    const map = new Map();
    const goPaths = new Set();
    for (const f of sourceFiles(repo, unit.root, { test: false })) {
      const specifiers = importSpecifiers(repo.readText(f));
      for (const s of specifiers) {
        if (!map.has(s)) map.set(s, new Set());
        map.get(s).add(f);
      }
      if (unit.goModule) {
        const text = repo.readText(f);
        // Every module-shaped import is recorded, not only those under the
        // unit's own module: a Go workspace member can be depended on purely by
        // importing it, with no require line at all.
        for (const m of text.matchAll(GO_IMPORT_RE) ) goPaths.add(m[1]);
      }
    }
    byUnit.set(unit, map);
    goPathsByUnit.set(unit, goPaths);
  }
  return { byUnit, goPathsByUnit };
}

function mergeDerived(target, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v instanceof Set) {
      target[k] = target[k] instanceof Set ? new Set([...target[k], ...v]) : new Set(v);
    } else if (Array.isArray(v)) {
      target[k] = (target[k] || []).concat(v);
    } else if (v && typeof v === "object") {
      target[k] = { ...(target[k] || {}), ...v };
    } else if (v !== undefined && v !== null) {
      target[k] = v;
    }
  }
}

function adapterStamp(adapters) {
  return adapters
    .map((a) => ({ name: a.name, version: a.version }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function validateOidcProviders({ repo, sources, discovery }) {
  const errors = [];
  for (const api of sources.entities.filter((e) => e.kind === "API" && e.doc.spec.type === "oidc")) {
    const dp = api.doc.spec.contract.discoveryPath;
    const provider = sources.byRef.get(api.doc.spec.provider);
    const unit = discovery && discovery.eligible.find((x) => x.component === provider);
    if (!provider) continue;
    const roots = unit ? [unit.root] : [dirOf(provider.file)];
    let found = false;
    for (const root of roots) {
      for (const f of repo.walk(root)) {
        if (!/\.(ts|tsx|js|mjs|jsx|py|go|rb|java|kt|rs)$/.test(f)) continue;
        if (/(^|\/)(test|tests|__tests__)\//.test(f) || /\.(test|spec)\./.test(f)) continue;
        if (repo.readText(f).includes(dp)) { found = true; break; }
      }
      if (found) break;
    }
    if (!found) {
      errors.push(new AgentDocError(
        CODES.OIDC_DISCOVERY,
        "provider " + api.doc.spec.provider + " does not expose discovery path '" + dp + "' anywhere in its source",
        { path: api.file, ref: api.ref }
      ));
    }
  }
  return errors;
}

function dirOf(p) { return p.split("/").slice(0, -1).join("/") || "."; }

export { redactCommand, PROV_TO_EVIDENCE, sha256Hex };
