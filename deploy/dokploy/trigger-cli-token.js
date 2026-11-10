"use strict";
// Registers TRIGGER_CLI_TOKEN as a personal access token of the bootstrap user.
// Runs inside the Trigger image: tokens are stored AES-256-GCM encrypted with
// the webapp's ENCRYPTION_KEY and looked up by their SHA-256 hash.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const token = process.env.TRIGGER_CLI_TOKEN || "";
if (!token) {
  console.log("[trigger-cli-token] TRIGGER_CLI_TOKEN not set; skipping");
  process.exit(0);
}
if (!/^tr_pat_[A-Za-z0-9]{20,}$/.test(token)) {
  console.error(
    "[trigger-cli-token] TRIGGER_CLI_TOKEN must look like tr_pat_<alphanumeric>",
  );
  process.exit(1);
}

// The image ships `pg` inside pnpm's store; resolve it without pinning a version.
function loadPg() {
  const store = "/triggerdotdev/node_modules/.pnpm";
  const dir = fs.readdirSync(store).find((name) => name.startsWith("pg@"));
  if (!dir) throw new Error("pg not found in the Trigger image");
  return createRequire(
    path.join(store, dir, "node_modules", "pg", "package.json"),
  )("pg");
}

async function main() {
  const { Client } = loadPg();
  const key = process.env.ENCRYPTION_KEY;
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = cipher.update(token, "utf8", "hex") + cipher.final("hex");
  const encrypted = {
    nonce: nonce.toString("hex"),
    ciphertext,
    tag: cipher.getAuthTag().toString("hex"),
  };
  const hashed = crypto.createHash("sha256").update(token).digest("hex");
  const body = token.slice("tr_pat_".length);
  const obfuscated =
    "tr_pat_" + body.slice(0, 4) + "*".repeat(18) + body.slice(-4);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const email = process.env.TRIGGER_BOOTSTRAP_EMAIL;
    const user = await client.query(
      'select id from "User" where lower(email) = lower($1) limit 1',
      [email],
    );
    if (user.rowCount === 0) {
      throw new Error("bootstrap user " + email + " does not exist");
    }
    await client.query(
      'insert into "PersonalAccessToken" (id, name, "userId", "updatedAt", "obfuscatedToken", "encryptedToken", "hashedToken") ' +
        "values ($1, 'HackerAI CLI', $2, now(), $3, $4::jsonb, $5) " +
        'on conflict ("hashedToken") do update set "revokedAt" = null, "encryptedToken" = excluded."encryptedToken"',
      [
        "ha_pat_" + crypto.randomBytes(12).toString("hex"),
        user.rows[0].id,
        obfuscated,
        JSON.stringify(encrypted),
        hashed,
      ],
    );
    console.log("[trigger-cli-token] CLI token registered");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[trigger-cli-token]", error.message);
  process.exit(1);
});
