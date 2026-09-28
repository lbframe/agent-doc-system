// Protobuf adapter: .proto files as canonical contracts, with the service and
// method inventory an agent needs and deterministic consumer resolution.
import { Adapter } from "./registry.mjs";
import { resolveContractConsumers, isBuildConfig } from "./contract-consumers.mjs";

export class ProtobufAdapter extends Adapter {
  static adapterName = "protobuf";
  constructor() {
    super({ name: "protobuf", version: "1.0.0", kind: "contract" });
  }
  contracts(ctx) {
    const out = [];
    for (const api of ctx.sources.entities.filter((e) => e.kind === "API" && e.doc.spec.type === "protobuf")) {
      const ref = api.doc.spec.contract.ref;
      const text = ctx.repo.readText(ref);
      const methods = [];
      const packages = [];
      for (const m of text.matchAll(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/gm)) packages.push(m[1]);
      for (const m of text.matchAll(/service\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\n\}/g)) {
        for (const r of m[2].matchAll(/rpc\s+([A-Za-z0-9_]+)\s*\(\s*(stream\s+)?([A-Za-z0-9_.]+)/g)) {
          methods.push({ service: m[1], method: r[1], request: r[3], streaming: Boolean(r[2]) });
        }
      }
      methods.sort((a, b) => ((a.service + a.method) < (b.service + b.method) ? -1 : 1));
      ctx.addContract({ apiRef: api.ref, ref, services: [...new Set(text.match(/service\s+([A-Za-z0-9_]+)/g) || [])].length, methods, packages: [...new Set(packages)].sort() });

      const consumers = resolveContractConsumers(ctx, ref, api.doc.spec.provider);
      for (const [consumerRef, files] of consumers) {
        const provs = files.map((f) => ctx.prov.add(isBuildConfig(f) ? "validated" : "observed", f, "api-contract-extractor", ["rel:pending"]));
        ctx.addEdge("consumesApi", consumerRef, api.ref, { via: files.some(isBuildConfig) ? "codegen" : "source-reference" }, provs, "DERIVED");
      }
    }
    return out;
  }
}
