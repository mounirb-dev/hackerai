/**
 * Container and volume lifecycle for per-user sandboxes.
 *
 * One container (`hackerai-sbx-<hash>`) and one named volume
 * (`hackerai-home-<hash>`) per user. The container is recreated freely; the
 * volume is only removed by an explicit data deletion.
 */

import { createHash } from "node:crypto";
import { getDockerEngine, type DockerEngine } from "./engine";
import { DockerEngineError, NotFoundError, SandboxError } from "./errors";
import {
  DockerSandbox,
  LEASE_FILE,
  SANDBOX_HOME,
  assertContainerRef,
} from "./sandbox";

export const SANDBOX_LABEL = "ai.hackerai.sandbox";
export const SANDBOX_USER_LABEL = "ai.hackerai.user";
const DEFAULT_IMAGE = "hackerai/sandbox:latest";
const DEFAULT_IDLE_SECONDS = 30 * 60;

export type SandboxConfig = {
  image: string;
  memoryBytes: number;
  cpus: number;
  pidsLimit: number;
  network?: string;
  idleSeconds: number;
};

const positiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function readSandboxConfig(
  env: Record<string, string | undefined> = process.env,
): SandboxConfig {
  return {
    image: env.DOCKER_SANDBOX_IMAGE?.trim() || DEFAULT_IMAGE,
    memoryBytes: Math.floor(
      positiveNumber(env.SANDBOX_MEMORY_MB, 2048) * 1024 * 1024,
    ),
    cpus: positiveNumber(env.SANDBOX_CPUS, 2),
    pidsLimit: Math.floor(positiveNumber(env.SANDBOX_PIDS_LIMIT, 2048)),
    network: env.SANDBOX_DOCKER_NETWORK?.trim() || undefined,
    // 0 keeps the container running until it is stopped explicitly.
    // Always a finite integer: it is interpolated into the init shell script.
    idleSeconds: (() => {
      const n = Math.floor(
        Number(env.SANDBOX_IDLE_TIMEOUT_SECONDS ?? DEFAULT_IDLE_SECONDS),
      );
      return Number.isFinite(n) && n > 0 ? n : 0;
    })(),
  };
}

const userKey = (userId: string) =>
  createHash("sha256").update(userId).digest("hex").slice(0, 24);
export const containerNameFor = (userId: string) =>
  `hackerai-sbx-${userKey(userId)}`;
export const volumeNameFor = (userId: string) =>
  `hackerai-home-${userKey(userId)}`;

type ContainerInfo = {
  Id: string;
  Name: string;
  State: { Running: boolean; Status: string };
  Config: { Labels?: Record<string, string> };
};

