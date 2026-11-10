import { NextResponse, type NextRequest } from "next/server";
import { signupsAllowed } from "@/lib/selfhost/config";
import { validatePasswordStrength } from "@/lib/selfhost/passwords";
import {
  AuthError,
  consumeRateLimit,
  createSession,
  createUser,
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
  if (!signupsAllowed()) {
    return NextResponse.json(
      { error: "Sign-ups are closed on this server" },
      { status: 403 },
    );
  }
  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
    firstName?: unknown;
    lastName?: unknown;
    redirect?: unknown;
  } | null;
  if (typeof body?.email !== "string" || typeof body.password !== "string") {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 },
    );
  }
  const weakness = validatePasswordStrength(body.password);
  if (weakness) return NextResponse.json({ error: weakness }, { status: 400 });

  const ip = clientIp(request);
  if (!(await consumeRateLimit(`signup:ip:${ip}`, 10, 60 * 60))) {
    return NextResponse.json(
      { error: "Too many sign-ups from this address" },
      { status: 429 },
    );
  }

  try {
    const user = await createUser({
      email: body.email,
      password: body.password,
      firstName:
        typeof body.firstName === "string" ? body.firstName : undefined,
      lastName: typeof body.lastName === "string" ? body.lastName : undefined,
    });
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
      const status = error.code === "email_taken" ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    console.error("[selfhost-auth] sign-up failed", error);
    return NextResponse.json({ error: "Sign-up failed" }, { status: 500 });
  }
}
