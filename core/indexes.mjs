// Typed non-entity indexes: interfaces.events, externalDependencies,
// capabilities, verification, journeys. Nothing here is an entity and nothing
// here may appear as a relation endpoint.
import { CODES, AgentDocError } from "./codes.mjs";
import { contractDefRegex } from "./contracts.mjs";

const classifyContractDef = contractDefRegex;

// A literal like "orders.created.v1" folds into a declared family
// "orders.created.*" when that family is also declared. Folding is
// deterministic and its provenance is rebound to the merged record.
function familyOf(pattern, families) {
  for (const fam of families) {
    const prefix = fam.replace(/\*$/, "").replace(/>$/, "");
    if (prefix && pattern.startsWith(prefix)) return fam;
  }
  return null;
}

export function plausibilityCheck(ctx) {
  const prefixes = ctx.cfg.discovery.eventPatternPrefixes;
  const ok = (p) => {
    if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9._>\*-]*$/.test(p)) return false;
    if (!prefixes || prefixes.length === 0) return true;
    return prefixes.some((pre) => p.startsWith(pre));
  };
  return ok;
}

export function buildIndexes(ctx) {
  const { prov, diagnostics } = ctx;
  const plausible = plausibilityCheck(ctx);
  const events = [];
  const merged = new Map();
  const mergeInto = (pattern, rec) => {
    if (!merged.has(pattern)) merged.set(pattern, { producers: new Set(), consumers: new Set(), provs: new Set(), contract: rec.contract });
    const m = merged.get(pattern);
    if (rec.contract) m.contract = rec.contract;
    for (const x of rec.producers) m.producers.add(x);
    for (const x of rec.consumers) m.consumers.add(x);
    for (const p of rec.provs) m.provs.add(p);
  };
  const raw = [...ctx.events.keys()].filter((p) => plausible(p));
  for (const [p, rec] of ctx.events) {
    if (plausible(p)) continue;
    diagnostics.push({
      severity: "warning",
      code: "AGENTDOC_EVENT_UNRESOLVED",
      subject: p,
      message: "event subject '" + p + "' does not match the configured event subject shape; left out of the interface index",
    });
    // The subject is not in the index, so its evidence must stop claiming to
    // prove it. The warning still surfaces it to a reviewer.
    for (const pr of rec.provs) pr.subjects.delete("evt:" + p);
  }
  const families = new Set(raw.filter((p) => p.endsWith(".*") || p.endsWith(".>")));
  for (const [pattern, rec] of ctx.events) {
    if (!plausible(pattern)) continue;
    const fam = families.has(pattern) ? null : familyOf(pattern, families);
    mergeInto(fam || pattern, rec);
    if (fam) {
      for (const p of rec.provs) {
        if (p.subjects.has("evt:" + pattern)) {
          p.subjects.delete("evt:" + pattern);
          p.subjects.add("evt:" + fam);
        }
      }
    }
  }

  for (const [pattern, rec] of [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const contract = rec.contract;
    if (!contract || !ctx.repo.exists(contract.ref)) {
      diagnostics.push({
        severity: "error",
        code: CODES.EVENT_CONTRACT,
        subject: pattern,
        message: "event pattern '" + pattern + "' has no resolvable canonical contract" + (contract ? ": " + contract.ref : ""),
        paths: contract ? [contract.ref] : [],
      });
      continue;
    }
    const resolution = rec.producers.size > 0 ? "resolved" : "unresolved";
    if (resolution === "unresolved") {
      diagnostics.push({
        severity: "warning",
        code: "AGENTDOC_EVENT_UNRESOLVED",
        subject: pattern,
        refs: [...rec.consumers].sort(),
        message: "event pattern '" + pattern + "' has " + rec.consumers.size + " consumer(s) but no observed producer",
        paths: [contract.ref],
      });
    }
    events.push({
      pattern,
      producers: [...rec.producers].sort(),
      consumers: [...rec.consumers].sort(),
      contract,
      provs: rec.provs,
      resolution,
    });
  }

  const externalDependencies = [...ctx.externals.values()]
    .sort((a, b) => (a.componentRef + "|" + a.name < b.componentRef + "|" + b.name ? -1 : 1))
    .map((r) => ({ componentRef: r.componentRef, name: r.name, role: r.role, mechanism: r.mechanism, evidenceClass: r.evidenceClass, provs: r.provs }));

  const capabilities = [...ctx.capabilities.values()]
    .sort((a, b) => (a.componentRef + "|" + a.name < b.componentRef + "|" + b.name ? -1 : 1))
    .map((r) => ({ componentRef: r.componentRef, name: r.name, evidenceClass: r.evidenceClass, provs: r.provs }));

  const verification = [...ctx.verification.values()]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((v) => ({
      id: v.id,
      componentRefs: [...v.componentRefs].sort(),
      tier: v.tier,
      command: v.command,
      configPaths: [...(v.configPaths || [])].sort(),
      provs: v.provs,
    }));

  const journeys = (ctx.sources.journeys || []).map((j) => ({
    id: j.id,
    description: j.description,
    components: j.components,
    notes: j.notes || null,
    provs: new Set([prov.add("declared", ctx.journeysPath, "journey-extractor", ["jou:" + j.id])]),
  }));

  return { events, externalDependencies, capabilities, verification, journeys };
}

// Every contract file under a configured contract root must be claimed by
// exactly one API descriptor, and no contract may be claimed twice.
export function checkContractCoverage(ctx) {
  const errors = [];
  const claimed = new Map();
  for (const api of ctx.sources.entities.filter((e) => e.kind === "API" && e.doc.spec.contract?.ref)) {
    const cref = api.doc.spec.contract.ref;
    if (claimed.has(cref)) {
      errors.push(new AgentDocError(
        CODES.CONTRACT_SHARED,
        "contract.ref '" + cref + "' is claimed by two APIs: " + claimed.get(cref) + " and " + api.ref,
        { path: api.file, ref: api.ref }
      ));
    }
    claimed.set(cref, api.ref);
  }
  const defRe = classifyContractDef();
  for (const rootDir of ctx.cfg.discovery.contractRoots || []) {
    if (!ctx.repo.isDir(rootDir)) continue;
    for (const f of ctx.repo.walk(rootDir)) {
      if (defRe.test(f) && !claimed.has(f)) {
        errors.push(new AgentDocError(
          CODES.CONTRACT_UNCLAIMED,
          "canonical contract definition '" + f + "' is not referenced by any API contract.ref",
          { path: f }
        ));
      }
    }
  }
  return errors;
}
