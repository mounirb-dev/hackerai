import type { Sandbox } from "@/lib/sandbox/docker";
import type { CentrifugoSandbox } from "./centrifugo-sandbox";
import type { AnySandbox, SandboxInfo } from "@/types";
import type { CloudSandboxProvider } from "./cloud-sandbox-provider";
import path from "node:path";

/** Keep native Desktop artifacts inside its selected project file boundary. */
export function getSandboxArtifactDirectory(
  sandbox: AnySandbox,
  artifact:
    "agent-transcripts" | "terminal_full_output" | "terminal_execution_records",
): string {
  if (isCentrifugoSandbox(sandbox)) {
    const project = sandbox.getWorkingDirectory?.();
    if (project && sandbox.supportsNativeFileRelay?.()) {
      const paths = sandbox.isWindows() ? path.win32 : path.posix;
      const directory = paths.join(project, ".hackerai", artifact);
      return sandbox.isWindows() ? directory.replaceAll("\\", "/") : directory;
    }
    const namespace =
      sandbox.getConnectionInfo?.().capabilities?.privateArtifactNamespace;
    if (artifact !== "agent-transcripts" && namespace !== undefined) {
      if (
        !/^uid-(0|[1-9][0-9]{0,9})$/.test(namespace) ||
        !sandbox.supportsCommandStdin?.() ||
        sandbox.isWindows()
      ) {
        throw new Error("Invalid private terminal artifact namespace");
      }
      return `/tmp/${artifact}-${namespace}`;
    }
    return `/tmp/${artifact}`;
  }
  return `/home/user/${artifact}`;
}

export interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  hostname: string;
}

export interface ConnectionInfo {
  connectionId: string;
  environmentId?: string;
  createdAt?: number;
  name: string;
  osInfo?: OsInfo;
  lastSeen?: number;
  isDesktop?: boolean;
  capabilities?: {
    commands: boolean;
    pty: boolean;
    files?: boolean;
    commandStdin?: boolean;
    privateArtifactNamespace?: string;
    operationChannels?: boolean;
  };
}

/**
 * Type guard to check if a sandbox is a CentrifugoSandbox
 * using the `sandboxKind` discriminant field.
 */
export function isCentrifugoSandbox(
  sandbox: AnySandbox | null,
): sandbox is CentrifugoSandbox {
  return (
    sandbox !== null &&
    "sandboxKind" in sandbox &&
    (sandbox as any).sandboxKind === "centrifugo"
  );
}

/**
 * Type guard for the self-hosted cloud (Docker) sandbox.
 *
 * Any sandbox that is not Centrifugo is treated as cloud. PTY availability
 * should be checked at the call site via `sandbox.pty`, not here.
 */
export function isCloudSandbox(sandbox: AnySandbox | null): sandbox is Sandbox {
  if (sandbox === null) return false;
  if (isCentrifugoSandbox(sandbox)) return false;
  return true;
}

export function getCloudSandboxProviderForInstance(
  sandbox: AnySandbox | null,
): CloudSandboxProvider | null {
  if (isCloudSandbox(sandbox)) return "docker";
  return null;
}

/** Canonical runtime identity used by sandbox logs and analytics. */
export function getSandboxInfoForInstance(sandbox: AnySandbox): SandboxInfo {
  const provider = getCloudSandboxProviderForInstance(sandbox);
  if (provider) return { type: "cloud", provider };

  if (!isCentrifugoSandbox(sandbox)) {
    return { type: "cloud", provider: "docker" };
  }
  const connection =
    typeof sandbox.getConnectionInfo === "function"
      ? sandbox.getConnectionInfo()
      : undefined;
  const isDesktop =
    connection?.isDesktop ??
    (typeof sandbox.supportsNativeFileRelay === "function" &&
      sandbox.supportsNativeFileRelay());
  return {
    type: isDesktop ? "desktop" : "remote-connection",
    ...(connection?.name && { name: connection.name }),
  };
}

export function getSandboxLogFields(sandbox: AnySandbox): {
  sandbox_type: SandboxInfo["type"];
  sandbox_provider?: CloudSandboxProvider;
} {
  const info = getSandboxInfoForInstance(sandbox);
  return {
    sandbox_type: info.type,
    ...(info.provider && { sandbox_provider: info.provider }),
  };
}

/**
 * Common sandbox interface that both the Docker sandbox and CentrifugoSandbox implement
 */
export interface CommonSandboxInterface {
  commands: {
    run: (
      command: string,
      opts?: {
        envVars?: Record<string, string>;
        cwd?: string;
        timeoutMs?: number;
        background?: boolean;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
        displayName?: string;
        stdin?: string | Buffer;
        signal?: AbortSignal;
      },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  files: {
    write: (path: string, content: string | Buffer) => Promise<void>;
    read: (path: string) => Promise<string>;
    remove: (path: string) => Promise<void>;
    list: (path: string) => Promise<{ name: string }[]>;
  };
  getHost: (port: number) => string | Promise<string>;
  close: () => Promise<void>;
}

/**
 * Get the sandbox as the common interface type.
 * The `as unknown as` cast is necessary because the Docker sandbox's method
 * signatures are richer than the common interface (extra options and return
 * shapes). Both implementations satisfy CommonSandboxInterface at runtime.
 */
export function asCommonSandbox(sandbox: AnySandbox): CommonSandboxInterface {
  return sandbox as unknown as CommonSandboxInterface;
}
