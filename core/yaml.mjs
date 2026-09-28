// Strict YAML 1.2 *subset* parser with zero dependencies.
//
// Supported: multi-document streams, block mappings, block sequences, plain /
// single-quoted / double-quoted scalars, flow sequences and mappings of
// scalars, literal (|) and folded (>) block scalars, comments, and the YAML
// 1.2 core scalar resolution (null/bool/int/float/string).
//
// Deliberately unsupported and rejected with a dedicated code: anchors,
// aliases, custom tags, merge keys, environment interpolation, complex keys,
// and any nesting the compiler would have to guess at. Authored sources are
// machine-generated templates plus human review; ambiguity is a defect, not a
// feature. See SPEC.md "Source dialect".
import { AgentDocError, CODES } from "./codes.mjs";

const BANNED = [
  { re: /(?:^|[\s\[])&[A-Za-z0-9_-]+/, code: CODES.YAML_ANCHOR, what: "anchors" },
  { re: /(?:^|[\s\[])\*[A-Za-z0-9_-]+/, code: CODES.YAML_ALIAS, what: "aliases" },
  { re: /(?:^|[\s[])!(?:<[^>]*>|![^\s]*|[A-Za-z][A-Za-z0-9_:.\/-]*)/, code: CODES.YAML_TAG, what: "custom tags" },
  { re: /^\s*<<\s*:/, code: CODES.YAML_MERGE_KEY, what: "merge keys" },
  { re: /\$\{[A-Za-z_][A-Za-z0-9_]*\}/, code: CODES.YAML_ENV, what: "environment interpolation" },
];

function scanBanned(text, path) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#|---|\.\.\.)/.test(line) && !/^(---|...)/.test(line.trim())) continue;
    for (const b of BANNED) {
      if (b.re.test(line)) {
        throw new AgentDocError(b.code, "YAML " + b.what + " are forbidden in agentdoc sources", {
          path,
          line: i + 1,
        });
      }
    }
  }
}

function makeLine(raw, lineNo) {
  const l = { raw, lineNo, indent: 0, content: "", blank: false, _c: null };
  l.indent = /^[ \t]*/.exec(raw)[0].length;
  if (/^\t/.test(raw)) {
    throw new AgentDocError(CODES.YAML_PARSE, "tab character used for indentation", { line: lineNo });
  }
  const t = raw.trim();
  l.blank = t === "" || t.startsWith("#");
  return l;
}

function stripComment(raw) {
  let q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) {
      if (c === "\\" && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function content(l) {
  if (l._c === null) l._c = stripComment(l.raw).replace(/\s+$/, "");
  return l._c;
}

const isSeqEntry = (s) => s === "-" || /^-(\s)/.test(s);

function splitKey(s) {
  // Returns {key, rest} for `key: value` / `key:` / `"key": value`, else null.
  if (s === "") return null;
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    let i = 1;
    while (i < s.length) {
      if (s[i] === "\\" && q === '"') { i += 2; continue; }
      if (s[i] === q) {
        if (q === "'" && s[i + 1] === "'") { i += 2; continue; }
        break;
      }
      i++;
    }
    if (i >= s.length) return null;
    const key = unquote(s.slice(0, i + 1));
    const after = s.slice(i + 1);
    if (!after.startsWith(":")) return null;
    return { key, rest: after.slice(1).replace(/^[ \t]+/, "").replace(/\s+$/, "") };
  }
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0) {
      const nxt = s[i + 1];
      if (nxt === undefined || nxt === " " || nxt === "\t") {
        return { key: s.slice(0, i).replace(/\s+$/, ""), rest: s.slice(i + 1).replace(/^[ \t]+/, "").replace(/\s+$/, "") };
      }
    }
  }
  return null;
}

function unquote(tok) {
  const q = tok[0];
  const body = tok.slice(1, -1);
  if (q === "'") return body.replace(/''/g, "'");
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { out += c; continue; }
    const n = body[++i];
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === "0") out += "\0";
    else if (n === '"') out += '"';
    else if (n === "\\") out += "\\";
    else if (n === "/") out += "/";
    else if (n === "u") { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
    else throw new AgentDocError(CODES.YAML_UNSUPPORTED, "unsupported escape sequence \\" + n);
  }
  return out;
}

