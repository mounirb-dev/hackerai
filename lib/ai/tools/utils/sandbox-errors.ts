import {
  SandboxError,
  TimeoutError,
  NotFoundError,
  AuthenticationError,
  NotEnoughSpaceError,
  RateLimitError,
  TemplateError,
  InvalidArgumentError,
  CommandExitError,
} from "@/lib/sandbox/docker";

export {
  SandboxError,
  TimeoutError,
  NotFoundError,
  AuthenticationError,
  NotEnoughSpaceError,
  RateLimitError,
  TemplateError,
  InvalidArgumentError,
  CommandExitError,
};

/**
 * Sandbox error classification categories.
 * - "permanent": never retry (auth, template, invalid args, sandbox gone)
 * - "transient": retry with standard backoff (timeouts, generic sandbox errors)
 * - "rate_limit": retry with extended backoff
 * - "disk_space": actionable — tell user to free space
 * - "command_failure": command ran but returned non-zero exit (don't retry)
 * - "unknown": not a recognized sandbox error
 */
export type SandboxErrorCategory =
  | "permanent"
  | "transient"
  | "rate_limit"
  | "disk_space"
  | "command_failure"
  | "unknown";

const DOCKER_UNREACHABLE_CODES = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "EACCES",
  "EPERM",
  "ENOTFOUND",
]);

/** The Docker daemon (or its socket proxy) could not be reached at all. */
export function isDockerUnreachableError(error: unknown): boolean {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && DOCKER_UNREACHABLE_CODES.has(code);
}

/**
 * Classify an error into a sandbox error category using instanceof checks
 * against the sandbox error class hierarchy.
 */
export function classifySandboxError(error: unknown): SandboxErrorCategory {
  if (!(error instanceof Error)) return "unknown";

  if (error instanceof CommandExitError) return "command_failure";
  if (error instanceof AuthenticationError) return "permanent";
  if (error instanceof TemplateError) return "permanent";
  if (error instanceof InvalidArgumentError) return "permanent";
  if (error instanceof RateLimitError) return "rate_limit";
  if (error instanceof NotEnoughSpaceError) return "disk_space";
  if (error instanceof NotFoundError) return "permanent";
  if (error instanceof TimeoutError) return "transient";
  if (isDockerUnreachableError(error)) return "transient";
  if (error instanceof SandboxError) return "transient";

  // String-based fallback for edge cases
  if (error.message.includes("not running anymore")) return "permanent";
  if (error.message.includes("Sandbox not found")) return "permanent";

  return "unknown";
}

/**
 * Check if an error is permanent and should not be retried.
 */
export function isSandboxPermanentError(error: unknown): boolean {
  const category = classifySandboxError(error);
  return category === "permanent" || category === "command_failure";
}

/**
 * Check if an error is a rate limit that requires extended backoff.
 */
export function isSandboxRateLimitError(error: unknown): boolean {
  return error instanceof RateLimitError;
}

/**
 * Generate a user-friendly error message based on the error type.
 * Returns null if the error is not a recognized sandbox error.
 */
export function getUserFacingSandboxErrorMessage(
  error: unknown,
): string | null {
  if (!(error instanceof Error)) return null;

  if (isDockerUnreachableError(error)) {
    return "The sandbox runtime (Docker) is unreachable. Check DOCKER_HOST and that the Docker daemon or socket proxy is running.";
  }
  if (error instanceof AuthenticationError) {
    return "Sandbox authentication failed. Please contact the administrator.";
  }
  if (error instanceof RateLimitError) {
    return "Sandbox API rate limit exceeded. Please wait a moment and try again.";
  }
  if (error instanceof NotEnoughSpaceError) {
    return "Sandbox disk space is full. Try removing unnecessary files or deleting the sandbox in Settings > Data Controls.";
  }
  if (error instanceof TemplateError) {
    return "Sandbox image is incompatible. Please contact the administrator.";
  }
  if (error instanceof TimeoutError) {
    return "Sandbox operation timed out. The sandbox may be overloaded. Please try again.";
  }
  if (error instanceof NotFoundError) {
    return "Sandbox was not found or has expired.";
  }
  if (error instanceof InvalidArgumentError) {
    return "Invalid sandbox configuration. Please contact the administrator.";
  }

  return null;
}
