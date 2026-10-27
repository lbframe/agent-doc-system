// TOML reader for deployment manifests and Python project files.
//
// Values follow TOML 1.0: tables, arrays of tables, dotted keys, strings,
// integers (decimal, hex, octal, binary, with `_` separators), floats
// (including inf and nan), booleans, dates and times, arrays and inline
// tables. Safe integers are Numbers; larger integers are exact BigInts.
// Strings are basic, literal, and both multi-line forms. Literal
// strings are raw — a backslash is a backslash. Dates and times are returned
// as the exact lexeme; nothing in the compiler derives a fact from them.
// Only a form the spec rejects is a diagnostic. A mis-parsed manifest is
// worse than one, and a valid `[tool.*]` table must not fail the compile.
import { AgentDocError, CODES } from "./codes.mjs";

export function parse(src, path = "") {
  // Byte input must be decoded without replacing malformed UTF-8. String
  // callers already own decoding; still reject unpaired UTF-16 surrogates.
  let text;
  try {
    text = src instanceof Uint8Array
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(src)
      : String(src);
  } catch {
    throw new AgentDocError(CODES.YAML_PARSE, "invalid UTF-8 in TOML", { path, line: 1 });
  }
  const p = new Parser(text.replace(/\r\n/g, "\n"), path);
  const invalid = /[\uD800-\uDFFF]/u.exec(p.s);
  if (invalid) {
    p.line = p.s.slice(0, invalid.index).split("\n").length;
    p.die("invalid unicode scalar");
  }
  return p.parseDocument();
}

class Parser {
  constructor(src, path) {
    this.s = src;
    this.n = src.length;
    this.i = 0;
    this.line = 1;
    this.path = path;
    // Metadata stays outside returned values. Only implicit header parents can
    // later be declared with [table]; inline tables can never be extended.
    this.tables = new WeakMap();
    this.tableArrays = new WeakSet();
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
    let isArray = false;
    if (this.peek() === "[") {
      isArray = true;
      this.i++;
      this.skipSpaces();
    }
    const keys = this.parseKey();
    this.skipSpaces();
    this.expect("]");
    if (isArray) this.expect("]");
    this.endLine();
    return { keys, isArray };
  }

  table(kind) {
    const out = {};
    this.tables.set(out, kind);
    return out;
  }

  has(table, key) { return Object.prototype.hasOwnProperty.call(table, key); }

  put(table, key, value) {
    // __proto__, constructor and toString are ordinary TOML keys.
    Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
  }

  openTable(root, keys, isArray) {
    let cur = root;
    for (const key of keys.slice(0, -1)) cur = this.descend(cur, key, true);
    const key = keys.at(-1);
    if (isArray) {
      if (!this.has(cur, key)) {
        const array = [];
        this.tableArrays.add(array);
        this.put(cur, key, array);
      }
      if (!this.tableArrays.has(cur[key])) this.die("key '" + key + "' is not an array of tables");
      const obj = this.table("explicit");
      cur[key].push(obj);
      return obj;
    }
    if (!this.has(cur, key)) this.put(cur, key, this.table("implicit"));
    if (this.tables.get(cur[key]) !== "implicit") this.die("duplicate or conflicting table '" + key + "'");
    this.tables.set(cur[key], "explicit");
    return cur[key];
  }

  descend(cur, key, header = false) {
    if (!this.has(cur, key)) this.put(cur, key, this.table(header ? "implicit" : "dotted"));
    let value = cur[key];
    // A header below an array of tables belongs to its most recent element.
    if (header && this.tableArrays.has(value)) value = value.at(-1);
    const kind = this.tables.get(value);
    if (!kind || kind === "inline" || (!header && kind === "explicit")) {
      this.die("key '" + key + "' cannot contain a nested key");
    }
    return value;
  }

  assign(table, keys, value) {
    let cur = table;
    for (const key of keys.slice(0, -1)) cur = this.descend(cur, key);
    const key = keys.at(-1);
    if (this.has(cur, key)) this.die("duplicate key '" + key + "'");
    this.put(cur, key, value);
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
    if (c === "+" || c === "-" || c === "i" || c === "n" || (c >= "0" && c <= "9")) return this.parseNumber();
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
    const out = this.table("inline");
    this.skipSpaces();
    if (this.peek() === "}") { this.i++; return out; }
    for (;;) {
      this.skipSpaces();
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
        if (!multi) { this.i++; return out; }
        // One or two quotes may precede the closing three, but never three.
        let q = 3;
        while (this.s[this.i + q] === '"') q++;
        if (q > 5) this.die("too many quotes at end of basic string");
        this.i += q;
        return out + '"'.repeat(q - 3);
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
        if (!multi) { this.i++; return out; }
        // One or two quotes may precede the closing three, but never three.
        let q = 3;
        while (this.s[this.i + q] === "'") q++;
        if (q > 5) this.die("too many quotes at end of literal string");
        this.i += q;
        return out + "'".repeat(q - 3);
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
    if (this.peek() !== "+" && this.peek() !== "-") {
      const dated = this.tryDateOrTime();
      if (dated !== null) return dated;
      if (this.s.startsWith("0x", this.i) || this.s.startsWith("0o", this.i) || this.s.startsWith("0b", this.i)) {
        return this.parseRadixInt();
      }
    }
    const special = this.trySpecialFloat();
    if (special !== null) return special;
    const start = this.i;
    const rest = this.s.slice(start);
    const num = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest);
    if (!num) this.die("invalid number");
    const raw = num[0];
    if (raw === "+" || raw === "-" || raw.endsWith("_") || raw.includes("__")) this.die("invalid number");
    this.i = start + raw.length;
    if (/[A-Za-z_]/.test(this.peek())) this.die("invalid number");
    const clean = raw.replace(/_/g, "");
    return /[.eE]/.test(clean) ? Number(clean) : this.integer(clean);
  }

