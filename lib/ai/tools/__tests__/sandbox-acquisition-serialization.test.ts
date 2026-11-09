const mockGetSandboxWithFallbackGuard = jest.fn();
const mockResetSandbox = jest.fn();
const mockQuarantineLocalConnection = jest.fn();
const mockIsE2BSandbox = jest.fn();
const mockLoggerWarn = jest.fn();
let mockTrackSandboxUsage: ((sandbox: unknown) => void) | undefined;
const mockNetworkQuery = jest.fn();
const mockCaptchaSolve = jest.fn();
jest.mock("../../captcha/solver", () => ({
  createTwoCaptchaSolver: () => ({ solve: mockCaptchaSolve }),
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    query: mockNetworkQuery,
    mutation: jest.fn(async () => true),
  }),
}));

jest.mock("../run-terminal-cmd", () => ({
  createRunTerminalCmd: jest.fn((context) => ({
    execute: async (input: { action: string }) =>
      input.action === "inspect"
        ? context.checkBrowserChallenge?.(undefined, {
            sandbox: {},
            sessionName: "default",
          })
        : context.requestBrowserChallenge?.("solve", "default"),
  })),
}));
jest.mock("../interact-terminal-session", () => ({
  createInteractTerminalSession: jest.fn(() => ({})),
}));
jest.mock("../get-terminal-files", () => ({
  createGetTerminalFiles: jest.fn(() => ({})),
}));
jest.mock("../file", () => ({
  createFile: jest.fn(() => ({})),
  createFileEdit: jest.fn(() => ({})),
  createFileWrite: jest.fn(() => ({})),
}));
jest.mock("../web-search", () => ({ createWebSearch: jest.fn(() => ({})) }));
jest.mock("../open-url", () => ({ createOpenUrlTool: jest.fn(() => ({})) }));
jest.mock("../todo-write", () => ({ createTodoWrite: jest.fn(() => ({})) }));
jest.mock("../notes", () => ({
  createCreateNote: jest.fn(() => ({})),
  createListNotes: jest.fn(() => ({})),
  createUpdateNote: jest.fn(() => ({})),
  createDeleteNote: jest.fn(() => ({})),
}));

jest.mock("../utils/hybrid-sandbox-manager", () => ({
  HybridSandboxManager: jest
    .fn()
    .mockImplementation((_userId, trackSandboxUsage, preference) => {
      mockTrackSandboxUsage = trackSandboxUsage;
      return {
        getEffectivePreference: () => preference,
        resetSandbox: mockResetSandbox,
        quarantineLocalConnection: mockQuarantineLocalConnection,
      };
    }),
}));

jest.mock("../utils/sandbox-manager", () => ({
  DefaultSandboxManager: jest.fn(() => ({
    getEffectivePreference: () => "e2b",
  })),
}));

jest.mock("../utils/sandbox-types", () => ({
  isCloudSandbox: (...args: unknown[]) => mockIsE2BSandbox(...args),
  isCentrifugoSandbox: (...args: unknown[]) => !mockIsE2BSandbox(...args),
  getCloudSandboxProviderForInstance: (
    sandbox: { provider?: string } | null,
  ) => (sandbox?.provider === "docker" ? sandbox.provider : null),
}));

