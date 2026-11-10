import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/selfhost/config";
import { validatePasswordStrength } from "@/lib/selfhost/passwords";
import {
  AuthError,
  changePassword,
  consumeRateLimit,
  resolveSession,
} from "@/lib/selfhost/session-store";
import { hasTrustedOrigin } from "@/lib/selfhost/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const session = await resolveSession(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  } | null;
  if (
    typeof body?.currentPassword !== "string" ||
    typeof body.newPassword !== "string"
  ) {
    return NextResponse.json(
      { error: "Both passwords are required" },
      { status: 400 },
    );
  }
  const weakness = validatePasswordStrength(body.newPassword);
  if (weakness) return NextResponse.json({ error: weakness }, { status: 400 });
  if (!(await consumeRateLimit(`password:${session.user.id}`, 10, 15 * 60))) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  try {
    await changePassword(
      session.user.id,
      body.currentPassword,
      body.newPassword,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[selfhost-auth] password change failed", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
