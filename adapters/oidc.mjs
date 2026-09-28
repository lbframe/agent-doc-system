// OIDC adapter.
//
// The canonical authority for an OIDC surface is the published standard plus
// the provider's discovery document, both of which live outside the repository
// (EXTERNAL_STANDARD). What the repository can establish is narrower and is
// recorded as such: which units implement a client against the declared
// discovery path, and the fact that the provider exposes that path.
//
// A discovery document fetched from a live deployment is an OBSERVED_RUNTIME
// fact and belongs in an ObservationSet, not here.
import { Adapter } from "./registry.mjs";
import { sourceFiles } from "../core/sourcescan.mjs";

// A component is an OIDC client when it both names the discovery surface and
// shows the shape of a token request. One of the two alone is not enough: a
// comment mentioning /oidc/token, or a bare import of an OAuth helper in a
// component that never calls the identity provider, would both produce a false
// edge, and a false edge is worse than a missing one.
const DISCOVERY_HINT = /(\.well-known\/openid-configuration|jwks_uri|token_endpoint|\/oidc\/token|oauth2?\/token)/i;
// Both naming conventions: the wire names (snake_case, as in JSON) and the
// field names a typed client uses (camelCase, as in Go and TypeScript).
const TOKEN_REQUEST_HINT = /(grant_?type|client_?id|client_?secret|jwks|authoriz|id_?token|access_?token|userinfo|refresh_?token)/i;

export class OidcAdapter extends Adapter {
  static adapterName = "oidc";
  constructor() {
    super({ name: "oidc", version: "1.0.0", kind: "contract" });
  }
  contracts(ctx) {
    const out = [];
    for (const api of ctx.sources.entities.filter((e) => e.kind === "API" && e.doc.spec.type === "oidc")) {
      const discoveryPath = api.doc.spec.contract.discoveryPath;
      const providerFile = api.file;
      const providerRef = api.doc.spec.provider;
      const hosts = new Map();
      for (const unit of ctx.discovery.eligible) {
        if (!unit.component) continue;
        for (const f of sourceFiles(ctx.repo, unit.root, { test: false })) {
          const text = ctx.repo.readText(f);
          const namesDiscovery = text.includes(discoveryPath) || DISCOVERY_HINT.test(text);
          if (namesDiscovery && TOKEN_REQUEST_HINT.test(text)) {
            hosts.set(unit.component.ref, f);
            break;
          }
        }
      }
      hosts.delete(providerRef);
      for (const [ref, file] of [...hosts.entries()].sort()) {
        const pr = ctx.prov.add("validated", file, "oidc-extractor", ["rel:pending"]);
        ctx.addEdge("consumesApi", ref, api.ref, { via: "oidc-client" }, [pr], "DERIVED");
      }
      ctx.addContract({ apiRef: api.ref, ref: providerFile, standard: api.doc.spec.contract.standard, discoveryPath, consumers: [...hosts.keys()].sort() });
    }
    return out;
  }
}
