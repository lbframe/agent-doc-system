// Python adapter: pyproject.toml / setup.cfg / setup.py / requirements*.txt
// as unit markers, the distribution graph as build relations, and the
// verification commands the repository's own config actually proves.
//
// Shape of a marker (documented so a later change does not invent a second rule):
//   deployable — an entrypoint the file states: [project.scripts] or
//     [project.gui-scripts] or [tool.poetry.scripts], a console_scripts entry
//     point, __main__.py, manage.py, or an ASGI/WSGI app object
//     (`app`/`application` = FastAPI|Flask|Starlette|Litestar|Sanic|Quart(...),
//     or get_asgi_application / get_wsgi_application).
//   importable — a build backend ( [build-system] build-backend, or setup.py /
//     setup.cfg) together with a package. The import name is the explicit
//     package list when one is written; otherwise the distribution name with
//     hyphens turned into underscores, when that directory exists; otherwise
//     the single package directory present. Two or more, and no list, is
//     ambiguous: the unit is still importable, and the import name is not
//     recorded.
//   present — a Python manifest with neither of the above. It corroborates a
//     descriptor; it does not invent a service or a library.
//
// Nothing here executes Python, resolves a lockfile, or reads the network.
// A PEP 508 marker is recognised and then ignored: evaluating it would be a
// guess about the interpreter. A dynamic setup.py dependency is not derived.
import { Adapter } from "./registry.mjs";
import { parse as parseToml } from "../core/toml.mjs";
import { AgentDocError, CODES } from "../core/codes.mjs";
import { globToRegExp } from "../core/fsx.mjs";
import { sourceFiles } from "../core/sourcescan.mjs";
import { DEFAULT_NOT_UNIT_ROOTS } from "../core/discover.mjs";

// Nested workspace manifests are discovered only this deep. The same bound
// is what a Cargo workspace walk should use: deterministic, inside the repo,
// and short enough that a generated tree cannot become the search.
const MAX_WORKSPACE_DEPTH = 6;

const DEV_EXTRA = /^(dev|devel|development|test|tests|testing|lint|type|types|typecheck)$/i;
const APP_ASSIGN = /(?:^|\n)\s*(?:app|application)\s*(?::[^\n=]+)?=\s*(?:FastAPI|Flask|Starlette|Litestar|Sanic|Quart)\s*\(/;
const APP_GETTER = /\b(?:get_asgi_application|get_wsgi_application)\s*\(/;
const SKIP_PKG_DIR = new Set(["src", "tests", "test", "docs", "doc", "scripts", "script", "alembic", "migrations", "migration", ".github", "examples", "example"]);

export function pep503(name) {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, "-");
}

// The distribution name, extras, a version specifier and a marker. Returns
// null when the tail is not a specifier — the caller must not keep the name.
export function parsePep508(spec) {
  const s = String(spec).trim();
  // The longer form has to come first: a one-character alternative would
  // succeed on the first letter and leave the rest of the name unparsed.
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(s);
  if (!m) return null;
  let rest = s.slice(m[1].length).trim();
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 0) return null;
    const extras = rest.slice(1, end).trim();
    if (extras && !/^[A-Za-z0-9._-]+(\s*,\s*[A-Za-z0-9._-]+)*$/.test(extras)) return null;
    rest = rest.slice(end + 1).trim();
  }
  if (rest.startsWith("@")) {
    const semi = indexOfMarker(rest);
    const url = (semi < 0 ? rest.slice(1) : rest.slice(1, semi)).trim();
    if (!url || /\s/.test(url)) return null;
    if (semi >= 0 && !markerOk(rest.slice(semi + 1))) return null;
    return { name: pep503(m[1]) };
  }
  const semi = indexOfMarker(rest);
  const ver = (semi < 0 ? rest : rest.slice(0, semi)).trim();
  const marker = semi < 0 ? "" : rest.slice(semi + 1);
  if (ver && !versionOk(ver)) return null;
  if (marker && !markerOk(marker)) return null;
  return { name: pep503(m[1]) };
}

function indexOfMarker(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ";") return i;
  }
  return -1;
}

function versionOk(ver) {
  return ver.split(",").every((c) => /^\s*(?:~=|===|==|!=|<=|>=|<|>)\s*[A-Za-z0-9.!+*_-]+\s*$/.test(c));
}

function markerOk(marker) {
  const t = marker.trim();
  if (!t) return false;
  // Shape only. The marker is not evaluated.
  return /^[A-Za-z0-9_."'<>!=~\s()]+$/.test(t);
}

export function pythonImportNames(text) {
  const out = new Set();
  let triple = null;
  let logical = "";
  for (const raw of String(text).split("\n")) {
    const masked = maskPythonLine(raw, triple);
    triple = masked.triple;
    if (triple && !masked.code.trim()) { logical = ""; continue; }
    let code = masked.code;
    if (logical) { code = logical + " " + code.trim(); logical = ""; }
    if (code.trimEnd().endsWith("\\")) { logical = code.trimEnd().slice(0, -1); continue; }
    for (const part of code.split(";")) collectImport(part, out);
  }
  return [...out].sort();
}

function maskPythonLine(line, triple) {
  if (triple) {
    const at = line.indexOf(triple);
    if (at < 0) return { code: "", triple };
    return maskPythonLine(line.slice(at + triple.length), null);
  }
  let code = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      const q = line.slice(i, i + 3);
      const end = line.indexOf(q, i + 3);
      if (end < 0) return { code, triple: q };
      i = end + 2;
      code += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < line.length && line[i] !== q) { if (line[i] === "\\") i++; i++; }
      code += " ";
      continue;
    }
    if (c === "#") break;
    code += c;
  }
  return { code, triple: null };
}

