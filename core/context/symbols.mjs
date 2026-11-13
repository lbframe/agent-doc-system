import { CODES } from "../codes.mjs";
// On-demand lexical experiment. These are source navigation candidates, never
// complete call/dependency analysis and never grounds for removing checks.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalPath } from "../paths.mjs";

function reject(message) { throw Object.assign(new Error(message), { code: CODES.SYMBOL_REQUEST }); }
// Preserve source offsets while hiding comments and quoted text. Interpolated
// template expressions and regex literals are deliberately unsupported.
function codeOnly(text) {
  let out = "", state = "code";
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out += "  "; i++; }
      else if (c === "/" && next === "*") { state = "block"; out += "  "; i++; }
      else if (c === "'" || c === '"' || c === "`") { state = c; out += " "; }
      else out += c;
    } else if (state === "line") {
      out += c === "\n" ? "\n" : " ";
      if (c === "\n") state = "code";
    } else if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i++; }
      else out += c === "\n" ? "\n" : " ";
    } else if (c === "\\") {
      out += " ";
      if (next !== undefined) { out += next === "\n" ? "\n" : " "; i++; }
    } else {
      out += c === "\n" ? "\n" : " ";
      if (c === state) state = "code";
    }
  }
  return out;
}

export function indexTypeScriptSymbols(root, files) {
  if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== "string")) reject("files must be a nonempty list of TypeScript paths");
  const base = fs.realpathSync(root);
  const paths = files.map((file) => {
    const rel = canonicalPath(file);
    if (rel === null || !/\.(?:[cm]?ts|tsx)$/.test(rel)) reject("only repository-relative TypeScript files are supported");
    return rel;
  });
  const sources = [...new Set(paths)].sort().map((file) => {
    let absolute, source;
    try {
      absolute = fs.realpathSync(path.join(base, file));
      if (!absolute.startsWith(base + path.sep)) reject("source escapes repository");
      source = fs.readFileSync(absolute, "utf8");
    } catch (e) {
      if (e.code === CODES.SYMBOL_REQUEST) throw e;
      reject("source unavailable: " + file);
    }
    const clean = codeOnly(source);
    const declarations = [];
    const pattern = /\b(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of clean.matchAll(pattern)) {
      const offset = match.index + match[0].lastIndexOf(match[3]);
      const before = source.slice(0, offset);
      declarations.push({ name: match[3], kind: match[2], exported: Boolean(match[1]),
        line: before.split("\n").length, column: offset - before.lastIndexOf("\n") });
    }
    return { path: file, sha256: createHash("sha256").update(source).digest("hex"), declarations, clean };
  });
  const names = new Set(sources.flatMap((s) => s.declarations.map((d) => d.name)));
  const indexed = sources.map(({ clean, ...file }) => {
    const references = [];
    for (const match of clean.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!names.has(match[0])) continue;
      const before = clean.slice(0, match.index);
      const line = before.split("\n").length, column = match.index - before.lastIndexOf("\n");
      const declaration = file.declarations.some((d) => d.line === line && d.column === column);
      if (!declaration) references.push({ name: match[0], line, column });
    }
    return { ...file, references };
  });
  return { schemaVersion: "agentdoc.dev/symbol-candidates/v1", coverage: { partial: true, checkSelection: "unchanged",
    limitations: ["lexical candidates only; scope, imports and overloads are not resolved", "dynamic uses, template interpolation and regex literals are not resolved", "coverage is restricted to the explicitly requested files"] }, files: indexed };
}
