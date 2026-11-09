jest.mock("@/lib/sandbox/docker", () => ({
  ...jest.requireActual("@/lib/sandbox/docker/errors"),
  Sandbox: class MockSandbox {},
  ensureUserSandbox: jest.fn(),
}));

import { Sandbox, ensureUserSandbox } from "@/lib/sandbox/docker";
import { ensureSandboxConnection, SandboxAcquisitionError } from "../sandbox";

const ensure = ensureUserSandbox as unknown as jest.Mock;

describe("ensureSandboxConnection", () => {
  beforeEach(() => {
    ensure.mockReset();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it("reuses the sandbox the caller already holds without touching Docker", async () => {
    const initialSandbox = new Sandbox() as never;
    const result = await ensureSandboxConnection(
      { userID: "u1", setSandbox: jest.fn() } as never,
      { initialSandbox },
    );
    expect(result.sandbox).toBe(initialSandbox);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("reports a fresh create versus a reused container to the boot hook", async () => {
    const sandbox = new Sandbox();
    const onBoot = jest.fn();
    const setSandbox = jest.fn();
    ensure.mockResolvedValueOnce({ sandbox, created: true });
    await ensureSandboxConnection({
      userID: "u1",
      setSandbox,
      onBoot,
    } as never);
    expect(onBoot).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "create_fresh", create_attempts: 1 }),
    );
    expect(setSandbox).toHaveBeenCalledWith(sandbox);

    ensure.mockResolvedValueOnce({ sandbox, created: false });
    await ensureSandboxConnection({
      userID: "u1",
      setSandbox,
      onBoot,
    } as never);
    expect(onBoot).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "reuse_existing", create_attempts: 0 }),
    );
  });

  it("maps an unreachable Docker daemon to an actionable message", async () => {
    ensure.mockRejectedValue(
      Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
    );
    const failure = ensureSandboxConnection({
      userID: "u1",
      setSandbox: jest.fn(),
    } as never);
    await expect(failure).rejects.toBeInstanceOf(SandboxAcquisitionError);
    await expect(failure).rejects.toThrow(/DOCKER_HOST/);
  });
});
