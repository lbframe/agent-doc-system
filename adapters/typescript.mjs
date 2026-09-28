// TypeScript adapter.
//
// Owns tsconfig.json as an importability marker, project references as a build
// relation source, and the framework route conventions that are genuinely
// TypeScript-ecosystem facts rather than project conventions.
import path from "node:path";
import { Adapter } from "./registry.mjs";
import { parseYamlDocuments } from "../core/yaml.mjs";

export class TypeScriptAdapter extends Adapter {
  static adapterName = "typescript";
  constructor() {
    super({ name: "typescript", version: "1.0.0", kind: "unit-marker" });
  }
  detect(ctx, root) {
    const p = root + "/tsconfig.json";
    if (!ctx.repo.exists(p)) return null;
    return { path: p, shape: "importable" };
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const p = unit.root + "/tsconfig.json";
    if (!repo.exists(p)) return {};
    const derived = { languages: new Set(["typescript"]), runtimes: new Set(["node"]) };
    let ts;
    try {
      ts = parseTsconfig(repo, p);
    } catch {
      ts = {};
    }
    const pr = prov.add("observed", p, "tsconfig-extractor", ["der:" + compRef + ":/languages", "rel:pending"]);

    // Project references: an explicit build-time dependency between units.
    for (const refPath of (ts.references || [])) {
      const targetDir = path.posix.normalize(path.posix.join(unit.root, refPath));
      const target = ctx.unitForRoot(targetDir);
      if (!target || !target.component) continue;
      ctx.addEdge("buildDependsOn", compRef, target.component.ref, { via: "tsconfig-references" }, [pr], "DERIVED");
    }
    derived.tsconfig = { composite: Boolean(ts.compilerOptions?.composite), references: (ts.references || []).length };

    // Route conventions of the file-based router ecosystem: a route file is a
    // real HTTP surface and must be visible to the query surface.
    const routes = [];
    for (const base of ["src/app", "app", "src/pages", "pages"]) {
      if (!repo.isDir(unit.root + "/" + base)) continue;
      for (const f of repo.walk(unit.root + "/" + base)) {
        const routePath = routeFor(unit.root, base, f);
        if (!routePath) continue;
        const rpr = prov.add("observed", f, "route-extractor", ["der:" + compRef + ":/routes"]);
        routes.push({ path: f, route: routePath, provenanceIds: null, _provs: new Set([rpr]) });
      }
    }
    if (routes.length) {
      routes.sort((a, b) => (a.route < b.route ? -1 : 1));
      derived.routes = routes;
      // Published on the unit so other adapters can resolve a scheduled
      // trigger to the component that actually serves the route.
      unit.routes = routes;
    }
    return derived;
  }
}

function routeFor(root, base, file) {
  const rel = file.slice((root + "/" + base).length + 1);
  if (base.endsWith("app")) {
    if (!rel.endsWith("/route.ts") && !rel.endsWith("/route.tsx") && !rel.endsWith("/route.js")) return null;
    const segs = rel.split("/").slice(0, -1);
    if (!segs.length) return "/";
    return "/" + segs.map((s) => (s.startsWith("(") && s.endsWith(")") ? "" : s.replace(/^\[\.\.\.(.+)\]$/, ":$1*").replace(/^\[(.+)\]$/, ":$1"))).join("/");
  }
  if (!rel.startsWith("api/") || !rel.endsWith(".ts")) return null;
  return "/" + rel.slice(4).replace(/\.ts$/, "");
}

// tsconfig allows comments and trailing commas; strip them before JSON.parse.
function parseTsconfig(repo, p) {
  let text = repo.readText(p);
  text = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
  text = text.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

export { parseYamlDocuments };