const INT_RE = /^[-+]?[0-9]+$/;
const OCT_RE = /^0o[0-7]+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const FLOAT_RE = /^[-+]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][-+]?[0-9]+)?$/;

function resolvePlain(s) {
  if (s === "" || s === "null" || s === "~" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (INT_RE.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n)) throw new AgentDocError(CODES.YAML_UNSUPPORTED, "integer out of safe range: " + s);
    return n;
  }
  if (OCT_RE.test(s)) return parseInt(s.slice(2), 8);
  if (HEX_RE.test(s)) return parseInt(s.slice(2), 16);
  if (FLOAT_RE.test(s) && /[.eE]/.test(s)) return Number(s);
  if (s === ".inf" || s === ".Inf") return Infinity;
  if (s === "-.inf" || s === "-.Inf") return -Infinity;
  if (s === ".nan" || s === ".NaN") return NaN;
  return s;
}

function scalar(tok, lineNo) {
  const t = tok.trim();
  if (t === "") return null;
  if (t[0] === '"' || t[0] === "'") {
    if (t.length < 2 || t[t.length - 1] !== t[0]) {
      throw new AgentDocError(CODES.YAML_PARSE, "unterminated quoted scalar", { line: lineNo });
    }
    return unquote(t);
  }
  if (t[0] === "[" || t[0] === "{") return flow(t, lineNo);
  if (t[0] === "&" || t[0] === "*" || t[0] === "!") {
    throw new AgentDocError(CODES.YAML_UNSUPPORTED, "anchors, aliases and tags are not supported", { line: lineNo });
  }
  return resolvePlain(t);
}

