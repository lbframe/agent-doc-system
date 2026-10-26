// TOML reader for deployment manifests and Python project files.
//
// The subset is the one those files actually use: tables, arrays of tables,
// dotted keys, strings, integers, floats, booleans, arrays and inline tables.
// Strings follow TOML 1.0: basic, literal, and both multi-line forms. Literal
// strings are raw — a backslash is a backslash. Anything outside this subset
// (dates, hex integers, inf/nan, an unknown escape) is rejected. Returning the
// raw text would be a mis-parse, and a mis-parsed manifest is worse than a
// diagnostic.
import { AgentDocError, CODES } from "./codes.mjs";

export function parse(src, path = "") {
  const text = String(src).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const p = new Parser(text, path);
  return p.parseDocument();
}

class Parser {
  constructor(src, path) {
    this.s = src;
    this.n = src.length;
    this.i = 0;
    this.line = 1;
    this.path = path;
  }

  parseDocument() {
    const root = {};
    let cur = root;
    while (!this.eof()) {
      this.skipIgnorable();
      if (this.eof()) break;
      if (this.peek() === "[") {
        const header = this.parseTableHeader();
        cur = this.openTable(root, header.keys, header.isArray);
        continue;
      }
      const keys = this.parseKey();
      this.skipSpaces();
      this.expect("=");
      this.skipSpaces();
      const value = this.parseValue();
      this.assign(cur, keys, value);
      this.endLine();
    }
    return root;
  }

  // ── structure ──────────────────────────────────────────────────────────

  parseTableHeader() {
    this.expect("[");
    this.skipSpaces();
    let isArray = false;
    if (this.peek() === "[") {
      isArray = true;
      this.i++;
      this.skipSpaces();
    }
    const keys = this.parseKey();
    this.skipSpaces();
    this.expect("]");
    if (isArray) {
      this.skipSpaces();
      this.expect("]");
    }
    this.endLine();
    return { keys, isArray };
  }

  openTable(root, keys, isArray) {
    let cur = root;
    for (let k = 0; k < keys.length - 1; k++) {
      cur = this.descend(cur, keys[k]);
    }
    const key = keys[keys.length - 1];
    if (isArray) {
      if (cur[key] === undefined) cur[key] = [];
      if (!Array.isArray(cur[key])) this.die("key '" + key + "' is not an array of tables");
      const obj = {};
      cur[key].push(obj);
      return obj;
    }
    if (cur[key] === undefined) cur[key] = {};
    if (cur[key] === null || typeof cur[key] !== "object" || Array.isArray(cur[key])) {
      this.die("key '" + key + "' cannot be a table");
    }
    return cur[key];
  }

  descend(cur, key) {
    if (cur[key] === undefined) cur[key] = {};
    if (cur[key] === null || typeof cur[key] !== "object" || Array.isArray(cur[key])) {
      this.die("key '" + key + "' cannot contain a nested key");
    }
    return cur[key];
  }

  assign(table, keys, value) {
    let cur = table;
    for (let k = 0; k < keys.length - 1; k++) cur = this.descend(cur, keys[k]);
    const key = keys[keys.length - 1];
    if (Object.prototype.hasOwnProperty.call(cur, key)) this.die("duplicate key '" + key + "'");
    cur[key] = value;
  }

  parseKey() {
    const keys = [];
    for (;;) {
      this.skipSpaces();
      keys.push(this.parseKeySegment());
      this.skipSpaces();
      if (this.peek() !== ".") break;
      this.i++;
    }
    return keys;
  }

  parseKeySegment() {
    const c = this.peek();
    if (c === '"') return this.parseBasicString(false);
    if (c === "'") return this.parseLiteralString(false);
    const start = this.i;
    while (/[A-Za-z0-9_-]/.test(this.peek())) this.i++;
    if (this.i === start) this.die("expected a key");
    return this.s.slice(start, this.i);
  }

  // ── values ─────────────────────────────────────────────────────────────

  parseValue() {
    const c = this.peek();
    if (c === '"') return this.s.startsWith('"""', this.i) ? this.parseBasicString(true) : this.parseBasicString(false);
    if (c === "'") return this.s.startsWith("'''", this.i) ? this.parseLiteralString(true) : this.parseLiteralString(false);
    if (c === "[") return this.parseArray();
    if (c === "{") return this.parseInlineTable();
    if (c === "t" && this.startsWithWord("true")) { this.i += 4; return true; }
    if (c === "f" && this.startsWithWord("false")) { this.i += 5; return false; }
    if (c === "+" || c === "-" || (c >= "0" && c <= "9")) return this.parseNumber();
    this.die("unsupported TOML value");
  }

