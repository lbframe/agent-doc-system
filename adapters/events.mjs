// Event subject adapter.
//
// Discovers event subjects and their producers and consumers from source,
// filtered by the project's declared event subject prefixes. Two things matter
// here:
//
//   1. No hard-coded project vocabulary. Koda's `koda.` prefix became a
//      configuration value; without prefixes the extractor falls back to a
//      conservative three-or-more-segment shape, which is what subject-based
//      brokers actually use.
//   2. Producer and consumer roles are evidence, not assumption. A file that
//      merely mentions a subject is neither.
import { Adapter } from "./registry.mjs";
import { sourceFiles as sourceFilesOf } from "../core/sourcescan.mjs";

const SRC_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|go|py|rb|java|kt|rs|ex|exs|cs|php)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//;
const TEST_FILE = /\.(test|spec)\./;

// A subject-shaped token: three or more dot-separated lowercase segments, with
// optional trailing wildcards. Two-segment values are usually scopes, not
// subjects, and are excluded for exactly that reason.
// A subject is three or more dot-separated segments: `orders.created.v1`. A
// declared family is two or more segments plus a wildcard: `orders.created.*`.
// Both are real and both are indexed. A bare `orders.*` is NOT accepted: a
// wildcard at the top level is a catch-all, not a subject, and letting it in
// would fold every subject in the system into one meaningless family.
const SUBJECT_TOKEN = /["'`]([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+(?:[.*>])?|[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+\.(?:\*|>))["'`]/g;
// A named subject constant: its name is what a producer file actually mentions,
// while the pattern lives in another unit. Resolving the name is what lets a
// component that publishes "LESSON_PUBLISHED" be credited with producing the
// subject the shared package defines.
const SUBJECT_CONST = /\b([A-Z][A-Z0-9_]*_SUBJECT)\b\s*[=:]\s*["'`]([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+){2,}(?:[.*>])?)["'`]/g;
// Any identifier bound to a subject literal, in any naming style. A producer
// file usually references the constant by name; the literal itself lives in the
// shared unit that defines the vocabulary.
const SUBJECT_DECL = /\b([A-Za-z_$][\w$]*)\b\s*(?::\s*string\s*)?=\s*["'`]([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+){2,}(?:[.*>])?)["'`]/g;
const CONST_REF = /\b([A-Za-z_$][\w$]*)\b/g;

const PUBLISH_HINT = /\b(publish|emit|enqueue|produce|outbox|Publish\(|Emit\()/;
const CONSUME_HINT = /\b(subscribe|consume|onMessage|handler|WithFilterSubject|FilterSubjects|busloop|subscriber|ProcessBatch|dlq|DLQ|ack|Nak\()/;

export class EventsAdapter extends Adapter {
  static adapterName = "events";
  constructor() {
    super({ name: "events", version: "1.0.0", kind: "source" });
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const prefixes = (ctx.cfg.discovery.eventPatternPrefixes || []).filter(Boolean);
    const contract = ctx.primaryEventContract();
    if (!contract) return {};
    // Constants declared anywhere in the repository, and which of those
    // declarations this unit can actually see (itself plus what it depends on).
    const consts = new Map();
    const collectDecls = (root) => {
      for (const f of sourceFilesOf(ctx.repo, root)) {
        const text = ctx.repo.readText(f);
        for (const m of text.matchAll(SUBJECT_DECL)) consts.set(m[1], m[2]);
        for (const m of text.matchAll(SUBJECT_CONST)) consts.set(m[1], m[2]);
      }
    };
    collectDecls(unit.root);
    // A unit can only be credited with a subject it can see: its own sources,
    // plus those of the units it declares a dependency on, transitively. The
    // dependency map is built from manifests before extraction, so this does
    // not depend on adapter execution order.
    const visible = ctx.transitiveDependencies(compRef);
    for (const other of ctx.discovery.eligible) {
      if (other.component && visible.has(other.component.ref) && other.component.ref !== compRef) collectDecls(other.root);
    }
    const families = new Set();
    for (const f of repo.walk(unit.root)) {
      if (!SRC_EXT.test(f)) continue;
      if (TEST_PATH.test(f) || TEST_FILE.test(f)) continue;
      const text = repo.readText(f);
      const publish = PUBLISH_HINT.test(text);
      const consume = CONSUME_HINT.test(text);
      if (!publish && !consume) continue;
      const found = new Set();
      for (const m of text.matchAll(SUBJECT_TOKEN)) {
        const s = m[1];
        if (prefixes.length && !prefixes.some((p) => s.startsWith(p))) continue;
        found.add(s);
      }
      for (const m of text.matchAll(CONST_REF)) {
        const pattern = consts.get(m[1]);
        if (pattern && pattern !== m[0] && (!prefixes.length || prefixes.some((p) => pattern.startsWith(p)))) found.add(pattern);
      }
      for (const s of found) {
        if (s.endsWith(".*") || s.endsWith(".>")) families.add(s);
      }
      for (const s of found) {
        const pr = prov.add("observed", f, "event-extractor", ["evt:" + s]);
        if (publish) ctx.addEvent(s, "producer", compRef, pr, contract);
        if (consume) ctx.addEvent(s, "consumer", compRef, pr, contract);
      }
    }
    // The family set is only needed to fold literals; the fold itself happens in
    // the index builder, where the contract and the resolution state are known.
    void families;
    return {};
  }
  // A declared event catalog is a strong, human-maintained statement of which
  // component subscribes to which subjects. The catalog file is the contract.
  contracts(ctx) {
    const out = [];
    for (const ec of ctx.cfg.discovery.eventContracts || []) {
      // A contract may be a file, a directory, or a module prefix.
      const files = ctx.repo.filesWithPrefix(ec.path);
      if (!files.length) {
        ctx.errors.push({
          code: "AGENTDOC_PATH_UNRESOLVED",
          message: "declared event contract path does not resolve: " + ec.path,
          path: ec.path,
        });
        continue;
      }
      const patterns = ec.format === "code" ? harvestFromCode(ctx, ec, files) : Object.keys(safeJson(ctx, ec));
      // Provenance must name a real file; the contract may be a directory or a
      // module prefix.
      const evidenceFile = files.find((f) => SRC_EXT.test(f) && !/\.(test|spec)\./.test(f)) || files[0];
      const pr = ctx.prov.add("declared", evidenceFile, "event-catalog-extractor", patterns.map((p) => "evt:" + p));
      for (const p of patterns.sort()) ctx.addEvent(p, "consumer", ec.consumer, pr, { format: ec.format === "code" ? "code" : "declared-catalog", ref: ec.path });
    }
    return out;
  }
}

function safeJson(ctx, ec) {
  try {
    return ctx.repo.readJson(ec.path);
  } catch {
    return {};
  }
}

function harvestFromCode(ctx, ec, files) {
  const out = new Set();
  for (const f of files) {
    if (!SRC_EXT.test(f)) continue;
    for (const m of ctx.repo.readText(f).matchAll(SUBJECT_TOKEN)) out.add(m[1]);
  }
  return [...out];
}
