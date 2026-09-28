// Wrangler adapter (Cloudflare Workers / Pages).
//
// This adapter is where the most expensive lesson of the reference project
// lives. A committed deployment manifest is a *declared* schedule and a
// *declared* binding set. It is DERIVED evidence about what the repository
// intends, and nothing more. If a live scheduler disagrees — an hourly trigger
// with hour-3 gating where the manifest says "daily" — the disagreement has to
// reach the graph as a conflict, which only happens if the manifest claim is
// emitted as a fact on the same key the observation uses. So: no manifest value
// is ever reported as deployed truth.
import { Adapter } from "./registry.mjs";
import { parse as parseToml } from "../core/toml.mjs";
import { sourceFiles } from "../core/sourcescan.mjs";

const MANIFESTS = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];

export class WranglerAdapter extends Adapter {
  static adapterName = "wrangler";
  constructor() {
    super({ name: "wrangler", version: "1.0.0", kind: "unit-marker" });
  }
  detect(ctx, root) {
    for (const n of MANIFESTS) {
      if (ctx.repo.exists(root + "/" + n)) return { path: root + "/" + n, shape: "deployable" };
    }
    return null;
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const file = MANIFESTS.map((n) => unit.root + "/" + n).find((p) => repo.exists(p));
    if (!file) return {};
    let toml;
    try {
      toml = file.endsWith(".toml") ? parseToml(repo.readText(file), file) : stripJsonc(repo.readText(file));
    } catch {
      return {};
    }
    const derived = { runtimes: new Set(["cloudflare-workers"]) };
    if (toml.name) unit.platformName = String(toml.name);
    const pr = prov.add("observed", file, "platform-manifest-extractor", ["der:" + compRef + ":/runtimes", "der:" + compRef + ":/bindings"]);

    const bindings = [];
    // The manifest makes ONE claim about the binding set, so the graph records
    // one fact. Emitting a fact per binding would make a manifest that declares
    // two bindings look like a contradiction against a runtime that reports one.
    const bindingKinds = new Set();
    const bindingNames = new Set();
    const pushBinding = (kind, locator) => {
      bindingKinds.add(kind);
      if (locator && locator.binding) bindingNames.add(locator.binding);
      bindings.push({ kind, locator, resolution: "resolved", provenanceIds: null, _provs: new Set([pr]) });
    };
    for (const kv of toml.kv_namespaces || []) pushBinding("kv", { binding: String(kv.binding || "") });
    for (const d1 of toml.d1_databases || []) pushBinding("d1", { binding: String(d1.binding || "") });
    for (const r2 of toml.r2_buckets || []) pushBinding("r2", { binding: String(r2.binding || "") });
    for (const dofs of toml.durable_objects?.bindings || []) pushBinding("durable-object", { binding: String(dofs.name || "") });
    for (const em of toml.send_email || []) pushBinding("email-routing", { binding: String(em.name || em.binding || "") });
    for (const q of toml.queues?.producers || []) pushBinding("queue-producer", { binding: String(q.binding || "") });
    for (const q of toml.queues?.consumers || []) pushBinding("queue-consumer", { binding: String(q.queue || q.binding || "") });
    if (bindings.length) derived.bindings = bindings;

    // Service bindings: a platform-level runtime call. Resolved in a second
    // pass once every unit's platform name is known.
    const pending = [];
    for (const svc of toml.services || []) {
      pushBinding("service-binding", { binding: String(svc.binding || ""), service: String(svc.service || "") });
      pending.push({ binding: String(svc.binding || ""), service: String(svc.service || "") });
    }
    if (pending.length) {
      derived.serviceBindings = pending;
      ctx.deferSecondPass((pass) => {
        for (const sb of pending) {
          const target = pass.byPlatformName.get(sb.service);
          if (target && target.component) {
            const epr = prov.add("observed", file, "service-binding-extractor", ["rel:pending"]);
            ctx.addEdge("runtimeCalls", compRef, target.component.ref,
              { transport: "service-binding", contractRef: file }, [epr], "DERIVED");
          } else {
            ctx.diagnostics.push({
              severity: "warning",
              code: "AGENTDOC_SERVICE_BINDING_UNRESOLVED",
              subject: compRef,
              refs: [compRef],
              message: "service binding '" + sb.service + "' declared in " + file + " does not match any discovered component",
              paths: [file],
            });
          }
        }
      });
    }

    if (bindingNames.size) {
      ctx.addFact(compRef, "binding.declared", [...bindingNames].sort(), {
        evidenceClass: "DERIVED", confidence: "deterministic", provRecs: [pr],
        semantics: "the binding names the committed manifest declares for this component",
      });
    }
    if (bindingKinds.size) {
      ctx.addFact(compRef, "binding.kind", [...bindingKinds].sort(), {
        evidenceClass: "DERIVED", confidence: "deterministic", provRecs: [pr],
        semantics: "the kinds of platform binding the committed manifest declares for this component",
      });
    }

    // Scheduled triggers. Emitted as a DERIVED fact on schedule.cron, which is
    // the same key a scheduler observation uses, so the two can be compared.
    const crons = ((toml.triggers && toml.triggers.crons) || []).map(String).sort();
    if (crons.length) {
      derived.schedules = crons;
      ctx.addFact(compRef, "schedule.cron", crons.join(","), {
        evidenceClass: "DERIVED", confidence: "deterministic", provRecs: [pr],
        semantics: "cron expressions the committed deployment manifest declares for this component",
      });
      ctx.addFact(compRef, "schedule.enabled", true, {
        evidenceClass: "DERIVED", confidence: "deterministic", provRecs: [pr],
        semantics: "the manifest declares a trigger, i.e. the job is intended to be enabled",
      });
    }

    // Job handlers: a cron URL variable names the endpoint a trigger calls.
    // Again one claim, not one per variable.
    const vars = toml.vars || {};
    const declaredTargets = [];
    for (const [varName, url] of Object.entries(vars)) {
      if (typeof url !== "string") continue;
      const m = /^https?:\/\/[^/]+(\/[^\s]*)$/.exec(url);
      if (!m) continue;
      declaredTargets.push({ var: varName, route: m[1] });
    }
    if (declaredTargets.length) {
      derived.scheduleTargets = declaredTargets.slice().sort((a, b) => (a.route < b.route ? -1 : 1));
      ctx.addFact(compRef, "schedule.target", [...new Set(declaredTargets.map((t) => t.route))].sort(), {
        evidenceClass: "DERIVED", confidence: "deterministic", provRecs: [pr],
        semantics: "endpoints the committed manifest points scheduled triggers at",
      });
      // A schedule that points at a route this repository implements is a
      // `schedules` relation. Without it, "who does this trigger call?" has no
      // answer and an agent debugging a missed job has nothing to follow.
      for (const t of declaredTargets) {
        ctx.deferSecondPass(() => {
          const owner = findRouteOwner(ctx, t.route, compRef);
          if (owner) {
            const rpr = prov.add("observed", file, "schedule-extractor", ["rel:pending"]);
            const tpr = prov.add("observed", owner.file, "schedule-extractor", ["rel:pending"]);
            ctx.addEdge("schedules", compRef, owner.ref, { via: "declared-trigger-target", route: t.route }, [rpr, tpr], "DERIVED");
          } else {
            ctx.diagnostics.push({
              severity: "warning",
              code: "AGENTDOC_SCHEDULE_UNRESOLVED",
              subject: compRef,
              refs: [compRef],
              message: "scheduled trigger target '" + t.route + "' declared in " + file + " does not resolve to a route in any discovered component",
              paths: [file],
            });
          }
        });
      }
    }
    return derived;
  }
}

