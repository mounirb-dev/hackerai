import type { AuthConfig } from "convex/server";

/**
 * Convex trusts access tokens minted by this app's own auth layer
 * (lib/selfhost). Set `AUTH_ISSUER` in the Convex deployment to the public
 * origin of the web app, e.g. `https://hackerai.example.com`; the matching
 * public keys are published at `<origin>/.well-known/jwks.json`.
 */
function resolveIssuer(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let origin: URL;
  try {
    origin = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("AUTH_ISSUER must be a hostname or origin without a path");
  }
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    !/^\/*$/.test(origin.pathname) ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("AUTH_ISSUER must be a hostname or origin without a path");
  }
  return origin.origin;
}

const issuer = resolveIssuer(process.env.AUTH_ISSUER);
// Optional: where the Convex backend downloads the keys from, when it should
// not go through the public origin (e.g. `http://app:3000/.well-known/jwks.json`
// inside a compose network). The token issuer is still `AUTH_ISSUER`.
const jwksUrl = process.env.AUTH_JWKS_URL?.trim();

const authConfig = {
  providers: issuer
    ? [
        {
          type: "customJwt" as const,
          issuer,
          algorithm: "RS256" as const,
          jwks: jwksUrl || `${issuer}/.well-known/jwks.json`,
        },
      ]
    : [],
} satisfies AuthConfig;

export default authConfig;
