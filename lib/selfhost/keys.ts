/**
 * RS256 signing keys for access tokens.
 *
 * Convex validates tokens against a public JWKS, so the keypair has to be stable
 * across restarts and replicas. It is generated once and kept in Postgres; the
 * JWKS endpoint publishes every stored public key (rotation = insert a row).
 */

import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  type CryptoKey,
  type JWK,
} from "jose";
import { query } from "./db";
import { ACCESS_TOKEN_TTL_SECONDS, getIssuer } from "./config";

type KeyRow = { kid: string; private_pem: string; public_jwk: JWK };
type LoadedKey = { kid: string; privateKey: CryptoKey };

let signingKey: Promise<LoadedKey> | undefined;

async function loadNewestKey(): Promise<KeyRow | undefined> {
  const rows = await query<KeyRow>(
    "SELECT kid, private_pem, public_jwk FROM auth_signing_keys ORDER BY created_at DESC LIMIT 1",
  );
  return rows[0];
}

async function createKey(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    modulusLength: 2048,
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  await query(
    `INSERT INTO auth_signing_keys (kid, private_pem, public_jwk)
     VALUES ($1, $2, $3) ON CONFLICT (kid) DO NOTHING`,
    [
      kid,
      await exportPKCS8(privateKey),
      JSON.stringify({ ...publicJwk, kid, alg: "RS256", use: "sig" }),
    ],
  );
}

async function getSigningKey(): Promise<LoadedKey> {
  signingKey ??= (async () => {
    let row = await loadNewestKey();
    if (!row) {
      await createKey();
      // Concurrent boots may each create a key; all of them read the same newest.
      row = await loadNewestKey();
    }
    if (!row) throw new Error("Failed to create an auth signing key");
    return {
      kid: row.kid,
      privateKey: await importPKCS8(row.private_pem, "RS256"),
    };
  })().catch((error) => {
    signingKey = undefined;
    throw error;
  });
  return signingKey;
}

export async function getJwks(): Promise<{ keys: JWK[] }> {
  await getSigningKey();
  const rows = await query<{ public_jwk: JWK }>(
    "SELECT public_jwk FROM auth_signing_keys ORDER BY created_at DESC",
  );
  return { keys: rows.map((row) => row.public_jwk) };
}

export type AccessTokenClaims = {
  userId: string;
  sessionId: string;
  organizationId?: string;
  role?: string;
  entitlements: string[];
  email?: string;
};

export async function signAccessToken(
  claims: AccessTokenClaims,
): Promise<{ token: string; expiresAt: number }> {
  const { kid, privateKey } = await getSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    sid: claims.sessionId,
    entitlements: claims.entitlements,
    ...(claims.organizationId && { org_id: claims.organizationId }),
    ...(claims.role && { role: claims.role }),
    ...(claims.email && { email: claims.email }),
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(getIssuer())
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
  return { token, expiresAt };
}
