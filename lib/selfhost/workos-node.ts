/**
 * Shape-compatible subset of `@workos-inc/node`, backed by the self-hosted
 * Postgres store (see ./db.ts). Only the calls this repo makes are implemented.
 */

import { createHash, randomBytes } from "node:crypto";
import { newId, query, withTransaction } from "./db";
import { hashPassword } from "./passwords";

const unsupported =
  (name: string) =>
  (..._args: any[]): any => {
    throw new Error(`${name} is not supported by self-hosted auth`);
  };

/** Mirrors WorkOS `NotFoundException` so existing call sites keep matching. */
export class NotFoundException extends Error {
  readonly status = 404;
  readonly code = "entity_not_found";
  readonly entity: string;
  constructor(entity: string, id: string) {
    super(`${entity} not found: '${id}'.`);
    this.name = "NotFoundException";
    this.entity = entity;
  }
}

export type User = {
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

export type Organization = {
  object: "organization";
  id: string;
  name: string;
  externalId: string | null;
  stripeCustomerId?: string;
  metadata: Record<string, string>;
  domains: never[];
  createdAt: string;
  updatedAt: string;
};

export type OrganizationMembership = {
  object: "organization_membership";
  id: string;
  userId: string;
  organizationId: string;
  status: "active" | "inactive" | "pending";
  role: { slug: string };
  createdAt: string;
  updatedAt: string;
};

export type Invitation = {
  object: "invitation";
  id: string;
  email: string;
  state: "pending" | "accepted" | "expired" | "revoked";
  organizationId: string | null;
  inviterUserId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  acceptInvitationUrl: string;
  token?: string;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  object: "session";
  id: string;
  userId: string;
  organizationId: string | null;
  status: "active" | "revoked" | "expired";
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
};

export type Event = { id: string; event: string; createdAt: string; data: any };

export class ListResult<T> {
  readonly object = "list" as const;
  readonly listMetadata = { before: null, after: null };
  constructor(readonly data: T[]) {}
  async autoPagination(): Promise<T[]> {
    return this.data;
  }
}

type Row = Record<string, any>;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown) => (v ? iso(v) : null);
const clampLimit = (limit?: number) =>
  Math.min(Math.max(Math.trunc(limit ?? 10), 1), 100);

