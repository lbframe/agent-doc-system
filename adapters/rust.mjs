// Rust adapter: Cargo.toml as the unit marker, workspace members as roots,
// and crate dependencies as build relations. Nothing here runs cargo, reads
// Cargo.lock, or talks to crates.io. A dependency is a sibling only when a
// path, a workspace = true entry, or a source import says so.
import { Adapter } from "./registry.mjs";
import { AgentDocError, CODES } from "../core/codes.mjs";
import { globToRegExp } from "../core/fsx.mjs";
import { parse } from "../core/toml.mjs";

const SKIP_IDENTS = new Set(["self", "super", "crate"]);

export function manifestPath(root) {
  if (!root || root === ".") return "Cargo.toml";
  return root.replace(/\/$/, "") + "/Cargo.toml";
}

export function unitDir(root) {
  if (!root || root === ".") return "";
  return root.replace(/\/$/, "");
}

export function rustIdent(name) {
  return String(name || "").replace(/-/g, "_");
}

// A Cargo.toml the TOML reader rejects must not throw out of the compiler.
// The caller turns `error` into an AGENTDOC_* diagnostic. `text` is kept so a
// `[package]` header can still mark a unit when the body does not parse.
export function readCargo(repo, rel) {
  if (!repo.exists(rel)) return { missing: true, doc: null, error: null, text: null };
  let text;
  try {
    text = repo.readText(rel);
  } catch (e) {
    if (e instanceof AgentDocError) return { missing: false, doc: null, error: e, text: null };
    throw e;
  }
  try {
    return { missing: false, doc: parse(text, rel), error: null, text };
  } catch (e) {
    // The TOML reader throws AgentDocError for a line it rejects, and a plain
    // SyntaxError for a string it hands to JSON.parse. Either one is a
    // diagnostic. Neither may escape the compiler.
    if (e instanceof AgentDocError) return { missing: false, doc: null, error: e, text };
    return {
      missing: false,
      doc: null,
      error: new AgentDocError(CODES.YAML_PARSE, "Cargo.toml could not be parsed" + (e && e.message ? ": " + e.message : ""), { path: rel }),
      text,
    };
  }
}

