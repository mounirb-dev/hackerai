/**
 * Self-hosted replacement for the parts of `@workos-inc/authkit-nextjs` this app
 * uses (resolved through the tsconfig path alias). Same function names and
 * return shapes, backed by Postgres sessions instead of the WorkOS API.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, getBaseUrl, isLocalPath } from "./config";
import { signAccessToken } from "./keys";
import {
  resolveSession,
  revokeSessionById,
  type ResolvedSession,
  type SelfhostUser,
} from "./session-store";

export type UserInfo = {
  user: SelfhostUser;
  sessionId: string;
  organizationId?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
  entitlements?: string[];
  featureFlags?: string[];
  impersonator?: undefined;
  accessToken: string;
};

export type NoUserInfo = {
  user: null;
  sessionId?: undefined;
  organizationId?: undefined;
  role?: undefined;
  roles?: undefined;
  permissions?: undefined;
  entitlements?: undefined;
  featureFlags?: undefined;
  impersonator?: undefined;
  accessToken?: undefined;
};

async function toUserInfo(session: ResolvedSession): Promise<UserInfo> {
  const { token } = await signAccessToken({
    userId: session.user.id,
    sessionId: session.sessionId,
    organizationId: session.organizationId,
    role: session.role,
    entitlements: session.entitlements,
    email: session.user.email,
  });
  return {
    user: session.user,
    sessionId: session.sessionId,
    organizationId: session.organizationId,
    role: session.role,
    roles: session.role ? [session.role] : undefined,
    permissions: [],
    entitlements: session.entitlements,
    featureFlags: [],
    accessToken: token,
  };
}

export async function getSignInUrl(
  options: { returnTo?: string } = {},
): Promise<string> {
  const url = new URL("/auth/sign-in", getBaseUrl());
  if (isLocalPath(options.returnTo)) {
    url.searchParams.set("redirect", options.returnTo);
  }
  return url.toString();
}

export async function getSignUpUrl(
  options: { returnTo?: string } = {},
): Promise<string> {
  const url = new URL("/auth/sign-up", getBaseUrl());
  if (isLocalPath(options.returnTo)) {
    url.searchParams.set("redirect", options.returnTo);
  }
  return url.toString();
}

/**
 * Middleware entry point. Resolves the session cookie of a request; it never
 * throws for a bad cookie (that is simply "signed out").
 */
export type AuthkitOptions = {
  redirectUri?: string;
  eagerAuth?: boolean;
  onSessionRefreshError?: (args: {
    error: unknown;
    isTransient: boolean;
  }) => void;
};

export async function authkit(
  request: NextRequest | Request,
  _options: AuthkitOptions = {},
): Promise<{
  session: UserInfo | NoUserInfo;
  headers: Headers;
  authorizationUrl?: string;
}> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieValue = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);

  const headers = new Headers();
  // The root layout only reads auth when this marker says the proxy ran.
  headers.set("x-workos-middleware", "true");

  const resolved = await resolveSession(
    cookieValue ? decodeURIComponent(cookieValue) : undefined,
  );
  if (!resolved) {
    return {
      session: { user: null },
      headers,
      authorizationUrl: await getSignInUrl(),
    };
  }
  return { session: await toUserInfo(resolved), headers };
}

/** Server-side current user (layouts, server actions, route handlers). */
export async function withAuth(
  options: { ensureSignedIn?: boolean } = {},
): Promise<UserInfo | NoUserInfo> {
  const store = await cookies();
  const resolved = await resolveSession(store.get(SESSION_COOKIE_NAME)?.value);
  if (!resolved) {
    if (options.ensureSignedIn) redirect(await getSignInUrl());
    return { user: null };
  }
  return toUserInfo(resolved);
}

export async function signOut(
  options: { returnTo?: string } = {},
): Promise<void> {
  const store = await cookies();
  const resolved = await resolveSession(store.get(SESSION_COOKIE_NAME)?.value);
  if (resolved) await revokeSessionById(resolved.sessionId);
  store.delete(SESSION_COOKIE_NAME);
  redirect(isLocalPath(options.returnTo) ? options.returnTo : "/");
}

/**
 * The hosted sign-in flow had an OAuth callback; with local accounts there is
 * nothing to exchange, so the route just sends the browser home.
 */
export function handleAuth(_options: Record<string, unknown> = {}) {
  // Configured origin, not the request's Host header.
  return async (_request: Request): Promise<Response> =>
    Response.redirect(`${getBaseUrl()}/`, 307);
}
