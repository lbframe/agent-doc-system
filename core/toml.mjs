// Minimal TOML reader for platform deployment manifests.
//
// Only what a deployment manifest needs: tables, arrays of tables, key/value
// pairs, strings, integers, booleans, inline arrays and inline tables. Anything
// richer is rejected rather than guessed at, because a mis-parsed manifest
// would produce confident nonsense about deployed state.
import { AgentDocError, CODES } from "./codes.mjs";

export function parse(src, path = "") {
  const root = {};
  let cur = root;
  const lines = String(src).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    const table = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (table) {
      const isArray = line.startsWith("[[");
      const keys = splitKeyPath(table[1]);
      cur = root;
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        const last = k === keys.length - 1;
        if (last && isArray) {
          if (!Array.isArray(cur[key])) cur[key] = [];
          const obj = {};
          cur[key].push(obj);
          cur = obj;
        } else {
          if (cur[key] === undefined) cur[key] = {};
          cur = cur[key];
        }
      }
      continue;
    }
    const eq = findEquals(line);
    if (eq < 0) {
      throw new AgentDocError(CODES.YAML_PARSE, "unparseable TOML line " + (i + 1) + (path ? " in " + path : ""), { path, line: i + 1 });
    }
    const key = unquoteKey(line.slice(0, eq).trim());
    let valueText = line.slice(eq + 1).trim();
    // Multi-line arrays.
    while (unbalanced(valueText) && i + 1 < lines.length) {
      i++;
      valueText += " " + stripComment(lines[i]).trim();
    }
    const keys = splitKeyPath(key);
    let target = cur;
    for (let k = 0; k < keys.length - 1; k++) {
      if (target[keys[k]] === undefined) target[keys[k]] = {};
      target = target[keys[k]];
    }
    target[keys[keys.length - 1]] = value(valueText, path, i + 1);
  }
  return root;
}

function unbalanced(s) {
  let b = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "[" || c === "{") b++;
    if (c === "]" || c === "}") b--;
  }
  return b > 0;
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\" && q === '"') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#") return s.slice(0, i);
  }
  return s;
}

function findEquals(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\" && q === '"') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "=") return i;
  }
  return -1;
}

function splitKeyPath(s) {
  return s.split(".").map((k) => unquoteKey(k.trim()));
}

function unquoteKey(k) {
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) return k.slice(1, -1);
  return k;
}

function value(t, path, line) {
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^".*"$/.test(t)) return JSON.parse(t.replace(/\\'/g, "'"));
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t.startsWith("[")) return parseArray(t, path, line);
  if (t.startsWith("{")) return parseInlineTable(t, path, line);
  if (t === "") return "";
  return t;
}

function parseArray(t, path, line) {
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  const out = [];
  let buf = "";
  let q = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) { buf += c; if (c === "\\") { buf += inner[++i] || ""; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === "[" || c === "{") { depth++; buf += c; continue; }
    if (c === "]" || c === "}") { depth--; buf += c; continue; }
    if (c === "," && depth === 0) { out.push(value(buf.trim(), path, line)); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(value(buf.trim(), path, line));
  return out;
}

function parseInlineTable(t, path, line) {
  const inner = t.slice(1, -1).trim();
  const out = {};
  if (!inner) return out;
  for (const part of splitTop(inner)) {
    const eq = findEquals(part);
    if (eq < 0) continue;
    out[unquoteKey(part.slice(0, eq).trim())] = value(part.slice(eq + 1).trim(), path, line);
  }
  return out;
}

function splitTop(s) {
  const out = [];
  let buf = "";
  let q = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { buf += c; if (c === "\\") { buf += s[++i] || ""; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === "[" || c === "{") { depth++; buf += c; continue; }
    if (c === "]" || c === "}") { depth--; buf += c; continue; }
    if (c === "," && depth === 0) { out.push(buf.trim()); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
