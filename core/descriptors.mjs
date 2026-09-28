// Authored source loading: the config document, entity descriptors, journeys,
// observation sets and reviewed overrides.
//
// Deliberate strictness, preserved from the reference implementation:
//   - one canonical location per kind (a descriptor in the wrong file is an
//     error, not a warning)
//   - prohibited fields: lifecycle/owner/status/relations/annotations metadata
//     has no home in a machine-readable entity and would immediately drift
//   - exactly one sentence descriptions
//   - no untrimmed strings
//   - no secrets
//   - refs and context paths must resolve
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { AgentDocError, CODES, collect } from "./codes.mjs";
import { assertRepoPath, expandGlob, sha256Hex } from "./fsx.mjs";
import { parseYamlDocuments } from "./yaml.mjs";
import { scanForSecrets } from "./secrets.mjs";
import { formatErrors } from "./jsonschema.mjs";
import { SchemaBundle } from "./jsonschema.mjs";

export const KINDS = Object.freeze(["Domain", "System", "Component", "API", "Resource"]);
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function makeRefs(namespace) {
  const refFor = (kind, name) => kind.toLowerCase() + ":" + namespace + "/" + name;
  const kindOfRef = (ref) => KINDS.find((k) => k.toLowerCase() === String(ref).split(":")[0]);
  const nameOfRef = (ref) => String(ref).split("/")[1];
  const isValidRef = (ref) => typeof ref === "string" && new RegExp("^(" + KINDS.map((k) => k.toLowerCase()).join("|") + "):" + namespace + "/[a-z0-9]+(?:-[a-z0-9]+)*$").test(ref);
  return { refFor, kindOfRef, nameOfRef, isValidRef, namespace };
}

const PROHIBITED_KEYS = new Set([
  "status", "owner", "owners", "lifecycle", "maturity", "uid", "etag", "uuid",
  "annotations", "labels", "createdAt", "updatedAt", "created", "modified",
  "relations", "dependsOn", "depends_on", "runtime", "secrets",
]);

// `extensions` is the documented forward-evolution bag: typed as free-form and
// ignored by every core rule, including this one. Recursing into it would make
// the escape hatch unusable for exactly the slow-drifting metadata the spec says
// has no home in an entity.
const FREE_FORM_KEYS = new Set(["extensions"]);

function rejectProhibitedFields(node, pathStr, freeForm = false) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v) => rejectProhibitedFields(v, pathStr, freeForm));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (FREE_FORM_KEYS.has(k)) continue;
    if (PROHIBITED_KEYS.has(k)) {
      const code = k === "relations" || k === "dependsOn" || k === "depends_on" || k === "runtime"
        ? CODES.RELATION_AUTHORED
        : CODES.PROHIBITED_FIELD;
      throw new AgentDocError(
        code,
        "prohibited field '" + k + "': derived topology and ownership metadata have no place in an authored entity — use the graph",
        { path: pathStr }
      );
    }
    rejectProhibitedFields(v, pathStr, freeForm);
  }
}

