// Relation materialisation.
//
// No relation is ever authored. Placement comes from authored placement fields,
// provider edges from the API descriptor, everything else from deterministic
// extractors or bounded reviewed overrides. Inversions are generated, the kind
// pair is validated, and duplicates merge their provenance instead of forking
// the graph.
import { CODES, AgentDocError } from "./codes.mjs";
import { PROV_TO_EVIDENCE } from "./authority/classes.mjs";

export const INVERSE = Object.freeze({
  partOf: "hasPart",
  hasPart: "partOf",
  providesApi: "apiProvidedBy",
  apiProvidedBy: "providesApi",
  consumesApi: "apiConsumedBy",
  apiConsumedBy: "consumesApi",
  buildDependsOn: "buildDependencyOf",
  buildDependencyOf: "buildDependsOn",
  testDependsOn: "testDependencyOf",
  testDependencyOf: "testDependsOn",
  runtimeCalls: "runtimeCalledBy",
  runtimeCalledBy: "runtimeCalls",
  usesResource: "resourceUsedBy",
  resourceUsedBy: "usesResource",
  schedules: "scheduledBy",
  scheduledBy: "schedules",
});

export const KIND_PAIRS = Object.freeze({
  partOf: { Component: ["System", "Domain"], System: ["Domain"], Resource: ["System"] },
  hasPart: { System: ["Component", "Resource"], Domain: ["Component", "System"] },
  providesApi: { Component: ["API"] },
  apiProvidedBy: { API: ["Component"] },
  consumesApi: { Component: ["API"] },
  apiConsumedBy: { API: ["Component"] },
  buildDependsOn: { Component: ["Component"] },
  buildDependencyOf: { Component: ["Component"] },
  testDependsOn: { Component: ["Component"] },
  testDependencyOf: { Component: ["Component"] },
  runtimeCalls: { Component: ["Component"] },
  runtimeCalledBy: { Component: ["Component"] },
  usesResource: { Component: ["Resource"] },
  resourceUsedBy: { Resource: ["Component"] },
  schedules: { Component: ["Component"] },
  scheduledBy: { Component: ["Component"] },
});

// A closed whitelist of attribute keys per relation type. An unknown key is a
// compiler error, so the graph cannot accumulate unvalidated payload — and a
// new relation type cannot silently start carrying arbitrary data.
export const ATTRIBUTE_KEYS = Object.freeze({
  partOf: [], hasPart: [],
  providesApi: [], apiProvidedBy: [],
  consumesApi: ["via"], apiConsumedBy: ["via"],
  buildDependsOn: ["via", "package"], buildDependencyOf: ["via", "package"],
  testDependsOn: ["via", "package"], testDependencyOf: ["via", "package"],
  runtimeCalls: ["transport", "contractRef", "deliverySemantics"],
  runtimeCalledBy: ["transport", "contractRef", "deliverySemantics"],
  usesResource: ["via", "client"], resourceUsedBy: ["via", "client"],
  schedules: ["via", "route"], scheduledBy: ["via", "route"],
});

// Attributes that record *how* an edge was found, not what the edge is.
// `via` is the derivation route ("npm-manifest", "source-import",
// "reviewed-override"). It must not take part in a relation's identity: if it
// did, the single fact "accounts consumes the OCR admin API" would appear once
// per adapter that noticed it, and a repository's edge count would measure
// adapter overlap rather than architecture. `package` and `route` are the
// opposite case — they name the specific instance, so two of them are two real
// edges and are kept apart deliberately.
const DERIVATION_ATTRS = new Set(["via"]);

// The identity of a relation: what it asserts, ignoring how it was found.
export function relationIdentity(e) {
  const attrs = {};
  for (const k of Object.keys(e.attributes || {}).sort()) {
    if (!DERIVATION_ATTRS.has(k)) attrs[k] = e.attributes[k];
  }
  return e.type + "|" + e.sourceRef + "|" + e.targetRef + "|" + canonicalAttrs(attrs);
}

export function canonicalAttrs(attrs) {
  return Object.keys(attrs || {}).sort().map((k) => k + "=" + JSON.stringify(attrs[k])).join("|");
}

