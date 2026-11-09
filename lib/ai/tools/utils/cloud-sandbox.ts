import type { ReportCloudAcquisitionStage } from "./cloud-acquisition-budget";
import type { AnySandbox, SandboxBootInfo, SubscriptionTier } from "@/types";
import { randomUUID } from "node:crypto";
import { destroyUserSandbox, type Sandbox } from "@/lib/sandbox/docker";
import type {
  CloudSandboxProvider,
  CloudSandboxSelectionReason,
} from "./cloud-sandbox-provider";
import { ensureSandboxConnection, SandboxAcquisitionError } from "./sandbox";
import { isCloudSandbox } from "./sandbox-types";
import { phLogger } from "@/lib/posthog/server";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";

export type CloudSandboxAcquisitionContext = {
  signal?: AbortSignal;
  onTimeout?: () => void;
  onFailure?: () => void;
  acquisitionId?: string;
  provider?: CloudSandboxProvider;
  selectionReason?: CloudSandboxSelectionReason;
  subscription?: SubscriptionTier;
  chatId?: string;
  triggerRunId?: string;
  runKind?: "parent" | "subagent";
  triggerRegion?: TriggerRunRegion;
  environment?: string;
};

export async function ensureCloudSandboxConnection(options: {
  reportStage?: ReportCloudAcquisitionStage;
  userId: string;
  signal?: AbortSignal;
  initialSandbox?: AnySandbox | null;
  setSandbox: (sandbox: AnySandbox) => void;
  onBoot?: (info: SandboxBootInfo) => void;
  context?: CloudSandboxAcquisitionContext;
}): Promise<{ sandbox: Sandbox; provider: CloudSandboxProvider }> {
  const startedAt = Date.now();
  const acquisitionId = randomUUID();
  let bootInfo: SandboxBootInfo | undefined;
  const selectionReason = options.context?.selectionReason ?? "docker_only";
  const recordOutcome = (outcome: "success" | "error") => {
    const fields = {
      chat_id: options.context?.chatId,
      trigger_run_id: options.context?.triggerRunId,
      acquisition_id: acquisitionId,
      agent_run_kind: options.context?.runKind ?? "parent",
      subscription_tier: options.context?.subscription,
      preferred_provider: "docker",
      provider_selection_reason: selectionReason,
      sandbox_provider: "docker",
      sandbox_type: "cloud",
      outcome,
      fallback_used: false,
      duration_ms: Date.now() - startedAt,
      sandbox_boot_path: bootInfo?.path,
      image_version: bootInfo?.image_version,
      sandbox_create_attempts: bootInfo?.create_attempts,
      cloud_sandbox_acquisition_completed_event_version: 1,
    };
    if (outcome === "error")
      console.warn("Cloud sandbox acquisition completed", fields);
    else console.info("Cloud sandbox acquisition completed", fields);
    phLogger.event("cloud_sandbox_acquisition_completed", {
      ...fields,
      userId: options.userId,
    });
  };

  try {
    options.signal?.throwIfAborted();
    const result = await ensureSandboxConnection(
      {
        userID: options.userId,
        // Publish only after acquisition fully succeeded.
        setSandbox: () => {},
        onBoot: (info) => {
          bootInfo = info;
          options.onBoot?.(info);
        },
      },
      {
        signal: options.signal,
        reportStage: options.reportStage,
        initialSandbox:
          options.initialSandbox && isCloudSandbox(options.initialSandbox)
            ? options.initialSandbox
            : null,
      },
    );
    options.signal?.throwIfAborted();
    options.setSandbox(result.sandbox);
    recordOutcome("success");
    return { ...result, provider: "docker" };
  } catch (error) {
    try {
      options.context?.onFailure?.();
    } catch {
      /* A closed stream cannot mask the acquisition failure. */
    }
    recordOutcome("error");
    phLogger.event("cloud_sandbox_acquisition_failed", {
      userId: options.userId,
      chat_id: options.context?.chatId,
      trigger_run_id: options.context?.triggerRunId,
      acquisition_id: acquisitionId,
      provider: "docker",
      sandbox_type: "cloud",
      sandbox_provider: "docker",
      cloud_sandbox_transport: "docker_engine_api",
      subscription: options.context?.subscription,
      subscription_tier: options.context?.subscription,
      agent_run_kind: options.context?.runKind ?? "parent",
      failure_stage: "ensure_cloud_sandbox",
      duration_ms: Date.now() - startedAt,
      error_name: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof SandboxAcquisitionError ? error.diagnostics : {}),
      cloud_sandbox_acquisition_failed_event_version: 6,
    });
    throw error;
  }
}

/**
 * Remove the user's sandbox container and workspace volume. Irreversible: the
 * volume holds every file the user kept in the cloud workspace.
 */
export async function terminateCloudSandboxesForUser(
  userId: string,
  _options: { permanent?: boolean } = {},
): Promise<{ total: number; killed: number; alreadyGone: number }> {
  const { containerRemoved, volumeRemoved } = await destroyUserSandbox(userId);
  const total = containerRemoved || volumeRemoved ? 1 : 0;
  return {
    total,
    killed: total,
    alreadyGone: 0,
  };
}
