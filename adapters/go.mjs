// Go adapter: go.mod / go.work as unit markers, module graph as build
// relations, and the go toolchain's own verification commands.
import { Adapter } from "./registry.mjs";

export class GoAdapter extends Adapter {
  static adapterName = "go";
  constructor() {
    super({ name: "go", version: "1.0.0", kind: "unit-marker" });
  }
  roots(ctx) {
    const out = [];
    const ws = "go.work";
    if (!ctx.repo.exists(ws)) return out;
    const text = ctx.repo.readText(ws);
    const block = /use\s*\(([^)]*)\)/s.exec(text);
    const candidates = block
      ? block[1].split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean)
      : [...text.matchAll(/^\s*use\s+(\S+)/gm)].map((m) => m[1]);
    for (const raw of candidates) {
      const d = raw.replace(/^\.\//, "").replace(/\/$/, "");
      if (!d || d.startsWith("//") || d.includes("..")) continue;
      if (!ctx.repo.isDir(d)) continue;
      if (!ctx.repo.exists(d + "/go.mod")) continue;
      out.push({ root: d, deployable: ctx.repo.isDir(d + "/cmd"), importable: !ctx.repo.isDir(d + "/cmd") });
    }
    return out;
  }
  detect(ctx, root) {
    const p = root + "/go.mod";
    if (!ctx.repo.exists(p)) return null;
    return { path: p, shape: ctx.repo.isDir(root + "/cmd") ? "deployable" : "importable" };
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const p = unit.root + "/go.mod";
    if (!repo.exists(p)) return {};
    const derived = { languages: new Set(["go"]), runtimes: new Set(["go"]) };
    const text = repo.readText(p);
    const pr = prov.add("observed", p, "gomod-extractor", ["der:" + compRef + ":/runtimes", "der:" + compRef + ":/languages"]);

    for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.]+\.[a-z0-9./-]+)\s+v[0-9]/gm)) {
      const mod = m[1];
      const target = ctx.unitByGoModule.get(mod);
      if (target && target.component && target.component.ref !== compRef) {
        ctx.addEdge("buildDependsOn", compRef, target.component.ref, { via: "go-module" }, [pr], "DERIVED");
      } else {
        for (const x of ctx.externalMatchers()) {
          if (!x.re.test(mod)) continue;
          ctx.addExternal(compRef, x.name, x.mechanism, x.role, pr, "DERIVED");
        }
      }
    }
    // Workspace members depended on by import alone. A Go workspace member can
    // have no require line at all, so the import graph is the only evidence.
    for (const importPath of ctx.importIndex.goPathsByUnit.get(unit) || []) {
      for (const [mod, target] of ctx.unitByGoModule) {
        if (target === unit || !target.component) continue;
        if (importPath !== mod && importPath.startsWith(mod + "/")) {
          ctx.addEdge("buildDependsOn", compRef, target.component.ref, { via: "go-import" }, [pr], "DERIVED");
        }
      }
    }

    const hasTests = repo.walk(unit.root).some((f) => /_test\.go$/.test(f));
    ctx.addVerification({
      id: compRef + ":go-test",
      componentRefs: [compRef],
      tier: "unit",
      command: "go test ./...",
      configPaths: [p],
      provRecs: [pr],
    });
    ctx.addVerification({
      id: compRef + ":go-vet",
      componentRefs: [compRef],
      tier: "static",
      command: "go vet ./...",
      configPaths: [p],
      provRecs: [pr],
    });
    if (hasTests) derived.hasTests = true;
    derived.goModule = unit.goModule;
    return derived;
  }
}

export function goExternalName(mod) {
  const parts = mod.split("/");
  const tail = parts[parts.length - 1].replace(/\.v\d+$/, "");
  return (tail || parts[0]).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "go-module";
}