// Flow collections of scalars (and nested flow collections).
function flow(text, lineNo) {
  let i = 0;
  const err = (m) => { throw new AgentDocError(CODES.YAML_PARSE, "flow collection: " + m, { line: lineNo }); };
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  let valueStart = 0;
  function value() {
    ws();
    const c = text[i];
    if (c === "[") return seqFlow();
    if (c === "{") return mapFlow();
    valueStart = i;
    return scalarToken();
  }
  function scalarToken() {
    ws();
    if (text[i] === '"' || text[i] === "'") {
      valueStart = i;
      const q = text[i++];
      let out = "";
      while (i < text.length) {
        if (q === '"' && text[i] === "\\") { out += text[i] + text[i + 1]; i += 2; continue; }
        if (text[i] === q) {
          if (q === "'" && text[i + 1] === "'") { out += "'"; i += 2; continue; }
          i++;
          return unquote(q + out + q);
        }
        out += text[i++];
      }
      err("unterminated quoted scalar");
    }
    // Scan a plain scalar in flow context. It ends at a bracket, at a colon, or
    // at a comma that is a separator; see isSeqSeparator.
    while (i < text.length) {
      const c = text[i];
      if (c === "]" || c === "}") break;
      if (c === ":") break;
      if (c === ",") {
        const save = i;
        if (isSeqSeparator()) { i = save; break; }
        i++;
        continue;
      }
      i++;
    }
    const t = text.slice(valueStart, i).replace(/\s+$/, "");
    return resolvePlain(t);
  }
  function seqFlow() {
    i++; // [
    const out = [];
    ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value());
      ws();
      if (isSeqSeparator()) { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      err("expected , or ]");
    }
  }
  function mapFlow() {
    i++; // {
    const out = {};
    ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws();
      valueStart = i;
      const k = scalarKey();
      ws();
      if (text[i] !== ":") err("expected : in flow mapping");
      i++;
      const v = value();
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        throw new AgentDocError(CODES.YAML_DUP_KEY, "duplicate mapping key " + JSON.stringify(k), { line: lineNo });
      }
      out[k] = v;
      ws();
      if (isSeqSeparator()) { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      err("expected , or }");
    }
  }
  // A flow-mapping key is a plain or quoted scalar ending at a colon. Keys are
  // never allowed to swallow a comma, so this is the strict form.
  function scalarKey() {
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i++];
      let out = "";
      while (i < text.length) {
        if (text[i] === "\\" && q === '"') { out += text[i] + text[i + 1]; i += 2; continue; }
        if (text[i] === q) {
          if (q === "'" && text[i + 1] === "'") { out += "'"; i += 2; continue; }
          i++;
          return unquote(q + out + q);
        }
        out += text[i++];
      }
      err("unterminated quoted key");
    }
    const start = i;
    while (i < text.length && !":,]}".includes(text[i])) i++;
    const t = text.slice(start, i).replace(/\s+$/, "");
    if (t.includes(": ")) err("quoted keys are required in flow mappings");
    return resolvePlain(t);
  }

  // A comma inside a flow collection is a separator only when what follows
  // looks like the next element. Real OpenAPI documents contain flow mappings
  // whose plain-scalar values contain commas — `{ description: Body is
  // unreadable, invalid, or wrong. }` — and the YAML ecosystem parses them, so
  // refusing them would reject valid-in-practice contracts. The rule below is
  // deterministic and matches that behaviour: a comma separates when the
  // remainder is a closing bracket, a new key (`ident:`), or the previous token
  // carried no internal whitespace.
  function isSeqSeparator() {
    if (text[i] !== ",") return false;
    const rest = text.slice(i + 1);
    if (/^\s*[}\]]/.test(rest)) return true;
    if (/^\s*[\[{]/.test(rest)) return true;
    if (/^\s*[^,:{}\[\]"']+\s*:/.test(rest)) return true;
    const prev = text.slice(valueStart, i);
    return prev.length > 0 && !/\s/.test(prev);
  }
  const v = value();
  ws();
  if (i !== text.length) err("trailing content after flow collection");
  return v;
}

class Reader {
  constructor(lines, path) {
    this.ls = lines;
    this.path = path;
  }
  skip() {
    while (this.i < this.ls.length && this.ls[this.i].blank) this.i++;
  }
  peek() {
    this.skip();
    return this.i < this.ls.length ? this.ls[this.i] : null;
  }
  node(indent) {
    const l = this.peek();
    if (!l || l.indent < indent) return null;
    if (isSeqEntry(content(l).slice(l.indent))) return this.seq(l.indent);
    return this.map(l.indent);
  }
  map(indent) {
    const out = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      const s = content(l).slice(l.indent);
      if (isSeqEntry(s)) {
        throw new AgentDocError(CODES.YAML_PARSE, "sequence entry where a mapping key was expected", {
          path: this.path, line: l.lineNo,
        });
      }
      if (l.indent > indent) {
        throw new AgentDocError(CODES.YAML_PARSE, "unexpected indentation", { path: this.path, line: l.lineNo });
      }
      const kv = splitKey(s);
      if (!kv) {
        throw new AgentDocError(CODES.YAML_PARSE, "expected 'key: value', got " + JSON.stringify(s.slice(0, 40)), {
          path: this.path, line: l.lineNo,
        });
      }
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) {
        throw new AgentDocError(CODES.YAML_DUP_KEY, "duplicate mapping key " + JSON.stringify(kv.key), {
          path: this.path, line: l.lineNo,
        });
      }
      this.i++;
      out[kv.key] = this.value(l, kv.rest, indent);
    }
    return out;
  }
  seq(indent) {
    const out = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) break;
      const s = content(l).slice(l.indent);
      if (!isSeqEntry(s)) {
        if (l.indent > indent) {
          throw new AgentDocError(CODES.YAML_PARSE, "unexpected indentation in sequence", { path: this.path, line: l.lineNo });
        }
        break;
      }
      const rest = s.slice(1).replace(/^[ \t]+/, "");
      if (rest === "") {
        this.i++;
        out.push(this.node(indent + 1));
        continue;
      }
      const dashOffset = l.indent + (s.length - rest.length);
      if (splitKey(rest)) {
        // Inline mapping opened by the dash: re-anchor it at the text column so
        // continuation lines line up naturally.
        this.ls[this.i] = { raw: " ".repeat(dashOffset) + rest, lineNo: l.lineNo, indent: dashOffset, blank: false, _c: null };
        out.push(this.map(dashOffset));
      } else {
        this.i++;
        out.push(this.scalarValue(l, rest, indent));
      }
    }
    return out;
  }
  value(l, rest, indent) {
    if (rest === "") return this.node(indent + 1);
    if (rest[0] === "|" || rest[0] === ">") return this.blockScalar(l, rest, indent);
    return scalar(rest, l.lineNo);
  }
  scalarValue(l, rest, indent) {
    if (rest[0] === "|" || rest[0] === ">") return this.blockScalar(l, rest, indent);
    return scalar(rest, l.lineNo);
  }
  blockScalar(l, head, indent) {
    const m = /^([|>])([-+]?)([0-9]*)([-+]?)\s*$/.exec(head);
    if (!m) {
      throw new AgentDocError(CODES.YAML_UNSUPPORTED, "unsupported block scalar header " + JSON.stringify(head), {
        path: this.path, line: l.lineNo,
      });
    }
    const folded = m[1] === ">";
    const chomp = m[2] || m[4] || "";
    const explicit = m[3] ? Number(m[3]) : 0;
    const body = [];
    let blockIndent = explicit ? indent + explicit : -1;
    while (this.i < this.ls.length) {
      const n = this.ls[this.i];
      const t = n.raw.trim();
      if (t === "" && n.indent === 0) { body.push(""); this.i++; continue; }
      if (n.indent <= indent) break;
      if (blockIndent < 0) blockIndent = n.indent;
      body.push(n.raw.slice(blockIndent));
      this.i++;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    let text;
    if (folded) {
      const parts = [];
      let cur = "";
      for (const b of body) {
        if (b === "") { parts.push(cur); cur = ""; continue; }
        cur = cur === "" ? b : cur + " " + b;
      }
      parts.push(cur);
      text = parts.join("\n");
    } else {
      text = body.join("\n");
    }
    if (chomp !== "-") text += "\n";
    return text;
  }
}

