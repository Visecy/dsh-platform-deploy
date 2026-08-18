// packages/fs-k8s/src/index.ts
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion
} from "@deepseek-ai/dsh-fs";

// packages/fs-k8s/src/client.ts
var DaemonError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var DaemonFilesClient = class {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  baseUrl;
  get defaultEndpoint() {
    return this.baseUrl;
  }
  async read(path, opts, endpoint) {
    const data = await this.post("/files/read", { path, offset: opts?.offset, maxBytes: opts?.maxBytes }, endpoint);
    return Buffer.from(data.bytes, "base64");
  }
  async write(path, content, intent, endpoint) {
    const data = await this.post("/files/write", { path, content: Buffer.from(content).toString("base64"), intent }, endpoint);
    return data.outcome;
  }
  async list(path, endpoint) {
    const data = await this.post("/files/list", { path }, endpoint);
    return data.entries;
  }
  async info(path, endpoint) {
    const data = await this.post("/files/info", { path }, endpoint);
    return data.info;
  }
  async remove(path, endpoint) {
    await this.post("/files/remove", { path }, endpoint);
  }
  async rename(src, dst, endpoint) {
    await this.post("/files/rename", { src, dst }, endpoint);
  }
  async post(path, body, endpoint) {
    const base = endpoint ?? this.baseUrl;
    let res;
    try {
      res = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new DaemonError("DAEMON_UNREACHABLE", `sandbox daemon unreachable: ${e.message}`);
    }
    const payload = await res.json();
    if (!payload.ok) {
      const err = payload.data?.error;
      throw new DaemonError(err?.code ?? "ERROR", err?.message ?? String(payload.data));
    }
    return payload.data;
  }
};

// packages/fs-k8s/src/translate.ts
import { posix } from "node:path";
var PathTranslator = class {
  constructor(hostRoot, podRoot) {
    this.hostRoot = hostRoot;
    this.podRoot = podRoot;
  }
  hostRoot;
  podRoot;
  /** Translate a host path to the pod-side path. Throws on escape. */
  toPod(hostPath) {
    const normalized = posix.normalize(hostPath);
    if (normalized === this.hostRoot) return this.podRoot;
    if (!normalized.startsWith(this.hostRoot + "/")) {
      throw new Error(`path escapes workspace root: ${hostPath}`);
    }
    return this.podRoot + normalized.slice(this.hostRoot.length);
  }
  /** Translate a pod path back to the host-side display path. */
  toHost(podPath) {
    const normalized = posix.normalize(podPath);
    if (normalized === this.podRoot) return this.hostRoot;
    if (!normalized.startsWith(this.podRoot + "/")) {
      throw new Error(`pod path escapes workspace root: ${podPath}`);
    }
    return this.hostRoot + normalized.slice(this.podRoot.length);
  }
};

