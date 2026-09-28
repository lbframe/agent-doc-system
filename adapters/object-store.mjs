// Object-store adapter: bucket bindings and literal bucket names.
//
// A bucket literal in a component's source is deterministic evidence that the
// component touches that store. It is only turned into a resource relation when
// exactly one authored logical-dataset Resource matches — an ambiguous literal
// is left unresolved rather than guessed at.
import { Adapter } from "./registry.mjs";

const SRC_EXT = /\.(ts|tsx|js|jsx|mts|cts|go|py|rb|java|kt|rs)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//;
const TEST_FILE = /\.(test|spec)\./;
const BUCKET_LITERAL = /["'`]([a-z][a-z0-9-]{4,60})["'`]/g;
const STORE_HINT = /(@aws-sdk\/client-s3|minio|google\.cloud\.storage|\bS3\b|bucket|Bucket|BlobService|createBucket)/i;

export class ObjectStoreAdapter extends Adapter {
  static adapterName = "object-store";
  constructor() {
    super({ name: "object-store", version: "1.0.0", kind: "source" });
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const datasets = ctx.sources.entities.filter((e) => e.kind === "Resource" && e.doc.spec.type === "logical-dataset");
    if (!datasets.length) return {};
    const usesStore = ctx.unitImports && [...ctx.unitImports.keys()].some((k) => /s3|minio|storage|blob/i.test(k));
    const bindings = [];
    const claimed = new Set();
    for (const f of repo.walk(unit.root)) {
      if (!SRC_EXT.test(f)) continue;
      if (TEST_PATH.test(f) || TEST_FILE.test(f)) continue;
      const text = repo.readText(f);
      if (!STORE_HINT.test(text)) continue;
      for (const m of text.matchAll(BUCKET_LITERAL)) {
        const lit = m[1];
        const matches = datasets.filter((d) => lit.includes(token(d.name)) || d.name.includes(token(lit)));
        if (matches.length !== 1) {
          if (matches.length > 1) {
            ctx.diagnostics.push({
              severity: "warning",
              code: "AGENTDOC_BINDING_AMBIGUOUS",
              subject: compRef,
              refs: [compRef],
              message: "bucket literal '" + lit + "' in " + f + " matches " + matches.length + " authored logical-dataset Resources; left unresolved",
              paths: [f],
            });
          }
          continue;
        }
        if (claimed.has(matches[0].ref)) continue;
        claimed.add(matches[0].ref);
        const pr = prov.add("observed", f, "binding-extractor", ["der:" + compRef + ":/bindings", "rel:pending"]);
        bindings.push({ kind: "object-store", logicalResourceRef: matches[0].ref, locator: { bucket: lit }, resolution: "resolved", provenanceIds: null, _provs: new Set([pr]) });
        const client = ctx.clientKeyForResourceType("logical-dataset");
        const attrs = client ? { via: "bucket-literal", client } : { via: "bucket-literal" };
        ctx.addEdge("usesResource", compRef, matches[0].ref, attrs, [pr], "DERIVED");
      }
    }
    if (!usesStore && !bindings.length) return {};
    return bindings.length ? { bindings } : { objectStoreClientOnly: true };
  }
}

function token(name) {
  return name.split("-")[0];
}
