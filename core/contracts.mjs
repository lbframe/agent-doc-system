// Contract validation and indexing.
//
// Every durable cross-component boundary should have exactly one canonical
// machine-readable contract, and the Catalog points at it rather than
// duplicating it. The default dialect is OpenAPI 3.1 for JSON HTTP, but a
// protocol's native schema is equally valid: OIDC discovery, GraphQL SDL,
// protobuf, AsyncAPI.
import { parseYamlDocuments } from "./yaml.mjs";
import { AgentDocError, CODES } from "./codes.mjs";

const CONTRACTS = {
  openapi: {
    validate(text, fail) {
      let root = null;
      try {
        const docs = parseYamlDocuments(text, "");
        root = docs[0] && docs[0].doc;
      } catch {
        try {
          root = JSON.parse(text);
        } catch {
          fail("not parseable as YAML or JSON");
          return null;
        }
      }
      if (!root || typeof root !== "object") { fail("root is not a mapping"); return null; }
      if (typeof root.openapi !== "string") fail("missing 'openapi' version field");
      else if (!/^3\.[01]/.test(root.openapi)) fail("openapi must be 3.0 or 3.1, got " + root.openapi);
      if (!root.paths || typeof root.paths !== "object") fail("missing 'paths' object");
      if (root.components === undefined) fail("missing 'components' object");
      if (typeof root.info?.title !== "string") fail("missing 'info.title'");
      return { openapi: root.openapi, title: root.info?.title || null, operations: countOps(root.paths) };
    },
    defRe: /\.(openapi)\.(ya?ml|json)$/,
  },
  asyncapi: {
    validate(text, fail) {
      let root = null;
      try {
        const docs = parseYamlDocuments(text, "");
        root = docs[0] && docs[0].doc;
      } catch {
        try { root = JSON.parse(text); } catch { fail("not parseable as YAML or JSON"); return null; }
      }
      if (!root || root.asyncapi === undefined) { fail("missing 'asyncapi' field"); return null; }
      if (!root.channels || typeof root.channels !== "object") fail("missing 'channels' object");
      return { asyncapi: root.asyncapi, title: root.info?.title || null, channels: Object.keys(root.channels).length };
    },
    defRe: /\.(asyncapi)\.(ya?ml|json)$/,
  },
  protobuf: {
    validate(text, fail) {
      if (!/^\s*(syntax|edition)\s*=/m.test(text)) { fail("missing syntax or edition declaration"); return null; }
      const services = [...text.matchAll(/^\s*service\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
      if (!services.length) fail("no service definitions found");
      return { services };
    },
    defRe: /\.proto$/,
  },
  graphql: {
    validate(text, fail) {
      if (!/(type|schema|interface|input|enum|scalar)\s+[A-Za-z_]/.test(text)) { fail("no GraphQL type definitions found"); return null; }
      return { types: [...text.matchAll(/^\s*(?:type|interface|input|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]) };
    },
    defRe: /\.graphqls?$/,
  },
  "graphql-sdl": {
    validate(text, fail) {
      if (!/(type|schema|interface|input|enum|scalar)\s+[A-Za-z_]/.test(text)) { fail("no GraphQL type definitions found"); return null; }
      return null;
    },
    defRe: /\.graphqls?$/,
  },
};

function countOps(paths) {
  let n = 0;
  for (const v of Object.values(paths || {})) {
    if (v && typeof v === "object") n += Object.keys(v).filter((k) => ["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(k)).length;
  }
  return n;
}

export function validateContractFile(repo, bundle, api) {
  const type = api.doc.spec.type;
  const ref = api.doc.spec.contract?.ref;
  if (!ref) return;
  if (type === "oidc") return; // the canonical authority is the published standard, not a file
  const spec = CONTRACTS[type];
  const text = repo.readText(ref);
  const fail = (msg) => {
    throw new AgentDocError(
      CODES.CONTRACT_SYNTAX,
      "contract " + ref + " is not a valid " + type + " definition: " + msg,
      { path: ref, ref: api.ref }
    );
  };
  if (!spec) throw new AgentDocError(CODES.CONTRACT_FORM, "unsupported contract type " + type, { path: ref, ref: api.ref });
  const summary = spec.validate(text, fail);
  void bundle;
  api.contractSummary = summary;
}

export function contractDefRegex() {
  const res = [];
  for (const s of new Set(Object.values(CONTRACTS).map((c) => c.defRe.source))) res.push(s);
  return new RegExp("(" + res.join("|") + ")");
}

// Contract files matching a declared type. Used by the audit to point at
// contract-shaped files that no API claims.
export function classifyContractFile(rel) {
  for (const [type, spec] of Object.entries(CONTRACTS)) {
    if (spec.defRe.test(rel)) return type;
  }
  return null;
}

export function contractTypes() {
  return Object.keys(CONTRACTS);
}
