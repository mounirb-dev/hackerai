/**
 * Accounts and browser sessions.
 *
 * A session cookie is `<session id>.<secret>`. Only the SHA-256 of the secret is
 * stored, so a database leak cannot be replayed as a login. Access tokens for
 * Convex are minted on demand from the session (see keys.ts).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId, query, withTransaction } from "./db";
import { SESSION_TTL_SECONDS, getDefaultEntitlements } from "./config";
import { hashPassword, verifyPassword } from "./passwords";

export type SelfhostUser = {
  object: "user";
  id: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
  externalId: string | null;
  metadata: Record<string, string>;
  locale: string | null;
  lastSignInAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResolvedSession = {
  user: SelfhostUser;
  sessionId: string;
  organizationId?: string;
  role?: string;
  entitlements: string[];
};

type UserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  first_name: string | null;
  last_name: string | null;
  email_verified: boolean;
  profile_picture_url: string | null;
  external_id: string | null;
  metadata: Record<string, string>;
  last_sign_in_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function toUser(row: UserRow): SelfhostUser {
  return {
    object: "user",
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    firstName: row.first_name,
    lastName: row.last_name,
    profilePictureUrl: row.profile_picture_url,
    externalId: row.external_id,
    metadata: row.metadata ?? {},
    locale: null,
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const isValidEmail = (email: string) =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export class AuthError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "email_taken"
      | "invalid_input"
      | "signups_closed"
      | "rate_limited",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Fixed-window limiter in Postgres, shared by every app replica. */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const rows = await query<{ count: number }>(
    `INSERT INTO auth_rate_limits (key, count, window_start)
     VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN auth_rate_limits.window_start < now() - make_interval(secs => $2::int)
                    THEN 1 ELSE auth_rate_limits.count + 1 END,
       window_start = CASE WHEN auth_rate_limits.window_start < now() - make_interval(secs => $2::int)
                    THEN now() ELSE auth_rate_limits.window_start END
     RETURNING count`,
    [key, windowSeconds],
  );
  return (rows[0]?.count ?? 1) <= limit;
}

export async function createUser(input: {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}): Promise<SelfhostUser> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    throw new AuthError("invalid_input", "Enter a valid email address");
  }
  const passwordHash = await hashPassword(input.password);
  try {
    const rows = await query<UserRow>(
      `INSERT INTO auth_users (id, email, password_hash, first_name, last_name, email_verified)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [
        newId("user"),
        email,
        passwordHash,
        input.firstName?.trim() || null,
        input.lastName?.trim() || null,
      ],
    );
    return toUser(rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new AuthError("email_taken", "An account with this email exists");
    }
    throw error;
  }
}

export async function authenticatePassword(
  emailInput: string,
  password: string,
): Promise<SelfhostUser> {
  const rows = await query<UserRow>(
    "SELECT * FROM auth_users WHERE lower(email) = $1",
    [normalizeEmail(emailInput)],
  );
  const row = rows[0];
  const valid = await verifyPassword(password, row?.password_hash);
  if (!row || !valid) {
    throw new AuthError("invalid_credentials", "Incorrect email or password");
  }
  await query("UPDATE auth_users SET last_sign_in_at = now() WHERE id = $1", [
    row.id,
  ]);
  return toUser(row);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const rows = await query<UserRow>("SELECT * FROM auth_users WHERE id = $1", [
    userId,
  ]);
  if (!(await verifyPassword(currentPassword, rows[0]?.password_hash))) {
    throw new AuthError("invalid_credentials", "Current password is incorrect");
  }
  await query(
    "UPDATE auth_users SET password_hash = $2, updated_at = now() WHERE id = $1",
    [userId, await hashPassword(newPassword)],
  );
}

export async function createSession(input: {
  userId: string;
  organizationId?: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ cookieValue: string; sessionId: string; maxAge: number }> {
  const sessionId = newId("session");
  const secret = randomBytes(32).toString("base64url");
  await query(
    `INSERT INTO auth_sessions (id, user_id, organization_id, refresh_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [
      sessionId,
      input.userId,
      input.organizationId ?? null,
      sha256(secret),
      input.ip?.slice(0, 64) ?? null,
      input.userAgent?.slice(0, 256) ?? null,
      SESSION_TTL_SECONDS,
    ],
  );
  return {
    cookieValue: `${sessionId}.${secret}`,
    sessionId,
    maxAge: SESSION_TTL_SECONDS,
  };
}

type SessionJoinRow = UserRow & {
  session_id: string;
  session_org_id: string | null;
  refresh_hash: string;
  rotated_at: Date;
};

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; value: ResolvedSession | null }>();

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Resolve a cookie to a live session, or null when missing/expired/revoked. */
export async function resolveSession(
  cookieValue: string | undefined | null,
): Promise<ResolvedSession | null> {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0 || cookieValue.length > 200) return null;

  const cached = cache.get(cookieValue);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const sessionId = cookieValue.slice(0, dot);
  const secretHash = sha256(cookieValue.slice(dot + 1));
  const rows = await query<SessionJoinRow>(
    `SELECT u.*, s.id AS session_id, s.organization_id AS session_org_id,
            s.refresh_hash, s.rotated_at
       FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionId],
  );
  const row = rows[0];
  let value: ResolvedSession | null = null;

  if (row && safeEqualHex(row.refresh_hash, secretHash)) {
    const memberships = await query<{
      organization_id: string;
      role_slug: string;
      entitlements: string[] | null;
    }>(
      `SELECT m.organization_id, m.role_slug, o.entitlements
         FROM auth_memberships m JOIN auth_organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.status = 'active'
        ORDER BY m.created_at`,
      [row.id],
    );
    // Like AuthKit: an explicit session org wins; otherwise a single
    // membership is unambiguous and anything else stays unscoped.
    const active = row.session_org_id
      ? memberships.find((m) => m.organization_id === row.session_org_id)
      : memberships.length === 1
        ? memberships[0]
        : undefined;
    value = {
      user: toUser(row),
      sessionId: row.session_id,
      organizationId: active?.organization_id,
      role: active?.role_slug,
      entitlements: active?.entitlements ?? getDefaultEntitlements(),
    };
    // Sliding expiry, written at most hourly to avoid a write per request.
    if (Date.now() - row.rotated_at.getTime() > 60 * 60 * 1000) {
      void query(
        `UPDATE auth_sessions SET rotated_at = now(),
                expires_at = now() + make_interval(secs => $2) WHERE id = $1`,
        [row.session_id, SESSION_TTL_SECONDS],
      ).catch(() => undefined);
    }
  }

  if (cache.size > 500) cache.clear();
  cache.set(cookieValue, { at: Date.now(), value });
  return value;
}

export async function revokeSessionById(sessionId: string): Promise<void> {
  await query(
    "UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
  cache.clear();
}

export async function switchSessionOrganization(
  sessionId: string,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  return withTransaction(async (client) => {
    const member = await client.query(
      `SELECT 1 FROM auth_memberships
        WHERE user_id = $1 AND organization_id = $2 AND status = 'active'`,
      [userId, organizationId],
    );
    if (member.rowCount === 0) return false;
    await client.query(
      "UPDATE auth_sessions SET organization_id = $2 WHERE id = $1",
      [sessionId, organizationId],
    );
    cache.clear();
    return true;
  });
}

/** Test seam: forget cached sessions. */
export function clearSessionCache(): void {
  cache.clear();
}
