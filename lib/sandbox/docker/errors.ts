/**
 * Error hierarchy for the self-hosted Docker sandbox.
 *
 * Class names and the fields callers rely on (`exitCode`, `stdout`, `stderr`,
 * `statusCode`) are intentionally stable so retry logic and user-facing error
 * mapping can classify failures with `instanceof` checks.
 */

export class SandboxError extends Error {
  readonly statusCode?: number;

  constructor(message: string, options: { statusCode?: number } = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = options.statusCode;
  }
}

export class TimeoutError extends SandboxError {}
export class NotFoundError extends SandboxError {}
export class AuthenticationError extends SandboxError {}
export class NotEnoughSpaceError extends SandboxError {}
export class RateLimitError extends SandboxError {}
export class TemplateError extends SandboxError {}
export class InvalidArgumentError extends SandboxError {}

/** A command ran to completion and exited with a non-zero status. */
export class CommandExitError extends SandboxError {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(result: { exitCode: number; stdout: string; stderr: string }) {
    super(
      result.stderr.trim() ||
        `Command exited with code ${result.exitCode}`.trim(),
    );
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/** Raw failure reported by the Docker Engine API. */
export class DockerEngineError extends SandboxError {
  readonly body: string;

  constructor(statusCode: number, body: string) {
    super(
      `Docker Engine API responded with ${statusCode}: ${body.slice(0, 500)}`,
      { statusCode },
    );
    this.body = body;
  }
}