function checkTrimmed(node, pathStr, pointer = "") {
  if (typeof node === "string") {
    if (node !== node.trim()) {
      throw new AgentDocError(CODES.SCHEMA, "string at " + (pointer || "/") + " has leading or trailing whitespace", { path: pathStr });
    }
    return;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  for (const [k, v] of Object.entries(node)) checkTrimmed(v, pathStr, pointer + "/" + k);
}

function checkOneSentence(desc, pathStr) {
  if (typeof desc !== "string") return;
  const ok = /[.!?]$/.test(desc) && !/[.!?]/.test(desc.slice(0, -1)) && !/[\r\n]/.test(desc);
  if (!ok) {
    throw new AgentDocError(
      CODES.SCHEMA,
      "metadata.description must be one current-purpose sentence ending in '.', '!', or '?'",
      { path: pathStr }
    );
  }
}

// Schemas ship with the compiler, not with the target repository: the target
// repository must not be able to loosen validation by editing a schema. Their
// content hashes are folded into the graph input hash so upgrading a schema
// correctly invalidates every graph compiled against the old one.
const SYSTEM_ROOT = path.posix.join(path.dirname(new URL(import.meta.url).pathname), "..");

export function loadSchemaBundle() {
  const abs = path.join(SYSTEM_ROOT, "schemas");
  const names = fs.readdirSync(abs).filter((f) => f.endsWith(".schema.json")).sort();
  const map = new Map();
  const versionInputs = [];
  for (const n of names) {
    const text = fs.readFileSync(path.join(abs, n), "utf8");
    const s = JSON.parse(text);
    if (!s.$id) throw new AgentDocError(CODES.SCHEMA, "schema " + n + " has no $id");
    map.set(s.$id, s);
    versionInputs.push("schema:" + s.$id + ":" + createHash("sha256").update(text).digest("hex"));
  }
  if (!map.has("agentdoc.dev/schema/config.schema.json")) {
    throw new AgentDocError(CODES.SCHEMA, "the compiler's own schema bundle is incomplete");
  }
  return { bundle: SchemaBundle.fromMap(map), versionInputs };
}

const KIND_SCHEMA_ID = {
  Domain: "agentdoc.dev/schema/domain.schema.json",
  System: "agentdoc.dev/schema/system.schema.json",
  Component: "agentdoc.dev/schema/component.schema.json",
  API: "agentdoc.dev/schema/api.schema.json",
  Resource: "agentdoc.dev/schema/resource.schema.json",
};

export const CONFIG_PATH = "agentdoc/agentdoc.config.yaml";

export function loadConfig(repo, bundle) {
  const docs = parseYamlDocuments(repo.readText(CONFIG_PATH), CONFIG_PATH);
  if (docs.length !== 1) {
    throw new AgentDocError(CODES.CONFIG, "agentdoc.config.yaml must contain exactly one document", { path: CONFIG_PATH });
  }
  const cfg = docs[0].doc;
  const v = bundle.validator("agentdoc.dev/schema/config.schema.json");
  const errs = v.validate(cfg);
  if (errs) {
    throw new AgentDocError(CODES.SCHEMA, "agentdoc config violates its schema: " + formatErrors(errs), { path: CONFIG_PATH });
  }
  scanForSecrets(cfg, CONFIG_PATH);
  for (const g of [...cfg.discovery.componentDescriptors, ...cfg.discovery.centralDescriptors]) {
    if (g.split("/").includes("..")) {
      throw new AgentDocError(CODES.GLOB, "glob must not contain '..': " + g, { path: CONFIG_PATH });
    }
  }
  for (const p of [
    cfg.output.graph, cfg.output.observations, cfg.output.report,
    ...(cfg.discovery.supplementalRoots || []),
    ...(cfg.discovery.contractRoots || []),
    ...(cfg.docs ? Object.values(cfg.docs) : []),
  ].filter(Boolean)) {
    assertRepoPath(p, CONFIG_PATH);
  }
  return cfg;
}

function descriptorGlobs(repo, cfg) {
  const componentFiles = new Set();
  for (const g of cfg.discovery.componentDescriptors) for (const f of expandGlob(repo, g)) componentFiles.add(f);
  const centralFiles = new Set();
  for (const g of cfg.discovery.centralDescriptors) for (const f of expandGlob(repo, g)) centralFiles.add(f);
  return { componentFiles: [...componentFiles].sort(), centralFiles: [...centralFiles].sort() };
}

export function loadDescriptors(repo, cfg, bundle, refs) {
  const errors = [];
  const entities = [];
  const { componentFiles, centralFiles } = descriptorGlobs(repo, cfg);
  const componentSet = new Set(componentFiles);
  const centralSet = new Set(centralFiles);
  const descriptorName = cfg.discovery.componentDescriptorName;

  for (const file of [...componentFiles, ...centralFiles]) {
    const isComponentFile = componentSet.has(file);
    const docs = collect(() => parseYamlDocuments(repo.readText(file), file), errors);
    if (!docs) continue;
    for (const { doc, line } of docs) {
      collect(() => {
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
          throw new AgentDocError(CODES.YAML_NON_MAP_ROOT, "descriptor must be a YAML mapping", { path: file, line });
        }
        if (doc.apiVersion !== "agentdoc.dev/v1") {
          throw new AgentDocError(CODES.API_VERSION, "apiVersion must be exactly 'agentdoc.dev/v1'", { path: file, line });
        }
        if (!KINDS.includes(doc.kind)) {
          throw new AgentDocError(CODES.KIND, "kind must be one of " + KINDS.join(", "), { path: file, line });
        }
        const kind = doc.kind;
        if (kind === "Component") {
          if (!isComponentFile || path.posix.basename(file) !== descriptorName) {
            throw new AgentDocError(
              CODES.LOCATION,
              "Component descriptors must live in <unit-root>/" + descriptorName,
              { path: file, line }
            );
          }
        } else if (!centralSet.has(file)) {
          throw new AgentDocError(
            CODES.LOCATION,
            kind + " descriptors must be listed in discovery.centralDescriptors",
            { path: file, line }
          );
        }
        // Order matters: a secret is a harder failure than a style rule, and a
        // description containing a URL fails the sentence rule. Refusing the
        // secret first means the operator never sees a style complaint about
        // content they were never allowed to write.
        scanForSecrets(doc, file);
        rejectProhibitedFields(doc, file);
        checkTrimmed(doc, file);
        checkOneSentence(doc.metadata && doc.metadata.description, file);
        const v = bundle.validator(KIND_SCHEMA_ID[kind]);
        const errs = v.validate(doc);
        if (errs) {
          const unknown = errs.find((e) => e.keyword === "additionalProperties");
          throw new AgentDocError(
            unknown ? CODES.UNKNOWN_FIELD : CODES.SCHEMA,
            "descriptor violates the " + kind + " schema: " + formatErrors(errs),
            { path: file, line }
          );
        }
        const name = doc.metadata.name;
        if (!NAME_RE.test(name)) {
          throw new AgentDocError(CODES.NAME_INVALID, "invalid name " + JSON.stringify(name), { path: file, line });
        }
        entities.push({ kind, name, ref: refs.refFor(kind, name), doc, file, line });
      }, errors);
    }
  }

  const seen = new Map();
  for (const e of entities) {
    const key = e.kind + "/" + e.name;
    if (seen.has(key)) {
      errors.push(new AgentDocError(
        CODES.DUPLICATE_IDENTITY,
        "duplicate " + e.kind + " name '" + e.name + "', also defined in " + seen.get(key),
        { path: e.file, ref: e.ref }
      ));
    } else seen.set(key, e.file);
  }

  const byRef = new Map(entities.map((e) => [e.ref, e]));
  const byKindName = new Map(entities.map((e) => [e.kind + "/" + e.name, e]));

  const resolveName = (kind, name, file, field) => {
    if (!byKindName.has(kind + "/" + name)) {
      throw new AgentDocError(CODES.REF_UNRESOLVED, field + " references unknown " + kind + " '" + name + "'", {
        path: file, ref: refs.refFor(kind, name),
      });
    }
  };

  for (const e of entities) {
    collect(() => {
      const spec = e.doc.spec || {};
      const ctxPaths = [];
      if (e.kind === "System" && spec.domain) resolveName("Domain", spec.domain, e.file, "spec.domain");
      if (e.kind === "Resource" && spec.system) resolveName("System", spec.system, e.file, "spec.system");
      if (e.kind === "Component") {
        if (spec.system) resolveName("System", spec.system, e.file, "spec.system");
        if (spec.domain) resolveName("Domain", spec.domain, e.file, "spec.domain");
        ctxPaths.push(...(spec.context?.docs || []), ...(spec.context?.constraints || []), ...(spec.context?.runbooks || []));
        if (e.kind === "Component" && e.doc.spec.type === "library" && spec.system) {
          // allowed; no extra rule
        }
      }
      if (e.kind === "System" && spec.context) ctxPaths.push(...Object.values(spec.context).flat());
      if (e.kind === "Resource" && spec.context) ctxPaths.push(...Object.values(spec.context).flat());
      for (const p of ctxPaths) {
        assertRepoPath(p, e.file);
        if (!repo.exists(p)) {
          throw new AgentDocError(CODES.PATH_UNRESOLVED, "context link does not resolve: " + p, { path: e.file, ref: e.ref });
        }
      }
      if (e.kind === "API") {
        const prov = spec.provider;
        if (!refs.isValidRef(prov) || refs.kindOfRef(prov) !== "Component") {
          throw new AgentDocError(CODES.REF_INVALID, "spec.provider must be a full component ref", { path: e.file, ref: e.ref });
        }
        if (!byRef.has(prov)) {
          throw new AgentDocError(CODES.REF_UNRESOLVED, "spec.provider does not resolve: " + prov, { path: e.file, ref: e.ref });
        }
        const c = spec.contract;
        if (spec.type === "oidc") {
          if (!c.discoveryPath || !c.discoveryPath.startsWith("/") || /[?#]/.test(c.discoveryPath) || !c.standard) {
            throw new AgentDocError(
              CODES.CONTRACT_FORM,
              "oidc contract requires a standard and an absolute discoveryPath without scheme, host or query",
              { path: e.file, ref: e.ref }
            );
          }
        } else {
          if (!c.ref) {
            throw new AgentDocError(CODES.CONTRACT_FORM, "contract.ref is required for type " + spec.type, { path: e.file, ref: e.ref });
          }
          assertRepoPath(c.ref, e.file);
          if (!repo.exists(c.ref)) {
            throw new AgentDocError(CODES.PATH_UNRESOLVED, "contract.ref does not resolve: " + c.ref, { path: e.file, ref: e.ref });
          }
        }
        for (const cr of spec.consumers || []) {
          if (!byRef.has(cr)) {
            throw new AgentDocError(CODES.REF_UNRESOLVED, "spec.consumers references unknown component " + cr, { path: e.file, ref: e.ref });
          }
          if (cr === spec.provider) {
            throw new AgentDocError(CODES.REF_INVALID, "a provider cannot be listed as its own consumer", { path: e.file, ref: e.ref });
          }
        }
      }
    }, errors);
  }

  return { entities, byRef, byKindName, componentFiles: new Set(componentFiles), errors, componentSet, centralSet };
}

export function loadJourneys(repo, cfg, bundle, byRef) {
  const errors = [];
  const jPath = cfg.discovery.journeyDefinitions;
  if (!jPath || !repo.exists(jPath)) return { journeys: [], path: jPath || null, errors };
  try {
    const docs = parseYamlDocuments(repo.readText(jPath), jPath);
    if (docs.length !== 1) throw new AgentDocError(CODES.JOURNEY, "journeys file must contain exactly one document", { path: jPath });
    const errs = bundle.validator("agentdoc.dev/schema/journeys.schema.json").validate(docs[0].doc);
    if (errs) throw new AgentDocError(CODES.SCHEMA, "journeys violate their schema: " + formatErrors(errs), { path: jPath });
    scanForSecrets(docs[0].doc, jPath);
    const ids = new Set();
    for (const j of docs[0].doc.journeys) {
      if (ids.has(j.id)) throw new AgentDocError(CODES.JOURNEY, "duplicate journey id '" + j.id + "'", { path: jPath });
      ids.add(j.id);
      for (const ref of j.components) {
        if (!byRef.has(ref)) {
          throw new AgentDocError(CODES.REF_UNRESOLVED, "journey '" + j.id + "' references unknown component " + ref, { path: jPath, ref });
        }
      }
    }
    return { journeys: docs[0].doc.journeys, path: jPath, errors };
  } catch (e) {
    if (e instanceof AgentDocError) { errors.push(e); return { journeys: [], path: jPath, errors }; }
    throw e;
  }
}

export function loadObservations(repo, cfg, bundle, byRef) {
  const errors = [];
  const sets = [];
  const dir = cfg.output.observations;
  if (!repo.exists(dir)) return { sets, errors };
  const files = repo.walk(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  const v = bundle.validator("agentdoc.dev/schema/observation.schema.json");
  for (const file of files) {
    const docs = collect(() => parseYamlDocuments(repo.readText(file), file), errors);
    if (!docs) continue;
    for (const { doc, line } of docs) {
      collect(() => {
        if (doc.apiVersion !== "agentdoc.dev/observation/v1") {
          throw new AgentDocError(CODES.API_VERSION, "apiVersion must be 'agentdoc.dev/observation/v1'", { path: file, line });
        }
        if (doc.kind !== "ObservationSet") {
          throw new AgentDocError(CODES.KIND, "kind must be ObservationSet", { path: file, line });
        }
        const errs = v.validate(doc);
        if (errs) throw new AgentDocError(CODES.SCHEMA, "observation set violates its schema: " + formatErrors(errs), { path: file, line });
        scanForSecrets(doc, file);
        const m = doc.metadata;
        assertRepoPath(m.evidenceBundle, file);
        if (!repo.exists(m.evidenceBundle)) {
          throw new AgentDocError(
            CODES.PATH_UNRESOLVED,
            "observation evidence bundle does not resolve: " + m.evidenceBundle + " (observations must cite a durable, committed, secret-free reference)",
            { path: file }
          );
        }
        const seenFacts = new Set();
        for (const fact of doc.spec.facts) {
          if (!byRef.has(fact.subject)) {
            throw new AgentDocError(
              CODES.REF_UNRESOLVED,
              "observation fact '" + fact.id + "' subject does not resolve: " + fact.subject,
              { path: file, ref: fact.subject }
            );
          }
          if (seenFacts.has(fact.key)) {
            throw new AgentDocError(
              CODES.CONFIG,
              "observation set '" + m.name + "' has two facts with key '" + fact.key + "' on " + fact.subject,
              { path: file, ref: fact.subject }
            );
          }
          seenFacts.add(fact.key);
        }
        sets.push({ doc, file, line, meta: m, facts: doc.spec.facts });
      }, errors);
    }
  }
  return { sets, errors };
}

export function loadReviewedOverrides(repo, cfg, refs, byRef) {
  const errors = [];
  const out = [];
  for (const o of cfg.reviewedOverrides || []) {
    collect(() => {
      if (!refs.isValidRef(o.subject)) {
        throw new AgentDocError(CODES.REF_INVALID, "reviewed override subject is not a canonical entity ref: " + o.subject, { path: CONFIG_PATH });
      }
      if (!byRef.has(o.subject)) {
        throw new AgentDocError(CODES.REF_UNRESOLVED, "reviewed override subject does not resolve: " + o.subject, { path: CONFIG_PATH, ref: o.subject });
      }
      if (o.target !== undefined && o.fact !== "external-dependency-role") {
        if (!refs.isValidRef(o.target)) {
          throw new AgentDocError(CODES.REF_INVALID, "reviewed override target is not a canonical entity ref: " + o.target, { path: CONFIG_PATH });
        }
        if (!byRef.has(o.target)) {
          throw new AgentDocError(CODES.REF_UNRESOLVED, "reviewed override target does not resolve: " + o.target, { path: CONFIG_PATH, ref: o.target });
        }
      }
      // The digests are pinned by the author and re-verified here, on every
      // compile. A REVIEWED_OVERRIDE is the highest-authority input the model
      // accepts and the only thing that can falsify it is the evidence it cites.
      // If that evidence is rewritten and the override survives, a stale human
      // judgement is silently promoted to fact, and the graph ships a digest
      // that matches nothing. This is the same discipline `warningAcceptances`
      // applies, for the same reason.
      const seenEvidence = new Set();
      for (const ev of o.evidence) {
        assertRepoPath(ev.path, CONFIG_PATH);
        if (seenEvidence.has(ev.path)) {
          throw new AgentDocError(CODES.OVERRIDE_STALE, "duplicate reviewed override evidence path: " + ev.path, { path: CONFIG_PATH });
        }
        seenEvidence.add(ev.path);
        if (!repo.exists(ev.path)) {
          throw new AgentDocError(CODES.PATH_UNRESOLVED, "reviewed override evidence does not resolve: " + ev.path, { path: CONFIG_PATH });
        }
        const actual = sha256Hex(repo.readBytes(ev.path));
        if (actual !== ev.sha256) {
          throw new AgentDocError(
            CODES.OVERRIDE_STALE,
            "reviewed override evidence changed: " + ev.path + " — review the interpretation before updating its digest",
            { path: CONFIG_PATH, ref: o.subject }
          );
        }
      }
      // Evidence must live under a mapped component's source root or be the
      // declared contract. This is what stops a reviewed override from
      // asserting something no file in the repository can corroborate.
      const subjectRoot = path.posix.dirname(byRef.get(o.subject).file);
      const targetRoot = o.target && o.fact !== "external-dependency-role" && byRef.has(o.target)
        ? path.posix.dirname(byRef.get(o.target).file)
        : null;
      for (const ev of o.evidence) {
        const p = ev.path;
        const scoped = p === o.contractRef || p.startsWith(subjectRoot + "/") || (targetRoot && p.startsWith(targetRoot + "/"));
        if (!scoped) {
          throw new AgentDocError(
            CODES.RELATION_KIND,
            "reviewed override evidence must be the declared contract or live under a mapped component source root: " + p,
            { path: CONFIG_PATH }
          );
        }
      }
      out.push(o);
    }, errors);
  }
  return { overrides: out, errors };
}
