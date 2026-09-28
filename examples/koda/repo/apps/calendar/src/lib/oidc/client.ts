// Mints a service token from the accounts OIDC token endpoint.
export const TOKEN_PATH = "/oidc/token";
export const JWKS_URI = "/oidc/jwks";

export const tokenRequest = {
  grant_type: "client_credentials",
  client_id: "calendar",
};
