// pnpm workspace adapter: contributes workspace member roots so the descriptor
// globs do not have to know the layout, and records the workspace file as
// evidence for the repository as a whole.
import { Adapter } from "./registry.mjs";
import { parseYamlDocuments } from "../core/yaml.mjs";

export class PnpmAdapter extends Adapter {
  static adapterName = "pnpm";
  constructor() {
    super({ name: "pnpm", version: "1.0.0", kind: "workspace" });
  }
  roots(ctx) {
    const out = [];
    const ws = "pnpm-workspace.yaml";
    if (!ctx.repo.exists(ws)) return out;
    let docs;
    try {
      docs = parseYamlDocuments(ctx.repo.readText(ws), ws);
    } catch {
      return out;
    }
    const globs = (docs[0] && docs[0].doc && docs[0].doc.packages) || [];
    ctx.repo.readText(ws);
    for (const g of Array.isArray(globs) ? globs : []) {
      if (typeof g !== "string" || g.includes("..")) continue;
      const segs = g.split("/").filter((s) => s.length && s !== "**");
      const starAt = segs.findIndex((s) => s === "*");
      if (starAt < 0) continue;
      const base = segs.slice(0, starAt).join("/");
      if (!base || !ctx.repo.isDir(base)) continue;
      // One level of expansion is enough to enumerate members; deeper layouts
      // are picked up by the descriptor globs.
      for (const entry of ctx.repo.listDir(base)) {
        if (!entry.endsWith("/")) continue;
        const dir = base + "/" + entry.replace(/\/$/, "");
        if (!ctx.repo.isDir(dir)) continue;
        if (ctx.repo.exists(dir + "/package.json")) out.push({ root: dir, importable: true, deployable: true });
      }
    }
    return out;
  }
}
