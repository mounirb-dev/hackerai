/**
 * Self-hosted sandbox backed by one Docker container per user.
 *
 * The public surface (`commands`, `files`, `pty`, `getHost`, `getMetrics`, ...)
 * is what the agent tools consume. User data lives in a named volume mounted at
 * /home/user, so stopping or recreating the container keeps the workspace.
 */

import { getDockerEngine, type DockerEngine } from "./engine";
import { ExecProcess, startExec, type ExecResult } from "./exec";
import {
  CommandExitError,
  DockerEngineError,
  InvalidArgumentError,
  NotFoundError,
  SandboxError,
  TimeoutError,
} from "./errors";

export const SANDBOX_HOME = "/home/user";
export const LEASE_FILE = "/run/hackerai-lease";
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export type CommandRunOptions = {
  background?: boolean;
  cwd?: string;
  user?: string;
  /** Environment for the process. `envVars` is accepted for local-adapter parity. */
  envs?: Record<string, string>;
  envVars?: Record<string, string>;
  /** 0 disables the wait deadline. The process itself is never killed by it. */
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /** `true` keeps stdin open for `sendStdin`; data is written then closed. */
  stdin?: string | Uint8Array | boolean;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
};

export type CommandResult = ExecResult & { pid: number };

export class CommandHandle {
  constructor(
    private readonly process: ExecProcess,
    private readonly sandbox: DockerSandbox,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {}

  get pid(): number {
    return this.process.pid;
  }

  get stdout(): string {
    return this.process.stdout;
  }

  get stderr(): string {
    return this.process.stderr;
  }

  /** Set only after the process has exited. */
  exitCode?: number;

  async wait(): Promise<CommandResult> {
    const result = await raceWithDeadline(
      this.process.wait(),
      this.timeoutMs,
      this.signal,
      () => this.process.detach(),
    );
    this.exitCode = result.exitCode;
    if (result.exitCode !== 0) throw new CommandExitError(result);
    return { ...result, pid: this.pid };
  }

  kill(): Promise<boolean> {
    return this.sandbox.commands.kill(this.pid);
  }

  sendStdin(data: string | Uint8Array): Promise<void> {
    return this.process.write(data);
  }

  /** Stop reading output without signalling the process. */
  disconnect(): Promise<void> {
    this.process.detach();
    return Promise.resolve();
  }

  async closeStdin(): Promise<void> {
    this.process.endStdin();
  }
}

async function raceWithDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onGiveUp: () => void,
): Promise<T> {
  if (timeoutMs <= 0 && !signal) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            onGiveUp();
            reject(
              new TimeoutError(
                `Command exceeded timeoutMs (${timeoutMs}ms); the process keeps running`,
              ),
            );
          }, timeoutMs);
        }
        if (signal) {
          onAbort = () => {
            onGiveUp();
            reject(signal.reason ?? new Error("Aborted"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export type FileRequestOptions = {
  user?: string;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

export type FileInfo = {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  mode: number;
  modifiedTime: Date;
  symlinkTarget?: string;
};

export type PtyCreateOptions = {
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void | Promise<void>;
  user?: string;
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
};

export type SandboxMetrics = {
  timestamp: Date;
  cpuUsedPct: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
};

const STAT_FORMAT = "%F\t%s\t%a\t%Y\t%n";

function parseStatLine(line: string, directory?: string): FileInfo {
  const [kind, size, mode, mtime, ...nameParts] = line.split("\t");
  const rawName = nameParts.join("\t");
  const name = rawName.split("/").filter(Boolean).pop() ?? rawName;
  return {
    name,
    path: directory ? `${directory.replace(/\/+$/, "")}/${name}` : rawName,
    type: kind.startsWith("directory") ? "dir" : "file",
    size: Number(size),
    mode: parseInt(mode, 8),
    modifiedTime: new Date(Number(mtime) * 1000),
  };
}

function assertAbsolute(path: string): void {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("\0")
  ) {
    throw new InvalidArgumentError(
      `Expected an absolute sandbox path: ${path}`,
    );
  }
}

/**
 * Container ids/names are interpolated into Engine API URL paths, so reject
 * anything that could add path segments or query strings (`../`, `?`, `/`).
 */
export function assertContainerRef(ref: string): void {
  if (typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(ref)) {
    throw new InvalidArgumentError("Invalid sandbox identifier");
  }
}

export class DockerSandbox {
  private readonly ptys = new Map<number, ExecProcess>();
  private containerIp?: string;

  constructor(
    readonly sandboxId: string,
    readonly metadata: { userId: string; containerName: string },
    private readonly engine: DockerEngine = getDockerEngine(),
  ) {
    assertContainerRef(sandboxId);
  }

  // ── commands ───────────────────────────────────────────────────────────

  readonly commands = {
    run: (async (command: string, options: CommandRunOptions = {}) => {
      if (typeof command !== "string" || !command.length) {
        throw new InvalidArgumentError("A command is required");
      }
      const process = await startExec(this.engine, this.sandboxId, {
        cmd: ["/bin/bash", "-l", "-c", command],
        cwd: options.cwd ?? SANDBOX_HOME,
        user: options.user,
        env: { ...options.envVars, ...options.envs },
        stdin: typeof options.stdin === "boolean" ? undefined : options.stdin,
        interactive: options.stdin === true,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        signal: options.signal,
      });
      const timeoutMs =
        options.timeoutMs ??
        (options.background ? 0 : DEFAULT_COMMAND_TIMEOUT_MS);
      const handle = new CommandHandle(
        process,
        this,
        timeoutMs,
        options.background ? undefined : options.signal,
      );
      if (options.background) return handle;
      return handle.wait();
    }) as {
      (
        command: string,
        options: CommandRunOptions & { background: true },
      ): Promise<CommandHandle>;
      (
        command: string,
        options?: CommandRunOptions & { background?: false },
      ): Promise<CommandResult>;
      (
        command: string,
        options?: CommandRunOptions,
      ): Promise<CommandResult | CommandHandle>;
    },

    /** SIGKILL a process (and its group) by in-sandbox PID. */
    kill: async (
      pid: number,
      _options?: { requestTimeoutMs?: number },
    ): Promise<boolean> => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        const result = await this.exec(
          `kill -9 ${pid} 2>/dev/null; status=$?; kill -9 -- -${pid} 2>/dev/null; exit $status`,
        );
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
  };

  // ── files ──────────────────────────────────────────────────────────────

  readonly files = {
    read: (async (
      path: string,
      options: FileRequestOptions & { format?: "text" | "bytes" } = {},
    ) => {
      assertAbsolute(path);
      // Output is decoded as UTF-8 text, so binary reads travel as base64.
      const bytes = options.format === "bytes";
      const result = await this.exec(
        bytes ? `base64 -w0 -- "$1"` : `cat -- "$1"`,
        [path],
      );
      if (result.exitCode !== 0) throw this.fileError(path, result);
      return bytes
        ? new Uint8Array(Buffer.from(result.stdout, "base64"))
        : result.stdout;
    }) as {
      (
        path: string,
        options?: FileRequestOptions & { format?: "text" },
      ): Promise<string>;
      (
        path: string,
        options: FileRequestOptions & { format: "bytes" },
      ): Promise<Uint8Array>;
    },

    write: async (
      path: string,
      data: string | ArrayBuffer | Uint8Array,
      _options: FileRequestOptions = {},
    ): Promise<void> => {
      assertAbsolute(path);
      const payload =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data;
      const result = await this.exec(
        `mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && { chown user:user "$1" 2>/dev/null; true; }`,
        [path],
        payload,
      );
      if (result.exitCode !== 0) throw this.fileError(path, result);
    },

    list: async (path: string): Promise<FileInfo[]> => {
      assertAbsolute(path);
      const result = await this.exec(
        `cd -- "$1" || exit 44; for f in .[!.]* ..?* *; do if [ -e "$f" ] || [ -L "$f" ]; then stat -c '${STAT_FORMAT}' -- "$f"; fi; done`,
        [path],
      );
      if (result.exitCode !== 0) throw this.fileError(path, result);
      return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => parseStatLine(line, path));
    },

    stat: async (
      path: string,
      options?: FileRequestOptions,
    ): Promise<FileInfo> => this.files.getInfo(path, options),

    getInfo: async (
      path: string,
      _options?: FileRequestOptions,
    ): Promise<FileInfo> => {
      assertAbsolute(path);
      const result = await this.exec(`stat -c '${STAT_FORMAT}' -- "$1"`, [
        path,
      ]);
      if (result.exitCode !== 0) throw this.fileError(path, result);
      const info = parseStatLine(result.stdout.trim());
      return { ...info, path };
    },

    exists: async (path: string): Promise<boolean> => {
      assertAbsolute(path);
      return (await this.exec(`test -e "$1"`, [path])).exitCode === 0;
    },

    makeDir: async (path: string): Promise<boolean> => {
      assertAbsolute(path);
      const result = await this.exec(`mkdir -p -- "$1"`, [path]);
      if (result.exitCode !== 0) throw this.fileError(path, result);
      return true;
    },

    remove: async (
      path: string,
      _options?: FileRequestOptions,
    ): Promise<void> => {
      assertAbsolute(path);
      const result = await this.exec(`rm -rf -- "$1"`, [path]);
      if (result.exitCode !== 0) throw this.fileError(path, result);
    },
  };

  // ── pty ────────────────────────────────────────────────────────────────

  readonly pty = {
    create: async (options: PtyCreateOptions) => {
      const proc = await startExec(this.engine, this.sandboxId, {
        cmd: ["/bin/bash", "-l"],
        cwd: options.cwd ?? SANDBOX_HOME,
        user: options.user,
        env: { TERM: "xterm-256color", ...options.envs },
        tty: true,
        interactive: true,
        onData: (data) => {
          void Promise.resolve(options.onData(data)).catch(() => undefined);
        },
      });
      this.ptys.set(proc.pid, proc);
      void proc.wait().then(
        () => this.ptys.delete(proc.pid),
        () => this.ptys.delete(proc.pid),
      );
      await proc.resize(options.cols, options.rows).catch(() => undefined);
      return {
        pid: proc.pid,
        wait: async () => {
          const { exitCode } = await proc.wait();
          return { exitCode };
        },
      };
    },

    sendInput: async (pid: number, data: Uint8Array): Promise<void> => {
      await this.requirePty(pid).write(data);
    },

    resize: async (
      pid: number,
      size: { cols: number; rows: number },
    ): Promise<void> => {
      await this.requirePty(pid).resize(size.cols, size.rows);
    },

    kill: async (pid: number): Promise<boolean> => {
      if (!this.ptys.has(pid)) return false;
      const killed = await this.commands.kill(pid);
      this.ptys.get(pid)?.detach();
      this.ptys.delete(pid);
      return killed;
    },
  };

  // ── lifecycle & introspection ──────────────────────────────────────────

  /**
   * Extend the idle lease. The container's init loop stops the container when
   * the lease expires; the workspace volume survives and the next acquisition
   * restarts it.
   */
  async setTimeout(
    ms: number,
    _options: { requestTimeoutMs?: number } = {},
  ): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new InvalidArgumentError("Lease duration must be positive");
    }
    const seconds = Math.ceil(ms / 1000);
    const result = await this.exec(
      `echo $(( $(date +%s) + $1 )) > ${LEASE_FILE}`,
      [String(seconds)],
    );
    if (result.exitCode !== 0) {
      throw new SandboxError(
        `Failed to extend sandbox lease: ${result.stderr}`,
      );
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const info = await this.engine.json<{ State: { Running: boolean } }>(
        "GET",
        `/containers/${this.sandboxId}/json`,
      );
      return info.State.Running;
    } catch (error) {
      if (error instanceof DockerEngineError && error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /** Stop the container; the workspace volume is kept. */
  async pause(): Promise<boolean> {
    await this.engine.request("POST", `/containers/${this.sandboxId}/stop`, {
      query: { t: 5 },
      okStatuses: [304],
    });
    return true;
  }

  /** Remove the container; the workspace volume is kept. */
  async kill(): Promise<boolean> {
    try {
      await this.engine.request("DELETE", `/containers/${this.sandboxId}`, {
        query: { force: true },
      });
      return true;
    } catch (error) {
      if (error instanceof DockerEngineError && error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const process of this.ptys.values()) process.detach();
    this.ptys.clear();
  }

  /**
   * Address of a port inside the sandbox. A public wildcard template
   * (`SANDBOX_PUBLIC_HOST_TEMPLATE`, e.g. `{port}-{id}.sandbox.example.com`)
   * is required for anything the user's browser must reach.
   */
  async getHost(port: number): Promise<string> {
    const template = process.env.SANDBOX_PUBLIC_HOST_TEMPLATE?.trim();
    if (template) {
      return template
        .replaceAll("{port}", String(port))
        .replaceAll("{id}", this.sandboxId.slice(0, 12));
    }
    if (process.env.SANDBOX_ALLOW_INTERNAL_HOST === "true") {
      this.containerIp ??= await this.resolveContainerIp();
      return `${this.containerIp}:${port}`;
    }
    throw new SandboxError(
      "Exposing sandbox ports requires SANDBOX_PUBLIC_HOST_TEMPLATE",
    );
  }

  async getMetrics(
    _range: { start?: Date; end?: Date; requestTimeoutMs?: number } = {},
  ): Promise<SandboxMetrics[]> {
    const stats = await this.engine.json<{
      cpu_stats: {
        cpu_usage: { total_usage: number };
        system_cpu_usage?: number;
        online_cpus?: number;
      };
      precpu_stats: {
        cpu_usage: { total_usage: number };
        system_cpu_usage?: number;
      };
      memory_stats: {
        usage?: number;
        limit?: number;
        stats?: Record<string, number>;
      };
    }>("GET", `/containers/${this.sandboxId}/stats`, {
      query: { stream: false },
    });
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage -
      stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta =
      (stats.cpu_stats.system_cpu_usage ?? 0) -
      (stats.precpu_stats.system_cpu_usage ?? 0);
    const cpus = stats.cpu_stats.online_cpus ?? 1;
    const cache =
      stats.memory_stats.stats?.inactive_file ??
      stats.memory_stats.stats?.cache ??
      0;
    const disk = await this.exec(
      `df -B1 --output=used,size ${SANDBOX_HOME} | tail -n1`,
    );
    const [diskUsed = 0, diskTotal = 0] = disk.stdout
      .trim()
      .split(/\s+/)
      .map(Number);
    return [
      {
        timestamp: new Date(),
        cpuUsedPct: systemDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0,
        memUsed: Math.max(0, (stats.memory_stats.usage ?? 0) - cache),
        memTotal: stats.memory_stats.limit ?? 0,
        diskUsed,
        diskTotal,
      },
    ];
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Run a short shell snippet; positional arguments are `$1..$n`. */
  private async exec(
    script: string,
    args: string[] = [],
    stdin?: string | Uint8Array,
  ): Promise<ExecResult> {
    const proc = await startExec(this.engine, this.sandboxId, {
      cmd: ["/bin/sh", "-c", script, "sh", ...args],
      stdin,
    });
    return proc.wait();
  }

  private requirePty(pid: number): ExecProcess {
    const process = this.ptys.get(pid);
    if (!process) throw new NotFoundError(`PTY ${pid} not found`);
    return process;
  }

  private fileError(path: string, result: ExecResult): Error {
    const detail = result.stderr.trim();
    if (
      result.exitCode === 44 ||
      /no such file|not a directory/i.test(detail)
    ) {
      return new NotFoundError(`File not found: ${path}`);
    }
    return new SandboxError(detail || `File operation failed: ${path}`);
  }

  private async resolveContainerIp(): Promise<string> {
    const info = await this.engine.json<{
      NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
    }>("GET", `/containers/${this.sandboxId}/json`);
    const ip = Object.values(info.NetworkSettings.Networks)
      .map((network) => network.IPAddress)
      .find(Boolean);
    if (!ip) throw new SandboxError("Sandbox has no network address");
    return ip;
  }
}
