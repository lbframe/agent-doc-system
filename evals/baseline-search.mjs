// A deterministic working-tree reader. No graph, adapters, routing or scenario
// truth enters retrieval; the harness alone scores the returned facts/checks.
import fs from "node:fs";
import path from "node:path";
import { parseYamlDocuments } from "../core/yaml.mjs";
import { parse as parseToml } from "../core/toml.mjs";
import { fact, addRelationFacts } from "./facts.mjs";

const SKIP = new Set([".git", ".agentdoc", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build", ".next"]);
const TEXT = /\.(?:[cm]?[jt]sx?|go|rs|py|proto|sql|md|rst|txt|json|ya?ml|toml|ini|cfg|mod|work|lock)$/;
const SOURCE = /\.(?:[cm]?[jt]sx?|go|rs|py)$/;
const MANIFEST = /(?:^|\/)(?:package.json|Cargo.toml|pyproject.toml|go.mod|setup.cfg|setup.py|requirements[^/]*\.txt)$/;
const CHECK = /(?:test|lint|typecheck|check|clippy|vet|pytest|ruff|mypy|unittest)/i;
const under = (file, dir) => dir === "." || file === dir || file.startsWith(dir + "/");
const slug = (s) => s.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const quoted = (text) => [...text.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text, name) => new RegExp("(?<![\\w@/.-])" + esc(name) + "(?![\\w@/.-])").test(text);

function filesIn(root, dir = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const rel = dir ? dir + "/" + e.name : e.name;
    if (e.isDirectory() && !SKIP.has(e.name)) out.push(...filesIn(root, rel));
    else if (e.isFile() && e.name !== "graph.json" && (TEXT.test(rel) || e.name === "Dockerfile")) out.push(rel);
  }
  return out;
}

function readData(text, file) {
  try {
    if (file.endsWith(".json")) return JSON.parse(text);
    if (file.endsWith(".toml")) return parseToml(text, file);
  } catch { /* Malformed manifests remain searchable text. */ }
  return {};
}

function imports(file, text) {
  if (/\.[cm]?[jt]sx?$/.test(file)) return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
  if (file.endsWith(".go")) return quoted(text);
  if (file.endsWith(".rs")) {
    const local = new Set([...text.matchAll(/\bmod\s+(\w+)\s*[;{]/g)].map((m) => m[1]));
    return [...text.matchAll(/\b(?:use|extern\s+crate)\s+(\w+)|\b(\w+)::/g)].map((m) => m[1] || m[2]).filter((n) => !local.has(n));
  }
  if (file.endsWith(".py")) return [...text.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)].map((m) => m[1]);
  return [];
}

function unitNames(unit, entries) {
  const names = new Set();
  for (const [file, text] of entries) {
    const data = readData(text, file);
    if (file === path.posix.join(unit.dir, "package.json") && data.name) names.add(data.name);
    if (file === path.posix.join(unit.dir, "Cargo.toml") && data.package?.name) {
      names.add(data.package.name);
      names.add(data.package.name.replace(/-/g, "_"));
    }
    if (file === path.posix.join(unit.dir, "go.mod")) {
      const module = /^module\s+(\S+)/m.exec(text)?.[1];
      if (module) names.add(module);
    }
    if (path.posix.basename(file) === "pyproject.toml") {
      const name = data.project?.name || data.tool?.poetry?.name;
      if (name) names.add(name);
    }
    const rel = path.posix.relative(unit.dir, file);
    const py = /^(?:src\/)?([\w]+)\/(?:__init__|__main__)\.py$/.exec(rel);
    if (py) names.add(py[1]);
  }
  return [...names];
}

function externalNames(file, text) {
  const data = readData(text, file);
  if (file.endsWith("package.json")) return Object.keys({ ...data.dependencies, ...data.devDependencies, ...data.peerDependencies, ...data.optionalDependencies });
  if (file.endsWith("Cargo.toml")) return Object.keys({ ...data.dependencies, ...data["dev-dependencies"], ...data["build-dependencies"] });
  if (file.endsWith("go.mod")) return [...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\/[\w/.-]+)\s+v\S+/gm)].map((m) => m[1]);
  const requirements = [...(data.project?.dependencies || []), ...Object.values(data.project?.["optional-dependencies"] || {}).flat(), ...Object.values(data["dependency-groups"] || {}).flat()];
  if (/requirements[^/]*\.txt$/.test(file)) requirements.push(...text.split("\n"));
  return requirements.filter((s) => typeof s === "string").map((s) => /^([\w.-]+)/.exec(s)?.[1]).filter(Boolean);
}

