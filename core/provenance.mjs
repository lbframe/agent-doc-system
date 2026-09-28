// Provenance registry.
//
// Every fact that reaches the compiled graph is backed by a record carrying the
// evidence path, extractor identity, content hash, and RFC 6901 subject
// pointers into the graph. Provenance classes:
//   declared   — the file states the fact outright (authored descriptor, config)
//   observed   — the file shows the fact (manifest, source file, config)
//   validated  — two independent files agree (a generated client + the contract)
//   runtime    — read from an external system via a recorded collector
//   standard   — the canonical authority is a published standard
import { sha256Hex } from "./fsx.mjs";

// Extractor identities appear in the graph and are matched by tooling, so they
// are normalised to a slug. "discovery:pnpm" and "pnpm" must not be two
// different extractors.
export function slugExtractor(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "unknown";
}

// `reviewed` is the provenance class for a human interpretation recorded in
// configuration. It was previously filed as `declared`, which mapped to
// AUTHORED — the strongest class in the model — so a reviewed override merged
// with a derived edge and was relabelled AUTHORED, silently promoting a human
// judgement to the top of the hierarchy. The authority model elects classes per
// fact; a provenance class must not decide that on its own.
export const CLASSES = Object.freeze(["declared", "observed", "validated", "runtime", "standard", "reviewed"]);

export class ProvRegistry {
  constructor(repo) {
    this.repo = repo;
    this.records = [];
  }
  // subjects are symbolic keys ("rel:pending", "ent:<ref>", "evt:<pattern>")
  // resolved to graph pointers after assembly. Callers add "pending" first and
  // rebind later; see bindPending in graph.mjs.
  add(cls, path, extractorName, subjects, location, extractorVersion = "1.0.0") {
    if (!CLASSES.includes(cls)) throw new Error("unknown provenance class " + cls);
    const name = slugExtractor(extractorName);
    const buf = this.repo.readBytes(path);
    const rec = {
      cls,
      path,
      extractor: { name, version: extractorVersion },
      subjects: new Set(subjects.filter(Boolean)),
      hash: "sha256:" + sha256Hex(buf),
      location,
    };
    this.records.push(rec);
    return rec;
  }
  // Canonical order: path, extractor, first subject. IDs are positional, so the
  // numbering is a pure function of the input set.
  finalize(resolve) {
    const sorted = [...this.records].sort((a, b) => {
      const ka = a.path + "|" + a.extractor.name + "|" + [...a.subjects].sort()[0];
      const kb = b.path + "|" + b.extractor.name + "|" + [...b.subjects].sort()[0];
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const list = sorted.map((r, i) => {
      const subjects = [...r.subjects].map(resolve).sort();
      const out = {
        id: "p-" + String(i + 1).padStart(4, "0"),
        class: r.cls,
        path: r.path,
        extractor: { name: r.extractor.name, version: r.extractor.version },
        contentHash: r.hash,
        subjects,
      };
      if (r.location) out.location = r.location;
      return out;
    });
    const idOf = new Map(sorted.map((r, i) => [r, "p-" + String(i + 1).padStart(4, "0")]));
    return { list, idOf };
  }
}

// Collect the distinct extractor identities for the compiler stamp.
export function extractorSet(prov) {
  const m = new Map();
  for (const r of prov.records) m.set(r.extractor.name, r.extractor.version);
  return [...m.entries()].sort().map(([name, version]) => ({ name, version }));
}
