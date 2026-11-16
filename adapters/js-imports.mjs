// Imports between components of one JavaScript/TypeScript package.
//
// A package split into several components (one descriptor per directory) has
// no manifest edge between them: they share one package.json. The only
// evidence of `lib` depending on `db` is a source file in `lib` importing a
// file in `db`. This module resolves import specifiers to repository files and
// the files to their owning components.
//
// Resolution never guesses. A specifier counts only when it resolves to a file
// that is in a unit's input set, with the extension and index rules TypeScript
// and bundlers apply. Four sources of non-relative specifiers are read, in this
// order, and the first that resolves wins:
//   - `compilerOptions.paths` of the nearest tsconfig.json or jsconfig.json,
//     following repository-relative `extends`;
//   - the aliases of the nearest Vite, Vitest, webpack, Rollup and Babel
//     (module-resolver) configs, read statically: configuration is code and is
//     never executed, so only literal shapes are understood and anything else
//     is reported;
//   - the `imports` map (`#x`) of the nearest package.json;
//   - `compilerOptions.baseUrl`.
import path from "node:path";
import { canonicalPath, joinPath, longestOwner, REPO_ROOT } from "../core/paths.mjs";

export const JS_SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
// TypeScript lets an ESM import name the emitted file (`./x.js`) for a source
// file that is `./x.ts`.
const EMITTED = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const TS_CONFIGS = ["tsconfig.json", "jsconfig.json"];
const JS_CONFIG_EXT = ["ts", "mts", "js", "mjs", "cjs"];
// Each tool's configuration governs its files independently, so each family is
// looked up on its own: a nested .babelrc does not hide a root vite.config.ts.
const BUNDLER_FAMILIES = {
  vite: [...JS_CONFIG_EXT.map((e) => "vite.config." + e), ...JS_CONFIG_EXT.map((e) => "vitest.config." + e)],
  webpack: JS_CONFIG_EXT.map((e) => "webpack.config." + e),
  rollup: JS_CONFIG_EXT.map((e) => "rollup.config." + e),
  babel: [".babelrc", ".babelrc.json", "babel.config.json", ...["js", "cjs", "mjs"].flatMap((e) => [".babelrc." + e, "babel.config." + e])],
};

// The tool a config file belongs to.
export function configFlavor(file) {
  const name = path.posix.basename(file);
  if (/^vite(st)?\.config\./.test(name)) return "vite";
  if (/^webpack\.config\./.test(name)) return "webpack";
  if (/^rollup\.config\./.test(name)) return "rollup";
  if (/^(\.babelrc|babel\.config\.)/.test(name)) return "babel";
  return null;
}
export const ALIAS_UNRESOLVED = "AGENTDOC_IMPORT_ALIAS_UNRESOLVED";

// ── import statements ───────────────────────────────────────────────────────