// Resolve an absolute route path to the component that *serves* it.
//
// A route literal appears in more places than the component that owns it: every
// generated OpenAPI client embeds the path it calls. So candidates are ranked
// rather than counted, and only an unambiguous winner is used:
//
//   2  a file-based route whose path is this route
//   1  a route literal in hand-written source
//   0  a route literal in generated client code
//
// A tie at the top score is a genuine ambiguity and yields no relation.
function findRouteOwner(ctx, route, selfRef) {
  const generated = (ctx.cfg.discovery.generatedClientPatterns || ["/gen/", ".gen.", "/generated/", "/generated/"]).map(
    (p) => new RegExp(escapeRe(p))
  );
  const isGenerated = (f) => generated.some((re) => re.test(f));
  const candidates = [];
  for (const unit of ctx.discovery.eligible) {
    if (!unit.component || unit.component.ref === selfRef) continue;
    const viaPath = (unit.routes || []).find((r) => r.route === route);
    if (viaPath) { candidates.push({ ref: unit.component.ref, file: viaPath.path, score: 2 }); continue; }
    for (const f of sourceFiles(ctx.repo, unit.root, { test: false })) {
      const text = ctx.repo.readText(f);
      if (!text.includes(route)) continue;
      if (!new RegExp("[\"'\`]" + escapeRe(route) + "[\"'\`]").test(text)) continue;
      candidates.push({ ref: unit.component.ref, file: f, score: isGenerated(f) ? 0 : 1 });
      break;
    }
  }
  if (!candidates.length) return null;
  const best = Math.max(...candidates.map((c) => c.score));
  const winners = candidates.filter((c) => c.score === best);
  const distinct = new Set(winners.map((c) => c.ref));
  if (distinct.size !== 1) return null;
  return winners[0];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1").replace(/,(\s*[}\]])/g, "$1"));
}
