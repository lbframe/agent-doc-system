// Zero-dependency JSON Schema validator (2020-12 subset).
//
// Supported keywords — exactly what the agentdoc schemas use:
//   $ref (local bundle ids and #/$defs/... pointers), $defs, type, const, enum,
//   required, properties, additionalProperties, patternProperties, items,
//   prefixItems, minItems, maxItems, uniqueItems, minLength, maxLength,
//   pattern, minimum, maximum, allOf, anyOf, oneOf, not, if/then/else,
//   propertyNames, minProperties, format (annotation only).
//
// Anything else in a schema is a hard authoring error, so a schema can never
// silently validate less than it appears to. See SPEC.md "Schema dialect".
import { AgentDocError, CODES } from "./codes.mjs";

export const SUPPORTED_KEYWORDS = Object.freeze(new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "examples", "default", "deprecated",
  "type", "const", "enum", "required", "properties", "additionalProperties", "patternProperties",
  "items", "prefixItems", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength",
  "pattern", "minimum", "maximum", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "propertyNames", "minProperties", "$comment",
]));

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function typeMatches(v, t) {
  const a = typeOf(v);
  if (t === "number") return a === "number" || a === "integer";
  if (t === "integer") return a === "integer";
  return a === t;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) {
    if (!(typeof a === "number" && typeof b === "number")) return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object" || Array.isArray(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export class SchemaBundle {
  constructor(schemas) {
    this.byId = new Map();
    for (const s of schemas) this.byId.set(s.$id, s);
  }
  static fromMap(map) {
    return new SchemaBundle([...map.values()]);
  }
  get(id) {
    const s = this.byId.get(id);
    if (!s) throw new AgentDocError(CODES.SCHEMA, "schema not found in bundle: " + id);
    return s;
  }
  // Resolve a cross-schema $ref. Schemas may refer to a sibling by bare file
  // name ("common.json#/$defs/x"); both that alias and the fully qualified id
  // are accepted, so a bundle can be registered under either.
  //
  // Returns the target *and* the document it was found in. The document matters:
  // a node reached through `common.json#/$defs/metadata` contains its own local
  // `#/$defs/name` pointers, which must resolve against common rather than
  // against whichever schema happened to lead here.
  resolve(baseId, ref) {
    const [file, pointer] = splitRef(ref);
    const candidates = [];
    if (file) {
      if (this.byId.has(file)) candidates.push(file);
      if (baseId) candidates.push(relativeTo(baseId, file));
      for (const id of this.byId.keys()) {
        if (id === file || id.endsWith("/" + file)) candidates.push(id);
      }
    } else if (baseId) {
      candidates.push(baseId);
    }
    for (const c of candidates) {
      if (!this.byId.has(c)) continue;
      let target = this.byId.get(c);
      if (pointer) {
        for (const part of pointer.split("/").filter(Boolean)) {
          target = target[unescapePointer(part)];
        }
      }
      if (target !== undefined) return { node: target, document: this.byId.get(c) };
    }
    throw new AgentDocError(CODES.SCHEMA, "cannot resolve $ref " + ref + " from " + baseId);
  }
  validator(schemaOrId) {
    const root = typeof schemaOrId === "string" ? this.get(schemaOrId) : schemaOrId;
    return new Validator(this, root);
  }
}

export class Validator {
  constructor(bundle, root) {
    this.bundle = bundle;
    this.root = root;
  }
  // Returns null when valid, else an array of {instancePath, keyword, message}.
  validate(value) {
    const errs = [];
    this.#check(this.root, value, "", errs, this.root);
    return errs.length ? errs : null;
  }