function collectImport(stmt, out) {
  const t = stmt.trim();
  let m;
  if ((m = /^import\s+(.+)$/.exec(t))) {
    for (const part of m[1].split(",")) addTop(out, part.trim().split(/\s+/)[0]);
    return;
  }
  if ((m = /^from\s+(\.+)([A-Za-z_][\w.]*)?\s+import\b/.exec(t))) return;
  if ((m = /^from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(t))) addTop(out, m[1]);
}

function addTop(out, name) {
  if (!name || name.startsWith(".")) return;
  const top = name.split(".")[0];
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(top)) out.add(top);
}

function join(root, name) {
  return !root || root === "." ? name : root + "/" + name;
}

// Resolve `rel` against a unit directory. Null when the result would leave
// the repository — an escaped path is not a sibling unit.
export function resolveInside(fromDir, rel) {
  if (typeof rel !== "string" || !rel.trim()) return null;
  let p = rel.trim().replace(/\\/g, "/");
  p = p.replace(/^file:(?=\.{0,2}\/)/, "");
  if (p.startsWith("/") || p.includes("://") || p.startsWith("git+") || p.startsWith("file:")) return null;
  p = p.split(";")[0].trim().replace(/\[.*\]$/, "");
  const base = !fromDir || fromDir === "." ? "" : fromDir;
  const parts = (base ? base + "/" + p : p).split("/");
  const out = [];
  for (const seg of parts) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/") || null;
}

function locate(repo, root) {
  const py = join(root, "pyproject.toml");
  const cfg = join(root, "setup.cfg");
  const setup = join(root, "setup.py");
  const pyExists = repo.exists(py);
  const cfgExists = repo.exists(cfg);
  const setupExists = repo.exists(setup);
  const reqs = repo.listDir(root).filter((n) => /^requirements.*\.txt$/.test(n)).sort();
  let manifest = null;
  let kind = null;
  if (pyExists) { manifest = py; kind = "pyproject"; }
  else if (cfgExists) { manifest = cfg; kind = "setup.cfg"; }
  else if (setupExists) { manifest = setup; kind = "setup.py"; }
  else if (reqs.length) { manifest = join(root, reqs[0]); kind = "requirements"; }
  return { py, cfg, setup, pyExists, cfgExists, setupExists, reqs, manifest, kind };
}

function emptyUnit(loc) {
  return {
    marker: loc.kind,
    manifest: loc.manifest,
    dist: null,
    importNames: [],
    ambiguousImports: false,
    importable: false,
    deployable: false,
    requiresPython: null,
    prodDeps: [],
    devDeps: [],
    sourceDeps: [],
    pathDeps: [],
    workspaceNames: [],
    pytestInManifest: false,
    ruffInManifest: false,
    mypyInManifest: false,
    warnings: [],
    error: null,
  };
}

export function readPythonUnit(repo, root) {
  const loc = locate(repo, root);
  if (!loc.manifest) return emptyUnit(loc);
  try {
    if (loc.kind === "pyproject") return readPyproject(repo, root, loc);
    if (loc.kind === "setup.cfg") return readSetupCfg(repo, root, loc);
    if (loc.kind === "setup.py") return readSetupPy(repo, root, loc);
    return readRequirementsUnit(repo, root, loc);
  } catch (e) {
    if (!(e instanceof AgentDocError)) throw e;
    const info = emptyUnit(loc);
    info.error = e;
    return info;
  }
}

function finish(repo, root, info, explicitNames) {
  if (info._prod.has("pytest") || info._dev.has("pytest")) info.pytestInManifest = true;
  if (info._prod.has("ruff") || info._dev.has("ruff")) info.ruffInManifest = true;
  if (info._prod.has("mypy") || info._dev.has("mypy")) info.mypyInManifest = true;
  const dirs = packageDirs(repo, root);
  let names = explicitNames;
  if (!names) {
    const conventional = info.dist ? info.dist.replace(/-/g, "_") : null;
    if (conventional && dirs.includes(conventional)) names = [conventional];
    else if (dirs.length === 1) names = dirs;
    else if (dirs.length > 1) { names = []; info.ambiguousImports = true; }
    else names = [];
  }
  info.importNames = [...new Set(names)].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)).sort();
  const backend = info.backend;
  info.importable = Boolean(backend && (info.ambiguousImports || info.importNames.length > 0));
  info.prodDeps = [...info._prod].sort();
  info.devDeps = [...info._dev].filter((n) => !info._prod.has(n)).sort();
  info.sourceDeps = [...info._source].sort();
  info.workspaceNames = [...info._workspace].sort();
  delete info._prod;
  delete info._dev;
  delete info._source;
  delete info._workspace;
  delete info.backend;
  return info;
}

function blank(loc) {
  const info = emptyUnit(loc);
  info._prod = new Set();
  info._dev = new Set();
  info._source = new Set();
  info._workspace = new Set();
  info.backend = false;
  return info;
}

function warn(info, message) {
  info.warnings.push({ code: CODES.PYTHON_SPECIFIER, message });
}

function addDep(info, spec, bucket) {
  const parsed = parsePep508(spec);
  if (!parsed) { warn(info, "dependency specifier is not PEP 508 and was not recorded: " + spec); return null; }
  if (parsed.name === "python") return null;
  info[bucket].add(parsed.name);
  return parsed.name;
}

