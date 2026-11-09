import { BrowserSessions } from "./utils/browser-sessions";
import { createBrowserHandoff } from "./browser-handoff";
import { createBrowserChallengeHandler } from "../captcha/browser-challenge";
import { createCaptchaJournal } from "../captcha/journal";
import { isCaptchaEligible, CAPTCHA_SOLVER_FLAG } from "../captcha/policy";
import { DefaultSandboxManager } from "./utils/sandbox-manager";
import {
  HybridSandboxManager,
  type SandboxPreference,
} from "./utils/hybrid-sandbox-manager";
import { TodoManager } from "./utils/todo-manager";
import { createRunTerminalCmd } from "./run-terminal-cmd";
import { createInteractTerminalSession } from "./interact-terminal-session";
import { createGetTerminalFiles } from "./get-terminal-files";
import { createFile, createFileEdit, createFileWrite } from "./file";
import { createWebSearch } from "./web-search";
import { createOpenUrlTool } from "./open-url";
import { createTodoWrite } from "./todo-write";
import {
  createCreateNote,
  createListNotes,
  createUpdateNote,
  createDeleteNote,
} from "./notes";
import {
  createCreateVulnerabilityReport,
  createListReports,
  createGetReport,
  createUpdateVulnerabilityReport,
} from "./findings";
// match tool removed — usage analytics showed it wasn't being used enough to justify
// the added complexity. The agent should use run_terminal_cmd with rg instead.
// import { createMatch } from "./match";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import type { Sandbox } from "@/lib/sandbox/docker";
import type {
  ChatMode,
  ToolContext,
  Todo,
  AnySandbox,
  AppendMetadataStreamFn,
  SubscriptionTier,
  SandboxBootInfo,
  ToolFailureLogger,
  AgentToolApprovalRequester,
  AgentActiveTimeMeasurer,
  SandboxManager,
} from "@/types";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import type { Geo } from "@vercel/functions";
import { FileAccumulator } from "./utils/file-accumulator";
import { BackgroundProcessTracker } from "./utils/background-process-tracker";
import { ptySessionManager } from "./utils/pty-session-manager";
import { createPtyParserLogBudget } from "./utils/pty-output-formatter";
import {
  getCloudSandboxProviderForInstance,
  isCloudSandbox,
} from "./utils/sandbox-types";
import { getSandboxWithFallbackGuard } from "./utils/sandbox-fallback";
import { createE2BResourcePressureObserver } from "@/lib/analytics/sandbox-resource-pressure";
import {
  phLogger,
  getPostHogBooleanFlagDecisionForUser,
} from "@/lib/posthog/server";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import type { CloudSandboxAcquisitionContext } from "./utils/cloud-sandbox";
import type {
  CloudSandboxProvider,
  CloudSandboxSelectionReason,
} from "./utils/cloud-sandbox-provider";
import {
  releaseSandboxIdleLeaseBestEffort,
  startSandboxLeaseHeartbeat,
  type SandboxLeaseHeartbeat,
} from "./utils/sandbox-lease";

export { isCloudSandbox };

export type CreateToolsRuntimePolicy = {
  signal?: AbortSignal;
  allowedToolNames?: readonly string[];
  additionalTools?: (context: ToolContext) => ToolSet;
  ptyScopeId?: string;
  chargeSandboxRuntime?: boolean;
  cloudSandboxProvider?: CloudSandboxProvider;
  cloudSandboxSelectionReason?: CloudSandboxSelectionReason;
  triggerRegion?: TriggerRunRegion;
  environment?: string;
  keepSandboxLeaseAliveForRun?: boolean;
  browserAgentId?: string;
  onBrowserOwnershipLost?: () => void;
};

export type SandboxSessionUsage = {
  totalCostDollars: number;
  sandboxRuntimeMs: number;
  sandboxCostDollars: number;
};

// Self-hosted containers carry no per-second provider charge.
const SANDBOX_COST_PER_MS = 0;

const emptySandboxRuntimeMs = (): Record<CloudSandboxProvider, number> => ({
  docker: 0,
});

