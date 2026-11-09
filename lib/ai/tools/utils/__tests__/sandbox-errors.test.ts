import {
  classifySandboxError,
  CommandExitError,
  getUserFacingSandboxErrorMessage,
  isDockerUnreachableError,
  NotFoundError,
  TimeoutError,
} from "../sandbox-errors";

describe("sandbox error classification", () => {
  it("treats a missing sandbox as permanent and never promises a replacement", () => {
    const error = new NotFoundError("Sandbox not found");
    expect(classifySandboxError(error)).toBe("permanent");
    expect(getUserFacingSandboxErrorMessage(error)).toMatch(/expired/i);
    expect(getUserFacingSandboxErrorMessage(error)).not.toMatch(
      /will be created automatically/i,
    );
  });

  it("retries timeouts, since the container may just be slow", () => {
    expect(classifySandboxError(new TimeoutError("timeoutMs"))).toBe(
      "transient",
    );
  });

  it("does not retry a command that ran and exited non-zero", () => {
    const error = new CommandExitError({
      exitCode: 2,
      stdout: "",
      stderr: "x",
    });
    expect(classifySandboxError(error)).toBe("command_failure");
  });

  it("recognizes an unreachable Docker daemon and tells the operator what to check", () => {
    const error = Object.assign(new Error("connect ENOENT"), {
      code: "ENOENT",
    });
    expect(isDockerUnreachableError(error)).toBe(true);
    expect(classifySandboxError(error)).toBe("transient");
    expect(getUserFacingSandboxErrorMessage(error)).toMatch(/DOCKER_HOST/);
  });
});