const toUser = (r: Row): User => ({
  object: "user",
  id: r.id,
  email: r.email,
  emailVerified: !!r.email_verified,
  firstName: r.first_name ?? null,
  lastName: r.last_name ?? null,
  profilePictureUrl: r.profile_picture_url ?? null,
  externalId: r.external_id ?? null,
  metadata: r.metadata ?? {},
  locale: null,
  lastSignInAt: isoOrNull(r.last_sign_in_at),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toOrg = (r: Row): Organization => ({
  object: "organization",
  id: r.id,
  name: r.name,
  externalId: r.external_id ?? null,
  ...(r.stripe_customer_id && { stripeCustomerId: r.stripe_customer_id }),
  metadata: r.metadata ?? {},
  domains: [],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toMembership = (r: Row): OrganizationMembership => ({
  object: "organization_membership",
  id: r.id,
  userId: r.user_id,
  organizationId: r.organization_id,
  status: r.status,
  role: { slug: r.role_slug },
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const baseUrl = () =>
  (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );

const inviteUrl = (token: string) =>
  `${baseUrl()}/signup?invitation_token=${token}`;

export const hashInvitationToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const toInvitation = (r: Row, token?: string): Invitation => {
  const expired = new Date(r.expires_at).getTime() < Date.now();
  const state =
    r.state === "pending" && expired
      ? "expired"
      : (r.state as Invitation["state"]);
  return {
    object: "invitation",
    id: r.id,
    email: r.email,
    state,
    organizationId: r.organization_id ?? null,
    inviterUserId: r.inviter_user_id ?? null,
    expiresAt: iso(r.expires_at),
    acceptedAt: isoOrNull(r.accepted_at),
    revokedAt: isoOrNull(r.revoked_at),
    // Only known at creation time (we store the hash).
    acceptInvitationUrl: token ? inviteUrl(token) : `${baseUrl()}/signup`,
    ...(token && { token }),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
};

const toSession = (r: Row): Session => {
  const revoked = !!r.revoked_at;
  const expired = new Date(r.expires_at).getTime() < Date.now();
  return {
    object: "session",
    id: r.id,
    userId: r.user_id,
    organizationId: r.organization_id ?? null,
    status: revoked ? "revoked" : expired ? "expired" : "active",
    ipAddress: r.ip ?? null,
    userAgent: r.user_agent ?? null,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    endedAt: isoOrNull(r.revoked_at),
  };
};

class UserManagement {
  /** Create a local account (used by admin/e2e scripts). */
  async createUser(input: {
    email: string;
    password?: string;
    emailVerified?: boolean;
    firstName?: string;
    lastName?: string;
    externalId?: string;
    metadata?: Record<string, string>;
  }): Promise<User> {
    const rows = await query<Row>(
      `INSERT INTO auth_users (id, email, password_hash, first_name, last_name, email_verified, external_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        newId("user"),
        input.email.trim().toLowerCase(),
        input.password ? await hashPassword(input.password) : null,
        input.firstName ?? null,
        input.lastName ?? null,
        input.emailVerified ?? true,
        input.externalId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return toUser(rows[0]);
  }

  async updateUser(input: {
    userId: string;
    password?: string;
    emailVerified?: boolean;
    firstName?: string;
    lastName?: string;
    externalId?: string;
    metadata?: Record<string, string>;
  }): Promise<User> {
    const rows = await query<Row>(
      `UPDATE auth_users SET
         password_hash = COALESCE($2, password_hash),
         email_verified = COALESCE($3, email_verified),
         first_name = COALESCE($4, first_name),
         last_name = COALESCE($5, last_name),
         external_id = COALESCE($6, external_id),
         metadata = COALESCE($7::jsonb, metadata),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        input.userId,
        input.password ? await hashPassword(input.password) : null,
        input.emailVerified ?? null,
        input.firstName ?? null,
        input.lastName ?? null,
        input.externalId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
    if (!rows[0]) throw new NotFoundException("User", input.userId);
    return toUser(rows[0]);
  }

  /** Mark an invitation accepted and add the user to its organization. */
  async acceptInvitation(invitationId: string, userId?: string) {
    const invitation = await this.getInvitation(invitationId);
    await query(
      "UPDATE auth_invitations SET state = 'accepted', accepted_at = now(), updated_at = now() WHERE id = $1",
      [invitationId],
    );
    if (userId && invitation.organizationId) {
      await this.createOrganizationMembership({
        userId,
        organizationId: invitation.organizationId,
      });
    }
    return { ...invitation, state: "accepted" as const };
  }

  async getUser(userId: string): Promise<User> {
    const rows = await query("SELECT * FROM auth_users WHERE id = $1", [
      userId,
    ]);
    if (!rows[0]) throw new NotFoundException("User", userId);
    return toUser(rows[0]);
  }

  async listUsers(
    opts: { email?: string; organizationId?: string; limit?: number } = {},
  ): Promise<ListResult<User>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.email) {
      params.push(opts.email);
      where.push(`lower(u.email) = lower($${params.length})`);
    }
    if (opts.organizationId) {
      params.push(opts.organizationId);
      where.push(
        `EXISTS (SELECT 1 FROM auth_memberships m WHERE m.user_id = u.id AND m.organization_id = $${params.length})`,
      );
    }
    params.push(clampLimit(opts.limit));
    const rows = await query(
      `SELECT u.* FROM auth_users u ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY u.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return new ListResult(rows.map(toUser));
  }

  async deleteUser(userId: string): Promise<void> {
    const rows = await query(
      "DELETE FROM auth_users WHERE id = $1 RETURNING id",
      [userId],
    );
    if (!rows[0]) throw new NotFoundException("User", userId);
  }

  async listOrganizationMemberships(
    opts: {
      userId?: string;
      organizationId?: string;
      statuses?: string[];
      limit?: number;
    } = {},
  ): Promise<ListResult<OrganizationMembership>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.userId) {
      params.push(opts.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (opts.organizationId) {
      params.push(opts.organizationId);
      where.push(`organization_id = $${params.length}`);
    }
    if (opts.statuses?.length) {
      params.push(opts.statuses);
      where.push(`status = ANY($${params.length}::text[])`);
    }
    params.push(clampLimit(opts.limit));
    const rows = await query(
      `SELECT * FROM auth_memberships ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC LIMIT $${params.length}`,
      params,
    );
    return new ListResult(rows.map(toMembership));
  }

  async getOrganizationMembership(id: string): Promise<OrganizationMembership> {
    const rows = await query("SELECT * FROM auth_memberships WHERE id = $1", [
      id,
    ]);
    if (!rows[0]) throw new NotFoundException("Organization membership", id);
    return toMembership(rows[0]);
  }

  async createOrganizationMembership(opts: {
    userId: string;
    organizationId: string;
    roleSlug?: string;
  }): Promise<OrganizationMembership> {
    const [user, org] = await Promise.all([
      query("SELECT 1 FROM auth_users WHERE id = $1", [opts.userId]),
      query("SELECT 1 FROM auth_organizations WHERE id = $1", [
        opts.organizationId,
      ]),
    ]);
    if (!user[0]) throw new NotFoundException("User", opts.userId);
    if (!org[0])
      throw new NotFoundException("Organization", opts.organizationId);
    const rows = await query(
      `INSERT INTO auth_memberships (id, user_id, organization_id, role_slug)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        newId("om"),
        opts.userId,
        opts.organizationId,
        opts.roleSlug ?? "member",
      ],
    );
    return toMembership(rows[0]);
  }

  async deleteOrganizationMembership(id: string): Promise<void> {
    const rows = await query(
      "DELETE FROM auth_memberships WHERE id = $1 RETURNING id",
      [id],
    );
    if (!rows[0]) throw new NotFoundException("Organization membership", id);
  }

  async listInvitations(
    opts: { email?: string; organizationId?: string; limit?: number } = {},
  ): Promise<ListResult<Invitation>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.email) {
      params.push(opts.email);
      where.push(`lower(email) = lower($${params.length})`);
    }
    if (opts.organizationId) {
      params.push(opts.organizationId);
      where.push(`organization_id = $${params.length}`);
    }
    params.push(clampLimit(opts.limit));
    const rows = await query(
      `SELECT * FROM auth_invitations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return new ListResult(rows.map((r) => toInvitation(r)));
  }

  async getInvitation(id: string): Promise<Invitation> {
    const rows = await query("SELECT * FROM auth_invitations WHERE id = $1", [
      id,
    ]);
    if (!rows[0]) throw new NotFoundException("Invitation", id);
    return toInvitation(rows[0]);
  }

  async sendInvitation(opts: {
    email: string;
    organizationId?: string;
    inviterUserId?: string;
    expiresInDays?: number;
    roleSlug?: string;
  }): Promise<Invitation> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + (opts.expiresInDays ?? 7) * 24 * 60 * 60 * 1000,
    );
    const rows = await query(
      `INSERT INTO auth_invitations
         (id, email, organization_id, inviter_user_id, role_slug, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        newId("invitation"),
        opts.email,
        opts.organizationId ?? null,
        opts.inviterUserId ?? null,
        opts.roleSlug ?? "member",
        hashInvitationToken(token),
        expiresAt,
      ],
    );
    return toInvitation(rows[0], token);
  }

  async revokeInvitation(id: string): Promise<Invitation> {
    const rows = await query(
      `UPDATE auth_invitations
         SET state = 'revoked', revoked_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException("Invitation", id);
    return toInvitation(rows[0]);
  }

  /** WorkOS takes a positional user id; an options object is accepted too. */
  async listSessions(
    arg: string | { userId: string },
  ): Promise<ListResult<Session>> {
    const userId = typeof arg === "string" ? arg : arg.userId;
    const rows = await query(
      "SELECT * FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
      [userId],
    );
    return new ListResult(rows.map(toSession));
  }

  async revokeSession(opts: { sessionId: string }): Promise<void> {
    const rows = await query(
      `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 RETURNING id`,
      [opts.sessionId],
    );
    if (!rows[0]) throw new NotFoundException("Session", opts.sessionId);
  }

  getAuthorizationUrl = unsupported("getAuthorizationUrl");
  authenticateWithCode = unsupported("authenticateWithCode");
  authenticateWithRefreshToken = unsupported("authenticateWithRefreshToken");
  loadSealedSession = unsupported("loadSealedSession");
}

class Organizations {
  async getOrganization(id: string): Promise<Organization> {
    const rows = await query("SELECT * FROM auth_organizations WHERE id = $1", [
      id,
    ]);
    if (!rows[0]) throw new NotFoundException("Organization", id);
    return toOrg(rows[0]);
  }

  async createOrganization(opts: {
    name: string;
    externalId?: string;
    metadata?: Record<string, string>;
  }): Promise<Organization> {
    const rows = await query(
      `INSERT INTO auth_organizations (id, name, external_id, metadata)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
      [
        newId("org"),
        opts.name,
        opts.externalId ?? null,
        JSON.stringify(opts.metadata ?? {}),
      ],
    );
    return toOrg(rows[0]);
  }

  async updateOrganization(opts: {
    organization: string;
    name?: string;
    stripeCustomerId?: string;
    metadata?: Record<string, string>;
    externalId?: string;
  }): Promise<Organization> {
    return withTransaction(async (client) => {
      const current = await client.query(
        "SELECT * FROM auth_organizations WHERE id = $1 FOR UPDATE",
        [opts.organization],
      );
      if (!current.rows[0]) {
        throw new NotFoundException("Organization", opts.organization);
      }
      const cur = current.rows[0];
      const updated = await client.query(
        `UPDATE auth_organizations
           SET name = $2, external_id = $3, stripe_customer_id = $4,
               metadata = $5::jsonb, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          opts.organization,
          opts.name ?? cur.name,
          opts.externalId ?? cur.external_id,
          opts.stripeCustomerId ?? cur.stripe_customer_id,
          JSON.stringify(opts.metadata ?? cur.metadata ?? {}),
        ],
      );
      return toOrg(updated.rows[0]);
    });
  }

  async deleteOrganization(id: string): Promise<void> {
    const rows = await query(
      "DELETE FROM auth_organizations WHERE id = $1 RETURNING id",
      [id],
    );
    if (!rows[0]) throw new NotFoundException("Organization", id);
  }
}

class Webhooks {
  constructEvent = unsupported("webhooks.constructEvent");
}

export class WorkOS {
  readonly userManagement = new UserManagement();
  readonly organizations = new Organizations();
  readonly webhooks = new Webhooks();
  // Accepted for signature compatibility; self-hosted auth needs no API key.
  constructor(_apiKey?: string, _opts?: { clientId?: string }) {}
}
