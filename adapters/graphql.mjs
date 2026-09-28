// GraphQL adapter: SDL as the canonical contract plus deterministic consumer
// resolution.
import { Adapter } from "./registry.mjs";
import { resolveContractConsumers, isBuildConfig } from "./contract-consumers.mjs";

export class GraphQLAdapter extends Adapter {
  static adapterName = "graphql";
  constructor() {
    super({ name: "graphql", version: "1.0.0", kind: "contract" });
  }
  contracts(ctx) {
    const out = [];
    for (const api of ctx.sources.entities.filter((e) => e.kind === "API" && ["graphql", "graphql-sdl"].includes(e.doc.spec.type))) {
      const ref = api.doc.spec.contract.ref;
      const text = ctx.repo.readText(ref);
      const types = [...text.matchAll(/^\s*(?:type|interface|input|enum|scalar|union)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
      const queries = [...text.matchAll(/^\s*(?:extend\s+)?type\s+Query\s*\{([\s\S]*?)\n\}/gm)]
        .flatMap((m) => [...m[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/gm)].map((x) => x[1]));
      ctx.addContract({ apiRef: api.ref, ref, types: [...new Set(types)].sort(), queries: [...new Set(queries)].sort() });
      const consumers = resolveContractConsumers(ctx, ref, api.doc.spec.provider);
      for (const [consumerRef, files] of consumers) {
        const provs = files.map((f) => ctx.prov.add(isBuildConfig(f) ? "validated" : "observed", f, "api-contract-extractor", ["rel:pending"]));
        ctx.addEdge("consumesApi", consumerRef, api.ref, { via: files.some(isBuildConfig) ? "codegen" : "source-reference" }, provs, "DERIVED");
      }
    }
    return out;
  }
}