function readPyproject(repo, root, loc) {
  const doc = parseToml(repo.readText(loc.manifest), loc.manifest);
  const info = blank(loc);
  const project = doc.project && typeof doc.project === "object" ? doc.project : null;
  const poetry = doc.tool && doc.tool.poetry && typeof doc.tool.poetry === "object" ? doc.tool.poetry : null;
  if (project && typeof project.name === "string") info.dist = pep503(project.name);
  else if (poetry && typeof poetry.name === "string") info.dist = pep503(poetry.name);
  if (project && typeof project["requires-python"] === "string") info.requiresPython = project["requires-python"].trim();
  const backend = doc["build-system"] && doc["build-system"]["build-backend"];
  info.backend = typeof backend === "string" && backend.trim().length > 0;

  for (const spec of stringList(project && project.dependencies)) {
    const n = addDep(info, spec, "_prod");
    if (n) info._source.add(n);
  }
  const groups = doc["dependency-groups"];
  if (groups && typeof groups === "object" && !Array.isArray(groups)) {
    for (const [gname, specs] of Object.entries(groups)) {
      for (const spec of expandGroup(groups, gname, specs, new Set(), info)) {
        addDep(info, spec, "_dev");
      }
    }
  }
  const extras = project && project["optional-dependencies"];
  if (extras && typeof extras === "object") {
    for (const [gname, specs] of Object.entries(extras)) {
      if (!DEV_EXTRA.test(gname)) continue;
      for (const spec of stringList(specs)) addDep(info, spec, "_dev");
    }
  }
  if (poetry) {
    takePoetryTable(info, poetry.dependencies, "_prod", root);
    const g = poetry.group;
    if (g && typeof g === "object") {
      for (const group of Object.values(g)) {
        if (group && typeof group === "object") takePoetryTable(info, group.dependencies, "_dev", root);
      }
    }
  }
  const sources = doc.tool && doc.tool.uv && doc.tool.uv.sources;
  if (sources && typeof sources === "object") {
    for (const [name, val] of Object.entries(sources)) {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)) { warn(info, "uv source name is not a distribution name: " + name); continue; }
      const norm = pep503(name);
      info._source.add(norm);
      if (!val || typeof val !== "object" || Array.isArray(val)) continue;
      const hasPath = typeof val.path === "string";
      const hasWorkspace = val.workspace === true;
      if (!hasPath && !hasWorkspace) continue;
      if (hasWorkspace) info._workspace.add(norm);
      if (hasPath && hasWorkspace) {
        const dir = resolveInside(root, val.path);
        const member = resolveWorkspaceMember(repo, root, norm);
        if (dir && member.dir === dir && !member.ambiguous) info.pathDeps.push({ name: norm, dir });
        else info.warnings.push({ code: "AGENTDOC_BINDING_AMBIGUOUS", message: "uv source '" + name + "' sets both path and workspace = true and they do not name one directory" });
        continue;
      }
      if (hasPath) {
        const dir = resolveInside(root, val.path);
        if (dir) info.pathDeps.push({ name: norm, dir });
        else warn(info, "uv source path for '" + name + "' does not stay inside the repository");
        continue;
      }
      const member = resolveWorkspaceMember(repo, root, norm);
      if (member.ambiguous) {
        info.warnings.push({ code: "AGENTDOC_BINDING_AMBIGUOUS", message: "uv source '" + name + "' matches more than one member of the enclosing workspace" });
        continue;
      }
      if (member.dir) info.pathDeps.push({ name: norm, dir: member.dir });
      else if (member.missingWorkspace) warn(info, "uv source '" + name + "' sets workspace = true but no enclosing workspace manifest was found");
      else warn(info, "uv source '" + name + "' sets workspace = true but no member of the enclosing workspace has that name");
    }
  }
  info.pytestInManifest = Boolean(doc.tool && doc.tool.pytest && doc.tool.pytest.ini_options);
  info.ruffInManifest = Boolean(doc.tool && doc.tool.ruff);
  info.mypyInManifest = Boolean(doc.tool && doc.tool.mypy);
  const scripts = nonEmpty(project && project.scripts) || nonEmpty(project && project["gui-scripts"]) || nonEmpty(poetry && poetry.scripts);
  info.deployable = scripts || hasEntrypointFile(repo, root);
  return finish(repo, root, info, explicitImportNames(doc));
}

function expandGroup(groups, gname, specs, seen, info) {
  if (seen.has(gname)) { warn(info, "dependency-group '" + gname + "' includes itself"); return []; }
  seen.add(gname);
  const out = [];
  for (const item of Array.isArray(specs) ? specs : []) {
    if (typeof item === "string") { out.push(item); continue; }
    if (item && typeof item === "object" && typeof item["include-group"] === "string") {
      const other = item["include-group"];
      if (!Object.prototype.hasOwnProperty.call(groups, other)) {
        warn(info, "dependency-group '" + other + "' is included but not declared");
        continue;
      }
      out.push(...expandGroup(groups, other, groups[other], seen, info));
      continue;
    }
    warn(info, "dependency-group '" + gname + "' has an entry that is not a specifier");
  }
  return out;
}

function takePoetryTable(info, table, bucket, root) {
  if (!table || typeof table !== "object" || Array.isArray(table)) return;
  for (const [name, val] of Object.entries(table)) {
    if (name === "python") {
      const spec = typeof val === "string" ? val : val && typeof val.version === "string" ? val.version : null;
      if (spec && !info.requiresPython) info.requiresPython = spec.trim();
      continue;
    }
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)) { warn(info, "poetry dependency name is not a distribution name: " + name); continue; }
    const norm = pep503(name);
    info[bucket].add(norm);
    if (bucket === "_prod") info._source.add(norm);
    if (val && typeof val === "object" && typeof val.path === "string") {
      info._source.add(norm);
      const dir = resolveInside(root, val.path);
      if (dir) info.pathDeps.push({ name: norm, dir });
      else warn(info, "poetry path for '" + name + "' does not stay inside the repository");
    }
  }
}

