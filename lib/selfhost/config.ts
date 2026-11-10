/** Runtime configuration for the self-hosted auth layer. */

export const SESSION_COOKIE_NAME = "wos-session";
export const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export function getBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_BASE_URL?.trim() || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/** `iss` of access tokens; must equal `AUTH_ISSUER` in the Convex deployment. */
export function getIssuer(): string {
  return (process.env.AUTH_ISSUER?.trim() || getBaseUrl()).replace(/\/+$/, "");
}

export function isSecureOrigin(): boolean {
  return getBaseUrl().startsWith("https://");
}

/**
 * Plans granted to every account. Self-hosted deployments have no billing
 * provider, so the plan is a deployment setting: "ultra-plan" unlocks every
 * limit, "" keeps everyone on the free tier.
 */
export function getDefaultEntitlements(): string[] {
  const raw = process.env.SELFHOST_ENTITLEMENTS;
  if (raw === undefined) return ["ultra-plan"];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Set `AUTH_ALLOW_SIGNUPS=false` after creating your account to close signups. */
export function signupsAllowed(): boolean {
  return process.env.AUTH_ALLOW_SIGNUPS?.trim().toLowerCase() !== "false";
}

export function isLocalPath(path: string | null | undefined): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.startsWith("/\\")
  );
}
