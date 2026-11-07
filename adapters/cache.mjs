// Cache adapter: Redis / in-memory cache client evidence as a derived binding.
import { Adapter } from "./registry.mjs";
import { joinPath } from "../core/paths.mjs";

const CACHE_HINT = /(@upstash\/redis|ioredis|redis\.Redis|redis|go-redis|redis\.go|valkey|memcache|@memcached)/i;

export class CacheAdapter extends Adapter {
  static adapterName = "cache";
  constructor() {
    super({ name: "cache", version: "1.0.0", kind: "source" });
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const evFile = unit.goModule
      ? joinPath(unit.root, "go.mod")
      : unit.pythonManifest
        ? unit.pythonManifest
        : repo.exists(joinPath(unit.root, "package.json"))
          ? joinPath(unit.root, "package.json")
          : joinPath(unit.root, "Cargo.toml");
    if (!repo.exists(evFile)) return {};
    const text = repo.readText(evFile);
    if (!CACHE_HINT.test(text)) return {};
    const pr = prov.add("observed", evFile, "binding-extractor", ["der:" + compRef + ":/bindings"]);
    const resources = ctx.sources.entities.filter((e) => e.kind === "Resource" && e.doc.spec.type === "cache");
    if (resources.length === 1) {
      const client = ctx.clientKeyForResourceType("cache");
      const attrs = client ? { via: "cache-client", client } : { via: "cache-client" };
      ctx.addEdge("usesResource", compRef, resources[0].ref, attrs, [pr], "DERIVED");
      return { bindings: [{ kind: "cache", logicalResourceRef: resources[0].ref, resolution: "resolved", provenanceIds: null, _provs: new Set([pr]) }] };
    }
    return { bindings: [{ kind: "cache", resolution: "resolved", provenanceIds: null, _provs: new Set([pr]) }] };
  }
}
