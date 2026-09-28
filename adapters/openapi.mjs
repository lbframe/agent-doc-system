// OpenAPI adapter.
//
// The catalog points at the canonical contract; it never duplicates it. What
// the adapter adds is (a) the operation inventory an agent needs to find a
// handler without reading the whole spec, and (b) deterministic consumer
// resolution from the contract reference.
import { Adapter } from "./registry.mjs";
import { resolveContractConsumers, isBuildConfig } from "./contract-consumers.mjs";
import { parseYamlDocuments } from "../core/yaml.mjs";
import { parse as parseToml } from "../core/toml.mjs";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export class OpenApiAdapter extends Adapter {
  static adapterName = "openapi";
  constructor() {
    super({ name: "openapi", version: "1.0.0", kind: "contract" });
  }
  contracts(ctx) {
    const out = [];
    for (const api of ctx.sources.entities.filter((e) => e.kind === "API" && e.doc.spec.type === "openapi")) {
      const ref = api.doc.spec.contract.ref;
      let doc = null;
      try {
        doc = parseYamlDocuments(ctx.repo.readText(ref), ref)[0]?.doc || JSON.parse(ctx.repo.readText(ref, { track: false }));
      } catch {
        continue;
      }
      const operations = [];
      for (const [route, item] of Object.entries((doc && doc.paths) || {})) {
        for (const m of METHODS) {
          if (item && typeof item === "object" && item[m]) {
            operations.push({ method: m.toUpperCase(), route, operationId: item[m].operationId || null });
          }
        }
      }
      operations.sort((a, b) => (a.route + a.method < b.route + b.method ? -1 : 1));
      ctx.addContract({ apiRef: api.ref, ref, operations, title: doc?.info?.title || null });

      const consumers = resolveContractConsumers(ctx, ref, api.doc.spec.provider);
      for (const [ref2, files] of consumers) {
        const provs = files.map((f) => ctx.prov.add(isBuildConfig(f) ? "validated" : "observed", f, "api-contract-extractor", ["rel:pending"]));
        ctx.addEdge("consumesApi", ref2, api.ref, { via: files.some(isBuildConfig) ? "codegen" : "source-reference" }, provs, "DERIVED");
      }
    }
    return out;
  }
}

export { parseToml };