// Factory function to create tools with context
export const createTools = (
  userID: string,
  chatId: string,
  writer: UIMessageStreamWriter,
  mode: ChatMode = "agent",
  userLocation: Geo,
  initialTodos?: Todo[],
  notesEnabled: boolean = true,
  assistantMessageId?: string,
  sandboxPreference?: SandboxPreference,
  serviceKey?: string,
  appendMetadataStream?: AppendMetadataStreamFn,
  onToolCost?: (costDollars: number) => void,
  subscription?: SubscriptionTier,
  onSandboxBoot?: (info: SandboxBootInfo) => void,
  modelName?: string,
  onToolFailure?: ToolFailureLogger,
  requestToolApproval?: AgentToolApprovalRequester,
  autoReviewEvidenceEnabled?: boolean,
  measureAgentActiveTime?: AgentActiveTimeMeasurer,
  workingDirectory?: string,
  triggerRunId?: string,
  auxiliaryVision?: ToolContext["auxiliaryVision"],
  runtimePolicy: CreateToolsRuntimePolicy = {},
) => {
  let sandbox: AnySandbox | null = null;
  let sandboxCostSegmentStartedAt: number | null = null;
  let sandboxCostProvider: CloudSandboxProvider | null = null;
  const sandboxAccumulatedRuntimeMs = emptySandboxRuntimeMs();
  let providerSelectionRecorded = false;
  let sandboxBootInfo: SandboxBootInfo | null = null;
  let lastCloudSandbox: Sandbox | null = null;
  let runLeaseHeartbeat: SandboxLeaseHeartbeat | null = null;
  let currentModelName = modelName;
  let sandboxOperationQueue: Promise<void> = Promise.resolve();
  let pendingSandbox: Promise<AnySandbox> | null = null;

  const recordSandboxBoot = (info: SandboxBootInfo) => {
    sandboxBootInfo = info;
    onSandboxBoot?.(info);
  };

  const cloudSandboxContext: CloudSandboxAcquisitionContext = {
    signal: runtimePolicy.signal,
    onTimeout: () =>
      writer.write({
        type: "data-cloud-connection-error",
        data: { code: "timeout", workspacePreserved: true },
      }),
    onFailure: () =>
      writer.write({
        type: "data-cloud-connection-error",
        data: { code: "unavailable", workspacePreserved: true },
      }),
    provider: runtimePolicy.cloudSandboxProvider,
    selectionReason: runtimePolicy.cloudSandboxSelectionReason,
    subscription,
    chatId,
    triggerRunId,
    triggerRegion: runtimePolicy.triggerRegion,
    environment: runtimePolicy.environment,
    runKind:
      runtimePolicy.chargeSandboxRuntime === false ? "subagent" : "parent",
  };

  const trackSandboxUsage = (newSandbox: AnySandbox) => {
    sandbox = newSandbox;
    const provider = getCloudSandboxProviderForInstance(newSandbox);
    if (isCloudSandbox(newSandbox)) {
      lastCloudSandbox = newSandbox;
      if (runtimePolicy.keepSandboxLeaseAliveForRun && !runLeaseHeartbeat) {
        runLeaseHeartbeat = startSandboxLeaseHeartbeat(
          () => lastCloudSandbox,
          "run_heartbeat",
        );
      }
    }
    const now = performance.now();
    if (
      sandboxCostSegmentStartedAt !== null &&
      sandboxCostProvider !== null &&
      sandboxCostProvider !== provider
    ) {
      sandboxAccumulatedRuntimeMs[sandboxCostProvider] +=
        now - sandboxCostSegmentStartedAt;
      sandboxCostSegmentStartedAt = null;
    }
    if (provider !== null && sandboxCostSegmentStartedAt === null) {
      sandboxCostSegmentStartedAt = now;
    }
    sandboxCostProvider = provider;
    if (provider && !providerSelectionRecorded) {
      providerSelectionRecorded = true;
      phLogger.event("cloud_sandbox_provider_selected", {
        userId: userID,
        chat_id: chatId,
        trigger_run_id: triggerRunId,
        provider,
        sandbox_type: "cloud",
        sandbox_provider: provider,
        provider_selection_reason:
          runtimePolicy.cloudSandboxSelectionReason ?? "docker_only",
        cloud_sandbox_transport: "docker_engine_api",
        subscription,
        subscription_tier: subscription,
        agent_run_kind: cloudSandboxContext.runKind,
        trigger_region: cloudSandboxContext.triggerRegion,
        sandbox_boot_path: sandboxBootInfo?.path,
        sandbox_acquisition_duration_ms: sandboxBootInfo?.duration_ms,
        sandbox_create_attempts: sandboxBootInfo?.create_attempts,
        image_version:
          process.env.DOCKER_SANDBOX_IMAGE ?? "hackerai/sandbox:latest",
        cloud_sandbox_provider_event_version: 8,
      });
    }
  };

  // Cloud protection: free agent users must use a user-owned execution host.
  if (subscription === "free" && isAgentMode(mode)) {
    if (!sandboxPreference || sandboxPreference === "e2b") {
      throw new Error(
        "Free agent mode requires a local sandbox. Cloud sandboxes are not available on the free plan.",
      );
    }
  }

  // Use HybridSandboxManager if sandboxPreference and serviceKey are provided
  const sandboxManager: SandboxManager =
    sandboxPreference && serviceKey
      ? new HybridSandboxManager(
          userID,
          trackSandboxUsage,
          sandboxPreference,
          serviceKey,
          isCloudSandbox(sandbox) ? sandbox : null,
          subscription,
          recordSandboxBoot,
          workingDirectory,
          triggerRunId,
          chatId,
          cloudSandboxContext,
        )
      : new DefaultSandboxManager(
          userID,
          trackSandboxUsage,
          isCloudSandbox(sandbox) ? sandbox : null,
          recordSandboxBoot,
          cloudSandboxContext,
        );

  const todoManager = new TodoManager(initialTodos);
  const fileAccumulator = new FileAccumulator();
  const backgroundProcessTracker = new BackgroundProcessTracker();
  const onSandboxResourceMetrics = createE2BResourcePressureObserver({
    userId: userID,
    chatId,
    ptyScopeId: runtimePolicy.ptyScopeId,
    mode,
    subscription,
    triggerRunId,
  });

  // Pin preparation for this run so a rollout change cannot switch an existing
  // connected browser into a different namespace. Paid requests recheck the flag.
  let captchaPreparationDecision: Promise<boolean> | undefined;
  const captchaPreparationEnabled = (): Promise<boolean> => {
    if (
      !serviceKey ||
      requestToolApproval ||
      (runtimePolicy.browserAgentId ?? "parent") !== "parent" ||
      !isCaptchaEligible(runtimePolicy.environment)
    )
      return Promise.resolve(false);
    return (captchaPreparationDecision ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return (
          (await Promise.race([
            getPostHogBooleanFlagDecisionForUser(
              CAPTCHA_SOLVER_FLAG,
              userID,
              undefined,
              { sendFeatureFlagEvents: false },
            ),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), 1000);
            }),
          ])) === true
        );
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    })());
  };

  const browserSessions = triggerRunId
    ? new BrowserSessions(
        serviceKey
          ? {
              userId: userID,
              chatId,
              runId: triggerRunId,
              agentId: runtimePolicy.browserAgentId ?? "parent",
              triggerRegion: runtimePolicy.triggerRegion,
              serviceKey,
            }
          : undefined,
        runtimePolicy.onBrowserOwnershipLost,
        captchaPreparationEnabled,
        {
          enabled: async () =>
            runtimePolicy.environment === "PREVIEW" &&
            !!process.env.TWOCAPTCHA_API_KEY &&
            (await captchaPreparationEnabled()),
        },
      )
    : undefined;
  const context: ToolContext = {
    browserSessions,
    sandboxManager,
    writer,
    userLocation,
    todoManager,
    userID,
    chatId,
    ptyScopeId: runtimePolicy.ptyScopeId,
    assistantMessageId,
    triggerRunId,
    triggerRegion: runtimePolicy.triggerRegion,
    fileAccumulator,
    backgroundProcessTracker,
    ptySessionManager,
    ptyParserLogBudget: createPtyParserLogBudget(),
    mode,
    modelName,
    getCurrentModelName: () => currentModelName,
    subscription,
    isCloudSandbox,
    appendMetadataStream,
    onToolCost,
    onToolFailure,
    requestToolApproval,
    autoReviewEvidenceEnabled,
    measureAgentActiveTime,
    onSandboxResourceMetrics,
    auxiliaryVision,
  };

  // Keep attempt accounting across model fallback/schema rebuilds in this run.
  const checkBrowserChallenge =
    browserSessions &&
    serviceKey &&
    triggerRunId &&
    !requestToolApproval &&
    (runtimePolicy.browserAgentId ?? "parent") === "parent" &&
    isCaptchaEligible(runtimePolicy.environment)
      ? createBrowserChallengeHandler(
          context,
          runtimePolicy.environment,
          runtimePolicy.signal,
          undefined,
          createCaptchaJournal({
            serviceKey,
            userId: userID,
            chatId,
            runId: triggerRunId,
          }),
        )
      : undefined;
  context.checkBrowserChallenge = checkBrowserChallenge?.inspect;
  context.requestBrowserChallenge = checkBrowserChallenge?.request;

  const buildTools = (): ToolSet => {
    // Create all available tools. This is intentionally a factory rather than a
    // one-time object so model-specific tool schemas can be rebuilt for
    // provider fallback legs.
    const allTools = {
      ...(browserSessions && {
        browser_handoff: createBrowserHandoff(
          browserSessions,
          runtimePolicy.signal,
        ),
      }),
      run_terminal_cmd: createRunTerminalCmd(context),
      interact_terminal_session: createInteractTerminalSession(context),
      get_terminal_files: createGetTerminalFiles(context),
      file: createFile(context),
      file_edit: createFileEdit(context),
      file_write: createFileWrite(context),
      todo_write: createTodoWrite(context),
      create_vulnerability_report: createCreateVulnerabilityReport(
        context,
        () => sandbox,
      ),
      list_reports: createListReports(context),
      get_report: createGetReport(context),
      update_vulnerability_report: createUpdateVulnerabilityReport(
        context,
        () => sandbox,
      ),
      ...(notesEnabled && {
        create_note: createCreateNote(context),
        list_notes: createListNotes(context),
        update_note: createUpdateNote(context),
        delete_note: createDeleteNote(context),
      }),
      ...(process.env.PERPLEXITY_API_KEY && {
        web_search: createWebSearch(context),
      }),
      ...(process.env.JINA_API_KEY && {
        open_url: createOpenUrlTool(context),
      }),
      ...(runtimePolicy.additionalTools?.(context) ?? {}),
    };

    const guardedTools = browserSessions
      ? browserSessions.guardTools(allTools, runtimePolicy.signal)
      : allTools;

    if (runtimePolicy.allowedToolNames) {
      const allowed = new Set(runtimePolicy.allowedToolNames);
      return Object.fromEntries(
        Object.entries(guardedTools).filter(([name]) => allowed.has(name)),
      ) as ToolSet;
    }

    // Filter tools based on mode
    return mode === "ask"
      ? {
          ...(notesEnabled && {
            create_note: allTools.create_note,
            list_notes: allTools.list_notes,
            update_note: allTools.update_note,
            delete_note: allTools.delete_note,
          }),
          ...(process.env.PERPLEXITY_API_KEY && {
            web_search: createWebSearch(context),
          }),
          ...(process.env.JINA_API_KEY && {
            open_url: createOpenUrlTool(context),
          }),
        }
      : guardedTools;
  };

  const tools = buildTools();

  const getSandbox = () => sandbox;
  const ensureSandbox = async (options?: {
    refresh?: boolean;
    reason?: string;
    excludeConnectionId?: string;
  }) => {
    const recoveryRequested = Boolean(
      options?.refresh || options?.excludeConnectionId,
    );
    if (!recoveryRequested && pendingSandbox) return pendingSandbox;

    const operation = sandboxOperationQueue.then(async () => {
      if (options?.excludeConnectionId) {
        // Serialize quarantine/reset with every acquisition so a promise that
        // began before recovery cannot repopulate the manager afterward.
        await sandboxManager.quarantineLocalConnection?.(
          options.excludeConnectionId,
          "command_unresponsive",
        );
      }
      if (options?.refresh) {
        await sandboxManager.resetSandbox?.(options.reason);
      }
      const { sandbox: ensured } = await getSandboxWithFallbackGuard({
        sandboxManager,
      });
      return ensured;
    });
    sandboxOperationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    pendingSandbox = operation;
    void operation.then(
      () => {
        if (pendingSandbox === operation) pendingSandbox = null;
      },
      () => {
        if (pendingSandbox === operation) pendingSandbox = null;
      },
    );
    return operation;
  };
  const getTodoManager = () => todoManager;
  const getFileAccumulator = () => fileAccumulator;
  const setCurrentModelName = (nextModelName: string | undefined) => {
    currentModelName = nextModelName;
  };

  const getToolsForModel = (nextModelName: string | undefined) => {
    setCurrentModelName(nextModelName);
    return buildTools();
  };

  const getSandboxSessionUsage = async (): Promise<SandboxSessionUsage> => {
    if (runtimePolicy.chargeSandboxRuntime === false) {
      return {
        totalCostDollars: 0,
        sandboxRuntimeMs: 0,
        sandboxCostDollars: 0,
      };
    }

    const runtimeMs = { ...sandboxAccumulatedRuntimeMs };
    if (sandboxCostSegmentStartedAt !== null && sandboxCostProvider !== null) {
      runtimeMs[sandboxCostProvider] +=
        performance.now() - sandboxCostSegmentStartedAt;
    }
    const sandboxCostDollars = runtimeMs.docker * SANDBOX_COST_PER_MS;
    return {
      totalCostDollars: sandboxCostDollars,
      sandboxRuntimeMs: runtimeMs.docker,
      sandboxCostDollars,
    };
  };

  const getSandboxSessionCost = async (): Promise<number> => {
    return (await getSandboxSessionUsage()).totalCostDollars;
  };

  const releaseSandboxIdleLease = async (): Promise<boolean> => {
    if (!lastCloudSandbox) return false;
    return releaseSandboxIdleLeaseBestEffort(lastCloudSandbox);
  };

  const stopSandboxRunLeaseHeartbeat = async (): Promise<void> => {
    const heartbeat = runLeaseHeartbeat;
    runLeaseHeartbeat = null;
    await heartbeat?.stop();
  };

  return {
    getCaptchaReceiptPrompt: () =>
      checkBrowserChallenge?.getReceiptPrompt() ?? "",
    tools,
    canRecoverBrowserHandoff: (signal?: AbortSignal) =>
      browserSessions?.canRecoverHumanHandoff(signal ?? runtimePolicy.signal) ??
      Promise.resolve(false),
    waitForBrowserHandoff: (signal?: AbortSignal) =>
      browserSessions?.waitForAgentControl(signal ?? runtimePolicy.signal) ??
      Promise.resolve(false),
    getBrowserHandoffNotes: () =>
      browserSessions?.getExitNotes(runtimePolicy.signal) ??
      Promise.resolve([]),
    cleanupBrowserSessions: () =>
      browserSessions?.cleanup() ?? Promise.resolve(),
    getSandbox,
    ensureSandbox,
    getTodoManager,
    getFileAccumulator,
    sandboxManager,
    getSandboxSessionCost,
    getSandboxSessionUsage,
    releaseSandboxIdleLease,
    stopSandboxRunLeaseHeartbeat,
    setCurrentModelName,
    getToolsForModel,
  };
};

// Re-export types for external use
export type { SandboxPreference };
