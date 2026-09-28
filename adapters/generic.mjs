// Generic adapter: language- and toolchain-agnostic facts only.
//
// Nothing here knows a language, a package manager, a provider or a folder
// name. It contributes the two things any repository can be said to have:
// conventional documentation (handled in core/derive.mjs) and health contract
// route literals found in source.
import { Adapter } from "./registry.mjs";
import { resolveClientResources } from "./resource-client.mjs";
import { sourceFiles } from "../core/sourcescan.mjs";

// Conservative: a health route is an absolute string literal that looks like a
// liveness or readiness endpoint. Anything more specific belongs to a
// framework adapter.
const HEALTH_LITERAL = /["'`](\/(?:healthz|health|livez|readyz|ready|ping|status))["'`]/;

export class GenericAdapter extends Adapter {
  static adapterName = "generic";
  constructor() {
    super({ name: "generic", version: "1.0.0", kind: "source" });
  }

  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const derived = { healthContracts: [] };
    const seen = new Set();
    const ports = new Set();
    const portFiles = new Map();
    const allSrc = sourceFiles(repo, unit.root, { test: false });
    for (const f of allSrc) {
      const text = repo.readText(f);
      const pm = /ListenAndServe\(\s*":(\d{2,5})"|\bPORT\s*=\s*"?(\d{2,5})"?|\bport:\s*(\d{2,5})\b/.exec(text);
      if (pm) {
        const p = pm[1] || pm[2] || pm[3];
        ports.add(p);
        if (!portFiles.has(p)) portFiles.set(p, f);
      }
      const m = HEALTH_LITERAL.exec(text);
      if (!m) continue;
      const route = m[1];
      if (seen.has(route)) continue;
      seen.add(route);
      const pr = prov.add("observed", f, "health-extractor", ["der:" + compRef + ":/healthContracts"]);
      derived.healthContracts.push({ path: f, route, semantics: "liveness", provenanceIds: null, _provs: new Set([pr]) });
    }
    if (derived.healthContracts.length > 1) derived.healthContracts.sort((a, b) => (a.route < b.route ? -1 : 1));
    // A port is only a fact when the source states exactly one. Two literals
    // mean the component binds more than one, and a single number would be a
    // confident half-truth.
    // Declared external services front Resources; resolve those bindings.
    // Provenance must name a file that exists. The dependency evidence is the
    // manifest when there is one, and otherwise the unit's descriptor.
    const manifest = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "pom.xml"]
      .map((n) => unit.root + "/" + n)
      .find((p) => repo.exists(p)) || ctx.componentEntity().file;
    const clientProv = prov.add("observed", manifest, "client-resolver", ["rel:pending", "der:" + compRef + ":/bindings"]);
    resolveClientResources(ctx, unit, compRef, clientProv);

    // Capability detectors are declared, not hard-coded: a manifest cannot tell
    // you a component can use a browser API, but a source literal can.
    for (const cap of (ctx.cfg.discovery.capabilities || [])) {
      let re;
      try {
        re = new RegExp(cap.match);
      } catch {
        continue;
      }
      for (const f of allSrc) {
        if (!re.test(repo.readText(f))) continue;
        const cpr = prov.add("observed", f, "capability-extractor", ["cap:" + compRef + "|" + cap.name]);
        ctx.addCapability(compRef, cap.name, cpr, "DERIVED");
        break;
      }
    }

    if (ports.size === 1) {
      const p = [...ports][0];
      const pr = prov.add("observed", portFiles.get(p) || ctx.componentEntity().file, "port-extractor", ["der:" + compRef + ":/port"]);
      derived.port = Number(p);
      ctx.addFact(compRef, "component.port", Number(p), {
        evidenceClass: "DERIVED", confidence: "deterministic", provRecs: [pr],
        semantics: "the single TCP port the source binds a listener to",
      });
    }
    return derived;
  }
}