function explicitImportNames(doc) {
  const names = [];
  let explicit = false;
  const st = doc.tool && doc.tool.setuptools && doc.tool.setuptools.packages;
  if (Array.isArray(st)) {
    explicit = true;
    for (const s of st) if (typeof s === "string") names.push(s.split(".")[0]);
  }
  const poetry = doc.tool && doc.tool.poetry && doc.tool.poetry.packages;
  if (Array.isArray(poetry)) {
    explicit = true;
    for (const p of poetry) {
      if (p && typeof p.include === "string") names.push(p.include.split(/[./]/).filter(Boolean).pop());
    }
  }
  const wheel = doc.tool && doc.tool.hatch && doc.tool.hatch.build && doc.tool.hatch.build.targets && doc.tool.hatch.build.targets.wheel;
  const hatch = wheel && wheel.packages;
  if (Array.isArray(hatch)) {
    explicit = true;
    for (const p of hatch) if (typeof p === "string") names.push(p.split("/").filter(Boolean).pop());
  }
  if (!explicit) return null;
  return [...new Set(names)];
}

function readSetupCfg(repo, root, loc) {
  const text = repo.readText(loc.manifest);
  const ini = parseIni(text);
  const info = blank(loc);
  info.backend = true;
  const meta = ini.get("metadata") || new Map();
  const name = first(meta.get("name"));
  if (name) info.dist = pep503(name);
  const py = first(meta.get("python_requires"));
  if (py) info.requiresPython = py;
  const options = ini.get("options") || new Map();
  for (const spec of options.get("install_requires") || []) addDep(info, spec, "_prod");
  for (const spec of options.get("tests_require") || []) addDep(info, spec, "_dev");
  const extras = ini.get("options.extras_require") || new Map();
  for (const [gname, specs] of extras) {
    if (!DEV_EXTRA.test(gname)) continue;
    for (const spec of specs) addDep(info, spec, "_dev");
  }
  const entry = ini.get("options.entry_points") || new Map();
  const scripts = (entry.get("console_scripts") || []).length > 0 || (entry.get("gui_scripts") || []).length > 0;
  info.deployable = scripts || hasEntrypointFile(repo, root);
  info.pytestInManifest = ini.has("tool:pytest");
  info.mypyInManifest = ini.has("mypy") || ini.has("tool:mypy");
  let explicit = null;
  const packages = options.get("packages") || [];
  if (packages.length && !(packages.length === 1 && packages[0] === "find:")) explicit = packages.map((p) => p.split(".")[0]);
  return finish(repo, root, info, explicit);
}

