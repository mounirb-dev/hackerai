/**
 * Cloud sandbox PTY adapter.
 *
 * Wraps the cloud SDK's callback-style `sandbox.pty.create({onData, cols, rows, ...})`
 * into a listener-set based handle that higher-level code (PtySessionManager,
 * run_terminal_cmd action dispatch) can consume without thinking about SDK
 * internals. Every byte chunk emitted by the SDK fans out to all subscribed
 * listeners; `exited` is a single memoized promise resolved from the SDK
 * handle's `wait()`.
 */

import type { Sandbox } from "@/lib/sandbox/docker";

// ── Narrow structural types over the cloud SDK surface we actually touch ─
// Prevents `any` leakage and keeps the adapter resilient to SDK churn.

type PtyDataCb = (data: Uint8Array) => void | Promise<void>;

interface CloudPtyCreateOpts {
  cols: number;
  rows: number;
  onData: PtyDataCb;
  user: "root";
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
}

interface CloudCommandHandle {
  readonly pid: number;
  wait(opts?: {
    timeoutMs?: number;
  }): Promise<{ exitCode: number | null | undefined }>;
}

interface CloudPtyModule {
  create(opts: CloudPtyCreateOpts): Promise<CloudCommandHandle>;
  sendInput(pid: number, data: Uint8Array): Promise<void>;
  resize(pid: number, size: { cols: number; rows: number }): Promise<void>;
  kill(pid: number): Promise<boolean>;
}

interface SandboxWithPty {
  pty: CloudPtyModule;
}

// ── Public contract ─────────────────────────────────────────────────

export interface PtyHandle {
  readonly pid: number;
  sendInput(bytes: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  /** Returns an unsubscribe function. */
  onData(cb: (bytes: Uint8Array) => void): () => void;
  readonly exited: Promise<{ exitCode: number | null }>;
}

export interface CreatePtyOptions {
  cols: number;
  rows: number;
  cwd?: string;
  envs?: Record<string, string>;
}

// ── Implementation ──────────────────────────────────────────────────

const LOG_PREFIX = "[e2b-pty-adapter]";

// Disable the SDK's per-RPC deadline. Lifetime is owned by PtySessionManager
// (idle + max-lifetime timers). Without this, the default RPC timeout (~60s)
// rejects pty.create / handle.wait while the process is still healthy in the
// sandbox, leaving the manager to mark the session as exitedNaturally.
const PTY_NO_TIMEOUT_MS = 0;

export async function createSandboxPtyHandle(
  sandbox: Sandbox,
  opts: CreatePtyOptions,
): Promise<PtyHandle> {
  const pty = (sandbox as unknown as SandboxWithPty).pty;

  const listeners = new Set<(bytes: Uint8Array) => void>();

  const onData: PtyDataCb = (data) => {
    // Snapshot to tolerate listener churn (unsubscribe during iteration).
    const snapshot = Array.from(listeners);
    for (const listener of snapshot) {
      try {
        listener(data);
      } catch (err) {
        console.error(`${LOG_PREFIX} listener threw:`, err);
      }
    }
  };

  const handle = await pty.create({
    cols: opts.cols,
    rows: opts.rows,
    // Match commands.run: managed browser directories are private to root.
    // The default PTY user cannot access them and may launch an untracked browser.
    user: "root",
    cwd: opts.cwd ?? "/home/user",
    envs: opts.envs,
    onData,
    timeoutMs: PTY_NO_TIMEOUT_MS,
  });

  const pid = handle.pid;

  // Kick off wait() immediately so `exited` resolves exactly once and all
  // consumers share the same resolution. Any rejection is normalized to
  // {exitCode: null} with a structured log — the error is surfaced, not
  // swallowed silently.
  const exited: Promise<{ exitCode: number | null }> = handle
    .wait({ timeoutMs: PTY_NO_TIMEOUT_MS })
    .then((result) => ({
      exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
    }))
    .catch((err: unknown) => {
      console.error(`${LOG_PREFIX} pty wait() rejected for pid=${pid}:`, err);
      return { exitCode: null };
    });

  return {
    pid,
    sendInput(bytes: Uint8Array): Promise<void> {
      return pty.sendInput(pid, bytes);
    },
    async resize(cols: number, rows: number): Promise<void> {
      await pty.resize(pid, { cols, rows });
    },
    async kill(): Promise<void> {
      // The SDK's `pty.kill` returns a boolean — `false` when the PTY was not
      // found (already exited, wrong pid, torn-down sandbox). Surface that
      // as an error so callers don't see a silent success.
      const killed = await pty.kill(pid);
      if (!killed) {
        throw new Error(`Failed to kill PTY process: pid=${pid}`);
      }
    },
    onData(cb: (bytes: Uint8Array) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get exited() {
      return exited;
    },
  };
}
