import type { Sandbox } from "@/lib/sandbox/docker";
import { readSandboxConfig } from "@/lib/sandbox/docker";

/**
 * Idle lease for self-hosted sandbox containers.
 *
 * The container stops itself once its lease lapses (see the provisioner's init
 * loop); the workspace volume survives and the next acquisition restarts it.
 * `SANDBOX_IDLE_TIMEOUT_SECONDS=0` keeps containers running, so leases become
 * no-ops.
 */

export const SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;
export const SANDBOX_LEASE_REQUEST_TIMEOUT_MS = 5 * 1000;

/** Lease granted while a run is active or a tool has just used the sandbox. */
export const getSandboxLeaseMs = (): number =>
  readSandboxConfig().idleSeconds * 1000;

/** Lease left after a parent run settles. */
export const getSandboxIdleReleaseMs = (): number => {
  const configured = Number(process.env.SANDBOX_IDLE_RELEASE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured * 1000
    : getSandboxLeaseMs();
};

export type SandboxLeaseRefreshSource =
  | "foreground_heartbeat"
  | "run_heartbeat"
  | "default_manager_cache"
  | "hybrid_manager_cache";

const logLeaseFailure = (
  event: string,
  sandbox: Sandbox,
  error: unknown,
  source?: SandboxLeaseRefreshSource,
): void => {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event,
      service: "chat-handler",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
      sandbox_id: sandbox.sandboxId,
      sandbox_type: "cloud",
      sandbox_provider: "docker",
      ...(source && { source }),
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

export const refreshSandboxLease = async (
  sandbox: Sandbox,
): Promise<number> => {
  const leaseMs = getSandboxLeaseMs();
  if (leaseMs > 0) {
    await sandbox.setTimeout(leaseMs, {
      requestTimeoutMs: SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
    });
  }
  return leaseMs;
};

export const refreshSandboxLeaseBestEffort = async (
  sandbox: Sandbox,
  options: { source: SandboxLeaseRefreshSource; logFailure?: boolean },
): Promise<boolean> => {
  try {
    await refreshSandboxLease(sandbox);
    return true;
  } catch (error) {
    if (options.logFailure !== false) {
      logLeaseFailure(
        "sandbox_lease_refresh_failed",
        sandbox,
        error,
        options.source,
      );
    }
    return false;
  }
};

/** Shorten the lease after a parent run settles. */
export const releaseSandboxIdleLeaseBestEffort = async (
  sandbox: Sandbox,
): Promise<boolean> => {
  const releaseMs = getSandboxIdleReleaseMs();
  if (releaseMs <= 0) return true;
  try {
    await sandbox.setTimeout(releaseMs, {
      requestTimeoutMs: SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    logLeaseFailure("sandbox_idle_lease_release_failed", sandbox, error);
    return false;
  }
};

export type SandboxLeaseHeartbeat = {
  stop: () => Promise<void>;
};

/**
 * Starts a renewable lease heartbeat and returns an async stop operation that
 * waits for any refresh already in flight, preventing cleanup ordering races.
 */
export const startSandboxLeaseHeartbeat = (
  getSandbox: () => Sandbox | null,
  source: Extract<
    SandboxLeaseRefreshSource,
    "foreground_heartbeat" | "run_heartbeat"
  >,
): SandboxLeaseHeartbeat => {
  let refreshInFlight: Promise<void> | null = null;
  let heartbeatFailureLogged = false;
  const refresh = (): void => {
    if (refreshInFlight) return;
    const sandbox = getSandbox();
    if (!sandbox) return;

    const refreshPromise = (async () => {
      const refreshed = await refreshSandboxLeaseBestEffort(sandbox, {
        source,
        logFailure: !heartbeatFailureLogged,
      });
      heartbeatFailureLogged = !refreshed;
    })();
    refreshInFlight = refreshPromise;
    void refreshPromise.finally(() => {
      if (refreshInFlight === refreshPromise) refreshInFlight = null;
    });
  };

  const heartbeat = setInterval(refresh, SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS);
  (
    heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }
  ).unref?.();

  return {
    stop: async () => {
      clearInterval(heartbeat);
      await refreshInFlight;
    },
  };
};

/** Keeps the lease renewable for exactly the lifetime of one operation. */
export const withSandboxLeaseHeartbeat = async <T>(
  sandbox: Sandbox,
  operation: () => Promise<T>,
): Promise<T> => {
  const heartbeat = startSandboxLeaseHeartbeat(
    () => sandbox,
    "foreground_heartbeat",
  );
  try {
    return await operation();
  } finally {
    await heartbeat.stop();
  }
};
