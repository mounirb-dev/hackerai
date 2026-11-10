// One-shot setup job for the self-hosted stack (see docker-compose.yml):
//   1. Garage: single-node layout, access key, bucket, browser CORS.
//   2. Convex: environment variables, then `convex deploy` of ./convex.
// Every step is idempotent, so the job can run on each deploy.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

const env = (name, fallback) => {
  const value = process.env[name]?.trim() || fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};
const CONVEX_CLI = "node_modules/convex/bin/main.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, url, init) {
  for (let attempt = 1; attempt <= 90; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(2000);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

/** Garage wants `GK` + 24 hex chars and a 64 hex char secret. */
export function deriveS3Credentials(seed) {
  const digest = (label) =>
    createHash("sha256").update(`${label}:${seed}`).digest("hex");
  return {
    accessKeyId: `GK${digest("s3-access-key-id").slice(0, 24)}`,
    secretAccessKey: digest("s3-secret-access-key"),
  };
}

async function setupGarage({ bucket, region, credentials, appOrigin }) {
  const admin = env("GARAGE_ADMIN_URL", "http://garage:3903");
  const headers = {
    Authorization: `Bearer ${env("GARAGE_ADMIN_TOKEN")}`,
    "Content-Type": "application/json",
  };
  const call = async (method, path, body, okStatuses = []) => {
    const response = await fetch(`${admin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok && !okStatuses.includes(response.status)) {
      throw new Error(`Garage ${method} ${path}: ${response.status} ${text}`);
    }
    return { ok: response.ok, data: text ? JSON.parse(text) : null };
  };

  await waitFor("Garage", `${admin}/health`);

  const status = (await call("GET", "/v1/status")).data;
  const layout = (await call("GET", "/v1/layout")).data;
  if (!layout.roles?.some((role) => role.id === status.node)) {
    await call("POST", "/v1/layout", [
      {
        id: status.node,
        zone: "dc1",
        capacity: Number(env("GARAGE_CAPACITY_BYTES", "100000000000")),
        tags: [],
      },
    ]);
    await call("POST", "/v1/layout/apply", { version: layout.version + 1 });
    console.log("[setup] Garage layout applied");
  }

  const existingKey = await call(
    "GET",
    `/v1/key?id=${credentials.accessKeyId}`,
    undefined,
    [400, 404],
  );
  if (!existingKey.ok) {
    await call("POST", "/v1/key/import", {
      name: "hackerai",
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    });
    console.log("[setup] Garage access key imported");
  }

  let bucketInfo = await call(
    "GET",
    `/v1/bucket?globalAlias=${encodeURIComponent(bucket)}`,
    undefined,
    [400, 404],
  );
  if (!bucketInfo.ok) {
    bucketInfo = await call("POST", "/v1/bucket", { globalAlias: bucket });
    console.log(`[setup] Garage bucket ${bucket} created`);
  }
  await call("POST", "/v1/bucket/allow", {
    bucketId: bucketInfo.data.id,
    accessKeyId: credentials.accessKeyId,
    permissions: { read: true, write: true, owner: true },
  });

  // Browsers upload and download through presigned URLs on another origin.
  const s3 = new S3Client({
    endpoint: env("GARAGE_S3_URL", "http://garage:3900"),
    region,
    forcePathStyle: true,
    credentials,
  });
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [appOrigin],
            AllowedMethods: ["GET", "PUT", "POST", "HEAD", "DELETE"],
            AllowedHeaders: ["*"],
            ExposeHeaders: ["ETag"],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
  console.log("[setup] Garage CORS configured");
}

function convex(args, adminEnv) {
  const result = spawnSync(process.execPath, [CONVEX_CLI, ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...adminEnv },
  });
  if (result.status !== 0) {
    throw new Error(`convex ${args[0]} ${args[1] ?? ""} failed`);
  }
}

async function setupConvex({ bucket, region, credentials, appOrigin }) {
  const url = env("CONVEX_INTERNAL_URL", "http://convex:3210");
  await waitFor("Convex", `${url}/version`);

  const adminKey =
    process.env.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim() ||
    readFileSync(
      env("CONVEX_ADMIN_KEY_FILE", "/keys/admin_key"),
      "utf8",
    ).trim();
  const adminEnv = {
    CONVEX_SELF_HOSTED_URL: url,
    CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
  };

  const variables = {
    AUTH_ISSUER: env("AUTH_ISSUER", appOrigin),
    // Convex refuses to deploy while a variable read by auth.config.ts is unset.
    AUTH_JWKS_URL: env("AUTH_JWKS_URL", `${appOrigin}/.well-known/jwks.json`),
    AUTH_DATABASE_URL: env("AUTH_DATABASE_URL"),
    CONVEX_SERVICE_ROLE_KEY: env("CONVEX_SERVICE_ROLE_KEY"),
    AWS_S3_ENDPOINT: env("AWS_S3_ENDPOINT"),
    AWS_S3_REGION: region,
    AWS_S3_BUCKET_NAME: bucket,
    AWS_S3_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    // The WorkOS client is replaced by lib/selfhost; it only checks presence
    // (placeholders come from the compose file).
    WORKOS_API_KEY: env("WORKOS_API_KEY"),
    WORKOS_CLIENT_ID: env("WORKOS_CLIENT_ID"),
  };
  for (const [name, value] of Object.entries(variables)) {
    if (value === "") continue;
    // `--` keeps values that start with a dash from being parsed as flags.
    convex(["env", "set", "--", name, value], adminEnv);
  }

  convex(["deploy", "--typecheck", "disable"], adminEnv);
  console.log("[setup] Convex functions deployed");
}

async function main() {
  const appOrigin = env("NEXT_PUBLIC_BASE_URL").replace(/\/+$/, "");
  const shared = {
    appOrigin,
    bucket: env("AWS_S3_BUCKET_NAME", "hackerai"),
    region: env("AWS_S3_REGION", "us-east-1"),
    credentials: deriveS3Credentials(env("S3_SECRET_SEED")),
  };
  if (process.env.SKIP_GARAGE_SETUP !== "true") await setupGarage(shared);
  await setupConvex(shared);
}

main().catch((error) => {
  console.error("[setup] failed:", error.message);
  process.exit(1);
});
