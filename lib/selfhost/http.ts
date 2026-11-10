import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE_NAME,
  getBaseUrl,
  isLocalPath,
  isSecureOrigin,
} from "./config";

export function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** JSON POSTs from another origin are rejected (cookies are SameSite=Lax too). */
export function hasTrustedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(getBaseUrl()).host;
  } catch {
    return false;
  }
}

export function setSessionCookie(
  response: NextResponse,
  value: string,
  maxAge: number,
): void {
  response.cookies.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}

/** Where to go after signing in: explicit param, else the intent cookie. */
export function resolvePostLoginPath(
  request: NextRequest,
  requested: unknown,
): string {
  const fromCookie = request.cookies.get("post_login_redirect")?.value;
  if (isLocalPath(fromCookie)) return fromCookie;
  return isLocalPath(typeof requested === "string" ? requested : null)
    ? (requested as string)
    : "/";
}