export function crateNameOf(doc) {
  const n = doc && doc.package && doc.package.name;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

export function hasPackageHeader(text) {
  return /^\s*\[package\]\s*$/m.test(text || "");
}

export function isCargoPackage(parsed) {
  if (!parsed || parsed.missing) return false;
  if (crateNameOf(parsed.doc)) return true;
  return !parsed.doc && hasPackageHeader(parsed.text);
}

export function crateShape(repo, root, parsed) {
  const doc = parsed && parsed.doc;
  const text = (parsed && parsed.text) || "";
  const prefix = unitDir(root);
  const at = (rel) => (prefix ? prefix + "/" + rel : rel);
  const binTable = Boolean(doc && Array.isArray(doc.bin) && doc.bin.length > 0);
  const libTable = Boolean(doc && doc.lib && typeof doc.lib === "object" && !Array.isArray(doc.lib));
  const binText = !doc && /^\s*\[\[bin\]\]\s*$/m.test(text);
  const libText = !doc && /^\s*\[lib\]\s*$/m.test(text);
  const deployable = binTable || binText || repo.exists(at("src/main.rs")) || repo.isDir(at("src/bin"));
  const importable = libTable || libText || repo.exists(at("src/lib.rs"));
  if (deployable && importable) return "both";
  if (deployable) return "deployable";
  if (importable) return "importable";
  return "package";
}

export function findWorkspace(repo, root) {
  let dir = unitDir(root);
  const seen = new Set();
  while (!seen.has(dir)) {
    seen.add(dir);
    const rel = dir ? dir + "/Cargo.toml" : "Cargo.toml";
    if (repo.exists(rel)) {
      const parsed = readCargo(repo, rel);
      const ws = parsed.doc && parsed.doc.workspace;
      if (ws && typeof ws === "object" && !Array.isArray(ws)) return { root: dir, path: rel, doc: parsed.doc };
    }
    if (!dir) return null;
    const i = dir.lastIndexOf("/");
    dir = i < 0 ? "" : dir.slice(0, i);
  }
  return null;
}

export function loadCargoUnit(repo, unit) {
  const rel = manifestPath(unit.root);
  const parsed = readCargo(repo, rel);
  unit.cargoManifest = rel;
  unit.cargoDoc = parsed.doc;
  unit.cargoError = parsed.error || null;
  unit.cargoText = parsed.text;
  unit.cargoPackage = isCargoPackage(parsed);
  unit.crateName = crateNameOf(parsed.doc);
  unit.cargoWorkspace = unit.cargoPackage ? findWorkspace(repo, unit.root) : null;
  return unit;
}

function asStringList(v) {
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}

// `fromDir` and `rel` stay inside the repository. `..` that would leave it
// resolves to null rather than to a path the compiler must not read.
export function resolveInside(fromDir, rel) {
  if (typeof rel !== "string" || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return null;
  const out = [];
  const base = unitDir(fromDir);
  if (base) {
    for (const seg of base.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") return null;
      out.push(seg);
    }
  }
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

function expandMember(repo, workspaceRoot, pattern) {
  if (typeof pattern !== "string") return [];
  const rel = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (!rel || rel === "." || rel.split("/").includes("..") || rel.startsWith("/") || rel.includes("\\")) return [];
  const full = workspaceRoot ? workspaceRoot + "/" + rel : rel;
  if (full.split("/").includes("..")) return [];
  if (!/[*?]/.test(full)) return repo.isDir(full) ? [full] : [];
  const re = globToRegExp(full);
  const star = full.search(/[*?]/);
  const prefix = full.slice(0, star);
  const baseDir = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
  const dirs = new Set();
  for (const f of repo.walk(baseDir)) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (re.test(d)) dirs.add(d);
    }
  }
  return [...dirs].sort();
}

export function isExcludedWorkspaceMember(repo, dir) {
  if (!dir) return false;
  const parsed = readCargo(repo, "Cargo.toml");
  if (!parsed.doc || !parsed.doc.workspace) return false;
  const excluded = new Set();
  for (const pat of asStringList(parsed.doc.workspace.exclude)) {
    for (const d of expandMember(repo, "", pat)) excluded.add(d);
  }
  return excluded.has(dir);
}

export function memberDirs(repo, workspaceRoot, doc) {
  const ws = doc && doc.workspace;
  if (!ws || typeof ws !== "object" || Array.isArray(ws)) return [];
  const excluded = new Set();
  for (const pat of asStringList(ws.exclude)) {
    for (const dir of expandMember(repo, workspaceRoot, pat)) excluded.add(dir);
  }
  const out = [];
  const seen = new Set();
  for (const pat of asStringList(ws.members)) {
    for (const dir of expandMember(repo, workspaceRoot, pat)) {
      if (!dir || excluded.has(dir) || seen.has(dir)) continue;
      seen.add(dir);
      const rel = dir + "/Cargo.toml";
      if (!repo.exists(rel)) continue;
      out.push(dir);
    }
  }
  return out.sort();
}

function depsOf(doc, kind) {
  const tables = [];
  if (doc && doc[kind] && typeof doc[kind] === "object" && !Array.isArray(doc[kind])) tables.push(doc[kind]);
  const target = doc && doc.target;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    for (const key of Object.keys(target).sort()) {
      const table = target[key];
      if (table && typeof table === "object" && !Array.isArray(table) && table[kind] && typeof table[kind] === "object" && !Array.isArray(table[kind])) {
        tables.push(table[kind]);
      }
    }
  }
  const out = [];
  for (const table of tables) {
    for (const key of Object.keys(table).sort()) {
      const dep = normalizeDep(key, table[key]);
      if (dep) out.push(dep);
    }
  }
  return out;
}

