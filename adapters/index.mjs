// Adapter registry. Adapters are looked up by name and instantiated once.
// An unknown adapter name is a configuration error, never a silent no-op: a
// project that thinks it has protobuf discovery must not lose it quietly.
import { AgentDocError, CODES } from "../core/codes.mjs";
import { GenericAdapter } from "./generic.mjs";
import { NodeAdapter } from "./node.mjs";
import { PnpmAdapter } from "./pnpm.mjs";
import { TurborepoAdapter } from "./turborepo.mjs";
import { TypeScriptAdapter } from "./typescript.mjs";
import { GoAdapter } from "./go.mjs";
import { OpenApiAdapter } from "./openapi.mjs";
import { ProtobufAdapter } from "./protobuf.mjs";
import { GraphQLAdapter } from "./graphql.mjs";
import { OidcAdapter } from "./oidc.mjs";
import { GitHubActionsAdapter } from "./github-actions.mjs";
import { DockerfileAdapter } from "./dockerfile.mjs";
import { WranglerAdapter } from "./wrangler.mjs";
import { DatabaseAdapter } from "./database.mjs";
import { EventsAdapter } from "./events.mjs";
import { DeployConfigAdapter } from "./deploy-config.mjs";
import { ObjectStoreAdapter } from "./object-store.mjs";
import { CacheAdapter } from "./cache.mjs";

const REGISTRY = new Map();
for (const C of [
  GenericAdapter, NodeAdapter, PnpmAdapter, TurborepoAdapter, TypeScriptAdapter,
  GoAdapter, OpenApiAdapter, ProtobufAdapter, GraphQLAdapter, OidcAdapter,
  GitHubActionsAdapter, DockerfileAdapter, WranglerAdapter, DatabaseAdapter,
  EventsAdapter, DeployConfigAdapter, ObjectStoreAdapter, CacheAdapter,
]) {
  REGISTRY.set(C.prototype.constructor.adapterName, new C());
}

export function adapterNames() {
  return [...REGISTRY.keys()].sort();
}

export function loadAdapters(names) {
  // The generic adapter is always on: documentation conventions and health
  // contract detection are language-agnostic and cost nothing.
  const out = [REGISTRY.get("generic")];
  for (const n of names || []) {
    const a = REGISTRY.get(n);
    if (!a) {
      throw new AgentDocError(
        CODES.CONFIG,
        "unknown adapter '" + n + "'; available adapters: " + adapterNames().join(", ")
      );
    }
    if (out.includes(a)) continue;
    out.push(a);
  }
  // Deterministic order, independent of how the config listed them.
  return out.slice().sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}
