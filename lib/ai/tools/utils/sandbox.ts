import {
  CloudAcquisitionTimeoutError,
  type ReportCloudAcquisitionStage,
} from "./cloud-acquisition-budget";
import {
  DockerEngineError,
  ensureUserSandbox,
  type Sandbox,
} from "@/lib/sandbox/docker";
import type { SandboxBootInfo, SandboxContext } from "@/types";
import {
  classifySandboxError,
  getUserFacingSandboxErrorMessage,
} from "./sandbox-errors";

export {
  SANDBOX_LEASE_HEARTBEAT_INTERVAL_MS,
  SANDBOX_LEASE_REQUEST_TIMEOUT_MS,
  refreshSandboxLease,
  refreshSandboxLeaseBestEffort,
  releaseSandboxIdleLeaseBestEffort,
  startSandboxLeaseHeartbeat,
  withSandboxLeaseHeartbeat,
} from "./sandbox-lease";

type SandboxReadyPath = SandboxBootInfo["path"];
type AcquisitionPhase = "connect" | "create";

export class SandboxAcquisitionError extends Error {
  constructor(
    message: string,
    readonly diagnostics: {
      sandbox_phase: AcquisitionPhase;
      sandbox_error_category: ReturnType<typeof classifySandboxError>;
      sandbox_http_status?: number;
    },
  ) {
    super(message);
    this.name = "SandboxAcquisitionError";
  }
}

/**
 * Ensures the user's Docker sandbox exists and is running.
 *
 * The container is created on first use and restarted when its idle lease
 * lapsed. The workspace lives in a per-user volume, so neither path loses
 * files.
 */
export const ensureSandboxConnection = async (
  context: SandboxContext,
  options: {
    signal?: AbortSignal;
    reportStage?: ReportCloudAcquisitionStage;
    initialSandbox?: Sandbox | null;
  } = {},
): Promise<{ sandbox: Sandbox }> => {
  const { userID, setSandbox, onBoot } = context;
  const { initialSandbox, signal } = options;
  signal?.throwIfAborted();

  if (initialSandbox) return { sandbox: initialSandbox };

  const startedAt = performance.now();
  let phase: AcquisitionPhase = "connect";
  try {
    options.reportStage?.("connect");
    const { sandbox, created } = await ensureUserSandbox(userID);
    signal?.throwIfAborted();
    const path: SandboxReadyPath = created ? "create_fresh" : "reuse_existing";
    if (created) phase = "create";
    setSandbox(sandbox);
    onBoot?.({
      path,
      duration_ms: Math.round(performance.now() - startedAt),
      create_attempts: created ? 1 : 0,
    });
    return { sandbox };
  } catch (error) {
    signal?.throwIfAborted();
    const status =
      error instanceof DockerEngineError ? error.statusCode : undefined;
    const diagnostics = {
      sandbox_phase: phase,
      sandbox_error_category: classifySandboxError(error),
      ...(typeof status === "number" ? { sandbox_http_status: status } : {}),
    };
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "sandbox_acquisition_failed",
        service: "agent-worker",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        user_id: userID,
        ...diagnostics,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Math.round(performance.now() - startedAt),
      }),
    );
    if (error instanceof CloudAcquisitionTimeoutError) throw error;
    throw new SandboxAcquisitionError(
      getUserFacingSandboxErrorMessage(error) ??
        "Sandbox is temporarily unavailable. Please retry shortly.",
      diagnostics,
    );
  }
};