async function inspect(
  engine: DockerEngine,
  name: string,
): Promise<ContainerInfo | null> {
  try {
    return await engine.json<ContainerInfo>("GET", `/containers/${name}/json`);
  } catch (error) {
    if (error instanceof DockerEngineError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

function initCommand(idleSeconds: number): string[] {
  if (idleSeconds <= 0) return ["sleep", "infinity"];
  // The lease file holds an epoch deadline; heartbeats push it forward and the
  // container exits (stops) once it lapses.
  return [
    "/bin/sh",
    "-c",
    `echo $(( $(date +%s) + ${idleSeconds} )) > ${LEASE_FILE}; ` +
      `while [ "$(date +%s)" -lt "$(cat ${LEASE_FILE} 2>/dev/null || echo 0)" ]; do sleep 5; done`,
  ];
}

async function pullImage(engine: DockerEngine, image: string): Promise<void> {
  const separator = image.lastIndexOf(":");
  const hasTag = separator > image.lastIndexOf("/");
  await engine.request("POST", "/images/create", {
    query: {
      fromImage: hasTag ? image.slice(0, separator) : image,
      tag: hasTag ? image.slice(separator + 1) : "latest",
    },
  });
}

async function createContainer(
  engine: DockerEngine,
  userId: string,
  config: SandboxConfig,
): Promise<void> {
  const body = {
    Image: config.image,
    Cmd: initCommand(config.idleSeconds),
    User: "root",
    WorkingDir: SANDBOX_HOME,
    Hostname: "sandbox",
    Env: ["HOME=/home/user", "TERM=xterm-256color"],
    Labels: { [SANDBOX_LABEL]: "1", [SANDBOX_USER_LABEL]: userId },
    HostConfig: {
      Init: true,
      Privileged: false,
      Binds: [`${volumeNameFor(userId)}:${SANDBOX_HOME}`],
      CapAdd: ["NET_RAW", "NET_ADMIN", "SYS_PTRACE"],
      Memory: config.memoryBytes,
      MemorySwap: config.memoryBytes,
      NanoCpus: Math.floor(config.cpus * 1e9),
      PidsLimit: config.pidsLimit,
      ...(config.network && { NetworkMode: config.network }),
      LogConfig: {
        Type: "local",
        Config: { "max-size": "20m", "max-file": "2" },
      },
    },
  };
  const create = () =>
    engine.request("POST", "/containers/create", {
      query: { name: containerNameFor(userId) },
      json: body,
    });
  try {
    await create();
  } catch (error) {
    if (error instanceof DockerEngineError && error.statusCode === 404) {
      // Image missing locally: pull once, then retry.
      await pullImage(engine, config.image);
      await create();
      return;
    }
    throw error;
  }
}

async function ensureRunning(
  engine: DockerEngine,
  userId: string,
  config: SandboxConfig,
): Promise<ContainerInfo> {
  let info = await inspect(engine, containerNameFor(userId));
  if (!info) {
    try {
      await createContainer(engine, userId, config);
    } catch (error) {
      // A concurrent acquisition created it first.
      if (!(error instanceof DockerEngineError && error.statusCode === 409)) {
        throw error;
      }
    }
    info = await inspect(engine, containerNameFor(userId));
    if (!info) throw new SandboxError("Sandbox container was not created");
  }
  if (
    info.Config.Labels?.[SANDBOX_USER_LABEL] !== userId ||
    info.Config.Labels?.[SANDBOX_LABEL] !== "1"
  ) {
    throw new SandboxError("Sandbox container ownership mismatch");
  }
  if (!info.State.Running) {
    await engine.request("POST", `/containers/${info.Id}/start`, {
      okStatuses: [304],
    });
    info = (await inspect(engine, info.Id)) ?? info;
  }
  return info;
}

/** Find or start the user's sandbox, creating it on first use. */
export async function ensureUserSandbox(
  userId: string,
  options: { engine?: DockerEngine; config?: SandboxConfig } = {},
): Promise<{ sandbox: DockerSandbox; created: boolean }> {
  if (!userId) throw new SandboxError("A user id is required");
  const engine = options.engine ?? getDockerEngine();
  const config = options.config ?? readSandboxConfig();
  const existed = (await inspect(engine, containerNameFor(userId))) !== null;
  const info = await ensureRunning(engine, userId, config);
  const sandbox = new DockerSandbox(
    info.Id,
    { userId, containerName: containerNameFor(userId) },
    engine,
  );
  // A container started from a stopped state restarts its idle clock.
  if (config.idleSeconds > 0) {
    await sandbox.setTimeout(config.idleSeconds * 1000).catch(() => undefined);
  }
  return { sandbox, created: !existed };
}

/** Attach to an existing sandbox by container id without changing its state. */
export async function connectSandbox(
  sandboxId: string,
  options: { engine?: DockerEngine } = {},
): Promise<DockerSandbox> {
  assertContainerRef(sandboxId);
  const engine = options.engine ?? getDockerEngine();
  const info = await inspect(engine, sandboxId);
  if (!info) throw new NotFoundError(`Sandbox not found: ${sandboxId}`);
  const userId = info.Config.Labels?.[SANDBOX_USER_LABEL];
  const containerName = info.Name.replace(/^\//, "");
  // Labels alone are spoofable by anything able to create containers; the
  // deterministic name derived from the owner must agree with them.
  if (
    !userId ||
    info.Config.Labels?.[SANDBOX_LABEL] !== "1" ||
    containerName !== containerNameFor(userId)
  ) {
    throw new SandboxError("Container is not a HackerAI sandbox");
  }
  return new DockerSandbox(info.Id, { userId, containerName }, engine);
}

/** Remove the user's container and workspace volume. Irreversible. */
export async function destroyUserSandbox(
  userId: string,
  options: { engine?: DockerEngine } = {},
): Promise<{ containerRemoved: boolean; volumeRemoved: boolean }> {
  const engine = options.engine ?? getDockerEngine();
  const name = containerNameFor(userId);
  const info = await inspect(engine, name);
  if (info && info.Config.Labels?.[SANDBOX_USER_LABEL] !== userId) {
    throw new SandboxError("Sandbox container ownership mismatch");
  }
  let containerRemoved = false;
  if (info) {
    await engine.request("DELETE", `/containers/${info.Id}`, {
      query: { force: true },
    });
    containerRemoved = true;
  }
  let volumeRemoved = false;
  try {
    await engine.request("DELETE", `/volumes/${volumeNameFor(userId)}`, {
      query: { force: true },
    });
    volumeRemoved = true;
  } catch (error) {
    if (!(error instanceof DockerEngineError && error.statusCode === 404)) {
      throw error;
    }
  }
  return { containerRemoved, volumeRemoved };
}
