// packages/subprocess-k8s/src/index.ts
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// packages/subprocess-k8s/src/client.ts
var DaemonError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var DaemonSubprocessClient = class _DaemonSubprocessClient {
  constructor(baseUrl, endpointOverride) {
    this.baseUrl = baseUrl;
    this.endpointOverride = endpointOverride;
  }
  baseUrl;
  endpointOverride;
  get defaultEndpoint() {
    return this.baseUrl;
  }
  /** A client pinned to one daemon endpoint (used after per-call resolution). */
  withEndpoint(endpoint) {
    return new _DaemonSubprocessClient(this.baseUrl, endpoint);
  }
  get endpoint() {
    return this.endpointOverride ?? this.baseUrl;
  }
  async resolveExecutable(command) {
    const data = await this.post("/commands/resolve-executable", { command });
    return data.path;
  }
  async run(spec) {
    const data = await this.post("/commands/run", {
      spec: {
        argv: [...spec.argv],
        cwd: spec.cwd,
        env: spec.env,
        stdin: spec.stdin !== void 0 ? Buffer.from(spec.stdin).toString("base64") : void 0,
        timeoutMs: spec.timeoutMs
      }
    });
    return data;
  }
  async writeStdin(cmdId, data) {
    await this.post(`/commands/${cmdId}/stdin`, { data: Buffer.from(data).toString("base64") });
  }
  async closeStdin(cmdId) {
    await this.post(`/commands/${cmdId}/close-stdin`, {});
  }
  async status(cmdId) {
    const data = await this.get(`/commands/${cmdId}/status`);
    return data.status;
  }
  async readOutput(cmdId, stream, from) {
    const data = await this.get(`/commands/${cmdId}/output?stream=${stream}&from=${from}`);
    return data;
  }
  async kill(cmdId, graceMs) {
    const data = await this.post(`/commands/${cmdId}/kill`, { graceMs });
    return data.status;
  }
  async createPty(spec) {
    const data = await this.post("/ptys", { spec: { argv: [...spec.argv], cwd: spec.cwd, env: spec.env, rows: spec.rows, cols: spec.cols } });
    return data;
  }
  async ptyWrite(ptyId, data) {
    await this.post(`/ptys/${ptyId}/write`, { data: Buffer.from(data, "utf8").toString("base64") });
  }
  async ptyResize(ptyId, rows, cols) {
    await this.post(`/ptys/${ptyId}/resize`, { rows, cols });
  }
  async ptySignal(ptyId, sig) {
    await this.post(`/ptys/${ptyId}/signal`, { sig });
  }
  async ptyStatus(ptyId) {
    const data = await this.get(`/ptys/${ptyId}/status`);
    return data.phase;
  }
  async ptyOutput(ptyId, from) {
    const data = await this.get(`/ptys/${ptyId}/output?from=${from}`);
    return data;
  }
  async ptyTerminate(ptyId, graceMs) {
    await this.post(`/ptys/${ptyId}/terminate`, { graceMs });
  }
  async post(path, body) {
    let res;
    try {
      res = await fetch(this.endpoint + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      throw new DaemonError("DAEMON_UNREACHABLE", `sandbox daemon unreachable: ${e.message}`);
    }
    const payload = await res.json();
    if (!payload.ok) throw new DaemonError(payload.data?.error?.code ?? "ERROR", payload.data?.error?.message ?? "daemon error");
    return payload.data;
  }
  async get(path) {
    let res;
    try {
      res = await fetch(this.endpoint + path);
    } catch (e) {
      throw new DaemonError("DAEMON_UNREACHABLE", `sandbox daemon unreachable: ${e.message}`);
    }
    const payload = await res.json();
    if (!payload.ok) throw new DaemonError(payload.data?.error?.code ?? "ERROR", payload.data?.error?.message ?? "daemon error");
    return payload.data;
  }
};

// packages/subprocess-k8s/src/output.ts
import { Readable } from "node:stream";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// packages/sandbox-daemon/src/protocol.ts
var EOF_MARKER = "!dsh-e2b-output-complete!";

// packages/sandbox-daemon/src/framing.ts
var BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/;
var FrameDecoder = class {
  buffer = "";
  eof = false;
  get eofReceived() {
    return this.eof;
  }
  push(chunk, out) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line === "") continue;
      if (line === EOF_MARKER) {
        this.eof = true;
        continue;
      }
      if (!BASE64_LINE.test(line) || line.length % 4 !== 0) {
        throw new Error(`invalid base64 frame: ${JSON.stringify(line.slice(0, 32))}`);
      }
      const bytes = Buffer.from(line, "base64");
      if (bytes.toString("base64") !== line) {
        throw new Error(`non-canonical base64 frame: ${JSON.stringify(line.slice(0, 32))}`);
      }
      out.push(new Uint8Array(bytes));
    }
  }
};