// Module specifiers named by import statements, each with whether every
// statement naming it is type-only (`import type`, `export type`, or braces in
// which every name is `type X`). Static imports, re-exports, side-effect
// imports, dynamic import() and require() are read after comments are removed,
// so a commented-out import is not evidence.
export function jsImports(text) {
  const code = stripComments(text);
  const out = new Map();
  const note = (spec, typeOnly) => out.set(spec, out.has(spec) ? out.get(spec) && typeOnly : typeOnly);
  const STATIC = /(?:^|[;\s}])(?:import|export)\s+(type\s+)?(?:([^'"`;]*?)\bfrom\s*)?(["'])([^"'\n]+)\3/g;
  const CALL = /\b(?:import|require)\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g;
  for (const m of code.matchAll(STATIC)) {
    let typeOnly = Boolean(m[1]);
    if (!typeOnly && m[2]) {
      const braces = /^\s*\{([^}]*)\}\s*$/.exec(m[2]);
      const names = braces ? braces[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
      typeOnly = names.length > 0 && names.every((n) => /^type\s/.test(n));
    }
    note(m[4], typeOnly);
  }
  // A template literal with a substitution is a pattern (jsImportPatterns).
  for (const m of code.matchAll(CALL)) if (!m[2].includes("${")) note(m[2], false);
  return out;
}

export function jsImportSpecifiers(text) {
  return new Set(jsImports(text).keys());
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

// ── per-compile state ───────────────────────────────────────────────────────

// Shared by every unit: the input files of all units, which components own
// them, and the configuration that governs each directory.
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
    nearest: new Map(),
    tsconfigs: new Map(),
    bundlers: new Map(),
    manifests: new Map(),
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

// Whether a configuration file exists. A path inside a unit is answered from
// the unit walks at no cost; a path outside every unit is probed, and the
// probe is an input.
function present(ctx, s, p) {
  return s.files.has(p) || (!owningUnit(ctx, p) && ctx.repo.exists(p));
}

const parentDir = (dir) => (dir === REPO_ROOT ? null : path.posix.dirname(dir) === "." ? REPO_ROOT : path.posix.dirname(dir));

// The configuration files of `kind` that govern `dir`: those in the nearest
// directory, at or above it, that holds at least one of `names`.
function nearest(ctx, s, kind, names, dir) {
  const key = kind + "|" + dir;
  if (s.nearest.has(key)) return s.nearest.get(key);
  const here = names.map((n) => joinPath(dir, n)).filter((p) => present(ctx, s, p));
  const parent = parentDir(dir);
  const found = here.length ? here : parent === null ? [] : nearest(ctx, s, kind, names, parent);
  s.nearest.set(key, found);
  return found;
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

// ── tsconfig.json / jsconfig.json ───────────────────────────────────────────

// { baseUrl, paths, pathsBase } with every directory repository-relative.
// baseUrl is relative to the config that sets it; paths are relative to the
// effective baseUrl, or to the config that sets them when there is none.
function loadTsconfig(ctx, s, file, seen = new Set()) {
  if (s.tsconfigs.has(file)) return s.tsconfigs.get(file);
  if (seen.has(file)) return null;
  seen.add(file);
  let json;
  try {
    json = parseJsonc(ctx.repo.readText(file));
  } catch {
    s.tsconfigs.set(file, null);
    return null;
  }
  const dir = path.posix.dirname(file);
  let merged = { baseUrl: null, paths: null, pathsBase: null };
  const parents = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
  for (const ext of parents) {
    if (typeof ext !== "string") continue;
    const target = extendsTarget(ctx, s, dir, ext);
    if (!target) continue;
    const parent = loadTsconfig(ctx, s, target, seen);
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
  s.tsconfigs.set(file, merged);
  return merged;
}

// The file an `extends` names. A relative path is joined to the config's
// directory. A package is read only when it is a unit of this repository, at
// its own root and never through node_modules, which is not an input: the
// package's `exports` for the subpath, then the path itself, then its
// `tsconfig` field or tsconfig.json for the bare name. A third-party package
// is not read.
function extendsTarget(ctx, s, dir, ext) {
  const withJson = (p) => (p && !p.endsWith(".json") && !s.files.has(p) ? p + ".json" : p);
  if (/^\.\.?\//.test(ext)) {
    const p = withJson(canonicalPath(path.posix.join(dir, ext)));
    return p && present(ctx, s, p) ? p : null;
  }
  const name = packageOf(ext);
  const unit = name ? ctx.unitByPkgName?.get(name) : null;
  if (!unit) return null;
  const sub = ext.slice(name.length).replace(/^\//, "");
  const pkg = unit.pkg || {};
  let rel = null;
  if (!sub) rel = typeof pkg.tsconfig === "string" ? pkg.tsconfig : "tsconfig.json";
  else {
    const exported = pkg.exports && typeof pkg.exports === "object" ? pkg.exports["./" + sub] : undefined;
    rel = typeof exported === "string" ? exported : typeof exported?.default === "string" ? exported.default : sub;
  }
  const p = withJson(canonicalPath(joinPath(unit.root, rel.replace(/^\.\//, ""))));
  return p && s.files.has(p) ? p : null;
}

// The pattern of a `paths` or `imports` map that matches `spec`: an exact key,
// or the `*` pattern with the longest prefix, as TypeScript and Node choose.
function matchPattern(map, spec) {
  let best = null;
  for (const [pattern, targets] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star < 0) {
      if (pattern === spec) return { targets, capture: "" };
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

// ── Vite / webpack resolve.alias, read statically ───────────────────────────

// Strings are set aside as \0N\0 placeholders and comments removed, so neither
// can be mistaken for code. A template literal with a substitution is not a
// literal and is recorded as null.
function lex(text) {
  const strings = [];
  let code = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      code += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < text.length) {
        if (text[j] === "\\") { value += text[j + 1] ?? ""; j += 2; continue; }
        if (text[j] === c) { closed = true; break; }
        if (c !== "`" && text[j] === "\n") break;
        value += text[j++];
      }
      if (!closed) return null;
      strings.push(c === "`" && value.includes("${") ? null : value);
      code += "\u0000" + (strings.length - 1) + "\u0000";
      i = j + 1;
      continue;
    }
    code += c;
    i++;
  }
  return { code, strings };
}

const OPEN = { "{": "}", "[": "]", "(": ")" };

// The balanced bracket expression starting at `start`, or null.
function balanced(code, start) {
  const stack = [];
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === "}" || c === "]" || c === ")") {
      if (stack.pop() !== c) return null;
      if (!stack.length) return code.slice(start, i + 1);
    }
  }
  return null;
}

// Top-level comma-separated parts of a bracket body.
function splitTop(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const c of body) {
    if (OPEN[c]) depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// `key: value` of an object-literal part, or null for a computed key, a
// shorthand or a spread.
function property(part, strings) {
  const m = /^(?:([A-Za-z_$][\w$]*)|\u0000(\d+)\u0000)\s*:\s*([\s\S]+)$/.exec(part);
  if (!m) return null;
  const key = m[1] ?? strings[Number(m[2])];
  return typeof key === "string" ? { key, value: m[3].trim() } : null;
}

// A replacement directory, from the literal shapes bundler configs use:
// path.resolve/join(__dirname, "…"), fileURLToPath(new URL("…", import.meta.url)),
// new URL("…", import.meta.url).pathname, a root-relative "/src" in Vite, and
// a relative "./src" in Babel's module-resolver, which resolves it against the
// project. A bare string in Babel names another package: SKIP, not an error.
const SKIP = Symbol("skip");
function aliasTarget(value, strings, configDir, flavor) {
  const lit = (s) => {
    const m = /^\u0000(\d+)\u0000$/.exec(s.trim());
    return m ? strings[Number(m[1])] : undefined;
  };
  // Inside the repository, or null: path.posix.join keeps a leading "..",
  // which canonicalPath refuses.
  const inside = (rel) => canonicalPath(path.posix.join(configDir, rel));
  const direct = lit(value);
  if (typeof direct === "string") {
    if (flavor === "vite" && direct.startsWith("/")) return inside("." + direct);
    if (flavor === "babel" && /^\.\.?(\/|$)/.test(direct)) return inside(direct);
    if (flavor === "babel" && !direct.startsWith("/")) return SKIP;
    return null;
  }
  let m = /^(?:path\.)?(?:resolve|join)\(\s*(?:__dirname|import\.meta\.dirname)\s*((?:,\s*\u0000\d+\u0000\s*)*)\)$/.exec(value);
  if (m) {
    const segs = [...m[1].matchAll(/\u0000(\d+)\u0000/g)].map((x) => strings[Number(x[1])]);
    if (segs.some((x) => typeof x !== "string" || x.startsWith("/"))) return null;
    return inside(segs.join("/") || ".");
  }
  m = /^(?:(?:url\.)?fileURLToPath\(\s*new\s+URL\(\s*(\u0000\d+\u0000)\s*,\s*import\.meta\.url\s*\)\s*\)|new\s+URL\(\s*(\u0000\d+\u0000)\s*,\s*import\.meta\.url\s*\)\.pathname)$/.exec(value);
  if (m) {
    const rel = lit(m[1] || m[2]);
    return typeof rel === "string" && !rel.startsWith("/") ? inside(rel) : null;
  }
  return null;
}

// The aliases a bundler config states with literals, and why any other alias
// could not be read. Rollup's alias plugin names them `entries`; Babel's
// module-resolver adds `root` directories, searched like baseUrl. Exported for
// tests.
export function bundlerAliases(text, configPath) {
  const flavor = configFlavor(configPath) || "vite";
  const configDir = path.posix.dirname(configPath) === "." ? REPO_ROOT : path.posix.dirname(configPath);
  if (flavor === "babel" && /(\.babelrc|\.json)$/.test(configPath)) return babelJsonAliases(text, configDir);
  const lexed = lex(text);
  if (!lexed) return { entries: [], roots: [], unresolved: ["the config could not be read statically"] };
  const { code, strings } = lexed;
  const keyName = flavor === "rollup" ? "entries" : "alias";
  const entries = [];
  const unresolved = [];
  const keyRe = new RegExp("(?:^|[{,\\s])(?:" + keyName + "|\u0000(\\d+)\u0000)\\s*(:|[,}])", "g");
  for (const m of code.matchAll(keyRe)) {
    if (m[1] !== undefined && strings[Number(m[1])] !== keyName) continue;
    if (m[2] !== ":") {
      unresolved.push(keyName + " is a shorthand property, not a literal");
      continue;
    }
    let at = m.index + m[0].length;
    while (/\s/.test(code[at] || "")) at++;
    const expr = OPEN[code[at]] && code[at] !== "(" ? balanced(code, at) : null;
    if (!expr) {
      unresolved.push(keyName + " is not an object or array literal");
      continue;
    }
    const body = expr.slice(1, -1);
    const accept = (key, value) => {
      if (flavor === "babel" && key.startsWith("^")) {
        unresolved.push("alias " + JSON.stringify(key) + " is a regular expression");
        return;
      }
      const dir = aliasTarget(value, strings, configDir, flavor);
      if (dir === SKIP) return;
      if (dir === null) {
        unresolved.push("alias " + JSON.stringify(key) + " is not a literal path");
        return;
      }
      const exact = flavor === "webpack" && key.endsWith("$");
      entries.push({ find: exact ? key.slice(0, -1) : key, exact, dir });
    };
    if (expr[0] === "{") {
      for (const part of splitTop(body)) {
        const prop = property(part, strings);
        if (!prop) unresolved.push("an alias entry is computed, spread or shorthand");
        else accept(prop.key, prop.value);
      }
    } else {
      for (const part of splitTop(body)) {
        const obj = part.startsWith("{") ? balanced(part, 0) : null;
        const props = obj === part ? splitTop(obj.slice(1, -1)).map((p) => property(p, strings)) : null;
        const find = props?.find((p) => p?.key === "find");
        const repl = props?.find((p) => p?.key === "replacement");
        const findLit = find && /^\u0000(\d+)\u0000$/.exec(find.value);
        const key = findLit ? strings[Number(findLit[1])] : null;
        if (typeof key !== "string" || !repl) unresolved.push("an alias entry's find is not a string literal");
        else accept(key, repl.value);
      }
    }
  }
  return { entries, roots: [], unresolved };
}

// .babelrc and babel.config.json: the options of the module-resolver plugin.
function babelJsonAliases(text, configDir) {
  let json;
  try {
    json = parseJsonc(text);
  } catch {
    return { entries: [], roots: [], unresolved: ["the config is not valid JSON"] };
  }
  const entries = [];
  const roots = [];
  const unresolved = [];
  const plugins = [json, ...Object.values(json.env || {})].flatMap((c) => (Array.isArray(c?.plugins) ? c.plugins : []));
  for (const p of plugins) {
    const [name, opts] = Array.isArray(p) ? p : [p, {}];
    if (name !== "module-resolver" && name !== "babel-plugin-module-resolver") continue;
    for (const [key, value] of Object.entries(opts?.alias || {})) {
      if (key.startsWith("^")) { unresolved.push("alias " + JSON.stringify(key) + " is a regular expression"); continue; }
      if (typeof value !== "string") { unresolved.push("alias " + JSON.stringify(key) + " is not a string"); continue; }
      if (!/^\.\.?(\/|$)/.test(value)) continue; // another package
      const dir = canonicalPath(path.posix.join(configDir, value));
      if (dir === null) unresolved.push("alias " + JSON.stringify(key) + " is outside the repository");
      else entries.push({ find: key, exact: false, dir });
    }
    for (const r of [].concat(opts?.root || [])) {
      const dir = typeof r === "string" && !/[*?{]/.test(r) ? canonicalPath(path.posix.join(configDir, r)) : null;
      if (dir === null) unresolved.push("root " + JSON.stringify(r) + " is not a literal directory");
      else roots.push(dir);
    }
  }
  return { entries, roots, unresolved };
}

function loadBundler(ctx, s, file) {
  if (s.bundlers.has(file)) return s.bundlers.get(file);
  let parsed;
  try {
    parsed = bundlerAliases(ctx.repo.readText(file), file);
  } catch {
    parsed = { entries: [], roots: [], unresolved: ["the config could not be read"] };
  }
  if (parsed.unresolved.length) {
    // Reported once, on the component that owns the config. The aliases that
    // were read are still used: each one is a literal the config states.
    const owner = owningUnit(ctx, file)?.component?.ref;
    ctx.diagnostics.push({
      severity: "warning",
      code: ALIAS_UNRESOLVED,
      subject: owner || file,
      refs: owner ? [owner] : [],
      message:
        "import aliases in '" + file + "' are not fully read: " + [...new Set(parsed.unresolved)].sort().join("; ") + ". " +
        "Imports through them create no dependency; state them as tsconfig paths, package.json imports, " +
        "or literal path.resolve(__dirname, \"…\") values",
      paths: [file],
    });
  }
  const out = { entries: parsed.entries, roots: parsed.roots };
  s.bundlers.set(file, out);
  return out;
}

function matchAlias(entries, spec) {
  for (const e of entries) {
    if (spec === e.find) return e.dir;
    if (e.exact) continue;
    if (e.find.endsWith("/") ? spec.startsWith(e.find) : spec.startsWith(e.find + "/")) {
      return e.dir + "/" + spec.slice(e.find.length).replace(/^\//, "");
    }
  }
  return null;
}

// ── package.json imports ────────────────────────────────────────────────────

function loadManifest(ctx, s, file) {
  if (s.manifests.has(file)) return s.manifests.get(file);
  let imports = null;
  try {
    const json = ctx.repo.readJson(file);
    if (json && typeof json.imports === "object" && json.imports !== null) imports = json.imports;
  } catch {
    imports = null;
  }
  s.manifests.set(file, imports);
  return imports;
}

// Every string a conditional target can select. Which condition applies is a
// fact of the runtime, not of the checkout, so each is a possible dependency.
function targetStrings(t) {
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.flatMap(targetStrings);
  if (t && typeof t === "object") return Object.keys(t).sort().flatMap((k) => targetStrings(t[k]));
  return [];
}

// ── resolution ──────────────────────────────────────────────────────────────

// The places a specifier can name, source by source, in resolution order.
// Each route lists base paths; `all` marks a route whose bases are all
// possible at once (the branches of a conditional package import).
function routes(ctx, fromFile, spec) {
  const s = state(ctx);
  const fromDir = path.posix.dirname(fromFile) === "." ? REPO_ROOT : path.posix.dirname(fromFile);
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    return [{ via: "relative-import", bases: [path.posix.join(fromDir, spec)] }];
  }
  if (spec.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return [];
  const out = [];
  const [tsFile] = nearest(ctx, s, "ts", TS_CONFIGS, fromDir);
  const ts = tsFile ? loadTsconfig(ctx, s, tsFile) : null;
  if (ts?.paths) {
    const hit = matchPattern(ts.paths, spec);
    if (hit && Array.isArray(hit.targets)) {
      const base = ts.baseUrl ?? ts.pathsBase;
      out.push({ via: "path-alias", bases: hit.targets.filter((t) => typeof t === "string").map((t) => path.posix.join(base, t.replace("*", hit.capture))) });
    }
  }
  const bundlers = Object.entries(BUNDLER_FAMILIES)
    .flatMap(([family, names]) => nearest(ctx, s, family, names, fromDir))
    .map((file) => loadBundler(ctx, s, file));
  for (const b of bundlers) {
    const target = matchAlias(b.entries, spec);
    if (target !== null) out.push({ via: "bundler-alias", bases: [target] });
  }
  if (spec.startsWith("#")) {
    const [manifest] = nearest(ctx, s, "pkg", ["package.json"], fromDir);
    const imports = manifest ? loadManifest(ctx, s, manifest) : null;
    const hit = imports ? matchPattern(imports, spec) : null;
    if (hit) {
      const dir = path.posix.dirname(manifest);
      // A bare target maps to another package, which the manifest routes cover.
      const bases = targetStrings(hit.targets).filter((t) => t.startsWith("./")).map((t) => path.posix.join(dir, t.split("*").join(hit.capture)));
      out.push({ via: "subpath-import", bases, all: true });
    }
  }
  for (const b of bundlers) {
    if (b.roots.length) out.push({ via: "bundler-alias", bases: b.roots.map((r) => path.posix.join(r, spec)) });
  }
  if (ts?.baseUrl) out.push({ via: "path-alias", bases: [path.posix.join(ts.baseUrl, spec)] });
  return out;
}

// Resolve one specifier written in `fromFile`. Returns every { file, via } it
// can name (several only for a conditional package import), or [].
export function resolveImport(ctx, fromFile, spec) {
  const s = state(ctx);
  for (const route of routes(ctx, fromFile, spec)) {
    const files = [];
    for (const base of route.bases) {
      const file = resolveFile(s.files, base);
      if (file && !files.includes(file)) files.push(file);
      if (file && !route.all) break;
    }
    if (files.length) return files.map((file) => ({ file, via: route.via }));
  }
  return [];
}

// ── dynamic imports with a static part ──────────────────────────────────────

// Patterns a source can load at runtime: a template literal given to import()
// or require() (`./locales/${lang}.ts` → `./locales/*.ts`), and the globs of
// Vite's import.meta.glob. Exported for tests.
export function jsImportPatterns(text) {
  const code = stripComments(text);
  const out = [];
  const seen = new Set();
  const push = (pattern, kind) => {
    if (!seen.has(kind + "|" + pattern)) { seen.add(kind + "|" + pattern); out.push({ pattern, kind }); }
  };
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*`([^`]*)`\s*\)/g)) {
    if (m[1].includes("${")) push(m[1].replace(/\$\{[^}]*\}/g, "*"), "template");
  }
  for (const m of code.matchAll(/\bimport\.meta\.glob(?:Eager)?\s*(?:<[^>]*>)?\s*\(\s*(\[[^\]]*\]|"[^"\n]*"|'[^'\n]*')/g)) {
    for (const g of m[1].matchAll(/(["'])([^"'\n]*)\1/g)) if (!g[2].startsWith("!")) push(g[2], "glob");
  }
  return out;
}

const CODE_EXT = "(?:\\.(?:ts|tsx|d\\.ts|js|jsx|mts|cts|mjs|cjs|json))";

// A pattern's base path as a regular expression over repository paths. A
// template's `*` matches across directories with an optional extension or
// index file, as webpack's context modules do; a glob keeps glob semantics.
function patternRegex(base, kind) {
  const esc = (t) => t.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  if (kind === "template") {
    const body = base.split("*").map(esc).join(".*");
    return new RegExp("^" + body + "(?:" + CODE_EXT + "|/index" + CODE_EXT + ")?$");
  }
  let re = "";
  for (let i = 0; i < base.length; i++) {
    const c = base[i];
    if (c === "*" && base[i + 1] === "*") {
      re += base[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += base[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = base.indexOf("}", i);
      if (end < 0) return null;
      re += "(?:" + base.slice(i + 1, end).split(",").map(esc).join("|") + ")";
      i = end;
    } else re += esc(c);
  }
  return new RegExp("^" + re + "$");
}

// Every repository file a dynamic import pattern can load. A pattern with no
// static part before its first wildcard is not read: `import(x)` names nothing.
export function resolvePattern(ctx, fromFile, pattern, kind) {
  const s = state(ctx);
  const star = pattern.search(/[*?{]/);
  const prefix = star < 0 ? pattern : pattern.slice(0, star);
  if (!prefix) return [];
  for (const route of routes(ctx, fromFile, pattern)) {
    const files = new Set();
    for (const base of route.bases) {
      const b = canonicalPath(base);
      const re = b && b !== REPO_ROOT ? patternRegex(b, kind) : null;
      if (!re) continue;
      for (const f of s.files) if (re.test(f)) files.add(f);
      if (files.size && !route.all) break;
    }
    if (files.size) return [...files].sort().map((file) => ({ file, via: "dynamic-import" }));
  }
  return [];
}

// The package name a bare specifier imports (`pg`, `@scope/pkg`), or null.
export function packageOf(spec) {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(spec)) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? (parts.length > 1 ? parts.slice(0, 2).join("/") : null) : parts[0];
}
