/**
 * Exercises exec.ts / sandbox.ts / provisioner.ts against a fake Docker Engine
 * (no daemon, no sockets): exec output is emulated with Docker's multiplexed
 * frames and the in-sandbox PID marker printed by the sh wrapper.
 */
import { Duplex } from "node:stream";
import type { DockerEngine } from "../engine";
import {
  CommandExitError,
  DockerEngineError,
  InvalidArgumentError,
  NotFoundError,
  SandboxError,
  TimeoutError,
} from "../errors";
import { startExec } from "../exec";
import {
  containerNameFor,
  destroyUserSandbox,
  ensureUserSandbox,
  readSandboxConfig,
  SANDBOX_LABEL,
  SANDBOX_USER_LABEL,
  volumeNameFor,
} from "../provisioner";
import { DockerSandbox } from "../sandbox";

// ── fake engine ──────────────────────────────────────────────────────────

const frame = (type: 1 | 2, text: string | Buffer) => {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};
const marker = (pid: number | string) => `\u0001HAIPID:${pid}\n`;

type Script = {
  /** Raw bytes the "container" emits, in order, as separate socket chunks. */
  chunks: Buffer[];
  exitCode?: number;
  /** Keep the connection open (background / interactive processes). */
  hold?: boolean;
  /** Number of exec-inspect polls that still report Running. */
  runningPolls?: number;
};

const done = (
  opts: {
    pid?: number;
    out?: string;
    err?: string;
    exitCode?: number;
  } = {},
): Script => ({
  chunks: [
    frame(1, marker(opts.pid ?? 100) + (opts.out ?? "")),
    ...(opts.err ? [frame(2, opts.err)] : []),
  ],
  exitCode: opts.exitCode ?? 0,
});

class FakeSocket extends Duplex {
  private readonly received: Buffer[] = [];
  _read() {}
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.received.push(Buffer.from(chunk));
    cb();
  }
  get stdin(): Buffer {
    return Buffer.concat(this.received);
  }
}

type ExecRecord = {
  id: string;
  body: {
    AttachStdin: boolean;
    Tty: boolean;
    User: string;
    WorkingDir?: string;
    Env: string[];
    Cmd: string[];
  };
  script: Script;
  socket: FakeSocket;
  polls: number;
};

class FakeEngine {
  readonly execs: ExecRecord[] = [];
  readonly calls: Array<{ key: string; opts: any }> = [];
  readonly routes = new Map<string, (opts: any) => unknown>();
  scriptFor: (cmd: string[]) => Script = () => done();

  private dispatch(method: string, path: string, opts: any = {}): unknown {
    const key = `${method} ${path}`;
    this.calls.push({ key, opts });
    const route = this.routes.get(key);
    if (route) return route(opts);
    if (/^POST \/containers\/[^/]+\/exec$/.test(key)) {
      const id = `exec${this.execs.length + 1}`;
      const body = opts.json;
      this.execs.push({
        id,
        body,
        script: this.scriptFor(body.Cmd),
        socket: new FakeSocket(),
        polls: 0,
      });
      return { Id: id };
    }
    const inspectMatch = /^GET \/exec\/([^/]+)\/json$/.exec(key);
    if (inspectMatch) {
      const exec = this.execs.find((e) => e.id === inspectMatch[1])!;
      const running = exec.polls++ < (exec.script.runningPolls ?? 0);
      return {
        Running: running,
        ExitCode: running ? null : (exec.script.exitCode ?? 0),
      };
    }
    throw new Error(`Unrouted fake engine call: ${key}`);
  }

  request = jest.fn(async (method: string, path: string, opts?: any) => {
    this.dispatch(method, path, opts);
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  });

  json = jest.fn(async (method: string, path: string, opts?: any) =>
    this.dispatch(method, path, opts),
  );