// packages/subprocess-k8s/src/output.ts
var FramePoller = class {
  constructor(source, out, onEof, pollMs = 100) {
    this.source = source;
    this.out = out;
    this.onEof = onEof;
    this.pollMs = pollMs;
  }
  source;
  out;
  onEof;
  pollMs;
  offset = 0;
  stopped = false;
  timer;
  decoder = new FrameDecoder();
  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    if (this.timer !== void 0) clearInterval(this.timer);
  }
  async tick() {
    if (this.stopped) return;
    try {
      const { frames, nextOffset } = await this.source.read(this.offset);
      if (frames.length > 0) {
        const decoded = [];
        this.decoder.push(frames, decoded);
        for (const d of decoded) this.out.push(Buffer.from(d));
        this.offset = nextOffset;
      }
    } catch {
    }
  }
  finish() {
    this.stop();
    this.onEof();
  }
};
var CollectReader = class {
  constructor(collect, spillDir) {
    this.collect = collect;
    if (collect.spill !== void 0) {
      mkdirSync(spillDir, { recursive: true });
      this.spillPath = join(spillDir, `spill-${randomUUID()}.log`);
    }
  }
  collect;
  buffer = Buffer.alloc(0);
  spillPath;
  spillStream;
  offset = 0;
  lossy = false;
  get path() {
    return this.spillPath;
  }
  append(bytes) {
    if (this.spillStream !== void 0) {
      if (this.offset + this.buffer.length + bytes.length <= this.collect.spill.maxBytes) {
        this.spillStream.write(Buffer.from(bytes));
      } else if (existsSync(this.spillPath)) {
        this.spillStream.end();
        this.spillStream = void 0;
        rmSync(this.spillPath, { force: true });
      }
    }
    const combined = Buffer.concat([this.buffer, Buffer.from(bytes)]);
    if (combined.length > this.collect.maxBytes) {
      this.lossy = true;
      this.buffer = combined.subarray(combined.length - this.collect.maxBytes);
    } else {
      this.buffer = combined;
    }
  }
  close() {
    this.spillStream?.end();
  }
  readFrom(fromByte) {
    const start = Math.max(fromByte - this.offset, 0);
    const text = this.buffer.subarray(start).toString("utf8");
    return {
      text,
      nextOffset: this.offset + this.buffer.length,
      lossy: this.lossy || start > 0,
      spillPath: this.spillPath !== void 0 && existsSync(this.spillPath) ? this.spillPath : void 0
    };
  }
};
function makePipe(source, onEof) {
  const out = new Readable({ read() {
  } });
  const poller = new FramePoller(source, out, onEof);
  poller.start();
  out.on("close", () => poller.stop());
  return out;
}
var CollectPoller = class {
  constructor(source, reader, onEof, pollMs = 100) {
    this.source = source;
    this.reader = reader;
    this.onEof = onEof;
    this.pollMs = pollMs;
  }
  source;
  reader;
  onEof;
  pollMs;
  offset = 0;
  stopped = false;
  timer;
  decoder = new FrameDecoder();
  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    if (this.timer !== void 0) clearInterval(this.timer);
  }
  /** One final read so no buffered frame is left uncollected before stop. */
  async flush() {
    await this.tick();
  }
  async tick() {
    if (this.stopped) return;
    try {
      const { frames, nextOffset } = await this.source.read(this.offset);
      if (frames.length > 0) {
        const decoded = [];
        this.decoder.push(frames, decoded);
        for (const d of decoded) this.reader.append(d);
        this.offset = nextOffset;
      }
    } catch {
    }
  }
};

