import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/selfhost/config";
import {
  resolveSession,
  switchSessionOrganization,
  type ResolvedSession,
} from "@/lib/selfhost/session-store";
import { hasTrustedOrigin } from "@/lib/selfhost/http";

export const runtime = "nodejs";

function publicAuth(session: ResolvedSession) {
  return {
    user: session.user,
    sessionId: session.sessionId,
    organizationId: session.organizationId,
    role: session.role,
    roles: session.role ? [session.role] : undefined,
    permissions: [],
    entitlements: session.entitlements,
    featureFlags: [],
  };
}

const noStore = { "Cache-Control": "no-store" };

/** Current user, organization and entitlements (never the access token). */
export async function GET(request: NextRequest) {
  const session = await resolveSession(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );
  if (!session)
    return NextResponse.json({ user: null }, { status: 401, headers: noStore });
  return NextResponse.json(publicAuth(session), { headers: noStore });
}

/** Scope the session to one of the user's organizations. */
export async function POST(request: NextRequest) {
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await resolveSession(cookie);
  if (!session)
    return NextResponse.json({ user: null }, { status: 401, headers: noStore });

  const body = (await request.json().catch(() => null)) as {
    organizationId?: unknown;
  } | null;
  if (typeof body?.organizationId !== "string") {
    return NextResponse.json(
      { error: "organizationId is required" },
      { status: 400 },
    );
  }
  const switched = await switchSessionOrganization(
    session.sessionId,
    session.user.id,
    body.organizationId,
  );
  if (!switched) {
    return NextResponse.json(
      { error: "Not a member of this organization" },
      { status: 403 },
    );
  }
  const next = await resolveSession(cookie);
  return NextResponse.json(publicAuth(next ?? session), { headers: noStore });
}
