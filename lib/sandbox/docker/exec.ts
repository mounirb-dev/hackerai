/**
 * Process execution inside a container through the Docker exec API.
 *
 * The Engine only reports host-namespace PIDs, but the agent needs the PID
 * inside the sandbox (for `ps -p`, `kill`, background tracking). Every exec is
 * therefore launched through a tiny `sh` wrapper that prints its own PID as a
 * marker line and then `exec`s the real command, so the PID stays the same.
 */

import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import { createFrameDemuxer, type DockerEngine } from "./engine";
import {
  DockerEngineError,
  NotEnoughSpaceError,
  NotFoundError,
  SandboxError,
  TimeoutError,
} from "./errors";

const PID_MARKER = "\u0001HAIPID:";
const PID_WRAPPER = `printf '\\001HAIPID:%s\\n' "$$"; exec "$@"`;
const PID_START_TIMEOUT_MS = 15_000;
const EXIT_POLL_TIMEOUT_MS = 5_000;
/** Output kept for the final result; callbacks still receive everything. */
const MAX_CAPTURE_CHARS = 32 * 1024 * 1024;

export type ExecOptions = {
  cmd: string[];
  env?: Record<string, string>;
  cwd?: string;
  user?: string;
  tty?: boolean;
  /** Written once after start. */
  stdin?: string | Uint8Array;
  /** Keep stdin open for interactive input (PTY, sendStdin). */
  interactive?: boolean;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  /** Raw bytes, used by PTYs. */
  onData?: (data: Uint8Array) => void;
  signal?: AbortSignal;
};

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export class ExecProcess {
  private readonly exit: Promise<ExecResult>;

  constructor(
    readonly execId: string,
    readonly pid: number,
    private readonly socket: Duplex,
    private readonly engine: DockerEngine,
    private readonly capture: { stdout: () => string; stderr: () => string },
    exit: Promise<number>,
  ) {
    this.exit = exit.then((exitCode) => ({
      exitCode,
      stdout: capture.stdout(),
      stderr: capture.stderr(),
    }));
    // A background process may never be awaited; do not surface that as unhandled.
    this.exit.catch(() => undefined);
  }

  get stdout(): string {
    return this.capture.stdout();
  }

  get stderr(): string {
    return this.capture.stderr();
  }

  wait(): Promise<ExecResult> {
    return this.exit;
  }

  write(data: string | Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed || !this.socket.writable) {
        reject(new SandboxError("Process stdin is closed"));
        return;
      }
      this.socket.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  endStdin(): void {
    if (!this.socket.destroyed && this.socket.writable) this.socket.end();
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.engine.request("POST", `/exec/${this.execId}/resize`, {
      query: { h: rows, w: cols },
    });
  }

  /** Drop the connection without signalling the process. */
  detach(): void {
    this.socket.destroy();
  }
}

function mapEngineError(error: unknown, containerId: string): unknown {
  if (!(error instanceof DockerEngineError)) return error;
  const status = error.statusCode;
  if (status === 404) {
    return new NotFoundError(`Sandbox not found: ${containerId}`, {
      statusCode: 404,
    });
  }
  if (status === 409 || /is not running|paused/i.test(error.body)) {
    return new NotFoundError(`Sandbox ${containerId} is not running anymore`, {
      statusCode: status,
    });
  }
  if (/no space left/i.test(error.body)) {
    return new NotEnoughSpaceError(error.message, { statusCode: status });
  }
  return error;
}

