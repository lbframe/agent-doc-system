// Imports between components of one JavaScript/TypeScript package.
//
// A package split into several components (one descriptor per directory) has
// no manifest edge between them: they share one package.json. The only
// evidence of `lib` depending on `db` is a source file in `lib` importing a
// file in `db`, by a relative path (`../db`) or through a tsconfig/jsconfig
// path alias (`@/db`). This module resolves those specifiers to repository
// files and the files to their owning components.
//
// Resolution never guesses. A specifier counts only when it resolves to a file
// that is in a unit's input set, with the extension and index rules TypeScript
// and bundlers apply. An alias is read from `compilerOptions.paths` (and
// `baseUrl`) of the nearest tsconfig.json or jsconfig.json, following
// repository-relative `extends`. Aliases defined in code (Vite, webpack) are not
// read: that would mean executing configuration.
import path from "node:path";
import { canonicalPath, joinPath, longestOwner, REPO_ROOT } from "../core/paths.mjs";

export const JS_SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
// TypeScript lets an ESM import name the emitted file (`./x.js`) for a source
// file that is `./x.ts`.
const EMITTED = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

// Module specifiers named by import statements: static and type-only imports,
// re-exports, side-effect imports, dynamic import() and require(). Comments are
// removed first, so a commented-out import is not evidence.
export function jsImportSpecifiers(text) {
  const code = stripComments(text);
  const out = new Set();
  const STATIC = /(?:^|[;\s}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\bfrom\s*)?(["'])([^"'\n]+)\1/g;
  const CALL = /\b(?:import|require)\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
  for (const m of code.matchAll(STATIC)) out.add(m[2]);
  for (const m of code.matchAll(CALL)) out.add(m[2]);
  return out;
}

function stripComments(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// JSON with comments and trailing commas, as tsconfig allows. Strings are kept
// intact, so `"@/*"` is never read as the start of a comment.
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// Per-compile state, shared by every unit: the input files of all units, which
// components own them, and the path-alias configuration of each directory.
const STATE = new WeakMap();

function state(ctx) {
  let s = STATE.get(ctx.repo);
  if (s && s.discovery === ctx.discovery) return s;
  const owned = ctx.discovery.eligible.filter((u) => u.component);
  const files = new Set();
  for (const u of owned) for (const f of ctx.repo.walkUnit(u.root)) files.add(f);
  s = {
    discovery: ctx.discovery,
    files,
    byRoot: new Map(owned.map((u) => [canonicalPath(u.root), u])),
    configForDir: new Map(),
    configs: new Map(),
  };
  STATE.set(ctx.repo, s);
  return s;
}

// The unit owning a repository file: the deepest eligible unit root above it.
// Unit walks already exclude nested units, so the deepest root is the owner.
export function owningUnit(ctx, file) {
  const s = state(ctx);
  const root = longestOwner(s.byRoot.keys(), file);
  return root === null ? null : s.byRoot.get(root);
}

// The file a resolved base path names, by TypeScript's and bundlers' rules.
function resolveFile(files, base) {
  const b = canonicalPath(base);
  if (b === null || b === REPO_ROOT) return null;
  if (files.has(b)) return b;
  for (const ext of EXTENSIONS) if (files.has(b + ext)) return b + ext;
  const ext = path.posix.extname(b);
  for (const alt of EMITTED[ext] || []) {
    const swapped = b.slice(0, -ext.length) + alt;
    if (files.has(swapped)) return swapped;
  }
  for (const ext2 of EXTENSIONS) if (files.has(b + "/index" + ext2)) return b + "/index" + ext2;
  return null;
}

// The alias configuration that governs files in `dir`: the nearest
// tsconfig.json or jsconfig.json, merged with what it extends. Directories are
// looked up in the unit walks, so a config inside a unit costs no probe; a
// directory outside every unit is probed, and the probe is an input.
function configFor(ctx, s, dir) {
  const key = dir || REPO_ROOT;
  if (s.configForDir.has(key)) return s.configForDir.get(key);
  let found = null;
  for (const name of CONFIG_NAMES) {
    const p = joinPath(key, name);
    const known = s.files.has(p) || (!owningUnit(ctx, p) && ctx.repo.exists(p));
    if (known) {
      found = loadConfig(ctx, s, p, new Set());
      break;
    }
  }
  if (!found && key !== REPO_ROOT) found = configFor(ctx, s, path.posix.dirname(key) === "." ? REPO_ROOT : path.posix.dirname(key));
  s.configForDir.set(key, found);
  return found;
}

// { baseUrl, paths, pathsBase } with every directory repository-relative.
// baseUrl is relative to the config that sets it; paths are relative to the
// effective baseUrl, or to the config that sets them when there is none.
function loadConfig(ctx, s, file, seen) {
  if (s.configs.has(file)) return s.configs.get(file);
  if (seen.has(file)) return null;
  seen.add(file);
  let json;
  try {
    json = parseJsonc(ctx.repo.readText(file));
  } catch {
    s.configs.set(file, null);
    return null;
  }
  const dir = path.posix.dirname(file);
  let merged = { baseUrl: null, paths: null, pathsBase: null };
  const parents = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
  for (const ext of parents) {
    // Only a repository-relative parent is read. A package parent lives in
    // node_modules, which is not a repository input.
    if (typeof ext !== "string" || !/^\.\.?\//.test(ext)) continue;
    let target = canonicalPath(path.posix.join(dir, ext));
    if (target && !target.endsWith(".json") && !s.files.has(target)) target += ".json";
    if (!target || !(s.files.has(target) || ctx.repo.exists(target))) continue;
    const parent = loadConfig(ctx, s, target, seen);
    if (!parent) continue;
    merged = {
      baseUrl: parent.baseUrl ?? merged.baseUrl,
      paths: parent.paths ?? merged.paths,
      pathsBase: parent.pathsBase ?? merged.pathsBase,
    };
  }
  const opts = json.compilerOptions || {};
  if (typeof opts.baseUrl === "string") merged.baseUrl = canonicalPath(path.posix.join(dir, opts.baseUrl));
  if (opts.paths && typeof opts.paths === "object") {
    merged.paths = opts.paths;
    merged.pathsBase = dir;
  }
  s.configs.set(file, merged);
  return merged;
}

// The pattern of `paths` that matches `spec`, the one with the longest prefix
// before its `*`, as TypeScript chooses.
function matchPaths(paths, spec) {
  let best = null;
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf("*");
    if (star < 0) {
      if (pattern === spec && (!best || pattern.length > best.prefix.length)) best = { prefix: pattern, targets, capture: "" };
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    if (!best || prefix.length > best.prefix.length) {
      best = { prefix, targets, capture: spec.slice(prefix.length, spec.length - suffix.length) };
    }
  }
  return best;
}

// Resolve one specifier written in `fromFile`. Returns { file, via } or null.
export function resolveImport(ctx, fromFile, spec) {
  const s = state(ctx);
  const fromDir = path.posix.dirname(fromFile);
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    const file = resolveFile(s.files, path.posix.join(fromDir, spec));
    return file ? { file, via: "relative-import" } : null;
  }
  if (spec.startsWith("/") || /^[a-z]+:/i.test(spec)) return null;
  const cfg = configFor(ctx, s, fromDir === "." ? REPO_ROOT : fromDir);
  if (!cfg) return null;
  if (cfg.paths) {
    const hit = matchPaths(cfg.paths, spec);
    if (hit) {
      const base = cfg.baseUrl ?? cfg.pathsBase;
      for (const t of hit.targets) {
        if (typeof t !== "string") continue;
        const file = resolveFile(s.files, path.posix.join(base, t.replace("*", hit.capture)));
        if (file) return { file, via: "path-alias" };
      }
      return null;
    }
  }
  if (cfg.baseUrl) {
    const file = resolveFile(s.files, path.posix.join(cfg.baseUrl, spec));
    if (file) return { file, via: "path-alias" };
  }
  return null;
}

// The package name a bare specifier imports (`pg`, `@scope/pkg`), or null.
export function packageOf(spec) {
  if (spec.startsWith(".") || spec.startsWith("/") || /^[a-z]+:/i.test(spec)) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? (parts.length > 1 ? parts.slice(0, 2).join("/") : null) : parts[0];
}
