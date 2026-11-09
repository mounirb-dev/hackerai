import { createFrameDemuxer, resolveDockerEndpoint } from "../engine";
import {
  containerNameFor,
  readSandboxConfig,
  volumeNameFor,
} from "../provisioner";

const frame = (type: 1 | 2, text: string) => {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};

describe("resolveDockerEndpoint", () => {
  it("defaults per platform", () => {
    expect(resolveDockerEndpoint({}, "linux")).toEqual({
      socketPath: "/var/run/docker.sock",
    });
    expect(resolveDockerEndpoint({}, "win32")).toEqual({
      socketPath: "//./pipe/docker_engine",
    });
  });

  it("parses unix and tcp hosts and rejects other schemes", () => {
    expect(
      resolveDockerEndpoint({ DOCKER_HOST: "unix:///tmp/d.sock" }, "linux"),
    ).toEqual({ socketPath: "/tmp/d.sock" });
    expect(
      resolveDockerEndpoint(
        { DOCKER_HOST: "tcp://docker-proxy:2375" },
        "linux",
      ),
    ).toEqual({ host: "docker-proxy", port: 2375 });
    expect(() =>
      resolveDockerEndpoint({ DOCKER_HOST: "ssh://root@host" }, "linux"),
    ).toThrow(/Unsupported DOCKER_HOST/);
  });
});

describe("createFrameDemuxer", () => {
  it("splits stdout/stderr frames, including frames split across chunks", () => {
    const seen: Array<[string, string]> = [];
    const push = createFrameDemuxer((kind, data) =>
      seen.push([kind, data.toString()]),
    );
    const bytes = Buffer.concat([frame(1, "out"), frame(2, "err!")]);
    push(bytes.subarray(0, 5));
    push(bytes.subarray(5, 13));
    push(bytes.subarray(13));
    expect(seen).toEqual([
      ["stdout", "out"],
      ["stderr", "err!"],
    ]);
  });
});

describe("sandbox naming and config", () => {
  it("derives stable, distinct names per user", () => {
    expect(containerNameFor("user_a")).toBe(containerNameFor("user_a"));
    expect(containerNameFor("user_a")).not.toBe(containerNameFor("user_b"));
    expect(volumeNameFor("user_a")).toMatch(/^hackerai-home-[0-9a-f]{24}$/);
  });

  it("reads limits from the environment with safe fallbacks", () => {
    const config = readSandboxConfig({
      DOCKER_SANDBOX_IMAGE: "me/img:1",
      SANDBOX_MEMORY_MB: "512",
      SANDBOX_CPUS: "nope",
      SANDBOX_IDLE_TIMEOUT_SECONDS: "0",
    });
    expect(config.image).toBe("me/img:1");
    expect(config.memoryBytes).toBe(512 * 1024 * 1024);
    expect(config.cpus).toBe(2);
    expect(config.idleSeconds).toBe(0);
  });
});