// packages/subprocess-k8s/src/index.ts
var name = "@visecy/dsh-subprocess-k8s";
var SubprocessK8s = class extends SubprocessRuntime {
  client;
  spillDir;
  resolver;
  constructor(ctx, config) {
    super(ctx);
    this.client = new DaemonSubprocessClient(config.daemonEndpoint);
    this.spillDir = mkdtempSync(join2(tmpdir(), "dsh-subprocess-k8s-"));
    this.resolver = config.resolveEndpoint;
  }
  /** The workspace id from a host path like /workspaces/<id>/... */
  workspaceOf(cwd) {
    const m = /^\/workspaces\/([^/]+)/.exec(cwd);
    return m?.[1];
  }
  /** Resolve the daemon endpoint for a cwd (per-workspace pod) or the static one. */
  async endpointFor(cwd) {
    const resolver = this.resolver ?? this.ctx.workspaceEndpointResolver?.resolve;
    if (resolver === void 0) return this.client.defaultEndpoint;
    const ws = this.workspaceOf(cwd);
    if (ws === void 0) return this.client.defaultEndpoint;
    return resolver(ws);
  }
  async resolveExecutable(command, env, signal) {
    return this.client.resolveExecutable(command);
  }
  spawn(spec) {
    const handle = new RemoteHandle(
      () => this.endpointFor(spec.cwd).then((ep) => this.client.withEndpoint(ep)),
      spec,
      this.spillDir
    );
    void handle.start();
    return handle;
  }
  async spawnTerminal(spec) {
    const ep = await this.endpointFor(spec.cwd);
    const bound = this.client.withEndpoint(ep);
    const created = await bound.createPty({ argv: spec.argv, cwd: spec.cwd, env: spec.env, rows: spec.rows, cols: spec.cols });
    return new RemoteTerminalHandle(bound, created.ptyId, created.pid, spec);
  }
};
var RemoteHandle = class {
  constructor(clientFactory, spec, spillDir) {
    this.clientFactory = clientFactory;
    this.spec = spec;
    this.client = new DaemonSubprocessClient("http://placeholder.invalid:1");
    this.pid = -1;
    this.cmdId = "";
    this.done = new Promise((res) => {
      this.resolveDone = res;
    });
    if (spec.stdio.stdin === "pipe") {
      this.stdin = new Writable({
        write: (chunk, _enc, cb) => {
          this.client.writeStdin(this.cmdId, new Uint8Array(chunk)).then(() => cb(), (e) => cb(e));
        },
        final: (cb) => {
          this.client.closeStdin(this.cmdId).then(() => cb(), (e) => cb(e));
        }
      });
    }
    const mkCollect = (stream) => {
      const mode = stream === "stdout" ? spec.stdio.stdout : spec.stdio.stderr;
      if (typeof mode !== "object") return void 0;
      const reader = new CollectReader(mode, spillDir);
      const poller = new CollectPoller(
        { read: (from) => this.client.readOutput(this.cmdId, stream, from) },
        reader,
        () => void 0
      );
      poller.start();
      this.pollers.push(poller);
      return reader;
    };
    this.collected.stdout = mkCollect("stdout");
    this.collected.stderr = mkCollect("stderr");
  }
  clientFactory;
  spec;
  pid;
  stdin;
  stdout;
  stderr;
  collected = {};
  done;
  cmdId;
  resolveDone;
  pollers = [];
  terminated = false;
  client;
  async start() {
    try {
      this.client = await this.clientFactory();
      const stdinData = this.spec.stdio.stdin !== "ignore" && this.spec.stdio.stdin !== "pipe" ? new TextEncoder().encode(this.spec.stdio.stdin.data) : void 0;
      const info = await this.client.run({
        argv: this.spec.argv,
        cwd: this.spec.cwd,
        env: this.spec.env,
        stdin: stdinData
      });
      this.pid = info.pid;
      this.cmdId = info.cmdId;
      if (this.spec.stdio.stdout === "pipe") {
        ;
        this.stdout = makePipe(
          { read: (from) => this.client.readOutput(info.cmdId, "stdout", from) },
          () => void 0
        );
      }
      if (this.spec.stdio.stderr === "pipe") {
        ;
        this.stderr = makePipe(
          { read: (from) => this.client.readOutput(info.cmdId, "stderr", from) },
          () => void 0
        );
      }
      const outcome = await new Promise((res) => {
        const poll = async () => {
          const st = await this.client.status(info.cmdId);
          if (st.phase === "exited" || st.phase === "killed") {
            res({ exitCode: st.exitCode ?? null, signal: st.signal ?? null });
            return;
          }
          setTimeout(() => void poll(), 100);
        };
        void poll();
      });
      for (const p of this.pollers) await p.flush();
      for (const p of this.pollers) p.stop();
      this.resolveDone(outcome);
    } catch {
      for (const p of this.pollers) p.stop();
      this.resolveDone({ exitCode: -1, signal: null });
    }
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    if (this.cmdId !== "") {
      void this.client.kill(this.cmdId, this.spec.graceMs);
    }
  }
  async waitForExit(signal) {
    await this.done;
    return true;
  }
};
var RemoteTerminalHandle = class {
  constructor(client, ptyId, pid, spec) {
    this.client = client;
    this.ptyId = ptyId;
    this.spec = spec;
    this.pid = pid;
    this.done = new Promise((res) => {
      this.resolveDone = res;
    });
    this.output = makePipe({ read: (from) => this.client.ptyOutput(ptyId, from) }, () => void 0);
    const pollExit = async () => {
      const phase = await this.client.ptyStatus(ptyId);
      if (phase === "exited" || phase === "killed" || phase === void 0) {
        this.resolveDone({ exitCode: 0, signal: null });
        return;
      }
      setTimeout(() => void pollExit(), 200);
    };
    void pollExit();
  }
  client;
  ptyId;
  spec;
  pid;
  output;
  done;
  resolveDone;
  terminated = false;
  async write(data) {
    await this.client.ptyWrite(this.ptyId, data);
  }
  async inspectForeground() {
    return { processGroupId: this.pid, inputWaiting: false };
  }
  async signalForeground(signal) {
    await this.client.ptySignal(this.ptyId, signal);
    return this.pid;
  }
  async terminate() {
    if (this.terminated) return;
    this.terminated = true;
    await this.client.ptyTerminate(this.ptyId, this.spec.graceMs);
  }
};
function apply(ctx, config) {
  new SubprocessK8s(ctx, config);
}
export {
  SubprocessK8s,
  apply,
  name
};
