/**
 * Postgres store for the self-hosted auth layer (users, sessions, organizations).
 *
 * Replaces the WorkOS user-management backend. The schema is created on first
 * use, so a fresh database needs no migration step. Set `AUTH_DATABASE_URL`
 * (any Postgres 13+; the compose file shares the Convex Postgres instance).
 */

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | undefined;
let schemaReady: Promise<void> | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.AUTH_DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error("AUTH_DATABASE_URL must be configured");
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.AUTH_DATABASE_POOL_MAX) || 5,
    });
  }
  return pool;
}

/** Opaque id with a type prefix, e.g. `user_01hx…` (mirrors WorkOS id shapes). */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_users (
  id text PRIMARY KEY,
  email text NOT NULL,
  password_hash text,
  first_name text,
  last_name text,
  email_verified boolean NOT NULL DEFAULT false,
  profile_picture_url text,
  external_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_key ON auth_users (lower(email));

CREATE TABLE IF NOT EXISTS auth_organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  external_id text,
  stripe_customer_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  entitlements text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_memberships (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES auth_organizations(id) ON DELETE CASCADE,
  role_slug text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);
CREATE INDEX IF NOT EXISTS auth_memberships_org_idx ON auth_memberships (organization_id);

CREATE TABLE IF NOT EXISTS auth_invitations (
  id text PRIMARY KEY,
  email text NOT NULL,
  organization_id text REFERENCES auth_organizations(id) ON DELETE CASCADE,
  inviter_user_id text,
  role_slug text NOT NULL DEFAULT 'member',
  state text NOT NULL DEFAULT 'pending',
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_invitations_org_idx ON auth_invitations (organization_id);
CREATE INDEX IF NOT EXISTS auth_invitations_email_idx ON auth_invitations (lower(email));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  organization_id text,
  refresh_hash text NOT NULL,
  previous_refresh_hash text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS auth_signing_keys (
  kid text PRIMARY KEY,
  private_pem text NOT NULL,
  public_jwk jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  window_start timestamptz NOT NULL
);
`;

export function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const client = await getPool().connect();
    try {
      // Serialize concurrent first boots (several app replicas / build workers).
      await client.query("SELECT pg_advisory_lock(7263541)");
      try {
        await client.query(SCHEMA);
      } finally {
        await client.query("SELECT pg_advisory_unlock(7263541)");
      }
    } finally {
      client.release();
    }
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  await ensureSchema();
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