  // A `#/...` pointer resolves against the *document* that contains it, and that
  // document changes as a cross-file `$ref` is followed. Two bugs live here and
  // both failed silently, because dereferencing to `undefined` means "no
  // constraint" rather than an error:
  //
  //  1. Resolving against the referring subschema rather than its document looks
  //     up `#/$defs/E` inside `{"$ref": "#/$defs/E"}` and yields undefined, so any
  //     schema using `$ref` for an enum inside `items` validated anything at all.
  //  2. Resolving against `this.root` always is wrong in the other direction:
  //     after following `common.json#/$defs/metadata`, the local `#/$defs/name`
  //     inside *common* must resolve against common, not against the original
  //     root. That made every component descriptor fail to validate.
  //
  // `doc` therefore tracks the current base document, and `#` alone means the
  // current document's root.
  // Resolve `schema` to a node, and report which document that node's own local
  // `#/...` pointers must be resolved against. Threading the document explicitly
  // is what makes nested cross-file references work: without it, a
  // `#/$defs/repoPath` written inside `common.json` was looked up in whichever
  // schema happened to lead there, and dereferencing to `undefined` means "no
  // constraint" rather than an error — a silent soundness hole.
  #resolve(schema, doc = this.root, seen = new Set()) {
    let s = schema;
    let base = doc;
    while (s && typeof s.$ref === "string") {
      const id = s.$ref;
      const tag = (base && base.$id) + "|" + id;
      if (seen.has(tag)) throw new AgentDocError(CODES.SCHEMA, "cyclic $ref: " + id);
      seen.add(tag);
      if (id.startsWith("#")) {
        if (id === "#") { s = base; continue; }
        if (!id.startsWith("#/")) throw new AgentDocError(CODES.SCHEMA, "unsupported $ref " + id);
        s = pointerGet(base, id.slice(2).split("/").map(unescapePointer));
        if (s === undefined) {
          throw new AgentDocError(CODES.SCHEMA, "cannot resolve local $ref " + id + " against " + base.$id);
        }
      } else {
        const found = this.bundle.resolve(base.$id, id);
        s = found.node;
        base = found.document;
      }
    }
    return { node: s, document: base };
  }

  #check(rawSchema, value, ip, errs, doc = this.root) {
    const resolved = this.#resolve(rawSchema, doc);
    const schema = resolved.node;
    const base = resolved.document;
    if (schema === true || schema === undefined) return;
    if (schema === false) {
      errs.push({ instancePath: ip || "/", keyword: "false", message: "schema forbids any value" });
      return;
    }
    const add = (keyword, message) => errs.push({ instancePath: ip || "/", keyword, message });

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeMatches(value, t))) {
        add("type", "must be " + types.join("|") + " (got " + typeOf(value) + ")");
        return;
      }
    }
    if (schema.const !== undefined && !deepEqual(value, schema.const)) {
      add("const", "must equal " + JSON.stringify(schema.const));
    }
    if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(value, e))) {
      add("enum", "must be one of " + JSON.stringify(schema.enum));
    }

    const t = typeOf(value);
    if (t === "string") {
      if (schema.minLength !== undefined && [...value].length < schema.minLength) add("minLength", "shorter than " + schema.minLength);
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) add("maxLength", "longer than " + schema.maxLength);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
        add("pattern", "does not match " + schema.pattern);
      }
    }
    if (t === "number" || t === "integer") {
      if (schema.minimum !== undefined && value < schema.minimum) add("minimum", "below minimum " + schema.minimum);
      if (schema.maximum !== undefined && value > schema.maximum) add("maximum", "above maximum " + schema.maximum);
    }
    if (t === "array") {
      if (schema.minItems !== undefined && value.length < schema.minItems) add("minItems", "fewer than " + schema.minItems + " items");
      if (schema.maxItems !== undefined && value.length > schema.maxItems) add("maxItems", "more than " + schema.maxItems + " items");
      if (schema.uniqueItems === true) {
        for (let i = 0; i < value.length; i++) {
          for (let j = i + 1; j < value.length; j++) {
            if (deepEqual(value[i], value[j])) add("uniqueItems", "duplicate item at index " + j);
          }
        }
      }
      const prefix = schema.prefixItems || [];
      for (let i = 0; i < value.length; i++) {
        if (i < prefix.length) this.#check(prefix[i], value[i], ip + "/" + i, errs, base);
        else if (schema.items !== undefined) this.#check(schema.items, value[i], ip + "/" + i, errs, base);
      }
    }
    if (t === "object") {
      const keys = Object.keys(value);
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) add("minProperties", "fewer than " + schema.minProperties + " properties");
      for (const r of schema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(value, r)) add("required", "missing required property " + JSON.stringify(r));
      }
      const props = schema.properties || {};
      const patterns = Object.entries(schema.patternProperties || {});
      for (const k of keys) {
        const escaped = k.replace(/~/g, "~0").replace(/\//g, "~1");
        const childIp = ip + "/" + escaped;
        let covered = false;
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          covered = true;
          this.#check(props[k], value[k], childIp, errs, base);
        }
        for (const [re, sub] of patterns) {
          if (new RegExp(re, "u").test(k)) {
            covered = true;
            this.#check(sub, value[k], childIp, errs, base);
          }
        }
        if (!covered) {
          if (schema.additionalProperties === false) {
            errs.push({ instancePath: childIp, keyword: "additionalProperties", message: "unknown property " + JSON.stringify(k) });
          } else if (schema.additionalProperties !== undefined) {
            this.#check(schema.additionalProperties, value[k], childIp, errs, base);
          }
        }
        if (schema.propertyNames !== undefined) this.#check(schema.propertyNames, k, childIp, errs, base);
      }
    }

    for (const sub of schema.allOf || []) this.#check(sub, value, ip, errs, base);
    if (schema.anyOf) {
      const ok = schema.anyOf.some((s) => this.#sub(value, s, base));
      if (!ok) add("anyOf", "does not match any allowed variant");
    }
    if (schema.oneOf) {
      const n = schema.oneOf.filter((s) => this.#sub(value, s, base)).length;
      if (n !== 1) add("oneOf", "must match exactly one variant (matched " + n + ")");
    }
    if (schema.not !== undefined && this.#sub(value, schema.not, base)) add("not", "matches a forbidden shape");
    if (schema.if !== undefined) {
      if (this.#sub(value, schema.if, base)) this.#check(schema.then, value, ip, errs, base);
      else if (schema.else !== undefined) this.#check(schema.else, value, ip, errs, base);
    }
  }

  #sub(value, schema, doc = this.root) {
    const errs = [];
    this.#check(schema, value, "", errs, doc);
    return errs.length === 0;
  }
}

function unescapePointer(s) {
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointerGet(root, parts) {
  let cur = root;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function relativeTo(baseId, ref) {
  const base = baseId || "";
  const cut = base.lastIndexOf("/");
  return cut >= 0 ? base.slice(0, cut + 1) + ref : ref;
}

function splitRef(ref) {
  const at = ref.indexOf("#");
  return at < 0 ? [ref, null] : [ref.slice(0, at), ref.slice(at + 1)];
}

export function formatErrors(errs, limit = 8) {
  return errs.slice(0, limit).map((e) => (e.instancePath || "/") + " " + e.message).join("; ");
}