jest.mock("../utils/sandbox-fallback", () => ({
  getSandboxWithFallbackGuard: (...args: unknown[]) =>
    mockGetSandboxWithFallbackGuard(...args),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
  getPostHogBooleanFlagDecisionForUser: jest.fn(async () => true),
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

import { createTools } from "..";
import { createRunTerminalCmd } from "../run-terminal-cmd";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
// Self-hosted containers carry no per-second provider charge.
const SANDBOX_COST_PER_MS = 0;
import { BrowserSessions } from "../utils/browser-sessions";
import { DETECT_CHALLENGES_SCRIPT } from "../../captcha/detection";

describe("sandbox acquisition serialization", () => {
  it("retains the CAPTCHA attempt budget across provider fallback and excludes untrusted runtimes", async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,

      TWOCAPTCHA_API_KEY: "test-provider-key",
    };
    const evaluator = jest
      .spyOn(BrowserSessions.prototype, "getChallengeBrowser")
      .mockResolvedValue({
        identity: "owner:default",
        evaluate: async (script) =>
          script === DETECT_CHALLENGES_SCRIPT
            ? {
                url: "https://www.google.com/recaptcha/api2/demo",
                documentId: "1",
                interstitial: false,
                widgets: [
                  {
                    kind: "recaptcha_v2",
                    siteKey: "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
                    invisible: false,
                    observationId: "0123456789abcdef0123456789abcdef",
                    tokenPresent: false,
                  },
                ],
              }
            : { status: "token_delivered" },
      });
    mockCaptchaSolve.mockResolvedValue({
      token: "test-response",
      costDollars: 0.003,
    });
    try {
      const args: Parameters<typeof createTools> = [
        "user-1",
        "chat-1",
        {} as never,
        "agent",
        {} as never,
      ];
      args[9] = "service-key";
      args[20] = "run-1";
      args[22] = { environment: "PREVIEW" };
      const preview = createTools(...args);
      expect(preview.getCaptchaReceiptPrompt()).toBe("");
      expect(preview.tools.browser_challenge).toBeUndefined();
      await expect(
        preview.tools.run_terminal_cmd.execute!(
          { action: "inspect" },
          { toolCallId: "inspect", messages: [] },
        ),
      ).resolves.toMatchObject({ status: "solve_available" });
      expect(mockCaptchaSolve).not.toHaveBeenCalled();
      await expect(
        preview.tools.run_terminal_cmd.execute!(
          { action: "solve" },
          { toolCallId: "first", messages: [] },
        ),
      ).resolves.toMatchObject({ status: "token_delivered" });
      await expect(
        preview.getToolsForModel("fallback-model").run_terminal_cmd.execute!(
          { action: "solve" },
          { toolCallId: "fallback", messages: [] },
        ),
      ).resolves.toMatchObject({ status: "snapshot_required" });
      expect(mockCaptchaSolve).toHaveBeenCalledTimes(1);
      expect(preview.getCaptchaReceiptPrompt()).toContain("Provider: 2Captcha");
      expect(preview.getCaptchaReceiptPrompt()).toContain("0.003 USD");
      expect(createTools(...args).getCaptchaReceiptPrompt()).toBe("");
      args[22] = { environment: "DEVELOPMENT" };
      await expect(
        createTools(...args).tools.run_terminal_cmd.execute!(
          { action: "solve" },
          { toolCallId: "production", messages: [] },
        ),
      ).resolves.toBeUndefined();
      args[22] = { environment: "PREVIEW", browserAgentId: "child-1" };
      await expect(
        createTools(...args).tools.run_terminal_cmd.execute!(
          { action: "solve" },
          { toolCallId: "child", messages: [] },
        ),
      ).resolves.toBeUndefined();
    } finally {
      evaluator.mockRestore();
      process.env = originalEnv;
    }
  });
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getPostHogBooleanFlagDecisionForUser).mockResolvedValue(true);
    mockResetSandbox.mockResolvedValue(undefined);
    mockQuarantineLocalConnection.mockResolvedValue(undefined);
    mockIsE2BSandbox.mockReturnValue(false);
    mockTrackSandboxUsage = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    "flag off",
    "flag unavailable",
    "approval",
    "child",
    "untrusted",
    "Preview",
    "Production",
  ])(
    "gates connected browser preparation before touching its configuration: %s",
    async (variant) => {
      const originalEnv = process.env;
      process.env = {}; // Missing provider key must still permit eligible detection.
      const flag = jest.mocked(getPostHogBooleanFlagDecisionForUser);
      if (variant === "flag off") flag.mockResolvedValue(false);
      if (variant === "flag unavailable") flag.mockResolvedValue(null);
      const args: Parameters<typeof createTools> = [
        "user-1",
        "chat-1",
        {} as never,
        "agent",
        {} as never,
      ];
      args[9] = "service-key";
      args[20] = "run-1";
      args[22] = {
        environment:
          variant === "Production"
            ? "PRODUCTION"
            : variant === "untrusted"
              ? "DEVELOPMENT"
              : "PREVIEW",
        ...(variant === "child" && { browserAgentId: "child-1" }),
      };
      if (variant === "approval") args[16] = jest.fn();
      try {
        createTools(...args);
        const sessions = jest.mocked(createRunTerminalCmd).mock.calls.at(-1)![0]
          .browserSessions!;
        const run = jest.fn(
          async (_command: string, options: { stdin: string }) => {
            const { request } = JSON.parse(options.stdin);
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                root: `/tmp/hackerai-captcha-${request.owner}`,
                name: `captcha-${request.owner}`,
              }),
            };
          },
        );
        const target = {
          commands: { run },
          sandboxKind: "centrifugo",
          supportsCommandStdin: () => true,
          getConnectionInfo: () => ({ connectionId: "local" }),
          isWindows: () => false,
        } as never;
        const [a, b] = await Promise.all([
          sessions.prepare(target),
          sessions.prepare(target),
        ]);
        expect(b).toEqual(a);
        const eligible = ["Preview", "Production"].includes(variant);
        if (eligible) {
          expect(a.AGENT_BROWSER_CONFIG).toBeDefined();
          expect(run).toHaveBeenCalledTimes(1);
          expect(
            JSON.parse(run.mock.calls[0][1].stdin).request,
          ).not.toHaveProperty("initScript");
          expect(flag).toHaveBeenCalledTimes(1);
          // Turning the flag off must not silently switch the existing namespace.
          flag.mockResolvedValue(false);
          expect(await sessions.prepare(target)).toEqual(a);
          expect(flag).toHaveBeenCalledTimes(1);
        } else {
          expect(a).toEqual({});
          expect(run).not.toHaveBeenCalled();
        }
        await sessions.cleanup();
      } finally {
        process.env = originalEnv;
      }
    },
  );

  it("dispatches parent delegation and child tools without a scope lookup", async () => {
    const execute = jest.fn().mockResolvedValue({ result: "completed" });
    mockNetworkQuery.mockRejectedValue(new Error("scope storage unavailable"));
    const args: Parameters<typeof createTools> = [
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
    ];
    args[22] = {
      additionalTools: () => ({ delegate_task: { execute } as never }),
    };
    const { tools, getToolsForModel } = createTools(...args);
    const input = { task: "bounded offline analysis" };
    await tools.delegate_task.execute!(input, {
      toolCallId: "parent",
      messages: [],
    });
    await getToolsForModel("test-model").delegate_task.execute!(input, {
      toolCallId: "child",
      messages: [],
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(mockNetworkQuery).not.toHaveBeenCalled();
  });

  it("does not let a pre-reset acquisition replace the refreshed sandbox", async () => {
    let resolveFirst!: (value: { sandbox: { id: string } }) => void;
    const firstAcquisition = new Promise<{ sandbox: { id: string } }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    mockGetSandboxWithFallbackGuard
      .mockReturnValueOnce(firstAcquisition)
      .mockResolvedValueOnce({ sandbox: { id: "refreshed" } });
    const { ensureSandbox } = createTools(
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
      undefined,
      true,
      undefined,
      "e2b",
      "service-key",
    );

    const original = ensureSandbox();
    await Promise.resolve();
    const refresh = ensureSandbox({ refresh: true, reason: "health_check" });
    const joinedAfterRefresh = ensureSandbox();
    resolveFirst({ sandbox: { id: "original" } });

    await expect(original).resolves.toEqual({ id: "original" });
    await expect(refresh).resolves.toEqual({ id: "refreshed" });
    await expect(joinedAfterRefresh).resolves.toEqual({ id: "refreshed" });
    expect(mockResetSandbox).toHaveBeenCalledWith("health_check");
    expect(mockGetSandboxWithFallbackGuard).toHaveBeenCalledTimes(2);
    expect(mockResetSandbox.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockGetSandboxWithFallbackGuard.mock.invocationCallOrder[0],
    );
  });

  it("accounts for E2B runtime", async () => {
    jest.useFakeTimers();
    mockIsE2BSandbox.mockImplementation(
      (sandbox: { provider?: string } | null) => sandbox?.provider === "docker",
    );
    const { getSandboxSessionCost, getSandboxSessionUsage } = createTools(
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
      undefined,
      true,
      undefined,
      "e2b",
      "service-key",
    );

    mockTrackSandboxUsage?.({ provider: "docker" });
    jest.advanceTimersByTime(1_000);

    await expect(getSandboxSessionCost()).resolves.toBeCloseTo(
      SANDBOX_COST_PER_MS * 1_000,
      12,
    );
    await expect(getSandboxSessionUsage()).resolves.toEqual({
      totalCostDollars: SANDBOX_COST_PER_MS * 1_000,
      sandboxRuntimeMs: 1_000,
      sandboxCostDollars: SANDBOX_COST_PER_MS * 1_000,
    });
  });

  it.each(["docker"])(
    "does not charge shared %s runtime to a child agent",
    async (provider) => {
      jest.useFakeTimers();
      mockIsE2BSandbox.mockImplementation(
        (sandbox: { provider?: string } | null) =>
          sandbox?.provider === "docker",
      );
      const { getSandboxSessionCost, getSandboxSessionUsage } = createTools(
        "user-1",
        "chat-1",
        {} as never,
        "agent",
        {} as never,
        undefined,
        true,
        undefined,
        "e2b",
        "service-key",
        undefined,
        undefined,
        "pro",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "run-1",
        undefined,
        { chargeSandboxRuntime: false },
      );

      mockTrackSandboxUsage?.({ provider });
      jest.advanceTimersByTime(5_000);

      await expect(getSandboxSessionCost()).resolves.toBe(0);
      await expect(getSandboxSessionUsage()).resolves.toEqual({
        totalCostDollars: 0,
        sandboxRuntimeMs: 0,
        sandboxCostDollars: 0,
      });
    },
  );

  it("does not reset or duplicate runtime when reconnecting the same provider", async () => {
    jest.useFakeTimers();
    const { getSandboxSessionUsage } = createTools(
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
      undefined,
      true,
      undefined,
      "e2b",
      "service-key",
    );
    mockTrackSandboxUsage?.({ provider: "docker", sandboxId: "docker-1" });
    jest.advanceTimersByTime(2_000);
    mockTrackSandboxUsage?.({ provider: "docker", sandboxId: "docker-1" });
    jest.advanceTimersByTime(3_000);
    await expect(getSandboxSessionUsage()).resolves.toMatchObject({
      sandboxRuntimeMs: 5_000,
      sandboxCostDollars: 5_000 * SANDBOX_COST_PER_MS,
    });
  });

  it("stops cloud runtime billing while a non-cloud sandbox is active", async () => {
    jest.useFakeTimers();
    mockIsE2BSandbox.mockImplementation(
      (sandbox: { provider?: string } | null) => sandbox?.provider === "docker",
    );
    const { getSandboxSessionUsage } = createTools(
      "user-1",
      "chat-1",
      {} as never,
      "agent",
      {} as never,
      undefined,
      true,
      undefined,
      "e2b",
      "service-key",
    );

    mockTrackSandboxUsage?.({ provider: "docker" });
    jest.advanceTimersByTime(1_000);
    mockTrackSandboxUsage?.({ provider: "local" });
    jest.advanceTimersByTime(2_000);
    mockTrackSandboxUsage?.({ provider: "docker" });
    jest.advanceTimersByTime(3_000);

    await expect(getSandboxSessionUsage()).resolves.toEqual({
      totalCostDollars: SANDBOX_COST_PER_MS * 4_000,
      sandboxRuntimeMs: 4_000,
      sandboxCostDollars: SANDBOX_COST_PER_MS * 4_000,
    });
  });
});