// Parse a multi-document YAML stream. Returns [{doc, line}] with 1-based line
// numbers of each document root.
export function parseYamlDocuments(src, path) {
  if (typeof src !== "string") throw new AgentDocError(CODES.UTF8, "expected text for " + path, { path });
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  scanBanned(src, path);
  const all = src.split("\n").map((raw, i) => makeLine(raw.replace(/\r$/, ""), i + 1));
  const out = [];
  let start = 0;
  const bounds = [];
  for (let i = 0; i < all.length; i++) {
    const t = all[i].raw;
    if (/^---(\s|$)/.test(t)) { bounds.push({ kind: "start", i }); }
    else if (/^\.\.\.(\s|$)/.test(t)) { bounds.push({ kind: "end", i }); }
  }
  const segs = [];
  let from = 0;
  for (const b of bounds) {
    if (b.kind === "start") { if (b.i > from) segs.push([from, b.i]); from = b.i + 1; }
    else { segs.push([from, b.i]); from = b.i + 1; }
  }
  segs.push([from, all.length]);
  for (const [a, b] of segs) {
    const lines = all.slice(a, b);
    const r = new Reader(lines, path);
    r.i = 0;
    const first = r.peek();
    if (!first) continue;
    const rootLine = first.lineNo;
    const value = r.node(first.indent);
    if (r.peek()) {
      throw new AgentDocError(CODES.YAML_PARSE, "unparsed trailing content", { path, line: r.peek().lineNo });
    }
    if (value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new AgentDocError(CODES.YAML_NON_MAP_ROOT, "document root must be a mapping", { path, line: rootLine });
    }
    out.push({ doc: value, line: rootLine });
  }
  return out;
}

export function parseYamlOne(src, path) {
  const docs = parseYamlDocuments(src, path);
  if (docs.length !== 1) {
    throw new AgentDocError(CODES.YAML_PARSE, "expected exactly one YAML document in " + path, { path });
  }
  return docs[0].doc;
}