  startsWithWord(word) {
    if (!this.s.startsWith(word, this.i)) return false;
    const after = this.s[this.i + word.length];
    return after === undefined || /[\s,\]}#]/.test(after);
  }

  parseArray() {
    this.expect("[");
    const out = [];
    for (;;) {
      this.skipIgnorable();
      if (this.peek() === "]") { this.i++; return out; }
      out.push(this.parseValue());
      this.skipIgnorable();
      if (this.peek() === ",") { this.i++; continue; }
      if (this.peek() === "]") { this.i++; return out; }
      this.die("expected ',' or ']' in array");
    }
  }

  // Newlines inside an inline table are TOML 1.1. 1.0 rejects them, and so do
  // we: accepting the break would hide a file this reader does not fully model.
  parseInlineTable() {
    this.expect("{");
    const out = {};
    for (;;) {
      this.skipSpaces();
      if (this.peek() === "}") { this.i++; return out; }
      if (this.peek() === "\n") this.die("newline in an inline table is not supported");
      const keys = this.parseKey();
      this.skipSpaces();
      this.expect("=");
      this.skipSpaces();
      if (this.peek() === "\n") this.die("newline in an inline table is not supported");
      const value = this.parseValue();
      this.assign(out, keys, value);
      this.skipSpaces();
      if (this.peek() === ",") { this.i++; continue; }
      if (this.peek() === "}") { this.i++; return out; }
      if (this.peek() === "\n") this.die("newline in an inline table is not supported");
      this.die("expected ',' or '}' in inline table");
    }
  }

  parseBasicString(multi) {
    const delim = multi ? '"""' : '"';
    this.i += delim.length;
    if (multi && this.peek() === "\n") { this.i++; this.line++; }
    let out = "";
    while (!this.eof()) {
      if (!multi && this.peek() === "\n") this.die("unterminated basic string");
      if (this.s.startsWith(delim, this.i)) {
        // A multi-line string may contain one or two quotes. Three close it,
        // unless a longer run leaves a quote that still belongs to the content
        // — TOML keeps the extra quotes and closes on the final three.
        if (!multi) { this.i += delim.length; return out; }
        let q = 0;
        while (this.s[this.i + q] === '"') q++;
        if (q >= 3) {
          const keep = q === 3 ? 0 : q - 3;
          // Six or more quotes: the closing delimiter is the last three only
          // when at least one of the earlier quotes is content. A count of
          // exactly three always closes. More than five in a row is content
          // plus a closer: `q - 3` quotes stay, except we must not treat a
          // closer that is the entire remainder wrongly. TOML: the first
          // three quotes that can close, do close, and 1–2 quotes before a
          // closer are content. So from a run of q>=3, content gets q-3 and
          // the last three close — but only when those last three are the
          // delimiter. A run of 4 is one content quote + closer. A run of 5
          // is two + closer. A run of 6 closes immediately if we greedily
          // take the first three... The spec says three quotes end the
          // string, so the FIRST three close. Extra quotes after the closer
          // are trailing content for the caller to reject. That matches
          // `"""hello""""` being `hello"` + a leftover quote only if we keep
          // one and close on the next three: i.e. when q>3, we could either
          // close at the first three (content gets 0, leftover quotes remain)
          // or keep q-3. The first-three rule makes `""""` inside a multi-line
          // string impossible without escapes, which is what the spec says:
          // "To write three quotation marks you need to escape at least one."
          // So a run of three or more closes at the first three.
          this.i += 3;
          return out;
        }
        out += '"'.repeat(q);
        this.i += q;
        continue;
      }
      const c = this.peek();
      if (c === "\\") {
        if (multi && this.lineEndingBackslash()) continue;
        out += this.basicEscape();
        continue;
      }
      this.rejectControl(c, multi);
      if (c === "\n") this.line++;
      out += c;
      this.i++;
    }
    this.die("unterminated basic string");
  }

  // A `\` that is the last non-whitespace character on the line is not an
  // escape. It deletes itself, the line break, and the following whitespace.
  lineEndingBackslash() {
    let j = this.i + 1;
    while (j < this.n && (this.s[j] === " " || this.s[j] === "\t")) j++;
    if (j >= this.n || this.s[j] !== "\n") return false;
    this.i = j + 1;
    this.line++;
    while (this.peek() === " " || this.peek() === "\t" || this.peek() === "\n") {
      if (this.peek() === "\n") this.line++;
      this.i++;
    }
    return true;
  }

  basicEscape() {
    this.i++; // consume backslash
    const c = this.peek();
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (Object.prototype.hasOwnProperty.call(simple, c)) { this.i++; return simple[c]; }
    if (c === "u" || c === "U") {
      this.i++;
      const n = c === "u" ? 4 : 8;
      let hex = "";
      for (let k = 0; k < n; k++) {
        const h = this.peek();
        if (!/[0-9a-fA-F]/.test(h)) this.die("invalid unicode escape");
        hex += h;
        this.i++;
      }
      const cp = parseInt(hex, 16);
      if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) this.die("invalid unicode scalar");
      return String.fromCodePoint(cp);
    }
    this.die("unsupported escape '\\" + (c || "") + "'");
  }

  // Literal strings are raw. Backslash is not an escape. A single-line literal
  // cannot contain a quote or a newline; a multi-line literal closes on '''.
  parseLiteralString(multi) {
    const delim = multi ? "'''" : "'";
    this.i += delim.length;
    if (multi && this.peek() === "\n") { this.i++; this.line++; }
    let out = "";
    while (!this.eof()) {
      if (!multi && this.peek() === "\n") this.die("unterminated literal string");
      if (this.s.startsWith(delim, this.i)) {
        if (!multi) { this.i += delim.length; return out; }
        let q = 0;
        while (this.s[this.i + q] === "'") q++;
        if (q >= 3) { this.i += 3; return out; }
        out += "'".repeat(q);
        this.i += q;
        continue;
      }
      const c = this.peek();
      this.rejectControl(c, multi);
      if (c === "\n") this.line++;
      out += c;
      this.i++;
    }
    this.die("unterminated literal string");
  }

  parseNumber() {
    const start = this.i;
    if (this.peek() === "+" || this.peek() === "-") this.i++;
    const body = this.s.slice(this.i);
    if (/^0[xob]/i.test(body) || /^inf\b/i.test(body) || /^nan\b/i.test(body)) {
      this.die("unsupported TOML numeric form");
    }
    // Date-times start like numbers (`2024-` or `12:`). They are not floats.
    const rest = this.s.slice(start);
    if (/^[+-]?\d{4}-\d{2}-\d{2}/.test(rest) || /^[+-]?\d{2}:\d{2}:\d{2}/.test(rest)) {
      this.die("unsupported TOML date or time");
    }
    const num = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest);
    if (!num) this.die("invalid number");
    const raw = num[0];
    if (raw === "+" || raw === "-" || raw.endsWith("_") || raw.includes("__")) this.die("invalid number");
    this.i = start + raw.length;
    if (/[A-Za-z_]/.test(this.peek())) this.die("unsupported TOML numeric form");
    const n = Number(raw.replace(/_/g, ""));
    if (!Number.isFinite(n)) this.die("unsupported TOML numeric form");
    return n;
  }

  rejectControl(c, multi) {
    if (c === "\n" && multi) return;
    if (c === "\t") return;
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) this.die("control character in string");
  }

  // ── scanning ───────────────────────────────────────────────────────────

  skipSpaces() {
    while (this.peek() === " " || this.peek() === "\t") this.i++;
  }

  skipIgnorable() {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t") { this.i++; continue; }
      if (c === "\n") { this.i++; this.line++; continue; }
      if (c === "#") {
        while (!this.eof() && this.peek() !== "\n") this.i++;
        continue;
      }
      return;
    }
  }

  endLine() {
    this.skipSpaces();
    if (this.peek() === "#") {
      while (!this.eof() && this.peek() !== "\n") this.i++;
    }
    if (this.eof()) return;
    if (this.peek() === "\n") { this.i++; this.line++; return; }
    this.die("unexpected trailing content");
  }

  expect(ch) {
    if (this.peek() !== ch) this.die("expected '" + ch + "'");
    this.i++;
  }

  peek() { return this.i < this.n ? this.s[this.i] : ""; }
  eof() { return this.i >= this.n; }

  die(message) {
    const where = this.path ? " in " + this.path : "";
    throw new AgentDocError(CODES.YAML_PARSE, message + " (TOML line " + this.line + where + ")", { path: this.path, line: this.line });
  }
}