export function buildRelations(ctx) {
  const { entities, byRef } = ctx.sources;
  const { refs } = ctx;
  const errors = [];
  const forward = [];

  const add = (type, sourceRef, targetRef, attributes, provRecs, evidenceClass) => {
    forward.push({
      type,
      sourceRef,
      targetRef,
      attributes: attributes || {},
      provs: new Set(provRecs.filter(Boolean)),
      evidenceClass: evidenceClass || evidenceOf(provRecs),
    });
  };

  // placement
  for (const e of entities) {
    const spec = e.doc.spec || {};
    const p = () => ctx.prov.add("declared", e.file, "descriptor-reader", ["rel:pending"]);
    if (e.kind === "Component") {
      if (spec.system) add("partOf", e.ref, refs.refFor("System", spec.system), {}, [p()], "AUTHORED");
      else if (spec.domain) add("partOf", e.ref, refs.refFor("Domain", spec.domain), {}, [p()], "AUTHORED");
    } else if (e.kind === "System" && spec.domain) {
      add("partOf", e.ref, refs.refFor("Domain", spec.domain), {}, [p()], "AUTHORED");
    } else if (e.kind === "Resource" && spec.system) {
      add("partOf", e.ref, refs.refFor("System", spec.system), {}, [p()], "AUTHORED");
    }
  }

  // provider edges
  for (const e of entities.filter((x) => x.kind === "API")) {
    add("providesApi", e.doc.spec.provider, e.ref, {}, [ctx.prov.add("declared", e.file, "api-contract-extractor", ["rel:pending"])], "AUTHORED");
  }

  // extractor edges
  for (const e of ctx.edges) add(e.type, e.sourceRef, e.targetRef, e.attributes, [...e.provs], e.evidenceClass);

  // reviewed overrides
  for (const e of ctx.overrideEdges) add(e.type, e.sourceRef, e.targetRef, e.attributes, [...e.provs], "REVIEWED_OVERRIDE");

  // An API contract owns the boundary: a runtime call that duplicates the
  // canonical contract is a modelling error, not a second fact.
  const apiProviderOf = new Map();
  const contractOf = new Map();
  for (const e of entities.filter((x) => x.kind === "API")) {
    apiProviderOf.set(e.ref, e.doc.spec.provider);
    if (e.doc.spec.contract?.ref) contractOf.set(e.ref, e.doc.spec.contract.ref);
  }
  const consumed = new Map();
  for (const e of forward) {
    if (e.type !== "consumesApi") continue;
    if (!consumed.has(e.sourceRef)) consumed.set(e.sourceRef, new Set());
    consumed.get(e.sourceRef).add(e.targetRef);
  }
  const filtered = forward.filter((e) => {
    if (e.type !== "runtimeCalls") return true;
    for (const apiRef of consumed.get(e.sourceRef) || []) {
      if (apiProviderOf.get(apiRef) !== e.targetRef) continue;
      if (contractOf.get(apiRef) && contractOf.get(apiRef) === e.attributes?.contractRef) {
        errors.push(new AgentDocError(
          CODES.RELATION_CONTRACT_DUP,
          "runtime call " + e.sourceRef + " -> " + e.targetRef + " duplicates canonical API contract " + contractOf.get(apiRef),
          { ref: e.sourceRef }
        ));
        return false;
      }
    }
    return true;
  });

  const all = [];
  for (const e of filtered) {
    all.push(e);
    const inv = INVERSE[e.type];
    if (!inv) {
      errors.push(new AgentDocError(CODES.RELATION_KIND, "unknown relation type '" + e.type + "'", { ref: e.sourceRef }));
      continue;
    }
    all.push({ type: inv, sourceRef: e.targetRef, targetRef: e.sourceRef, attributes: e.attributes, provs: e.provs, evidenceClass: e.evidenceClass });
  }

  const kindOf = (ref) => refs.kindOfRef(ref);
  for (const e of all) {
    const sk = kindOf(e.sourceRef);
    const tk = kindOf(e.targetRef);
    if (!sk || !tk || !byRef.has(e.sourceRef) || !byRef.has(e.targetRef)) {
      errors.push(new AgentDocError(
        CODES.RELATION_UNRESOLVED,
        "relation endpoint does not resolve to a real entity: " + e.sourceRef + " -> " + e.targetRef
      ));
      continue;
    }
    const allowed = KIND_PAIRS[e.type]?.[sk] || [];
    if (!allowed.includes(tk)) {
      errors.push(new AgentDocError(CODES.RELATION_KIND, "invalid kind pair for " + e.type + ": " + sk + " -> " + tk, { ref: e.sourceRef }));
    }
    const allowedAttrs = ATTRIBUTE_KEYS[e.type];
    if (!allowedAttrs) {
      errors.push(new AgentDocError(CODES.RELATION_KIND, "unknown relation type '" + e.type + "'", { ref: e.sourceRef }));
    } else {
      const attrKeys = Object.keys(e.attributes || {});
      for (const k of attrKeys) {
        if (!allowedAttrs.includes(k)) {
          errors.push(new AgentDocError(
            CODES.RELATION_KIND,
            "relation " + e.type + " does not allow attribute '" + k + "' (allowed: " + allowedAttrs.join(", ") + ")",
            { ref: e.sourceRef }
          ));
        }
      }
      if (e.type === "runtimeCalls" || e.type === "runtimeCalledBy") {
        const a = e.attributes || {};
        if (!["http", "service-binding", "signed-http", "grpc", "queue", "in-process"].includes(a.transport)) {
          errors.push(new AgentDocError(CODES.RELATION_KIND, e.type + " requires a known transport", { ref: e.sourceRef }));
        }
        if (!a.contractRef) {
          errors.push(new AgentDocError(CODES.RELATION_KIND, e.type + " requires contractRef", { ref: e.sourceRef }));
        }
      }
    }
  }

  const seen = new Map();
  const out = [];
  const vias = new Map();
  for (const e of all) {
    const key = relationIdentity(e);
    if (seen.has(key)) {
      const prev = seen.get(key);
      for (const p of e.provs) prev.provs.add(p);
      // A corroborated edge keeps the label its evidence supports, recomputed
      // from the merged provenance rather than promoted by a fixed order.
      prev.evidenceClass = evidenceOf([...prev.provs]);
      // Every derivation route that found it, so merging never discards the
      // fact that a second, independent adapter agreed.
      const v = vias.get(key);
      if (v && e.attributes && e.attributes.via) v.add(e.attributes.via);
      continue;
    }
    const canon = {};
    for (const k of Object.keys(e.attributes || {}).sort()) canon[k] = e.attributes[k];
    e.attributes = canon;
    if (canon.via !== undefined) {
      vias.set(key, new Set([canon.via]));
      delete e.attributes.via;
    }
    seen.set(key, e);
    out.push(e);
  }
  // Re-attach the sorted derivation routes.
  for (const e of out) {
    const key = relationIdentity(e);
    const v = vias.get(key);
    if (v) {
      const canon = {};
      canon.via = [...v].sort();
      for (const k of Object.keys(e.attributes).sort()) canon[k] = e.attributes[k];
      e.attributes = canon;
    }
  }
  out.sort((a, b) => {
    const ka = relationIdentity(a);
    const kb = relationIdentity(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const keys = new Set(out.map(relationIdentity));
  for (const e of out) {
    const invKey = relationIdentity({ type: INVERSE[e.type], sourceRef: e.targetRef, targetRef: e.sourceRef, attributes: e.attributes });
    if (!keys.has(invKey)) {
      errors.push(new AgentDocError(CODES.RELATION_MISSING_INVERSE, "missing inverse for " + e.type + " " + e.sourceRef + " -> " + e.targetRef));
    }
  }
  return { relations: out, errors };
}

// The label on a relation records which classes back it.
//
// It does NOT pick a winner by strength. A precedence list here is a global
// precedence order hiding in a helper — the exact thing the authority model
// forbids — and it was actively wrong: a reviewed override corroborated by a
// source reference was relabelled AUTHORED, so the same fact read as a weaker,
// purely-authored claim on the relation while its assertion read
// REVIEWED_OVERRIDE. The graph contradicted itself about its own highest-
// authority input.
//
// So: when the evidence agrees there is one class and it is reported. When it
// disagrees, this elects nothing. REVIEWED_OVERRIDE is reported when a human
// interpretation is among the classes, because that is not an election between
// competing claims — it records that someone reviewed this specific edge — and
// suppressing it would hide the review. The full class set is always recoverable
// from the provenance records.
function evidenceOf(provRecs) {
  const classes = new Set((provRecs || []).map((p) => p && p.cls).filter(Boolean).map((c) => PROV_TO_EVIDENCE[c]).filter(Boolean));
  if (classes.size <= 1) return classes.size === 1 ? [...classes][0] : "DERIVED";
  if (classes.has("REVIEWED_OVERRIDE")) return "REVIEWED_OVERRIDE";
  return "DERIVED";
}