function normalizeDep(key, value) {
  if (typeof value === "string" || typeof value === "number") {
    return { key, packageName: key, workspace: false, path: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const packageName = typeof value.package === "string" && value.package ? value.package : key;
  return {
    key,
    packageName,
    workspace: value.workspace === true,
    path: typeof value.path === "string" ? value.path : null,
  };
}

function lookupUnit(unitsByRoot, dir) {
  if (dir == null) return null;
  if (unitsByRoot.has(dir)) return unitsByRoot.get(dir);
  if (dir === "" && unitsByRoot.has(".")) return unitsByRoot.get(".");
  if (dir === "." && unitsByRoot.has("")) return unitsByRoot.get("");
  return null;
}

function workspaceEntry(ws, dep) {
  const table = ws && ws.doc && ws.doc.workspace && ws.doc.workspace.dependencies;
  if (!table || typeof table !== "object" || Array.isArray(table)) return { entries: [] };
  const entries = [];
  if (Object.prototype.hasOwnProperty.call(table, dep.key)) entries.push(table[dep.key]);
  if (dep.packageName !== dep.key && Object.prototype.hasOwnProperty.call(table, dep.packageName)) entries.push(table[dep.packageName]);
  return { entries };
}

function entryPath(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  return typeof entry.path === "string" ? entry.path : null;
}

function resolveCargoTarget(dep, fromDir, ws, unitsByRoot) {
  const hits = [];
  if (dep.path) {
    const dir = resolveInside(fromDir, dep.path);
    if (dir == null) return { target: null, ambiguous: false, escaped: true };
    hits.push(lookupUnit(unitsByRoot, dir));
  }
  if (dep.workspace) {
    if (!ws) return { target: null, ambiguous: false, escaped: false };
    const { entries } = workspaceEntry(ws, dep);
    const dirs = [];
    for (const entry of entries) {
      const path = entryPath(entry);
      if (!path) continue;
      const dir = resolveInside(ws.root, path);
      if (dir == null) return { target: null, ambiguous: false, escaped: true };
      dirs.push(dir);
    }
    const unique = [...new Set(dirs)];
    if (unique.length > 1) return { target: null, ambiguous: true, escaped: false };
    if (unique.length === 1) hits.push(lookupUnit(unitsByRoot, unique[0]));
  }
  const units = [...new Set(hits.filter(Boolean))];
  if (units.length > 1) return { target: null, ambiguous: true, escaped: false };
  return { target: units[0] || null, ambiguous: false, escaped: false };
}

export function analyzeCargoDeps(unit, unitsByRoot) {
  const doc = unit.cargoDoc;
  if (!doc) return { prodNames: [], resolved: [] };
  const fromDir = unitDir(unit.root);
  const resolved = [];
  const prod = [];
  const seen = new Set();
  const consider = (dep, kind) => {
    if (kind !== "test" && !seen.has(dep.packageName)) {
      seen.add(dep.packageName);
      prod.push(dep.packageName);
    }
    const hit = resolveCargoTarget(dep, fromDir, unit.cargoWorkspace, unitsByRoot);
    resolved.push({ dep, kind, ...hit });
  };
  for (const dep of depsOf(doc, "dependencies")) consider(dep, "build");
  for (const dep of depsOf(doc, "build-dependencies")) consider(dep, "build");
  for (const dep of depsOf(doc, "dev-dependencies")) consider(dep, "test");
  prod.sort();
  return { prodNames: prod, resolved };
}

function noteAmbiguity(ctx, key, message, paths, refs) {
  if (!ctx.rustAmbiguity) ctx.rustAmbiguity = new Map();
  let rec = ctx.rustAmbiguity.get(key);
  if (!rec) {
    rec = { message, paths: new Set(), refs: new Set() };
    ctx.rustAmbiguity.set(key, rec);
  }
  for (const p of paths) if (p) rec.paths.add(p);
  for (const r of refs) if (r) rec.refs.add(r);
}

function unitsMatchingIdent(units, ident) {
  const out = [];
  for (const u of units) {
    if (!u.crateName || !u.component) continue;
    if (rustIdent(u.crateName) === ident) out.push(u);
  }
  return out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

function shellCrate(name) {
  return typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name) ? name : null;
}

export class RustAdapter extends Adapter {
  static adapterName = "rust";
  constructor() {
    super({ name: "rust", version: "1.0.0", kind: "unit-marker" });
  }

  roots(ctx) {
    const parsed = readCargo(ctx.repo, "Cargo.toml");
    if (!parsed.doc || !parsed.doc.workspace) return [];
    const out = [];
    for (const dir of memberDirs(ctx.repo, "", parsed.doc)) {
      const manifest = readCargo(ctx.repo, dir + "/Cargo.toml");
      if (!isCargoPackage(manifest)) continue;
      const shape = crateShape(ctx.repo, dir, manifest);
      out.push({
        root: dir,
        deployable: shape === "deployable" || shape === "both",
        importable: shape === "importable" || shape === "both",
      });
    }
    return out;
  }

  detect(ctx, root) {
    const rel = manifestPath(root);
    const parsed = readCargo(ctx.repo, rel);
    if (!isCargoPackage(parsed)) return null;
    return { path: rel, shape: crateShape(ctx.repo, root, parsed) };
  }

  extract(ctx, unit) {
    if (!unit.cargoPackage) return {};
    const { repo, prov, compRef } = ctx;
    const rel = unit.cargoManifest || manifestPath(unit.root);
    const derived = { languages: new Set(["rust"]), runtimes: new Set(["rust"]) };
    if (unit.crateName) derived.crateName = unit.crateName;
    const pr = prov.add("observed", rel, "cargo-extractor", [
      "der:" + compRef + ":/runtimes",
      "der:" + compRef + ":/languages",
    ]);

    if (unit.cargoError) {
      ctx.diagnostics.push({
        severity: "warning",
        code: unit.cargoError.code || "AGENTDOC_YAML_PARSE",
        message: "Cargo.toml could not be parsed; crate dependencies were not derived: " + unit.cargoError.message,
        paths: [rel],
        refs: [compRef],
        subject: compRef,
      });
    }

    const unitsByRoot = new Map((ctx.discovery.eligible || []).map((u) => [u.root, u]));
    const { prodNames, resolved } = analyzeCargoDeps(unit, unitsByRoot);
    const byTarget = new Map();
    for (const hit of resolved) {
      if (hit.ambiguous) {
        noteAmbiguity(
          ctx,
          "dep:" + unit.root + ":" + hit.dep.key,
          "dependency '" + hit.dep.key + "' in " + rel + " resolves to more than one crate; no edge was created",
          [rel],
          [compRef]
        );
        continue;
      }
      const target = hit.target;
      if (!target || !target.component || target.component.ref === compRef) continue;
      const prev = byTarget.get(target.component.ref);
      if (!prev) byTarget.set(target.component.ref, { target, kind: hit.kind, deps: [hit.dep] });
      else {
        prev.deps.push(hit.dep);
        if (hit.kind === "build") prev.kind = "build";
      }
    }
    for (const rec of [...byTarget.values()].sort((a, b) => (a.target.root < b.target.root ? -1 : 1))) {
      const pkg = rec.target.crateName || rec.deps[0].packageName;
      ctx.addEdge(
        rec.kind === "test" ? "testDependsOn" : "buildDependsOn",
        compRef,
        rec.target.component.ref,
        { via: "cargo-manifest", package: pkg },
        [pr],
        "DERIVED"
      );
    }

    const siblingNames = new Set();
    for (const rec of byTarget.values()) for (const d of rec.deps) siblingNames.add(d.packageName);
    const ambiguousNames = new Set(resolved.filter((h) => h.ambiguous).map((h) => h.dep.packageName));
    for (const name of prodNames) {
      if (siblingNames.has(name) || ambiguousNames.has(name)) continue;
      for (const x of ctx.externalMatchers()) {
        if (!x.re.test(name)) continue;
        ctx.addExternal(compRef, x.name, x.mechanism, x.role, pr, "DERIVED");
      }
    }

    const identFiles = (ctx.importIndex && ctx.importIndex.rustIdentsByUnit && ctx.importIndex.rustIdentsByUnit.get(unit)) || new Map();
    const byIdent = new Map();
    for (const hit of resolved) {
      const ident = rustIdent(hit.dep.key);
      if (!byIdent.has(ident)) byIdent.set(ident, []);
      byIdent.get(ident).push(hit);
    }
    for (const ident of [...identFiles.keys()].sort()) {
      if (SKIP_IDENTS.has(ident)) continue;
      const files = [...(identFiles.get(ident) || [])].sort();
      const hits = byIdent.get(ident) || [];
      const targets = [];
      const seen = new Set();
      for (const hit of hits) {
        if (hit.ambiguous || !hit.target || !hit.target.component) continue;
        if (hit.target.component.ref === compRef || seen.has(hit.target.component.ref)) continue;
        seen.add(hit.target.component.ref);
        targets.push(hit);
      }
      if (hits.some((h) => h.ambiguous) || targets.length > 1) {
        noteAmbiguity(
          ctx,
          "ident:" + ident,
          "crate import '" + ident + "' matches more than one dependency; no edge was created",
          [rel, ...files],
          [compRef]
        );
        continue;
      }
      if (targets.length === 1) {
        const hit = targets[0];
        const kind = hits.some((h) => h.target === hit.target && h.kind === "build") ? "build" : hit.kind;
        const provs = files.map((f) => prov.add("observed", f, "cargo-import-extractor", ["rel:pending"]));
        ctx.addEdge(
          kind === "test" ? "testDependsOn" : "buildDependsOn",
          compRef,
          hit.target.component.ref,
          { via: "source-import", package: hit.target.crateName || hit.dep.packageName },
          provs.length ? provs : [pr],
          "DERIVED"
        );
        continue;
      }
      const matches = unitsMatchingIdent(ctx.discovery.eligible || [], ident).filter((u) => u.component.ref !== compRef);
      if (matches.length > 1) {
        noteAmbiguity(
          ctx,
          "ident:" + ident,
          "crate import '" + ident + "' matches " + matches.length + " crates (" + matches.map((u) => u.crateName).join(", ") + "); no dependency edge was created",
          [...files, ...matches.map((u) => manifestPath(u.root))],
          [compRef, ...matches.map((u) => u.component.ref)]
        );
        continue;
      }
      if (matches.length === 1) {
        const provs = files.map((f) => prov.add("observed", f, "cargo-import-extractor", ["rel:pending"]));
        ctx.addEdge(
          "buildDependsOn",
          compRef,
          matches[0].component.ref,
          { via: "source-import", package: matches[0].crateName },
          provs.length ? provs : [pr],
          "DERIVED"
        );
      }
    }

    const name = shellCrate(unit.crateName);
    if (name) {
      ctx.addVerification({
        id: compRef + ":cargo-test",
        componentRefs: [compRef],
        tier: "unit",
        command: "cargo test -p " + name,
        configPaths: [rel],
        provRecs: [pr],
      });
      ctx.addVerification({
        id: compRef + ":cargo-clippy",
        componentRefs: [compRef],
        tier: "static",
        command: "cargo clippy -p " + name,
        configPaths: [rel],
        provRecs: [pr],
      });
    }

    if (hasRustTests(repo, unit.root)) derived.hasTests = true;
    return derived;
  }

  contracts(ctx) {
    const names = ctx.ambiguousCrateNames || new Map();
    for (const [name, units] of [...names.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const list = units.slice().sort((a, b) => (a.root < b.root ? -1 : 1));
      ctx.diagnostics.push({
        severity: "warning",
        code: "AGENTDOC_BINDING_AMBIGUOUS",
        message: "crate name '" + name + "' is declared by " + list.map((u) => u.root).join(" and ") + "; neither unit was elected as that name",
        paths: list.map((u) => manifestPath(u.root)).sort(),
        refs: list.map((u) => u.component && u.component.ref).filter(Boolean).sort(),
      });
    }
    const amb = ctx.rustAmbiguity || new Map();
    for (const [, rec] of [...amb.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      ctx.diagnostics.push({
        severity: "warning",
        code: "AGENTDOC_BINDING_AMBIGUOUS",
        message: rec.message,
        paths: [...rec.paths].sort(),
        refs: [...rec.refs].sort(),
      });
    }
    const rootUnit = (ctx.discovery.eligible || []).find((u) => !u.root || u.root === ".");
    const root = readCargo(ctx.repo, "Cargo.toml");
    if (root.error && !rootUnit) {
      ctx.diagnostics.push({
        severity: "warning",
        code: root.error.code || "AGENTDOC_YAML_PARSE",
        message: "workspace Cargo.toml could not be parsed; workspace members were not derived from it: " + root.error.message,
        paths: ["Cargo.toml"],
        refs: [],
      });
    }
  }
}

function hasRustTests(repo, root) {
  const prefix = unitDir(root);
  const tests = prefix ? prefix + "/tests" : "tests";
  if (repo.isDir(tests)) return true;
  const attr = /#\s*\[\s*(?:test|cfg\s*\(\s*test\s*\))\s*\]/;
  for (const f of repo.walk(prefix)) {
    if (!f.endsWith(".rs")) continue;
    if (attr.test(repo.readText(f))) return true;
  }
  return false;
}

export function rustIdentsInSource(src) {
  return extractRustIdents(maskRustNonCode(stripRustTestItems(String(src || ""))));
}

function stripRustTestItems(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const skipped = skipNoise(src, i);
    if (skipped > i) {
      out += src.slice(i, skipped);
      i = skipped;
      continue;
    }
    const attr = matchTestAttr(src, i);
    if (attr > i) {
      i = skipRustItem(src, attr);
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function matchTestAttr(src, i) {
  if (src[i] !== "#") return i;
  const m = /^#\s*\[\s*(?:test|cfg\s*\(\s*test\s*\))\s*\]/.exec(src.slice(i));
  return m ? i + m[0].length : i;
}

function skipRustItem(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  let depth = 0;
  let opened = false;
  while (i < src.length) {
    const skipped = skipNoise(src, i);
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const c = src[i];
    if (c === "{") {
      depth++;
      opened = true;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      if (opened && depth <= 0) return i;
      continue;
    }
    if (c === ";" && depth === 0) return i + 1;
    i++;
  }
  return i;
}

function maskRustNonCode(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const skipped = skipNoise(src, i);
    if (skipped > i) {
      out += " ".repeat(skipped - i);
      i = skipped;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function extractRustIdents(src) {
  const out = new Set();
  const add = (ident) => {
    if (ident && !SKIP_IDENTS.has(ident)) out.add(ident);
  };
  for (const m of src.matchAll(/\buse\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) add(m[1]);
  for (const m of src.matchAll(/\bextern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1]);
  for (const m of src.matchAll(/(^|[^A-Za-z0-9_:])([A-Za-z_][A-Za-z0-9_]*)::/g)) add(m[2]);
  return out;
}

function skipNoise(src, i) {
  if (src[i] === "/" && src[i + 1] === "/") {
    const j = src.indexOf("\n", i);
    return j < 0 ? src.length : j;
  }
  if (src[i] === "/" && src[i + 1] === "*") return skipBlockComment(src, i);
  if (src[i] === "b" && (src[i + 1] === '"' || src[i + 1] === "'")) return skipQuoted(src, i + 1);
  if (src[i] === "b" && src[i + 1] === "r" && rawStringEnd(src, i + 1) > i + 1) return rawStringEnd(src, i + 1);
  if (src[i] === "r" && rawStringEnd(src, i) > i) return rawStringEnd(src, i);
  if (src[i] === '"' || src[i] === "'") return skipQuoted(src, i);
  return i;
}

function skipBlockComment(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    if (src[j] === "/" && src[j + 1] === "*") {
      depth++;
      j += 2;
      continue;
    }
    if (src[j] === "*" && src[j + 1] === "/") {
      depth--;
      j += 2;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  return src.length;
}

function rawStringEnd(src, i) {
  if (src[i] !== "r") return i;
  let hashes = 0;
  let j = i + 1;
  while (src[j] === "#") {
    hashes++;
    j++;
  }
  if (src[j] !== '"') return i;
  j++;
  const close = '"' + "#".repeat(hashes);
  const at = src.indexOf(close, j);
  return at < 0 ? src.length : at + close.length;
}

function skipQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === q) return j + 1;
    if (q === '"' && src[j] === "\n") return j;
    j++;
  }
  return src.length;
}