// packages/fs-k8s/src/index.ts
var name = "@visecy/dsh-fs-k8s";
var BINARY_SAMPLE = 8192;
function isText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, BINARY_SAMPLE));
    return true;
  } catch {
    return false;
  }
}
var FsK8s = class extends FileSystem {
  client;
  translate;
  resolver;
  constructor(ctx, config) {
    super(ctx);
    this.client = new DaemonFilesClient(config.daemonEndpoint);
    this.translate = new PathTranslator(config.hostRoot, config.podRoot ?? "/workspace");
    this.resolver = config.resolveEndpoint;
  }
  /** Attach the per-workspace resolver (from workspace-k8s wiring). */
  attachResolver(resolver) {
    this.resolver = resolver;
  }
  podPathOf(target) {
    return target.targetKey.slice("dsh-k8s:".length);
  }
  /** The workspace id from a host path like /workspaces/<id>/... */
  workspaceOf(displayPath) {
    const root = this.translate.hostRoot;
    if (!displayPath.startsWith(root + "/")) return void 0;
    const rest = displayPath.slice(root.length + 1);
    const seg = rest.split("/")[0];
    return seg === "" ? void 0 : seg;
  }
  async endpointFor(target) {
    const resolver = this.resolver ?? this.ctx.workspaceEndpointResolver?.resolve;
    if (resolver === void 0) return this.client.defaultEndpoint;
    const ws = this.workspaceOf(target.displayPath);
    if (ws === void 0) return this.client.defaultEndpoint;
    return resolver(ws);
  }
  mapError(e) {
    if (e instanceof FsError) throw e;
    if (e instanceof DaemonError) {
      switch (e.code) {
        case "NOT_FOUND":
          throw new FsError(e.message, "FS_NOT_FOUND");
        case "VERSION_CONFLICT":
          throw new FsError(e.message, "FS_STALE_VERSION");
        case "OUT_OF_ROOT":
          throw new FsError(e.message, "FS_PERMISSION_DENIED");
        case "NOT_DIRECTORY":
          throw new FsError(e.message, "FS_NOT_DIRECTORY");
        default:
          throw new FsError(e.message, "FS_IO_ERROR");
      }
    }
    throw new FsError(e.message, "FS_IO_ERROR");
  }
  async resolve(path, opts) {
    const abs = opts?.cwd !== void 0 && !path.startsWith("/") ? opts.cwd + "/" + path : path;
    let podPath;
    try {
      podPath = this.translate.toPod(abs);
    } catch (e) {
      throw new FsError(e.message, "FS_PERMISSION_DENIED");
    }
    return {
      targetKey: FsTargetKey(`dsh-k8s:${podPath}`),
      displayPath: abs
    };
  }
  processPath(target) {
    return this.podPathOf(target);
  }
  fileUrl(target) {
    return "file://" + this.podPathOf(target);
  }
  contains(parent, child) {
    const p = this.podPathOf(parent);
    const c = this.podPathOf(child);
    return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
  }
  async stat(target, signal) {
    try {
      const info = await this.client.info(this.podPathOf(target), await this.endpointFor(target));
      if (info === void 0) return void 0;
      return {
        version: FsVersion(info.version ?? `v-${info.modifiedTime ?? 0}-${info.size ?? 0}`),
        type: info.type === "directory" ? "directory" : info.type === "file" ? "file" : "other",
        size: info.size
      };
    } catch (e) {
      this.mapError(e);
    }
  }
  async lstat(path, opts, signal) {
    const target = await this.resolve(path, opts);
    const info = await this.stat(target, signal);
    return info;
  }
  async readText(target, signal) {
    try {
      const bytes = await this.client.read(this.podPathOf(target), void 0, await this.endpointFor(target));
      if (!isText(bytes)) throw new FsError("binary or invalid UTF-8", "FS_NOT_TEXT");
      return new TextDecoder("utf-8").decode(bytes);
    } catch (e) {
      this.mapError(e);
    }
  }
  async streamText(target, signal) {
    const text = await this.readText(target, signal);
    return {
      async *[Symbol.asyncIterator]() {
        yield text;
      }
    };
  }
  async readBytes(target, signal, maxBytes) {
    try {
      const endpoint = await this.endpointFor(target);
      const info = await this.client.info(this.podPathOf(target), endpoint);
      if (info !== void 0 && info.size !== void 0 && info.size > maxBytes) {
        throw new FsError(`file exceeds ${maxBytes} bytes`, "FS_TOO_LARGE");
      }
      return await this.client.read(this.podPathOf(target), { maxBytes }, endpoint);
    } catch (e) {
      this.mapError(e);
    }
  }
  async listDir(target, signal) {
    try {
      const endpoint = await this.endpointFor(target);
      const entries = await this.client.list(this.podPathOf(target), endpoint);
      const out = [];
      for (const e of entries) {
        const podPath = e.path.startsWith("/") ? e.path : this.podPathOf(target) + "/" + e.path;
        const childTarget = { targetKey: FsTargetKey(`dsh-k8s:${podPath}`), displayPath: this.translate.toHost(podPath) };
        out.push({
          name: e.name,
          type: e.type === "directory" ? "directory" : e.type === "file" ? "file" : "other",
          target: childTarget,
          size: e.size
        });
      }
      return out;
    } catch (e) {
      this.mapError(e);
    }
  }
  async writeText(target, content, expected, signal, sandboxPolicy) {
    try {
      const podPath = this.podPathOf(target);
      const endpoint = await this.endpointFor(target);
      let before = null;
      try {
        const info = await this.client.info(podPath, endpoint);
        if (info !== void 0 && info.type === "file") {
          const bytes = await this.client.read(podPath, void 0, endpoint);
          if (isText(bytes)) before = new TextDecoder("utf-8").decode(bytes).replace(/\r\n/g, "");
        }
      } catch {
      }
      const intent = expected === void 0 ? void 0 : expected.kind === "createIfAbsent" ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", version: expected.version };
      const outcome = await this.client.write(podPath, new TextEncoder().encode(content), intent, endpoint);
      return {
        operation: outcome.operation === "create" ? "create" : "update",
        version: FsVersion(outcome.version),
        before: outcome.operation === "create" ? null : before,
        after: content.replace(/\r\n/g, "")
      };
    } catch (e) {
      this.mapError(e);
    }
  }
  async editText(target, edit, expected, signal, sandboxPolicy) {
    try {
      const podPath = this.podPathOf(target);
      const endpoint = await this.endpointFor(target);
      const info = await this.client.info(podPath, endpoint);
      if (info === void 0) throw new FsError("no such file", "FS_EDIT_NOT_FOUND");
      let currentVersion;
      if (expected !== void 0) {
        const st = await this.stat(target);
        currentVersion = st?.version;
        if (currentVersion === void 0 || currentVersion !== expected.version) {
          throw new FsError("stale version", "FS_STALE_VERSION");
        }
      }
      const bytes = await this.client.read(podPath, void 0, endpoint);
      if (!isText(bytes)) throw new FsError("binary file", "FS_NOT_TEXT");
      const current = new TextDecoder("utf-8").decode(bytes);
      let next;
      if (edit.replaceAll) {
        if (!current.includes(edit.oldString)) throw new FsError("pattern not found", "FS_EDIT_NOT_FOUND");
        next = current.split(edit.oldString).join(edit.newString);
      } else {
        const idx = current.indexOf(edit.oldString);
        if (idx === -1) throw new FsError("pattern not found", "FS_EDIT_NOT_FOUND");
        const second = current.indexOf(edit.oldString, idx + edit.oldString.length);
        if (second !== -1) throw new FsError("ambiguous edit", "FS_AMBIGUOUS_EDIT");
        next = current.slice(0, idx) + edit.newString + current.slice(idx + edit.oldString.length);
      }
      const st2 = await this.stat(target);
      const outcome = await this.client.write(podPath, new TextEncoder().encode(next), { kind: "replaceIfVersion", version: st2?.version ?? "" }, endpoint);
      return { version: FsVersion(outcome.version), before: current.replace(/\r\n/g, ""), after: next.replace(/\r\n/g, "") };
    } catch (e) {
      this.mapError(e);
    }
  }
};
function apply(ctx, config) {
  new FsK8s(ctx, config);
}
export {
  FsK8s,
  apply,
  name
};