export async function startExec(
  engine: DockerEngine,
  containerId: string,
  options: ExecOptions,
): Promise<ExecProcess> {
  const tty = options.tty === true;
  const interactive =
    options.interactive === true || options.stdin !== undefined;

  let execId: string;
  let socket: Duplex;
  let head: Buffer;
  try {
    ({ Id: execId } = await engine.json<{ Id: string }>(
      "POST",
      `/containers/${containerId}/exec`,
      {
        json: {
          AttachStdin: interactive,
          AttachStdout: true,
          AttachStderr: true,
          Tty: tty,
          User: options.user ?? "root",
          WorkingDir: options.cwd,
          Env: Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`),
          Cmd: ["/bin/sh", "-c", PID_WRAPPER, "sh", ...options.cmd],
        },
        signal: options.signal,
      },
    ));
    ({ socket, head } = await engine.hijack(
      `/exec/${execId}/start`,
      { Detach: false, Tty: tty },
      options.signal,
    ));
  } catch (error) {
    throw mapEngineError(error, containerId);
  }

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  let markerBuffer = "";
  let markerSettled = false;
  let resolvePid!: (pid: number) => void;
  let rejectPid!: (error: Error) => void;
  const pidPromise = new Promise<number>((resolve, reject) => {
    resolvePid = resolve;
    rejectPid = reject;
  });

  const emitOutput = (kind: "stdout" | "stderr", data: Buffer) => {
    if (options.onData) options.onData(data);
    const decoder = kind === "stdout" ? stdoutDecoder : stderrDecoder;
    const text = decoder.write(data);
    if (!text) return;
    if (kind === "stdout") {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += text;
      options.onStdout?.(text);
    } else {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += text;
      options.onStderr?.(text);
    }
  };

  // The first stdout bytes carry the PID marker; everything after is output.
  const handleStdout = (data: Buffer) => {
    if (markerSettled) return emitOutput("stdout", data);
    markerBuffer += data.toString("latin1");
    const newline = markerBuffer.indexOf("\n");
    if (newline === -1) return;
    const line = markerBuffer.slice(0, newline).replace(/\r$/, "");
    const rest = Buffer.from(markerBuffer.slice(newline + 1), "latin1");
    markerSettled = true;
    markerBuffer = "";
    const pid = line.startsWith(PID_MARKER)
      ? Number(line.slice(PID_MARKER.length))
      : NaN;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      rejectPid(new SandboxError("Sandbox did not report a process id"));
      return;
    }
    resolvePid(pid);
    if (rest.length) emitOutput("stdout", rest);
  };

  const demux = createFrameDemuxer((kind, data) =>
    kind === "stdout" ? handleStdout(data) : emitOutput("stderr", data),
  );
  const onChunk = (chunk: Buffer) => (tty ? handleStdout(chunk) : demux(chunk));

  const exit = new Promise<number>((resolve, reject) => {
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      const tail = stdoutDecoder.end();
      if (tail && markerSettled) {
        stdout += tail;
        options.onStdout?.(tail);
      }
      const errTail = stderrDecoder.end();
      if (errTail) {
        stderr += errTail;
        options.onStderr?.(errTail);
      }
      if (!markerSettled) {
        rejectPid(new SandboxError("Process ended before reporting its id"));
      }
      try {
        resolve(await readExitCode(engine, execId));
      } catch (error) {
        reject(error);
      }
    };
    socket.on("data", onChunk);
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error) => {
      rejectPid(error);
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
  });
  // The exit promise may reject before anyone awaits it.
  exit.catch(() => undefined);

  if (head.length) onChunk(head);

  const timer = setTimeout(
    () =>
      rejectPid(new TimeoutError("Timed out waiting for the process to start")),
    PID_START_TIMEOUT_MS,
  );
  let pid: number;
  try {
    pid = await pidPromise;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (options.stdin !== undefined) {
    socket.write(options.stdin);
    if (options.interactive !== true) socket.end();
  }

  return new ExecProcess(
    execId,
    pid,
    socket,
    engine,
    { stdout: () => stdout, stderr: () => stderr },
    exit,
  );
}

async function readExitCode(
  engine: DockerEngine,
  execId: string,
): Promise<number> {
  const deadline = Date.now() + EXIT_POLL_TIMEOUT_MS;
  for (;;) {
    const info = await engine.json<{
      Running: boolean;
      ExitCode: number | null;
    }>("GET", `/exec/${execId}/json`);
    if (!info.Running && typeof info.ExitCode === "number") {
      return info.ExitCode;
    }
    if (Date.now() >= deadline) {
      throw new SandboxError("Timed out reading the process exit code");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
