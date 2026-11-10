import { NextResponse } from "next/server";
import { getJwks } from "@/lib/selfhost/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public keys Convex uses to verify access tokens (see convex/auth.config.ts). */
export async function GET() {
  return NextResponse.json(await getJwks(), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
