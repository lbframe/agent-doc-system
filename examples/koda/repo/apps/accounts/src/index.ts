export const NAME = "accounts";

// Canonical OIDC surfaces published by this service. Every other service
// resolves these paths as literals, so they are part of the public contract.
export const OIDC = {
  discoveryPath: "/oidc/.well-known/openid-configuration",
  tokenPath: "/oidc/token",
  jwksPath: "/oidc/jwks",
};

export function handler() { return { ok: true, oidc: OIDC.tokenPath }; }
