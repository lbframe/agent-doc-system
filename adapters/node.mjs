// Node adapter: package.json as the unit marker and manifest authority.
import { Adapter } from "./registry.mjs";

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
    super({ name: "node", version: "1.0.0", kind: "unit-marker" });
  }
  detect(ctx, root) {
    const p = root + "/package.json";
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
    const manifestPath = root + "/package.json";
    if (!repo.exists(manifestPath)) return {};
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

// Normalise a package name into a graph-safe external dependency name.
export function externalName(d) {
  const n = d
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return /^[a-z0-9]/.test(n) ? n.slice(0, 60) : "pkg-" + n.replace(/[^a-z0-9]/g, "").slice(0, 50);
}
