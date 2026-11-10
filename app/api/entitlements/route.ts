import { NextRequest } from "next/server";
import { json } from "@/lib/api/response";
import {
  parseEntitlements,
  resolveSubscriptionTier,
} from "@/lib/auth/entitlements";
import { SESSION_COOKIE_NAME } from "@/lib/selfhost/config";
import { resolveSession } from "@/lib/selfhost/session-store";

/**
 * Current plan entitlements. Self-hosted accounts have no billing provider:
 * entitlements come from the organization row or `SELFHOST_ENTITLEMENTS`.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await resolveSession(
      req.cookies.get(SESSION_COOKIE_NAME)?.value,
    );
    if (!session) {
      return json({ error: "Unauthorized" }, { status: 401 });
    }

    const entitlements = parseEntitlements(session.entitlements);
    return json({
      entitlements,
      subscription: resolveSubscriptionTier(entitlements),
    });
  } catch (error) {
    console.error("Error loading entitlements:", error);
    return json({ error: "Failed to load entitlements" }, { status: 500 });
  }
}
