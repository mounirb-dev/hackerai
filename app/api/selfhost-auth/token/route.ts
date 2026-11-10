import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/selfhost/config";
import { signAccessToken } from "@/lib/selfhost/keys";
import { resolveSession } from "@/lib/selfhost/session-store";

export const runtime = "nodejs";

/** Short-lived JWT the browser hands to Convex. */
export async function GET(request: NextRequest) {
  const session = await resolveSession(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { token, expiresAt } = await signAccessToken({
    userId: session.user.id,
    sessionId: session.sessionId,
    organizationId: session.organizationId,
    role: session.role,
    entitlements: session.entitlements,
    email: session.user.email,
  });
  return NextResponse.json(
    { accessToken: token, expiresAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
