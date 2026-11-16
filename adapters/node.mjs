// Node adapter: package.json as the unit marker and manifest authority.
import { Adapter } from "./registry.mjs";
import { joinPath, longestOwner, canonicalPath } from "../core/paths.mjs";
import { sourceFiles } from "../core/sourcescan.mjs";
import { JS_SOURCE, jsImports, resolveImport, owningUnit, packageOf } from "./js-imports.mjs";
import { resolveClientResources } from "./resource-client.mjs";

// A script name maps to a verification tier. Deliberately conservative and
// project-neutral: a script that does not look like a check is not a check.
const TIERS = [
  [/^(test|tests)$|^test:unit$|^test:unit:/, "unit"],
  [/^test:integration$|^test:integration:/, "integration"],
  [/^test:contract$|^test:contract:/, "contract"],
  [/^test:e2e$|^test:e2e:/, "e2e"],
  [/^test:browser$/, "unit"],
  [/^(lint|typecheck|check-types|type-check)$/, "static"],
  [/^(build|compile)$/, "build"],
];
const IGNORED_SCRIPT = /^(dev|start|serve|watch|preview|clean|postinstall|preinstall|prepare|format|format:fix)$/;

export class NodeAdapter extends Adapter {
  static adapterName = "node";
  constructor() {
    super({ name: "node", version: "1.1.0", kind: "unit-marker" });
  }
  detect(ctx, root) {
    const p = joinPath(root, "package.json");
    if (!ctx.repo.exists(p)) return null;
    let pkg;
    try {
      pkg = ctx.repo.readJson(p);
    } catch {
      return null; // malformed manifest is not authority
    }
    const importable = Boolean(pkg.exports || pkg.main || pkg.bin || pkg.types);
    return { path: p, shape: importable ? "both" : "deployable" };
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const root = unit.root;
    const manifestPath = joinPath(root, "package.json");
    // Imports between components of one package. They run before the manifest
    // check: a component inside a package usually has no manifest of its own.
    const imports = componentImports(ctx, unit);
    if (!repo.exists(manifestPath)) {
      inheritClients(ctx, unit, imports.packages);
      return {};
    }
    const derived = { languages: new Set(["javascript"]), runtimes: new Set(["node"]) };
    const pkg = unit.pkg || repo.readJson(manifestPath);

    const pr = prov.add("observed", manifestPath, "manifest-extractor", [
      "der:" + compRef + ":/runtimes", "der:" + compRef + ":/languages", "der:" + compRef + ":/artifact",
    ]);
    const prodDeps = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
    const devDeps = new Set(Object.keys(pkg.devDependencies || {}));

    // Only declared external services are classified. A package in a manifest
    // is a build fact, not an architectural dependency, and recording six
    // hundred of them would make the index useless.
    for (const d of [...prodDeps].sort()) {
      for (const x of ctx.externalMatchers()) {
        if (!x.re.test(d)) continue;
        ctx.addExternal(compRef, x.name, x.mechanism, x.role, pr, "DERIVED");
      }
    }

    // Workspace resolution: a dependency naming another discovered unit is a
    // build relation, not an external dependency.
    for (const d of [...prodDeps, ...devDeps].sort()) {
      const target = ctx.unitByPkgName.get(d);
      if (!target || !target.component) continue;
      const isProd = prodDeps.has(d);
      ctx.addEdge(isProd ? "buildDependsOn" : "testDependsOn", compRef, target.component.ref,
        { via: "npm-manifest", package: d }, [pr], "DERIVED");
    }

    // Source imports are stronger evidence than the manifest, and catch
    // subpath imports the manifest cannot express.
    const sibling = new Map();
    for (const spec of ctx.unitImports.keys()) {
      const parts = spec.split("/");
      const base = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      const target = ctx.unitByPkgName.get(base);
      if (!target || !target.component || target.component.ref === compRef) continue;
      if (prodDeps.has(base)) continue;
      if (!sibling.has(target)) sibling.set(target, new Set());
      for (const f of ctx.unitImports.get(spec)) sibling.get(target).add(f);
    }
    for (const [target, files] of [...sibling.entries()].sort((a, b) => (a[0].root < b[0].root ? -1 : 1))) {
      const provs = [...files].sort().map((f) => prov.add("observed", f, "import-extractor", ["rel:pending"]));
      // The import names the same package the manifest route names, so it
      // carries the same instance key. Without it, a dependency found by both
      // routes shipped as two edges — the manifest one saying `package`, the
      // import one not — which measures adapter overlap rather than architecture.
      const pkgName = target.pkgName;
      const attrs = pkgName ? { via: "source-import", package: pkgName } : { via: "source-import" };
      ctx.addEdge(devDeps.has(pkgName) ? "testDependsOn" : "buildDependsOn",
        compRef, target.component.ref, attrs, provs, "DERIVED");
    }

    for (const [name, cmd] of Object.entries(pkg.scripts || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (IGNORED_SCRIPT.test(name)) continue;
      const tier = TIERS.find(([re]) => re.test(name));
      if (!tier) continue;
      const vpr = prov.add("observed", manifestPath, "verification-extractor", ["ver:" + compRef + ":" + name]);
      ctx.addVerification({
        id: compRef + ":" + name,
        componentRefs: [compRef],
        tier: tier[1],
        command: String(cmd).trim(),
        configPaths: [manifestPath],
        provRecs: [vpr],
      });
    }
    return derived;
  }
}

// ── imports between components ──────────────────────────────────────────────
//
// A relative or aliased import that resolves to a file another component owns
// is a dependency on that component, with the importing files as evidence:
// `buildDependsOn` from a production source, `testDependsOn` when only test
// files import it. Bare package specifiers that resolve to no repository file
// are returned for client resolution, except type-only ones: a type opens no
// connection.
function componentImports(ctx, unit) {
  const { repo, prov, compRef } = ctx;
  const own = governingPackage(ctx, unit);
  const edges = new Map(); // kind|targetRoot|via -> { kind, target, via, files }
  const packages = new Map(); // package name -> Set(files)
  for (const kind of ["build", "test"]) {
    for (const f of sourceFiles(repo, unit.root, { test: kind === "test", extensions: JS_SOURCE })) {
      for (const [spec, typeOnly] of [...jsImports(repo.readText(f))].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const hits = resolveImport(ctx, f, spec);
        if (!hits.length) {
          const pkg = packageOf(spec);
          if (pkg && kind === "build" && !typeOnly) {
            if (!packages.has(pkg)) packages.set(pkg, new Set());
            packages.get(pkg).add(f);
          }
          continue;
        }
        for (const hit of hits) {
          const target = owningUnit(ctx, hit.file);
          if (!target || target === unit || !target.component || target.component.ref === compRef) continue;
          const key = kind + "|" + target.root + "|" + hit.via;
          if (!edges.has(key)) edges.set(key, { kind, target, via: hit.via, files: new Set() });
          edges.get(key).files.add(f);
        }
      }
    }
  }
  // A production import already selects every tier of the importer's checks,
  // so a test import of the same component adds nothing.
  const built = new Set([...edges.values()].filter((e) => e.kind === "build").map((e) => e.target));
  for (const key of [...edges.keys()].sort()) {
    const { kind, target, via, files } = edges.get(key);
    if (kind === "test" && built.has(target)) continue;
    const provs = [...files].sort().map((f) => prov.add("observed", f, "import-extractor", ["rel:pending"]));
    // Into another package, the edge names it, as the manifest and the bare
    // import routes do, so the routes merge into one relation. Inside its own
    // package there is no package to name.
    const attrs = target.pkgName && target.pkgName !== own?.pkgName ? { via, package: target.pkgName } : { via };
    ctx.addEdge(kind === "build" ? "buildDependsOn" : "testDependsOn", compRef, target.component.ref, attrs, provs, "DERIVED");
  }
  return { packages };
}

// The unit whose package.json governs this unit's sources: the unit itself
// when it has a manifest, otherwise the nearest enclosing unit that has one.
function governingPackage(ctx, unit) {
  if (unit.pkg) return unit;
  const withManifest = ctx.discovery.eligible.filter((u) => u.pkg && u !== unit);
  const root = longestOwner(withManifest.map((u) => u.root), canonicalPath(unit.root));
  return root === null ? null : withManifest.find((u) => u.root === root);
}

// A component without a manifest depends on the services its enclosing package
// declares, but only on those its own sources import. That is the evidence a
// manifest gives a package (a declared dependency), narrowed by the import that
// shows this component, not a sibling, is the one using it.
function inheritClients(ctx, unit, packages) {
  const { prov, compRef } = ctx;
  const owner = governingPackage(ctx, unit);
  if (!owner) return;
  const pkg = owner.pkg;
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
  const used = [...packages.keys()].filter((d) => declared.has(d)).sort();
  if (!used.length) return;
  const manifestPath = joinPath(owner.root, "package.json");
  const clientDeps = [];
  const clientProvs = [];
  for (const d of used) {
    const matchers = ctx.externalMatchers().filter((x) => x.re.test(d));
    if (!matchers.length) continue;
    const recs = [
      prov.add("observed", manifestPath, "manifest-extractor", ["rel:pending"]),
      ...[...packages.get(d)].sort().map((f) => prov.add("observed", f, "import-extractor", ["rel:pending"])),
    ];
    for (const x of matchers) for (const r of recs) ctx.addExternal(compRef, x.name, x.mechanism, x.role, r, "DERIVED");
    if (matchers.some((x) => x.resourceType)) {
      clientDeps.push(d);
      clientProvs.push(...recs);
    }
  }
  if (clientDeps.length) resolveClientResources(ctx, unit, compRef, clientProvs, clientDeps);
}

// Normalise a package name into a graph-safe external dependency name.
export function externalName(d) {
  const n = d
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return /^[a-z0-9]/.test(n) ? n.slice(0, 60) : "pkg-" + n.replace(/[^a-z0-9]/g, "").slice(0, 50);
}
