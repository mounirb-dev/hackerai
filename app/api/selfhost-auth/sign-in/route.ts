import { NextResponse, type NextRequest } from "next/server";
import {
  AuthError,
  authenticatePassword,
  consumeRateLimit,
  createSession,
  normalizeEmail,
} from "@/lib/selfhost/session-store";
import {
  clientIp,
  hasTrustedOrigin,
  resolvePostLoginPath,
  setSessionCookie,
} from "@/lib/selfhost/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
    redirect?: unknown;
  } | null;
  if (typeof body?.email !== "string" || typeof body.password !== "string") {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 },
    );
  }

  const email = normalizeEmail(body.email);
  const ip = clientIp(request);
  const allowed =
    (await consumeRateLimit(`signin:ip:${ip}`, 30, 15 * 60)) &&
    (await consumeRateLimit(`signin:email:${email}`, 10, 15 * 60));
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }

  try {
    const user = await authenticatePassword(email, body.password);
    const session = await createSession({
      userId: user.id,
      ip,
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    const response = NextResponse.json({
      ok: true,
      redirect: resolvePostLoginPath(request, body.redirect),
    });
    setSessionCookie(response, session.cookieValue, session.maxAge);
    response.cookies.delete("post_login_redirect");
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("[selfhost-auth] sign-in failed", error);
    return NextResponse.json({ error: "Sign-in failed" }, { status: 500 });
  }
}