export function searchContext(root, touch) {
  const touches = touch.map((t) => t.replace(/^\.\//, "").replace(/\/$/, ""));
  const content = new Map();
  const units = [];
  for (const file of filesIn(root)) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (text.includes("\0")) continue;
    // Descriptors supply identity and path ownership only. All catalog data,
    // including observations, journeys and relation declarations, is excluded.
    if (/apiVersion:\s*agentdoc\.dev\//.test(text)) {
      if (/\.ya?ml$/.test(file)) {
        for (const { doc: d } of parseYamlDocuments(text, file)) {
          if (d.kind !== "Component") continue;
          units.push({
            ref: "component:" + (d.metadata.namespace || "default") + "/" + d.metadata.name,
            name: d.metadata.name,
            dir: path.posix.dirname(file),
            docs: Object.values(d.spec?.context || {}).filter(Array.isArray).flat().filter((p) => typeof p === "string"),
          });
        }
      }
      continue;
    }
    if (/(?:^|\/)agentdoc\//.test(file)) continue;
    content.set(file, text);
  }
  units.sort((a, b) => b.dir.length - a.dir.length || a.ref.localeCompare(b.ref, "en"));
  const owner = (file) => units.find((u) => u.docs.includes(file)) || units.find((u) => under(file, u.dir));
  const entries = new Map(units.map((u) => [u, [...content].filter(([f]) => owner(f) === u)]));
  for (const u of units) u.names = unitNames(u, entries.get(u));
  const links = new Map(units.map((u) => [u, new Set()]));
  const link = (a, b) => {
    if (!a || !b || a === b) return;
    links.get(a).add(b);
    links.get(b).add(a);
  };
  for (const [file, text] of content) {
    const from = owner(file);
    if (!from || (!SOURCE.test(file) && !MANIFEST.test(file))) continue;
    const names = imports(file, text);
    for (const to of units) {
      if (from === to) continue;
      const found = to.names.some((n) => {
        if (MANIFEST.test(file) && mentions(text, n)) return true;
        return names.some((i) => {
          if (file.endsWith(".py") && [...entries.get(from)].some(([p]) => p.endsWith("/" + i.split(".")[0] + ".py"))) return false;
          return i === n || i.startsWith(n + "/") || i.startsWith(n + ".");
        });
      });
      if (found) link(from, to);
    }
    for (const name of names.filter((n) => n.startsWith("."))) link(from, owner(path.posix.normalize(path.posix.join(path.posix.dirname(file), name))));
    // Local path dependencies are visible even when their import name differs.
    if (MANIFEST.test(file)) {
      for (const m of text.matchAll(/(?:path\s*=|file:|link:)\s*["']?([^"'\s,}]+)/g)) link(from, owner(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]))));
    }
  }

  const contracts = [];
  for (const [file, text] of content) {
    if (/\.proto$/.test(file)) {
      for (const m of text.matchAll(/\bservice\s+(\w+)\s*\{/g)) contracts.push({ file, ref: "api:default/" + slug(m[1]), paths: [], service: m[1] });
    } else if (/^openapi:\s/m.test(text)) {
      let doc;
      try { [{ doc }] = parseYamlDocuments(text, file); } catch { continue; }
      if (doc?.info?.title) contracts.push({ file, ref: "api:default/" + slug(doc.info.title).replace(/-api$/, "") + "-api", paths: Object.keys(doc.paths || {}) });
    }
  }
  for (const c of contracts) {
    c.providers = new Set();
    c.readers = new Set();
    for (const u of units) {
      for (const [file, text] of entries.get(u)) {
        if (text.includes(c.file)) c.readers.add(u);
        if (!SOURCE.test(file)) continue;
        if ((c.service && text.includes("Register" + c.service + "Server")) || c.paths.some((p) => quoted(text).includes(p) || file.endsWith("/app" + p + "/route.ts"))) c.providers.add(u);
      }
    }
    const related = [...new Set([...c.readers, ...c.providers])];
    for (const a of related) for (const b of related) link(a, b);
  }
  // Exact endpoint literals (including URL pathnames) connect clients and route
  // owners. No hostname-to-component or dynamic-string resolution is assumed.
  const routes = new Map();
  for (const [file, text] of content) {
    const u = owner(file);
    if (!u || (!SOURCE.test(file) && !file.endsWith(".toml"))) continue;
    const paths = quoted(text).flatMap((s) => {
      if (/^https?:\/\//.test(s)) { try { return [new URL(s).pathname]; } catch { return []; } }
      return s.startsWith("/") ? [s] : [];
    });
    const route = /\/app(\/api\/.*)\/route\.[jt]s$/.exec(file)?.[1];
    if (route) paths.push(route);
    for (const p of paths.filter((p) => p !== "/")) {
      if (!routes.has(p)) routes.set(p, new Set());
      for (const other of routes.get(p)) link(u, other);
      routes.get(p).add(u);
    }
  }

  const reached = new Set();
  for (const file of touches) {
    const u = units.find((u) => u.ref === file) || owner(file);
    if (u) reached.add(u);
    for (const c of contracts.filter((c) => c.file === file)) for (const related of [...c.readers, ...c.providers]) reached.add(related);
  }
  for (const u of reached) for (const other of links.get(u)) reached.add(other);

  const facts = new Set();
  const checks = [];
  const addCheck = (u, command) => {
    if (!command) return;
    const componentRef = u?.ref || null;
    if (!checks.some((c) => c.componentRef === componentRef && c.command === command)) checks.push({ componentRef, command });
    facts.add(fact("verify", command));
  };
  for (const u of reached) {
    facts.add(fact("ref", u.ref));
    const own = entries.get(u);
    const text = own.map(([, t]) => t).join("\n");
    for (const [file, body] of own) {
      if (/\.(md|rst|txt)$/.test(file)) {
        const type = /constraint/i.test(path.posix.basename(file)) ? "constraint" : /runbook/i.test(file) ? "runbook" : "doc";
        facts.add(fact(type, file));
      }
      if (SOURCE.test(file)) {
        for (const line of body.split("\n").filter((l) => /subject|event|topic|publish|subscribe/i.test(l))) {
          for (const s of quoted(line)) if (/^[a-z][\w-]*(?:\.[\w-]+){2,}$/.test(s)) facts.add(fact("event", s));
        }
      }
      if (MANIFEST.test(file)) for (const name of externalNames(file, body)) {
        if (!units.some((other) => other.names.includes(name))) facts.add(fact("external", name));
      }
      if (path.posix.basename(file) === "package.json") {
        const pkg = readData(body, file);
        for (const [name, command] of Object.entries(pkg.scripts || {})) if (CHECK.test(name)) addCheck(u, command);
        const turbo = readData(content.get("turbo.json") || "{}", "turbo.json");
        for (const name of Object.keys(turbo.tasks || turbo.pipeline || {})) if (CHECK.test(name) && pkg.name) addCheck(u, "turbo run " + name + " --filter=" + pkg.name);
      }
      if (path.posix.basename(file) === "go.mod") { addCheck(u, "go test ./..."); addCheck(u, "go vet ./..."); }
      if (path.posix.basename(file) === "Cargo.toml") {
        const name = readData(body, file).package?.name;
        if (name) { addCheck(u, "cargo test -p " + name); addCheck(u, "cargo clippy -p " + name); }
      }
    }
    const python = own.some(([f]) => f.endsWith(".py"));
    if (python) {
      const ancestors = [...content.keys()].filter((f) => /(?:uv|poetry)\.lock$/.test(f) && under(u.dir, path.posix.dirname(f))).sort((a, b) => b.length - a.length);
      const prefix = ancestors[0]?.endsWith("uv.lock") ? "uv run " : ancestors[0] ? "poetry run " : "";
      for (const tool of ["pytest", "ruff", "mypy"]) if (new RegExp("\\b" + tool + "\\b").test(text)) addCheck(u, prefix + (tool === "ruff" ? "ruff check" : tool));
      if (/\bunittest\b/.test(text) && !/\bpytest\b/.test(text)) addCheck(u, "python -m unittest discover");
    }
    // Resource identities are naming conventions, not catalog lookups.
    if (/postgres(?:ql)?(?:\+[\w]+)?:\/\/|sql\.Open\("postgres"|\b(?:pg|psycopg|asyncpg|sqlx|diesel)\b/.test(text) || own.some(([f]) => /\/migrations\/.*\.sql$/.test(f))) {
      addRelationFacts(facts, "usesResource", "resource:default/" + u.name + "-postgres");
    }
    if (/\bredis\b/i.test(text)) addRelationFacts(facts, "usesResource", "resource:default/" + u.name + "-redis");
    for (const m of text.matchAll(/(?:bucket|queue_name)\s*=\s*["']([^"']+)["']/g)) addRelationFacts(facts, "usesResource", "resource:default/" + slug(m[1]));
  }
  for (const c of contracts) {
    const touched = touches.includes(c.file);
    if (!touched && ![...c.readers, ...c.providers].some((u) => reached.has(u))) continue;
    facts.add(fact("ref", c.ref));
    if (touched || [...c.providers].some((u) => reached.has(u))) facts.add(fact("provides", c.ref));
    if ([...c.readers].some((u) => reached.has(u) && !c.providers.has(u))) facts.add(fact("consumes", c.ref));
    for (const u of c.providers) facts.add(fact("provider", u.ref));
    for (const u of c.readers) if (!c.providers.has(u)) facts.add(fact("consumer", u.ref));
  }
  for (const [file, text] of content) {
    if (!/^\.github\/workflows\/.*\.ya?ml$/.test(file)) continue;
    let workflow;
    try { [{ doc: workflow }] = parseYamlDocuments(text, file); } catch { continue; }
    for (const job of Object.values(workflow?.jobs || {})) {
      for (const step of job.steps || []) {
        if (typeof step.run !== "string") continue;
        const cwd = step["working-directory"] || job.defaults?.run?.["working-directory"];
        for (const command of step.run.split("\n").map((s) => s.trim()).filter(Boolean)) {
          if (!CHECK.test(command)) continue;
          if (cwd) { const u = owner(cwd); if (reached.has(u)) addCheck(u, command); }
          else {
            const scoped = units.filter((u) => u.names.some((n) => mentions(command, n)));
            if (scoped.length) { for (const u of scoped) if (reached.has(u)) addCheck(u, command); }
            else if (!/--filter|\bcd\b|\$\{\{/.test(command)) addCheck(null, command);
          }
        }
      }
    }
  }
  return { facts, checks, reached: [...reached].map((u) => u.ref).sort() };
}