function readSetupPy(repo, root, loc) {
  const text = repo.readText(loc.manifest);
  const info = blank(loc);
  info.backend = true;
  const name = /(?:^|\n)\s*name\s*=\s*(['"])([^'"]+)\1/.exec(text);
  if (name) info.dist = pep503(name[2]);
  const reqPy = /(?:^|\n)\s*python_requires\s*=\s*(['"])([^'"]+)\1/.exec(text);
  if (reqPy) info.requiresPython = reqPy[2].trim();
  const listed = /(?:^|\n)\s*install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (listed) {
    const stripped = listed[1].replace(/#[^\n]*/g, "").replace(/([rubfRUBF]*)(['"])[\s\S]*?\2/g, "").replace(/[\[\],\s]/g, "");
    if (stripped) warn(info, "setup.py install_requires is not a literal list; its dependencies were not derived");
    else for (const m of listed[1].matchAll(/['"]([^'"]+)['"]/g)) addDep(info, m[1], "_prod");
  } else if (/install_requires\s*=/.test(text)) {
    warn(info, "setup.py install_requires is not a literal list; its dependencies were not derived");
  }
  info.deployable = /console_scripts/.test(text) || hasEntrypointFile(repo, root);
  return finish(repo, root, info, null);
}

function readRequirementsUnit(repo, root, loc) {
  const info = blank(loc);
  info.backend = false;
  for (const name of loc.reqs) {
    const file = join(root, name);
    const dev = /(dev|test)/i.test(name);
    const parsed = parseRequirements(repo.readText(file), info);
    for (const spec of parsed.deps) addDep(info, spec, dev ? "_dev" : "_prod");
    for (const rel of parsed.paths) {
      const dir = resolveInside(root, rel);
      if (!dir) { warn(info, "editable requirement '" + rel + "' does not stay inside the repository"); continue; }
      const base = pep503(dir.split("/").pop());
      info._source.add(base);
      if (dev) info._dev.add(base);
      else info._prod.add(base);
      info.pathDeps.push({ name: base, dir });
    }
  }
  info.deployable = hasEntrypointFile(repo, root);
  return finish(repo, root, info, null);
}

function parseRequirements(text, info) {
  const deps = [];
  const paths = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (/^(-r|--requirement|-c|--constraint)\b/.test(line)) {
      warn(info, "included requirement file is not expanded: " + line);
      continue;
    }
    if (/^(-e|--editable)\b/.test(line)) {
      const spec = line.replace(/^(-e|--editable)\s+/, "").trim();
      const path = editablePath(spec);
      if (path) paths.push(path);
      else warn(info, "editable requirement is not a repository path: " + spec);
      continue;
    }
    if (line.startsWith("-")) continue;
    deps.push(line);
  }
  return { deps, paths };
}

function editablePath(spec) {
  let s = spec.trim();
  const at = s.indexOf(" @ ");
  if (at >= 0) s = s.slice(at + 3).trim();
  s = s.replace(/^file:(?=\.{0,2}\/)/, "");
  if (!s || s.startsWith("file:") || s.includes("://") || s.startsWith("git+")) return null;
  return s.split(";")[0].trim();
}

function parseIni(text) {
  const sections = new Map();
  let cur = null;
  let key = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sec) {
      cur = sec[1].trim();
      if (!sections.has(cur)) sections.set(cur, new Map());
      key = null;
      continue;
    }
    if (!cur || /^\s*[#;]/.test(line) || !line.trim()) continue;
    const kv = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const prev = sections.get(cur).get(key) || [];
      if (kv[2].trim()) prev.push(kv[2].trim());
      sections.get(cur).set(key, prev);
      continue;
    }
    if (key && /^\s+\S/.test(line)) sections.get(cur).get(key).push(line.trim());
  }
  return sections;
}

function first(list) { return list && list.length ? list[0] : null; }
function stringList(v) { return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
function nonEmpty(t) { return Boolean(t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).length); }

function packageDirs(repo, root) {
  const found = [];
  const src = join(root, "src");
  if (repo.isDir(src)) {
    for (const name of repo.listDir(src)) {
      if (!name.endsWith("/")) continue;
      const base = name.slice(0, -1);
      if (repo.exists(join(src, base) + "/__init__.py")) found.push(base);
    }
  }
  for (const name of repo.listDir(root)) {
    if (!name.endsWith("/")) continue;
    const base = name.slice(0, -1);
    if (SKIP_PKG_DIR.has(base) || base.startsWith(".")) continue;
    if (repo.exists(join(root, base) + "/__init__.py")) found.push(base);
  }
  return [...new Set(found)].sort();
}

function hasEntrypointFile(repo, root) {
  if (repo.exists(join(root, "manage.py"))) return true;
  const prefix = !root || root === "." ? "" : root + "/";
  for (const f of repo.walk(root)) {
    if (!f.endsWith("/__main__.py") && f !== prefix + "__main__.py") continue;
    if (/(^|\/)tests?\//.test(prefix ? f.slice(prefix.length) : f)) continue;
    return true;
  }
  for (const f of sourceFiles(repo, root, { test: false, extensions: /\.py$/ })) {
    if (APP_ASSIGN.test(repo.readText(f)) || APP_GETTER.test(repo.readText(f))) return true;
  }
  return false;
}

function classify(info, name, target) {
  const keys = [name, target && target.pythonDist].filter(Boolean);
  if (keys.some((k) => info.prodDeps.includes(k))) return "buildDependsOn";
  if (keys.some((k) => info.devDeps.includes(k))) return "testDependsOn";
  if (keys.some((k) => info.sourceDeps.includes(k))) return "buildDependsOn";
  return "buildDependsOn";
}

function lockLists(text, name) {
  const n = pep503(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^name\\s*=\\s*[\"']" + n + "[\"']\\s*(?:#.*)?$", "m").test(text);
}

function findUp(repo, root, filename) {
  let dir = root || ".";
  for (;;) {
    const p = !dir || dir === "." ? filename : dir + "/" + filename;
    if (repo.exists(p)) return p;
    if (!dir || dir === ".") return null;
    const i = dir.lastIndexOf("/");
    dir = i < 0 ? "." : dir.slice(0, i);
  }
}

function runnerFor(repo, root, tool, warnings) {
  const uv = findUp(repo, root, "uv.lock");
  const poetry = findUp(repo, root, "poetry.lock");
  const uvProves = Boolean(uv && lockLists(repo.readText(uv), tool));
  const poetryProves = Boolean(poetry && lockLists(repo.readText(poetry), tool));
  if (uvProves && poetryProves) {
    warnings.push({ code: "AGENTDOC_BINDING_AMBIGUOUS", message: "both uv.lock and poetry.lock provide '" + tool + "'; the command is not prefixed with a runner" });
    return { prefix: null, files: [] };
  }
  if (uvProves) return { prefix: "uv run", files: [uv] };
  if (poetryProves) return { prefix: "poetry run", files: [poetry] };
  return { prefix: null, files: [] };
}

function testPyFiles(repo, root) {
  const prefix = !root || root === "." ? "" : root + "/";
  return repo.walk(root).filter((f) => {
    if (!f.endsWith(".py")) return false;
    if (prefix && f !== root && !f.startsWith(prefix)) return false;
    const base = prefix ? f.slice(prefix.length) : f;
    if (/(^|\/)conftest\.py$/.test(base)) return true;
    if (/(^|\/)test_.+\.py$/.test(base) || /_test\.py$/.test(base)) return true;
    if (/(^|\/)tests?\//.test(base)) return true;
    return false;
  });
}

function usesUnittest(repo, files) {
  return files.some((f) => {
    if (/(^|\/)conftest\.py$/.test(f)) return false;
    return /^\s*(?:import\s+unittest\b|from\s+unittest\b)/m.test(repo.readText(f));
  });
}

function addCommand(ctx, compRef, prov, id, tier, command, configPaths) {
  ctx.addVerification({
    id: compRef + ":" + id,
    componentRefs: [compRef],
    tier,
    command,
    configPaths: [...new Set(configPaths)].sort(),
    provRecs: [prov],
  });
}

export class PythonAdapter extends Adapter {
  static adapterName = "python";
  constructor() {
    super({ name: "python", version: "1.1.0", kind: "unit-marker" });
  }

  roots(ctx) {
    const out = new Map();
    const workspaces = uvWorkspaceManifests(ctx.repo, ctx.cfg);
    const hop = new Set();
    for (const ws of workspaces) {
      hop.add(ws.dir || ".");
      const members = expandMembers(ctx.repo, ws.dir, ws.table.members || []);
      const excluded = new Set(expandMembers(ctx.repo, ws.dir, ws.table.exclude || []));
      for (const dir of members) {
        if (excluded.has(dir) || skippedRoot(ctx, dir)) continue;
        if (hasMarker(ctx.repo, dir)) out.set(dir, { root: dir });
      }
    }
    for (const dir of out.keys()) hop.add(dir);
    for (const dir of [...hop].sort()) {
      const file = !dir || dir === "." ? "pyproject.toml" : dir + "/pyproject.toml";
      if (!ctx.repo.exists(file)) continue;
      let parsed;
      try { parsed = parseToml(ctx.repo.readText(file), file); }
      catch { continue; }
      const from = dir === "." ? "" : dir;
      for (const rel of pathDepsOf(parsed)) {
        const resolved = resolveInside(from, rel);
        if (!resolved || skippedRoot(ctx, resolved) || !ctx.repo.isDir(resolved) || !hasMarker(ctx.repo, resolved)) continue;
        if (!out.has(resolved)) out.set(resolved, { root: resolved });
      }
    }
    return [...out.values()].sort((a, b) => (a.root < b.root ? -1 : 1));
  }

  detect(ctx, root) {
    const info = readPythonUnit(ctx.repo, root);
    if (!info.manifest) return null;
    const shape = info.deployable && info.importable ? "both" : info.deployable ? "deployable" : info.importable ? "importable" : "present";
    return { path: info.manifest, shape };
  }

  extract(ctx, unit) {
    const info = readPythonUnit(ctx.repo, unit.root);
    if (!info.manifest || info.error) return {};
    const { repo, prov, compRef } = ctx;
    const derived = { languages: new Set(["python"]), runtimes: new Set(["python"]) };
    if (info.dist) derived.pythonDistribution = info.dist;
    if (info.importNames.length && !info.ambiguousImports) derived.pythonImportNames = info.importNames;
    if (info.requiresPython) derived.requiresPython = info.requiresPython;
    const subjects = ["der:" + compRef + ":/runtimes", "der:" + compRef + ":/languages"];
    if (info.requiresPython) subjects.push("der:" + compRef + ":/requiresPython");
    const pr = prov.add("observed", info.manifest, "python-manifest-extractor", subjects);

    for (const w of info.warnings) {
      ctx.diagnostics.push({
        severity: "warning", code: w.code, subject: compRef, refs: [compRef], message: w.message, paths: [info.manifest],
      });
    }
    if (info.ambiguousImports || unit.pythonDistConflict || unit.pythonImportConflict) {
      ctx.diagnostics.push({
        severity: "warning",
        code: "AGENTDOC_BINDING_AMBIGUOUS",
        subject: compRef,
        refs: [compRef],
        paths: [info.manifest],
        message: info.ambiguousImports
          ? "python unit '" + unit.root + "' has more than one import package and no explicit package list; the import name is left unresolved"
          : "python distribution or import name of '" + unit.root + "' is claimed by another unit; the cross-unit link is left unresolved",
      });
    }

    const externalNames = new Set(info.prodDeps);
    for (const n of info.sourceDeps) if (!info.devDeps.includes(n)) externalNames.add(n);
    for (const name of [...externalNames].sort()) {
      for (const x of ctx.externalMatchers()) {
        if (!x.re.test(name)) continue;
        ctx.addExternal(compRef, x.name, x.mechanism, x.role, pr, "DERIVED");
      }
    }

    const linked = new Set();
    const link = (target, pkg, type, via, files) => {
      if (!target || !target.component || target.component.ref === compRef) return;
      const key = type + "|" + target.component.ref + "|" + pkg + "|" + via;
      if (linked.has(key)) return;
      linked.add(key);
      const provs = files.length
        ? files.map((f) => prov.add("observed", f, "python-import-extractor", ["rel:pending"]))
        : [pr];
      ctx.addEdge(type, compRef, target.component.ref, { via, package: pkg }, provs, "DERIVED");
    };

    const byRoot = new Map(ctx.discovery.eligible.map((u) => [u.root, u]));
    const workspaceOnly = new Set(info.workspaceNames || []);
    const consider = new Set([...info.prodDeps, ...info.devDeps, ...info.sourceDeps]);
    for (const name of [...consider].sort()) {
      // `workspace = true` is resolved against the nearest enclosing workspace.
      // The global distribution map must not substitute a different sibling.
      if (workspaceOnly.has(name)) continue;
      const target = ctx.unitByPythonDist.get(name);
      if (!target) continue;
      link(target, target.pythonDist || name, classify(info, name, target), "python-manifest", []);
    }
    for (const p of info.pathDeps) {
      const target = byRoot.get(p.dir);
      if (!target) continue;
      const pkg = target.pythonDist || p.name;
      link(target, pkg, classify(info, p.name, target), "python-manifest", []);
    }

    const imports = (ctx.importIndex.pythonImportsByUnit && ctx.importIndex.pythonImportsByUnit.get(unit)) || new Map();
    const byTarget = new Map();
    const shadowed = [];
    for (const name of [...imports.keys()].sort()) {
      const files = imports.get(name);
      const siblings = siblingImportUnits(ctx, unit, name);
      // A module or package the unit itself provides is not a sibling import.
      // Script-style layouts keep that module next to the importing file.
      if (unitProvidesImport(repo, unit.root, name, files)) {
        if (siblings.some((u) => u.component)) shadowed.push(name);
        continue;
      }
      if (siblings.length !== 1) continue;
      const target = siblings[0];
      if (!target.component || target.component.ref === compRef) continue;
      if (!byTarget.has(target)) byTarget.set(target, new Set());
      for (const f of files) byTarget.get(target).add(f);
    }
    if (shadowed.length) {
      const files = shadowed.flatMap((name) => [...imports.get(name)]);
      ctx.diagnostics.push({
        severity: "warning",
        code: "AGENTDOC_BINDING_AMBIGUOUS",
        subject: compRef,
        refs: [compRef],
        paths: [...new Set([info.manifest, ...files])].sort(),
        message: "import " + shadowed.join(", ") + " is provided by unit '" + unit.root + "' and also by a sibling; no import edge was recorded",
      });
    }
    for (const [target, files] of [...byTarget.entries()].sort((a, b) => (a[0].root < b[0].root ? -1 : 1))) {
      const pkg = target.pythonDist || pep503([...imports.keys()].find((n) => ctx.unitByPythonImport.get(n) === target) || target.root.split("/").pop());
      link(target, pkg, classify(info, pkg, target), "python-import", [...files].sort());
    }

    const tests = testPyFiles(repo, unit.root);
    if (tests.length) derived.hasTests = true;
    const pytestPaths = [];
    if (info.pytestInManifest) pytestPaths.push(info.manifest);
    for (const n of ["pytest.ini", "pytest.toml", ".pytest.ini"]) {
      const p = join(unit.root, n);
      if (repo.exists(p)) pytestPaths.push(p);
    }
    for (const f of tests) if (/(^|\/)conftest\.py$/.test(f)) pytestPaths.push(f);
    if (repo.exists(locSetupCfg(unit)) && /\[tool:pytest\]/.test(repo.readText(locSetupCfg(unit)))) {
      if (!pytestPaths.includes(locSetupCfg(unit))) pytestPaths.push(locSetupCfg(unit));
    }
    const runnerWarnings = [];
    if (pytestPaths.length) {
      const runner = runnerFor(repo, unit.root, "pytest", runnerWarnings);
      addCommand(ctx, compRef, pr, "pytest", "unit", (runner.prefix ? runner.prefix + " " : "") + "pytest", [...pytestPaths, ...runner.files]);
    } else if (usesUnittest(repo, tests)) {
      addCommand(ctx, compRef, pr, "unittest", "unit", "python -m unittest discover", [info.manifest]);
    }
    const ruffPaths = info.ruffInManifest ? [info.manifest] : [];
    for (const n of ["ruff.toml", ".ruff.toml"]) {
      const p = join(unit.root, n);
      if (repo.exists(p)) ruffPaths.push(p);
    }
    if (ruffPaths.length) {
      const runner = runnerFor(repo, unit.root, "ruff", runnerWarnings);
      addCommand(ctx, compRef, pr, "ruff", "static", (runner.prefix ? runner.prefix + " " : "") + "ruff check", [...ruffPaths, ...runner.files]);
    }
    const mypyPaths = info.mypyInManifest ? [info.manifest] : [];
    for (const n of ["mypy.ini", ".mypy.ini"]) {
      const p = join(unit.root, n);
      if (repo.exists(p)) mypyPaths.push(p);
    }
    if (mypyPaths.length) {
      const runner = runnerFor(repo, unit.root, "mypy", runnerWarnings);
      addCommand(ctx, compRef, pr, "mypy", "static", (runner.prefix ? runner.prefix + " " : "") + "mypy", [...mypyPaths, ...runner.files]);
    }
    for (const w of runnerWarnings) {
      ctx.diagnostics.push({
        severity: "warning", code: w.code, subject: compRef, refs: [compRef], message: w.message, paths: [info.manifest],
      });
    }
    return derived;
  }
}

function locSetupCfg(unit) { return join(unit.root, "setup.cfg"); }

function hasMarker(repo, dir) {
  return repo.exists(dir + "/pyproject.toml") || repo.exists(dir + "/setup.cfg") || repo.exists(dir + "/setup.py")
    || repo.listDir(dir).some((n) => /^requirements.*\.txt$/.test(n));
}

function notUnitSet(cfg) {
  const configured = cfg && cfg.discovery && cfg.discovery.notUnitRoots;
  return new Set(configured || DEFAULT_NOT_UNIT_ROOTS);
}

function skippedRoot(ctx, dir) {
  if (!dir) return false;
  if (notUnitSet(ctx.cfg).has(dir)) return true;
  const skip = ctx.repo.generatedDirs;
  return dir.split("/").some((seg) => skip && skip.has(seg));
}

function underSkippedRoot(dir, notUnit, skip) {
  if (!dir) return false;
  const parts = dir.split("/");
  if (parts.some((seg) => seg.startsWith(".") || (skip && skip.has(seg)))) return true;
  for (let i = 1; i <= parts.length; i++) {
    if (notUnit.has(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

// Workspace manifests at the repository root and below it. The file list comes
// from walk(), which already skips generated directories, so creating
// `.agentdoc/` between compiles does not change the input. Only manifests
// within MAX_WORKSPACE_DEPTH are workspaces.
function uvWorkspaceManifests(repo, cfg) {
  const notUnit = notUnitSet(cfg);
  const skip = repo.generatedDirs || new Set();
  const found = [];
  for (const f of repo.walk(".")) {
    if (f !== "pyproject.toml" && !f.endsWith("/pyproject.toml")) continue;
    const dir = f === "pyproject.toml" ? "" : f.slice(0, -"/pyproject.toml".length);
    const depth = dir ? dir.split("/").length : 0;
    if (depth > MAX_WORKSPACE_DEPTH) continue;
    if (underSkippedRoot(dir, notUnit, skip)) continue;
    try {
      const doc = parseToml(repo.readText(f), f);
      const table = doc.tool && doc.tool.uv && doc.tool.uv.workspace;
      if (table && typeof table === "object" && !Array.isArray(table)) found.push({ dir, table });
    } catch { /* a broken file is not a workspace; the unit reports the parse */ }
  }
  found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return found;
}

function nearestUvWorkspace(repo, root) {
  let dir = !root || root === "." ? "" : root;
  const seen = new Set();
  while (!seen.has(dir)) {
    seen.add(dir);
    const manifest = dir ? dir + "/pyproject.toml" : "pyproject.toml";
    if (repo.exists(manifest)) {
      try {
        const doc = parseToml(repo.readText(manifest), manifest);
        const table = doc.tool && doc.tool.uv && doc.tool.uv.workspace;
        if (table && typeof table === "object" && !Array.isArray(table)) return { dir, table };
      } catch { /* walk through a file that does not parse */ }
    }
    if (!dir) return null;
    const i = dir.lastIndexOf("/");
    dir = i < 0 ? "" : dir.slice(0, i);
  }
  return null;
}

function resolveWorkspaceMember(repo, fromRoot, name) {
  const ws = nearestUvWorkspace(repo, fromRoot);
  if (!ws) return { dir: null, ambiguous: false, missingWorkspace: true };
  const members = expandMembers(repo, ws.dir, ws.table.members || []);
  const excluded = new Set(expandMembers(repo, ws.dir, ws.table.exclude || []));
  const hits = [];
  for (const dir of members) {
    if (excluded.has(dir)) continue;
    if (distributionNameAt(repo, dir) === name) hits.push(dir);
  }
  if (hits.length > 1) return { dir: null, ambiguous: true, missingWorkspace: false };
  if (hits.length === 1) return { dir: hits[0], ambiguous: false, missingWorkspace: false };
  return { dir: null, ambiguous: false, missingWorkspace: false };
}

function distributionNameAt(repo, dir) {
  const loc = locate(repo, dir);
  try {
    if (loc.kind === "pyproject") {
      const doc = parseToml(repo.readText(loc.manifest), loc.manifest);
      const project = doc.project && doc.project.name;
      const poetry = doc.tool && doc.tool.poetry && doc.tool.poetry.name;
      if (typeof project === "string" && project.trim()) return pep503(project);
      if (typeof poetry === "string" && poetry.trim()) return pep503(poetry);
      return null;
    }
    if (loc.kind === "setup.cfg") {
      const meta = /\[metadata\]([^[]*)/.exec(repo.readText(loc.manifest));
      const n = meta && /^name\s*=\s*(\S+)/m.exec(meta[1]);
      return n ? pep503(n[1]) : null;
    }
    if (loc.kind === "setup.py") {
      const name = /(?:^|\n)\s*name\s*=\s*(['"])([^'"]+)\1/.exec(repo.readText(loc.manifest));
      return name ? pep503(name[2]) : null;
    }
  } catch {
    return null;
  }
  return null;
}

function hasModule(repo, dir, name) {
  const base = !dir || dir === "." ? "" : dir;
  const py = (base ? base + "/" : "") + name + ".py";
  const init = (base ? base + "/" : "") + name + "/__init__.py";
  return repo.exists(py) || repo.exists(init);
}

// Top-level module at the unit root, under src/, or beside the importing file.
function unitProvidesImport(repo, unitRoot, name, files) {
  const root = !unitRoot || unitRoot === "." ? "" : unitRoot;
  if (hasModule(repo, root, name)) return true;
  if (hasModule(repo, root ? root + "/src" : "src", name)) return true;
  for (const f of files || []) {
    const slash = f.lastIndexOf("/");
    if (hasModule(repo, slash < 0 ? "" : f.slice(0, slash), name)) return true;
  }
  return false;
}

function siblingImportUnits(ctx, unit, name) {
  const out = [];
  for (const u of ctx.discovery.eligible) {
    if (u === unit || !Array.isArray(u.pythonImports)) continue;
    if (u.pythonImports.includes(name)) out.push(u);
  }
  return out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

function expandMembers(repo, base, patterns) {
  const root = !base || base === "." ? "" : String(base).replace(/\/$/, "");
  const dirs = [];
  const list = Array.isArray(patterns) ? patterns : [];
  for (const g of list) {
    if (typeof g !== "string") continue;
    const pat = g.replace(/^\.\//, "").replace(/\/$/, "");
    if (!pat || pat.startsWith("/") || pat.split("/").includes("..")) continue;
    const full = root ? root + "/" + pat : pat;
    if (full.split("/").includes("..")) continue;
    if (!/[*?]/.test(pat)) {
      if (repo.isDir(full)) dirs.push(full);
      continue;
    }
    let re;
    try { re = globToRegExp(full); }
    catch { continue; }
    const prefix = full.split(/[*?]/)[0].replace(/\/$/, "");
    if (prefix && !repo.isDir(prefix)) continue;
    for (const d of nestedDirs(repo, prefix || ".", 6)) if (re.test(d)) dirs.push(d);
  }
  return [...new Set(dirs)].sort();
}

function nestedDirs(repo, base, maxDepth) {
  const out = [];
  const start = base === "." ? "" : base;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    for (const name of repo.listDir(dir)) {
      if (!name.endsWith("/")) continue;
      const baseName = name.slice(0, -1);
      if (baseName.startsWith(".") || baseName === "__pycache__" || (repo.generatedDirs && repo.generatedDirs.has(baseName))) continue;
      const child = dir ? dir + "/" + baseName : baseName;
      out.push(child);
      walk(child, depth + 1);
    }
  };
  walk(start, 1);
  return out.sort();
}

function pathDepsOf(doc) {
  const out = [];
  const sources = doc.tool && doc.tool.uv && doc.tool.uv.sources;
  if (sources && typeof sources === "object") {
    for (const val of Object.values(sources)) {
      if (val && typeof val === "object" && typeof val.path === "string") out.push(val.path);
    }
  }
  const poetry = doc.tool && doc.tool.poetry;
  if (poetry && typeof poetry === "object") {
    collectPoetryPaths(poetry.dependencies, out);
    const groups = poetry.group;
    if (groups && typeof groups === "object") {
      for (const g of Object.values(groups)) if (g && typeof g === "object") collectPoetryPaths(g.dependencies, out);
    }
  }
  return out;
}

function collectPoetryPaths(table, out) {
  if (!table || typeof table !== "object") return;
  for (const val of Object.values(table)) {
    if (val && typeof val === "object" && typeof val.path === "string") out.push(val.path);
  }
}
