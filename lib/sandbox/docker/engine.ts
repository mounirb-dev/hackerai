/**
 * Minimal Docker Engine API client.
 *
 * Talks plain HTTP over a unix socket, a Windows named pipe, or TCP so the app
 * needs no Docker SDK or CLI. Point `DOCKER_HOST` at a docker-socket-proxy
 * (`tcp://docker-proxy:2375`) to avoid handing the app full socket access.
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { DockerEngineError } from "./errors";

// Unversioned paths target the daemon's own API version. A pinned version breaks
// as soon as a daemon raises its minimum (Docker 29 rejects anything below 1.44).

type Endpoint = { socketPath: string } | { host: string; port: number };

export function resolveDockerEndpoint(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Endpoint {
  const raw = env.DOCKER_HOST?.trim();
  if (!raw) {
    return {
      socketPath:
        platform === "win32"
          ? "//./pipe/docker_engine"
          : "/var/run/docker.sock",
    };
  }
  if (raw.startsWith("unix://")) return { socketPath: raw.slice(7) };
  if (raw.startsWith("npipe://")) return { socketPath: raw.slice(8) };
  if (raw.startsWith("tcp://") || raw.startsWith("http://")) {
    const url = new URL(raw.replace(/^tcp:/, "http:"));
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  throw new Error(
    `Unsupported DOCKER_HOST "${raw}". Use unix://, npipe:// or tcp://.`,
  );
}

export type EngineRequest = {
  query?: Record<string, string | number | boolean | string[] | undefined>;
  json?: unknown;
  body?: Buffer;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Statuses treated as success besides 2xx. */
  okStatuses?: number[];
};

export type EngineResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

function buildPath(path: string, query: EngineRequest["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    params.set(
      key,
      Array.isArray(value) ? JSON.stringify(value) : String(value),
    );
  }
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}`;
}

// Node's shared agent applies a 5s idle socket timeout to keep-alive sockets,
// which would abort slow Engine calls (image pull, container stop). Engine
// calls are short-lived, so use a plain agent and set deadlines explicitly.
const engineAgent = new http.Agent({ keepAlive: false });

export class DockerEngine {
  constructor(private readonly endpoint: Endpoint = resolveDockerEndpoint()) {}

  request(
    method: string,
    path: string,
    options: EngineRequest = {},
  ): Promise<EngineResponse> {
    const payload =
      options.body ??
      (options.json === undefined
        ? undefined
        : Buffer.from(JSON.stringify(options.json)));
    return new Promise<EngineResponse>((resolve, reject) => {
      const req = http.request(
        {
          ...this.endpoint,
          method,
          path: buildPath(path, options.query),
          headers: {
            ...(options.json !== undefined && {
              "Content-Type": "application/json",
            }),
            ...(payload && { "Content-Length": String(payload.length) }),
            ...options.headers,
          },
          agent: engineAgent,
          signal: options.signal,
          timeout: options.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            const status = res.statusCode ?? 0;
            if (
              (status >= 200 && status < 300) ||
              options.okStatuses?.includes(status)
            ) {
              resolve({ status, headers: res.headers, body });
            } else {
              reject(new DockerEngineError(status, extractMessage(body)));
            }
          });
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error("Docker Engine request timed out")),
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  async json<T>(
    method: string,
    path: string,
    options: EngineRequest = {},
  ): Promise<T> {
    const response = await this.request(method, path, options);
    return (
      response.body.length
        ? JSON.parse(response.body.toString("utf8"))
        : undefined
    ) as T;
  }

  /**
   * POST with a connection upgrade, returning the raw duplex stream. Used by
   * exec/start where stdin and output share one hijacked connection.
   */
  hijack(
    path: string,
    json: unknown,
    signal?: AbortSignal,
  ): Promise<{ socket: Duplex; head: Buffer }> {
    const payload = Buffer.from(JSON.stringify(json));
    return new Promise((resolve, reject) => {
      const req = http.request({
        ...this.endpoint,
        method: "POST",
        path: buildPath(path, undefined),
        agent: engineAgent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
          Connection: "Upgrade",
          Upgrade: "tcp",
        },
        signal,
      });
      req.on("upgrade", (_res, socket, head) => resolve({ socket, head }));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          reject(
            new DockerEngineError(
              res.statusCode ?? 0,
              extractMessage(Buffer.concat(chunks)),
            ),
          ),
        );
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
}

function extractMessage(body: Buffer): string {
  const text = body.toString("utf8");
  try {
    const parsed = JSON.parse(text) as { message?: string };
    return parsed.message ?? text;
  } catch {
    return text;
  }
}

/**
 * Splits Docker's multiplexed stream (8-byte header: type, 3 pad bytes,
 * big-endian length) into stdout/stderr frames. TTY streams are not framed.
 */
export function createFrameDemuxer(
  onFrame: (stream: "stdout" | "stderr", data: Buffer) => void,
): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 8) {
      const length = pending.readUInt32BE(4);
      if (pending.length < 8 + length) break;
      onFrame(
        pending[0] === 2 ? "stderr" : "stdout",
        pending.subarray(8, 8 + length),
      );
      pending = pending.subarray(8 + length);
    }
  };
}

let defaultEngine: DockerEngine | undefined;
export function getDockerEngine(): DockerEngine {
  defaultEngine ??= new DockerEngine();
  return defaultEngine;
}
