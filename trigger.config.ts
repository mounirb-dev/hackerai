import { config } from "dotenv";
import { defineConfig } from "@trigger.dev/sdk";
import { additionalPackages } from "@trigger.dev/build/extensions/core";
import packageJson from "./package.json";

if (process.env.NODE_ENV !== "production") {
  config({ path: ".env.local" });
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID!,
  // centrifuge-js relies on globalThis.WebSocket, which is only stable on
  // Node 22+. The default "node" runtime is older and would throw
  // "WebSocket constructor not found" when CentrifugoSandbox connects.
  runtime: "node-22",
  logLevel: "log",
  // Default ceiling; agent-long overrides this with its own runtime budget
  // and reserves time for cleanup before Trigger.dev stops the worker.
  maxDuration: 4 * 60 * 60,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./trigger"],
  build: {
    autoDetectExternal: true,
    keepNames: true,
    minify: false,
    // Native modules that must be installed at deploy time, not bundled.
    external: ["node-pty", "sharp"],
    extensions: [
      additionalPackages({
        // AI SDK's guarded download uses createRequire("undici"), which the
        // bundler cannot discover. Install the same pinned version as the app.
        packages: [
          "node-pty",
          "sharp",
          `undici@${packageJson.dependencies.undici}`,
        ],
      }),
    ],
  },
});