  hijack = jest.fn(async (path: string) => {
    const id = /^\/exec\/([^/]+)\/start$/.exec(path)![1];
    const exec = this.execs.find((e) => e.id === id)!;
    setTimeout(() => {
      for (const chunk of exec.script.chunks) exec.socket.push(chunk);
      if (!exec.script.hold) exec.socket.push(null);
    }, 0);
    return { socket: exec.socket, head: Buffer.alloc(0) };
  });

  asEngine = () => this as unknown as DockerEngine;
  /** Finish a held process from the "container" side. */
  finish(index = 0) {
    this.execs[index].socket.push(null);
  }
}

const sandboxOn = (engine: FakeEngine) =>
  new DockerSandbox(
    "cid",
    { userId: "u1", containerName: "n" },
    engine.asEngine(),
  );

// ── startExec ────────────────────────────────────────────────────────────

describe("startExec", () => {
  it("strips the PID marker, demuxes stdout/stderr and reads the exit code from exec inspect", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () => ({
      chunks: [
        // marker and first output bytes arrive in one frame, split mid-marker
        frame(1, "\u0001HAIPI"),
        frame(1, "D:4321\nhello "),
        frame(2, "warn\n"),
        frame(1, "world\n"),
      ],
      exitCode: 7,
    });
    const out: string[] = [];
    const err: string[] = [];
    const proc = await startExec(engine.asEngine(), "cid", {
      cmd: ["echo"],
      onStdout: (t) => out.push(t),
      onStderr: (t) => err.push(t),
    });
    const result = await proc.wait();

    expect(proc.pid).toBe(4321);
    expect(result).toEqual({
      exitCode: 7,
      stdout: "hello world\n",
      stderr: "warn\n",
    });
    expect(out.join("")).toBe("hello world\n");
    expect(err.join("")).toBe("warn\n");
  });

  it("does not split multibyte characters across frames", async () => {
    const engine = new FakeEngine();
    const euro = Buffer.from("€");
    engine.scriptFor = () => ({
      chunks: [
        frame(1, Buffer.concat([Buffer.from(marker(9)), euro.subarray(0, 1)])),
        frame(1, euro.subarray(1)),
      ],
    });
    const proc = await startExec(engine.asEngine(), "cid", { cmd: ["x"] });
    expect((await proc.wait()).stdout).toBe("€");
  });

  it("waits while exec inspect still reports Running instead of returning a premature exit code", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () => ({ ...done({ exitCode: 3 }), runningPolls: 2 });
    const proc = await startExec(engine.asEngine(), "cid", { cmd: ["x"] });
    expect((await proc.wait()).exitCode).toBe(3);
    expect(engine.execs[0].polls).toBe(3);
  });

  it("runs the command through the PID wrapper with user, cwd and env from the options", async () => {
    const engine = new FakeEngine();
    const proc = await startExec(engine.asEngine(), "cid", {
      cmd: ["/bin/ls", "-la"],
      cwd: "/work",
      user: "user",
      env: { A: "1" },
    });
    await proc.wait();
    const { body } = engine.execs[0];
    // original argv must follow the wrapper untouched so `exec "$@"` runs it
    expect(body.Cmd.slice(-2)).toEqual(["/bin/ls", "-la"]);
    expect(body.Cmd.slice(0, 3)[0]).toBe("/bin/sh");
    expect(body.Cmd[3]).toBe("sh");
    expect(body).toMatchObject({
      User: "user",
      WorkingDir: "/work",
      Env: ["A=1"],
      AttachStdin: false,
      Tty: false,
    });
  });

  it("rejects when the stream ends before the marker arrives", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () => ({ chunks: [frame(2, "sh: not found\n")] });
    await expect(
      startExec(engine.asEngine(), "cid", { cmd: ["x"] }),
    ).rejects.toThrow(/ended before reporting its id/);
  });

  it("rejects a malformed or non-positive PID marker", async () => {
    for (const bad of ["abc", "0", "-5", "1.5"]) {
      const engine = new FakeEngine();
      engine.scriptFor = () => ({ chunks: [frame(1, marker(bad))] });
      await expect(
        startExec(engine.asEngine(), "cid", { cmd: ["x"] }),
      ).rejects.toThrow(/did not report a process id/);
    }
  });

  it("times out with TimeoutError and drops the connection when the marker never arrives", async () => {
    jest.useFakeTimers();
    try {
      const engine = new FakeEngine();
      engine.scriptFor = () => ({ chunks: [], hold: true });
      const started = startExec(engine.asEngine(), "cid", { cmd: ["x"] });
      const assertion = expect(started).rejects.toBeInstanceOf(TimeoutError);
      await jest.advanceTimersByTimeAsync(15_001);
      await assertion;
      expect(engine.execs[0].socket.destroyed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("maps a missing or stopped container to NotFoundError", async () => {
    for (const status of [404, 409]) {
      const engine = new FakeEngine();
      engine.routes.set("POST /containers/cid/exec", () => {
        throw new DockerEngineError(status, "no such container");
      });
      await expect(
        startExec(engine.asEngine(), "cid", { cmd: ["x"] }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("writes stdin once and closes it unless the process is interactive", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () => ({ ...done(), hold: true });
    const oneShot = await startExec(engine.asEngine(), "cid", {
      cmd: ["cat"],
      stdin: "payload",
    });
    expect(engine.execs[0].socket.stdin.toString()).toBe("payload");
    expect(engine.execs[0].socket.writableEnded).toBe(true);
    expect(engine.execs[0].body.AttachStdin).toBe(true);
    oneShot.detach();

    const interactive = await startExec(engine.asEngine(), "cid", {
      cmd: ["cat"],
      stdin: "first",
      interactive: true,
    });
    expect(engine.execs[1].socket.writableEnded).toBe(false);
    await interactive.write("second");
    expect(engine.execs[1].socket.stdin.toString()).toBe("firstsecond");
    interactive.detach();
  });
});

// ── DockerSandbox.commands ───────────────────────────────────────────────

describe("DockerSandbox.commands.run", () => {
  it("returns stdout, stderr, exit code and PID on success and runs the command via bash -l -c in the home dir", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () => done({ pid: 77, out: "ok\n", err: "note\n" });
    const result = await sandboxOn(engine).commands.run("echo ok && true");

    expect(result).toEqual({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "note\n",
      pid: 77,
    });
    const { body } = engine.execs[0];
    expect(body.Cmd.slice(-4)).toEqual([
      "/bin/bash",
      "-l",
      "-c",
      "echo ok && true",
    ]);
    expect(body.WorkingDir).toBe("/home/user");
  });

  it("throws CommandExitError carrying exit code, stdout and stderr on non-zero exit", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () =>
      done({ out: "partial", err: "boom\n", exitCode: 3 });
    const error = await sandboxOn(engine)
      .commands.run("false")
      .catch((e) => e);

    expect(error).toBeInstanceOf(CommandExitError);
    expect(error).toMatchObject({
      exitCode: 3,
      stdout: "partial",
      stderr: "boom\n",
      message: "boom",
    });
  });

  it("rejects an empty command without starting an exec", async () => {
    const engine = new FakeEngine();
    await expect(sandboxOn(engine).commands.run("")).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    expect(engine.execs).toHaveLength(0);
  });

  it("stops waiting after timeoutMs, reports TimeoutError and drops the connection but not the process", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () => ({ ...done(), hold: true });
    await expect(
      sandboxOn(engine).commands.run("sleep 999", { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(engine.execs[0].socket.destroyed).toBe(true);
    // only the exec stream is dropped; nothing sent a kill command
    expect(engine.execs).toHaveLength(1);
  });

  it("background runs return a handle immediately with pid, stdin control and a failing wait()", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () => ({
      ...done({ pid: 555 }),
      hold: true,
      exitCode: 2,
    });
    const handle = await sandboxOn(engine).commands.run("server", {
      background: true,
      stdin: true,
    });

    expect(handle.pid).toBe(555);
    expect(engine.execs[0].body.AttachStdin).toBe(true);

    await handle.sendStdin("ping\n");
    expect(engine.execs[0].socket.stdin.toString()).toBe("ping\n");
    await handle.closeStdin();
    expect(engine.execs[0].socket.writableEnded).toBe(true);
    // a closed stdin must not accept more data
    await expect(handle.sendStdin("late")).rejects.toThrow(/stdin is closed/);

    engine.finish();
    await expect(handle.wait()).rejects.toMatchObject({ exitCode: 2 });
    expect(handle.exitCode).toBe(2);
  });

  it("kill() sends SIGKILL to the in-sandbox PID, and refuses non-positive PIDs", async () => {
    const engine = new FakeEngine();
    const sandbox = sandboxOn(engine);
    expect(await sandbox.commands.kill(0)).toBe(false);
    expect(await sandbox.commands.kill(-1)).toBe(false);
    expect(engine.execs).toHaveLength(0);

    expect(await sandbox.commands.kill(321)).toBe(true);
    const script = engine.execs[0].body.Cmd[6];
    expect(script).toContain("kill -9 321");
    expect(script).toContain("kill -9 -- -321");

    engine.scriptFor = () => done({ exitCode: 1 });
    expect(await sandbox.commands.kill(321)).toBe(false);
  });
});

// ── DockerSandbox.files ──────────────────────────────────────────────────

describe("DockerSandbox.files", () => {
  const statLine = (
    kind: string,
    size: number,
    mode: string,
    mtime: number,
    name: string,
  ) => [kind, size, mode, mtime, name].join("\t");

  it("write passes path and byte length as positional args (never interpolated) and streams the data on stdin", async () => {
    const engine = new FakeEngine();
    const path = "/home/user/my dir/$(touch pwned)/f.txt";
    await sandboxOn(engine).files.write(path, "hello");

    const { Cmd } = engine.execs[0].body;
    expect(Cmd.slice(0, 3)[0]).toBe("/bin/sh");
    // Args are [path, byteLength]: the script reads exactly that many bytes so
    // it never depends on stdin EOF (unsupported by some Engine transports).
    expect(Cmd[Cmd.length - 2]).toBe(path);
    expect(Cmd[Cmd.length - 1]).toBe("5");
    const script = Cmd[6];
    expect(script).not.toContain("pwned");
    expect(script).toContain("mkdir -p");
    expect(script).toContain('head -c "$2" > "$1"');
    expect(engine.execs[0].socket.stdin.toString()).toBe("hello");
  });

  it("write preserves binary payloads byte for byte", async () => {
    const engine = new FakeEngine();
    const bytes = new Uint8Array([0, 255, 10, 13, 128]);
    await sandboxOn(engine).files.write("/home/user/b.bin", bytes);
    expect([...engine.execs[0].socket.stdin]).toEqual([...bytes]);
    await sandboxOn(engine).files.write("/home/user/c.bin", bytes.buffer);
    expect([...engine.execs[1].socket.stdin]).toEqual([...bytes]);
  });

  it("rejects relative or NUL-containing paths before touching the container", async () => {
    const engine = new FakeEngine();
    const files = sandboxOn(engine).files;
    for (const bad of ["rel/path", "", "/a\0b"]) {
      await expect(files.read(bad)).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
      await expect(files.write(bad, "x")).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
      await expect(files.list(bad)).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
      await expect(files.stat(bad)).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
    }
    expect(engine.execs).toHaveLength(0);
  });

  it("read returns text, and bytes via base64 so binary data survives UTF-8 decoding", async () => {
    const engine = new FakeEngine();
    const sandbox = sandboxOn(engine);
    engine.scriptFor = () => done({ out: "line1\nline2" });
    expect(await sandbox.files.read("/home/user/a.txt")).toBe("line1\nline2");
    expect(engine.execs[0].body.Cmd[6]).toContain("cat --");

    const raw = Buffer.from([0, 255, 254, 1]);
    engine.scriptFor = () => done({ out: raw.toString("base64") });
    const bytes = await sandbox.files.read("/home/user/a.bin", {
      format: "bytes",
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([...raw]);
    expect(engine.execs[1].body.Cmd[6]).toContain("base64");
  });

  it("maps missing paths to NotFoundError but other failures to a plain SandboxError", async () => {
    const sandbox = (script: Script) => {
      const engine = new FakeEngine();
      engine.scriptFor = () => script;
      return sandboxOn(engine);
    };
    const missing = done({
      err: "cat: /x: No such file or directory\n",
      exitCode: 1,
    });
    await expect(sandbox(missing).files.read("/x")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(sandbox(missing).files.stat("/x")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      sandbox(done({ exitCode: 44 })).files.list("/nope"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      sandbox(
        done({ err: "cat: /d: Not a directory\n", exitCode: 1 }),
      ).files.write("/d/f", "x"),
    ).rejects.toBeInstanceOf(NotFoundError);

    const denied = await sandbox(
      done({ err: "cat: /root/x: Permission denied\n", exitCode: 1 }),
    )
      .files.write("/root/x", "x")
      .catch((e) => e);
    expect(denied).toBeInstanceOf(SandboxError);
    expect(denied).not.toBeInstanceOf(NotFoundError);
    expect(denied.message).toMatch(/Permission denied/);
  });

  it("list parses stat output into typed entries rooted at the listed directory", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () =>
      done({
        out: [
          statLine("directory", 4096, "755", 1_700_000_000, "src"),
          statLine("regular file", 12, "644", 1_700_000_500, "notes.txt"),
          "",
        ].join("\n"),
      });
    const entries = await sandboxOn(engine).files.list("/home/user/");

    expect(entries).toEqual([
      {
        name: "src",
        path: "/home/user/src",
        type: "dir",
        size: 4096,
        mode: 0o755,
        modifiedTime: new Date(1_700_000_000_000),
      },
      {
        name: "notes.txt",
        path: "/home/user/notes.txt",
        type: "file",
        size: 12,
        mode: 0o644,
        modifiedTime: new Date(1_700_000_500_000),
      },
    ]);
    // listing must cd into the directory given as $1, not interpolate it
    expect(engine.execs[0].body.Cmd.slice(-1)).toEqual(["/home/user/"]);
  });

  it("stat returns the requested path (not stat's relative name) and getInfo agrees", async () => {
    const engine = new FakeEngine();
    engine.scriptFor = () =>
      done({
        out:
          statLine(
            "regular file",
            5,
            "600",
            1_700_000_000,
            "/home/user/s.txt",
          ) + "\n",
      });
    const sandbox = sandboxOn(engine);
    const info = await sandbox.files.stat("/home/user/s.txt");
    expect(info).toMatchObject({
      name: "s.txt",
      path: "/home/user/s.txt",
      type: "file",
      size: 5,
      mode: 0o600,
    });
    expect(await sandbox.files.getInfo("/home/user/s.txt")).toEqual(info);
  });

  it("exists reflects the exit status of test -e", async () => {
    const engine = new FakeEngine();
    const sandbox = sandboxOn(engine);
    expect(await sandbox.files.exists("/a")).toBe(true);
    engine.scriptFor = () => done({ exitCode: 1 });
    expect(await sandbox.files.exists("/a")).toBe(false);
  });
});

// ── provisioner ──────────────────────────────────────────────────────────

const CONFIG = { ...readSandboxConfig({}), idleSeconds: 0 };
const NAME = containerNameFor("u1");

const info = (over: {
  running?: boolean;
  user?: string | null;
  id?: string;
}) => ({
  Id: over.id ?? "cid123",
  Name: `/${NAME}`,
  State: { Running: over.running ?? true, Status: "x" },
  Config: {
    Labels:
      over.user === null
        ? {}
        : { [SANDBOX_LABEL]: "1", [SANDBOX_USER_LABEL]: over.user ?? "u1" },
  },
});

const notFound = () => new DockerEngineError(404, "no such container");
const keysOf = (engine: FakeEngine) => engine.calls.map((c) => c.key);

describe("ensureUserSandbox", () => {
  it("creates the container when inspect returns 404, bound to the user's volume and labelled with the owner", async () => {
    const engine = new FakeEngine();
    let exists = false;
    engine.routes.set(`GET /containers/${NAME}/json`, () => {
      if (!exists) throw notFound();
      return info({});
    });
    engine.routes.set("POST /containers/create", () => {
      exists = true;
      return { Id: "cid123" };
    });

    const { sandbox, created } = await ensureUserSandbox("u1", {
      engine: engine.asEngine(),
      config: CONFIG,
    });

    expect(created).toBe(true);
    expect(sandbox.sandboxId).toBe("cid123");
    const create = engine.calls.find(
      (c) => c.key === "POST /containers/create",
    )!;
    expect(create.opts.query).toEqual({ name: NAME });
    expect(create.opts.json.Labels).toEqual({
      [SANDBOX_LABEL]: "1",
      [SANDBOX_USER_LABEL]: "u1",
    });
    expect(create.opts.json.HostConfig.Binds).toEqual([
      `${volumeNameFor("u1")}:/home/user`,
    ]);
    // already running after create: must not issue a start
    expect(keysOf(engine).some((k) => k.endsWith("/start"))).toBe(false);
  });

  it("pulls the image once and retries when create reports the image missing", async () => {
    const engine = new FakeEngine();
    let exists = false;
    let creates = 0;
    engine.routes.set(`GET /containers/${NAME}/json`, () => {
      if (!exists) throw notFound();
      return info({});
    });
    engine.routes.set("POST /containers/create", () => {
      if (creates++ === 0) throw new DockerEngineError(404, "No such image");
      exists = true;
      return { Id: "cid123" };
    });
    engine.routes.set("POST /images/create", () => ({}));

    await ensureUserSandbox("u1", {
      engine: engine.asEngine(),
      config: { ...CONFIG, image: "reg.example/team/img:v2" },
    });

    expect(creates).toBe(2);
    const pull = engine.calls.find((c) => c.key === "POST /images/create")!;
    expect(pull.opts.query).toEqual({
      fromImage: "reg.example/team/img",
      tag: "v2",
    });
  });

  it("starts an existing stopped container and reports created=false", async () => {
    const engine = new FakeEngine();
    let running = false;
    engine.routes.set(`GET /containers/${NAME}/json`, () => info({ running }));
    engine.routes.set("GET /containers/cid123/json", () => info({ running }));
    engine.routes.set("POST /containers/cid123/start", () => {
      running = true;
      return {};
    });

    const { sandbox, created } = await ensureUserSandbox("u1", {
      engine: engine.asEngine(),
      config: CONFIG,
    });

    expect(created).toBe(false);
    expect(sandbox.sandboxId).toBe("cid123");
    expect(keysOf(engine)).toContain("POST /containers/cid123/start");
    expect(keysOf(engine)).not.toContain("POST /containers/create");
    // 304 (already started by someone else) must be accepted by the start call
    const start = engine.calls.find((c) => c.key.endsWith("/start"))!;
    expect(start.opts.okStatuses).toContain(304);
  });

  it("tolerates a 409 create race and adopts the container the other caller made", async () => {
    const engine = new FakeEngine();
    let inspects = 0;
    engine.routes.set(`GET /containers/${NAME}/json`, () => {
      // existence check and pre-create inspect see nothing; the post-409 one finds it
      if (inspects++ < 2) throw notFound();
      return info({});
    });
    engine.routes.set("POST /containers/create", () => {
      throw new DockerEngineError(409, "name already in use");
    });

    const { sandbox } = await ensureUserSandbox("u1", {
      engine: engine.asEngine(),
      config: CONFIG,
    });

    expect(sandbox.sandboxId).toBe("cid123");
    expect(
      keysOf(engine).filter((k) => k === "POST /containers/create"),
    ).toHaveLength(1);
  });

  it("surfaces other create failures instead of swallowing them", async () => {
    const engine = new FakeEngine();
    engine.routes.set(`GET /containers/${NAME}/json`, () => {
      throw notFound();
    });
    engine.routes.set("POST /containers/create", () => {
      throw new DockerEngineError(500, "daemon exploded");
    });
    await expect(
      ensureUserSandbox("u1", { engine: engine.asEngine(), config: CONFIG }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("rejects a container whose owner label does not match, without starting or touching it", async () => {
    for (const user of ["someone-else", null]) {
      const engine = new FakeEngine();
      engine.routes.set(`GET /containers/${NAME}/json`, () =>
        info({ running: false, user }),
      );
      await expect(
        ensureUserSandbox("u1", { engine: engine.asEngine(), config: CONFIG }),
      ).rejects.toThrow(/ownership mismatch/);
      expect(keysOf(engine)).toEqual([
        `GET /containers/${NAME}/json`,
        `GET /containers/${NAME}/json`,
      ]);
    }
  });

  it("requires a user id", async () => {
    await expect(
      ensureUserSandbox("", { engine: new FakeEngine().asEngine() }),
    ).rejects.toBeInstanceOf(SandboxError);
  });
});

describe("destroyUserSandbox", () => {
  it("removes the container first and only then the workspace volume", async () => {
    const engine = new FakeEngine();
    engine.routes.set(`GET /containers/${NAME}/json`, () => info({}));
    engine.routes.set("DELETE /containers/cid123", () => ({}));
    engine.routes.set(`DELETE /volumes/${volumeNameFor("u1")}`, () => ({}));

    const result = await destroyUserSandbox("u1", {
      engine: engine.asEngine(),
    });

    expect(result).toEqual({ containerRemoved: true, volumeRemoved: true });
    expect(keysOf(engine)).toEqual([
      `GET /containers/${NAME}/json`,
      "DELETE /containers/cid123",
      `DELETE /volumes/${volumeNameFor("u1")}`,
    ]);
  });

  it("still removes the volume when the container is already gone, and tolerates a missing volume", async () => {
    const engine = new FakeEngine();
    engine.routes.set(`GET /containers/${NAME}/json`, () => {
      throw notFound();
    });
    engine.routes.set(`DELETE /volumes/${volumeNameFor("u1")}`, () => {
      throw notFound();
    });
    expect(
      await destroyUserSandbox("u1", { engine: engine.asEngine() }),
    ).toEqual({ containerRemoved: false, volumeRemoved: false });
  });

  it("refuses to delete anything when the container belongs to another user", async () => {
    const engine = new FakeEngine();
    engine.routes.set(`GET /containers/${NAME}/json`, () =>
      info({ user: "someone-else" }),
    );
    await expect(
      destroyUserSandbox("u1", { engine: engine.asEngine() }),
    ).rejects.toThrow(/ownership mismatch/);
    expect(keysOf(engine).some((k) => k.startsWith("DELETE"))).toBe(false);
  });

  it("propagates a volume removal failure other than 404 (e.g. volume in use)", async () => {
    const engine = new FakeEngine();
    engine.routes.set(`GET /containers/${NAME}/json`, () => info({}));
    engine.routes.set("DELETE /containers/cid123", () => ({}));
    engine.routes.set(`DELETE /volumes/${volumeNameFor("u1")}`, () => {
      throw new DockerEngineError(409, "volume is in use");
    });
    await expect(
      destroyUserSandbox("u1", { engine: engine.asEngine() }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