  // inf and nan are lowercase. A sign is allowed. `Inf` is not a float.
  trySpecialFloat() {
    const m = /^[+-]?(inf|nan)(?![A-Za-z0-9_])/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    if (m[1] === "nan") return NaN;
    return m[0].startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }

  // Hex, octal and binary have no sign. Underscores sit between digits.
  parseRadixInt() {
    const prefix = this.s.slice(this.i, this.i + 2);
    const base = prefix === "0x" ? 16 : prefix === "0o" ? 8 : prefix === "0b" ? 2 : 0;
    const digit = base === 16 ? /[0-9a-fA-F]/ : base === 8 ? /[0-7]/ : /[01]/;
    this.i += 2;
    if (!digit.test(this.peek())) this.die("invalid number");
    let body = "";
    let prevUnderscore = false;
    while (digit.test(this.peek()) || this.peek() === "_") {
      const c = this.peek();
      if (c === "_") {
        if (prevUnderscore) this.die("invalid number");
        prevUnderscore = true;
      } else {
        prevUnderscore = false;
        body += c;
      }
      this.i++;
    }
    if (prevUnderscore || !body) this.die("invalid number");
    if (/[A-Za-z0-9_]/.test(this.peek())) this.die("invalid number");
    return this.integer(prefix + body);
  }

  integer(raw) {
    const value = BigInt(raw);
    // Preserve the existing Number API for safe integers; never round int64s.
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value) : value;
  }

  // A local date, local time, local date-time, or offset date-time. The
  // lexeme is the value: callers do not interpret it.
  tryDateOrTime() {
    const s = this.s.slice(this.i);
    if (/^\d{2}:\d{2}:\d{2}/.test(s)) return this.readLocalTime();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return this.readDate();
    return null;
  }

  readLocalTime() {
    const m = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?/.exec(this.s.slice(this.i));
    if (!m) this.die("invalid date or time");
    this.checkTime(m[1], m[2], m[3]);
    this.i += m[0].length;
    this.rejectDateTail();
    return m[0];
  }

  readDate() {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(this.s.slice(this.i));
    if (!m) this.die("invalid date or time");
    this.checkDate(Number(m[1]), Number(m[2]), Number(m[3]));
    let raw = m[0];
    const rest = this.s.slice(this.i + raw.length);
    if (/^[Tt]/.test(rest) || /^ \d{2}:/.test(rest)) {
      const tm = /^[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?/.exec(rest);
      if (!tm) this.die("invalid date or time");
      this.checkTime(tm[1], tm[2], tm[3]);
      if (tm[5] && !/^[Zz]$/.test(tm[5])) this.checkTime(tm[5].slice(1, 3), tm[5].slice(4, 6), "00");
      raw += tm[0];
    }
    this.i += raw.length;
    this.rejectDateTail();
    return raw;
  }

  rejectDateTail() {
    if (/[0-9A-Za-z_]/.test(this.peek())) this.die("invalid date or time");
  }

  checkDate(y, m, d) {
    if (y < 1 || m < 1 || m > 12) this.die("invalid date or time");
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (d < 1 || d > dim[m - 1]) this.die("invalid date or time");
  }

  checkTime(hh, mm, ss) {
    const h = Number(hh);
    const m = Number(mm);
    const s = Number(ss);
    if (h > 23 || m > 59 || s > 59) this.die("invalid date or time");
  }

  rejectControl(c, multi) {
    if (c === "\n" && multi) return;
    if (c === "\t") return;
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) this.die("control character");
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
        this.skipComment();
        continue;
      }
      return;
    }
  }

  skipComment() {
    while (!this.eof() && this.peek() !== "\n") {
      this.rejectControl(this.peek(), false);
      this.i++;
    }
  }

  endLine() {
    this.skipSpaces();
    if (this.peek() === "#") this.skipComment();
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
