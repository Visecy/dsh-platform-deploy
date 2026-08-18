// packages/workspace-k8s/src/index.ts
import { Service } from "@deepseek-ai/cordis";
import * as k8s2 from "@kubernetes/client-node";

// packages/workspace-k8s/src/k8s-client.ts
import * as k8s from "@kubernetes/client-node";
var K8sPodController = class {
  constructor(kc, pvc = {}) {
    this.kc = kc;
    this.pvc = pvc;
  }
  kc;
  pvc;
  podName(workspaceId) {
    const safe = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    return `dsh-ws-${safe}`;
  }
  svcName(workspaceId) {
    return this.podName(workspaceId) + "-svc";
  }
  async ensurePod(spec) {
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    const name2 = this.podName(spec.workspaceId);
    const labels = { app: "dsh-workspace", workspace: name2 };
    const pod = {
      metadata: {
        name: name2,
        namespace: spec.namespace,
        labels
      },
      spec: {
        containers: [
          {
            name: "sandbox-daemon",
            image: spec.image,
            ports: [{ containerPort: spec.daemonPort, name: "daemon" }],
            readinessProbe: {
              httpGet: { path: "/healthz", port: spec.daemonPort },
              initialDelaySeconds: 1,
              periodSeconds: 2
            },
            securityContext: {
              runAsNonRoot: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] }
            },
            env: [{ name: "DAEMON_ROOT", value: "/workspace" }, { name: "DAEMON_PORT", value: String(spec.daemonPort) }],
            resources: spec.resources !== void 0 ? { requests: spec.resources, limits: spec.resources } : void 0,
            volumeMounts: [
              { name: "workspace", mountPath: "/workspace" }
            ]
          }
        ],
        securityContext: { runAsNonRoot: true, runAsUser: 1e3, fsGroup: 1e3 },
        volumes: [
          spec.pvcName !== void 0 ? { name: "workspace", persistentVolumeClaim: { claimName: spec.pvcName } } : { name: "workspace", emptyDir: {} }
        ]
      }
    };
    try {
      await core.createNamespacedPod({ namespace: spec.namespace, body: pod });
    } catch (e) {
      const status = e.body?.message ?? String(e);
      if (!status.includes("already exists")) throw e;
    }
    const svc = {
      metadata: { name: this.svcName(spec.workspaceId), namespace: spec.namespace, labels },
      spec: {
        clusterIP: "None",
        selector: labels,
        ports: [{ port: spec.daemonPort, targetPort: spec.daemonPort, name: "daemon" }]
      }
    };
    try {
      await core.createNamespacedService({ namespace: spec.namespace, body: svc });
    } catch (e) {
      const status = e.body?.message ?? String(e);
      if (!status.includes("already exists")) throw e;
    }
    return name2;
  }
  async deletePod(namespace, workspaceId) {
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    const name2 = this.podName(workspaceId);
    try {
      await core.deleteNamespacedPod({ name: name2, namespace });
    } catch {
    }
    try {
      await core.deleteNamespacedService({ name: this.svcName(workspaceId), namespace });
    } catch {
    }
  }
  async waitReady(namespace, name2, timeoutMs = 6e4) {
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      const raw = await core.readNamespacedPod({ name: name2, namespace });
      const pod = raw.body ?? raw;
      const ready = pod.status?.conditions?.some(
        (c) => c.type === "Ready" && c.status === "True"
      );
      if (ready === true) return;
      if (Date.now() > deadline) throw new Error(`workspace pod not ready in ${timeoutMs}ms: ${name2}`);
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  endpoint(namespace, workspaceId, port) {
    return `http://${this.svcName(workspaceId)}.${namespace}.svc.cluster.local:${port}`;
  }
  pvcName(workspaceId) {
    return `dsh-ws-${workspaceId}-data`;
  }
  async ensurePvc(workspaceId) {
    const ns = this.pvc.namespace ?? this.requireNamespace();
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    const name2 = this.pvcName(workspaceId);
    const pvc = {
      metadata: { name: name2, namespace: ns },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: this.pvc.storageSize ?? "10Gi" } },
        storageClassName: this.pvc.storageClassName
      }
    };
    try {
      await core.createNamespacedPersistentVolumeClaim({ namespace: ns, body: pvc });
    } catch (e) {
      const status = e.body?.message ?? String(e);
      if (!status.includes("already exists")) throw e;
    }
    return name2;
  }
  requireNamespace() {
    throw new Error("workspace PVC namespace not configured");
  }
  async deletePvc(workspaceId) {
    const ns = this.pvc.namespace ?? this.requireNamespace();
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      await core.deleteNamespacedPersistentVolumeClaim({ name: this.pvcName(workspaceId), namespace: ns });
    } catch {
    }
  }
};

// packages/workspace-k8s/src/session-tracker.ts
var SessionTracker = class _SessionTracker {
  constructor(source, onEvent) {
    this.source = source;
    this.onEvent = onEvent;
    source.onSessionCreated((sessionId, cwd) => this.sessionCreated(sessionId, cwd));
    source.onSessionDisposed((sessionId) => this.sessionDisposed(sessionId));
    source.onTurnStarted((sessionId) => this.turnStarted(sessionId));
    source.onTurnEnded((sessionId) => this.turnEnded(sessionId));
  }
  source;
  onEvent;
  sessionWs = /* @__PURE__ */ new Map();
  sessionTurns = /* @__PURE__ */ new Map();
  counts = /* @__PURE__ */ new Map();
  /** Extract workspaceId from a cwd like /workspaces/<id> or undefined. */
  static workspaceOf(cwd) {
    if (cwd === void 0) return void 0;
    const m = /^\/workspaces\/([^/]+)/.exec(cwd);
    return m?.[1];
  }
  touch(workspaceId, sessionId) {
    const c = this.counts.get(workspaceId) ?? { sessions: 0, turns: 0 };
    const turns = this.sessionTurns.get(sessionId) ?? 0;
    c.sessions = [...this.sessionWs.values()].filter((w) => w === workspaceId).length;
    c.turns = [...this.sessionTurns.entries()].filter(([sid, t]) => t > 0 && this.sessionWs.get(sid) === workspaceId).reduce((a, [, t]) => a + t, 0);
    this.counts.set(workspaceId, c);
    void turns;
  }
  sessionCreated(sessionId, cwd) {
    const ws = _SessionTracker.workspaceOf(cwd);
    if (ws === void 0) return;
    this.sessionWs.set(sessionId, ws);
    this.counts.set(ws, {
      sessions: (this.counts.get(ws)?.sessions ?? 0) + 1,
      turns: this.counts.get(ws)?.turns ?? 0
    });
    this.onEvent(ws, { type: "session-created" });
  }
  sessionDisposed(sessionId) {
    const ws = this.sessionWs.get(sessionId);
    if (ws === void 0) return;
    this.sessionWs.delete(sessionId);
    const turns = this.sessionTurns.get(sessionId) ?? 0;
    this.sessionTurns.delete(sessionId);
    this.counts.set(ws, {
      sessions: Math.max(0, (this.counts.get(ws)?.sessions ?? 0) - 1),
      turns: Math.max(0, (this.counts.get(ws)?.turns ?? 0) - turns)
    });
    for (let i = 0; i < turns; i++) this.onEvent(ws, { type: "turn-ended" });
    this.onEvent(ws, { type: "session-disposed" });
  }
  turnStarted(sessionId) {
    const ws = this.sessionWs.get(sessionId);
    if (ws === void 0) return;
    this.sessionTurns.set(sessionId, (this.sessionTurns.get(sessionId) ?? 0) + 1);
    this.counts.set(ws, {
      sessions: this.counts.get(ws)?.sessions ?? 0,
      turns: (this.counts.get(ws)?.turns ?? 0) + 1
    });
    this.onEvent(ws, { type: "turn-started" });
  }
  turnEnded(sessionId) {
    const ws = this.sessionWs.get(sessionId);
    if (ws === void 0) return;
    this.sessionTurns.set(sessionId, Math.max(0, (this.sessionTurns.get(sessionId) ?? 0) - 1));
    this.counts.set(ws, {
      sessions: this.counts.get(ws)?.sessions ?? 0,
      turns: Math.max(0, (this.counts.get(ws)?.turns ?? 0) - 1)
    });
    this.onEvent(ws, { type: "turn-ended" });
  }
  snapshot(workspaceId) {
    const c = this.counts.get(workspaceId);
    if (c === void 0) return void 0;
    return { workspaceId, activeSessions: c.sessions, openTurns: c.turns };
  }
};

// packages/workspace-k8s/src/state-machine.ts
var now = () => Date.now();
function initialState(workspaceId) {
  return {
    workspaceId,
    phase: "sleep",
    activeSessions: 0,
    openTurns: 0,
    lastTransitionAt: now()
  };
}
function transition(state, event) {
  const s = { ...state, lastTransitionAt: now() };
  if (event.type === "session-created") s.activeSessions += 1;
  if (event.type === "session-disposed") s.activeSessions = Math.max(0, s.activeSessions - 1);
  if (event.type === "turn-started") s.openTurns += 1;
  if (event.type === "turn-ended") s.openTurns = Math.max(0, s.openTurns - 1);
  const idle = s.activeSessions === 0 && s.openTurns === 0;
  if (event.type === "dispose-requested") {
    s.phase = "deleted";
    s.idleSince = void 0;
    return { state: s, action: { kind: "delete" } };
  }
  switch (s.phase) {
    case "provision": {
      if (event.type === "pod-ready") {
        s.phase = "running";
        if (idle) {
          s.idleSince = now();
          return { state: s, action: { kind: "start-grace" } };
        }
        return { state: s, action: { kind: "none" } };
      }
      if (event.type === "pod-lost") {
        return { state: s, action: { kind: "ensure" } };
      }
      return { state: s, action: { kind: "none" } };
    }
    case "running": {
      if (event.type === "pod-lost") {
        return { state: s, action: { kind: "ensure" } };
      }
      if (event.type === "user-attach" && s.idleSince !== void 0) {
        s.idleSince = void 0;
        return { state: s, action: { kind: "cancel-grace" } };
      }
      if (event.type === "grace-expired" && idle) {
        s.phase = "sleep";
        s.idleSince = void 0;
        return { state: s, action: { kind: "dispose" } };
      }
      if (idle && s.idleSince === void 0) {
        s.idleSince = now();
        return { state: s, action: { kind: "start-grace" } };
      }
      if (!idle && s.idleSince !== void 0) {
        s.idleSince = void 0;
        return { state: s, action: { kind: "cancel-grace" } };
      }
      return { state: s, action: { kind: "none" } };
    }
    case "sleep": {
      if (event.type === "user-attach" || event.type === "ensure-requested" || event.type === "session-created") {
        s.phase = "provision";
        s.idleSince = void 0;
        return { state: s, action: { kind: "ensure" } };
      }
      return { state: s, action: { kind: "none" } };
    }
    case "deleted": {
      return { state: s, action: { kind: "none" } };
    }
  }
}

// packages/workspace-k8s/src/lifecycle-manager.ts
var WorkspaceLifecycleManager = class {
  controller;
  opts;
  onBeforeSleep;
  now;
  timer;
  states = /* @__PURE__ */ new Map();
  timers = /* @__PURE__ */ new Map();
  ensureInflight = /* @__PURE__ */ new Set();
  constructor(opts) {
    this.controller = opts.controller;
    this.opts = {
      namespace: opts.namespace,
      image: opts.image,
      daemonPort: opts.daemonPort ?? 4390,
      graceMs: opts.graceMs ?? 3 * 60 * 60 * 1e3
    };
    this.now = opts.now ?? Date.now;
    this.onBeforeSleep = opts.onBeforeSleep;
    this.timer = opts.timer ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t)
    };
  }
  stateOf(workspaceId) {
    return this.states.get(workspaceId);
  }
  /** Session activity from the tracker (session/turn lifecycle). */
  handleSessionEvent(workspaceId, event) {
    this.handle(workspaceId, event);
  }
  /** User opened/activated the workspace (cancel sleep). */
  attach(workspaceId) {
    this.handle(workspaceId, { type: "user-attach" });
  }
  /** Explicit workspace deletion. */
  delete(workspaceId) {
    this.handle(workspaceId, { type: "dispose-requested" });
  }
  /** Health signal: execution pod lost (crash). */
  podLost(workspaceId) {
    this.handle(workspaceId, { type: "pod-lost" });
  }
  handle(workspaceId, event) {
    const state = this.states.get(workspaceId) ?? initialState(workspaceId);
    const { state: next, action } = transition(state, event);
    this.states.set(workspaceId, next);
    void this.runAction(workspaceId, action);
  }
  async runAction(workspaceId, action) {
    switch (action.kind) {
      case "none":
        return;
      case "start-grace": {
        const timer = this.timer.setTimeout(() => {
          this.timers.delete(workspaceId);
          this.handle(workspaceId, { type: "grace-expired" });
        }, this.opts.graceMs);
        this.timers.set(workspaceId, timer);
        return;
      }
      case "cancel-grace": {
        const t = this.timers.get(workspaceId);
        if (t !== void 0) {
          this.timer.clearTimeout(t);
          this.timers.delete(workspaceId);
        }
        return;
      }
      case "ensure": {
        if (this.ensureInflight.has(workspaceId)) return;
        this.ensureInflight.add(workspaceId);
        try {
          const pvcName = await this.controller.ensurePvc(workspaceId);
          const spec = {
            namespace: this.opts.namespace,
            workspaceId,
            image: this.opts.image,
            daemonPort: this.opts.daemonPort,
            pvcName,
            resources: void 0
          };
          const name2 = await this.controller.ensurePod(spec);
          await this.controller.waitReady(this.opts.namespace, name2);
          this.handle(workspaceId, { type: "pod-ready" });
        } catch {
          this.handle(workspaceId, { type: "pod-lost" });
        } finally {
          this.ensureInflight.delete(workspaceId);
        }
        return;
      }
      case "dispose": {
        if (this.onBeforeSleep !== void 0) {
          const ep = this.controller.endpoint(this.opts.namespace, workspaceId, this.opts.daemonPort);
          await this.onBeforeSleep(ep).catch(() => void 0);
        }
        await this.controller.deletePod(this.opts.namespace, workspaceId);
        const t = this.timers.get(workspaceId);
        if (t !== void 0) {
          this.timer.clearTimeout(t);
          this.timers.delete(workspaceId);
        }
        return;
      }
      case "delete": {
        await this.controller.deletePod(this.opts.namespace, workspaceId);
        await this.controller.deletePvc(workspaceId);
        const t = this.timers.get(workspaceId);
        if (t !== void 0) {
          this.timer.clearTimeout(t);
          this.timers.delete(workspaceId);
        }
        return;
      }
    }
  }
};

// packages/workspace-k8s/src/wire.ts
function wireWorkspaceLifecycle(ctx, opts) {
  const manager = new WorkspaceLifecycleManager(opts.lifecycle);
  const tracker = new SessionTracker(
    {
      onSessionCreated: (cb) => {
        ctx.on("session/created", (session) => {
          cb(String(session.id ?? ""), session.header?.cwd);
        });
      },
      onSessionDisposed: (cb) => {
        ctx.on("session/disposed", (session) => {
          cb(String(session.id ?? ""));
        });
      },
      onTurnStarted: (cb) => {
        void cb;
      },
      onTurnEnded: (cb) => {
        void cb;
      }
    },
    (workspaceId, event) => manager.handleSessionEvent(workspaceId, event)
  );
  void tracker;
  return {
    resolveEndpoint: async (workspaceId) => {
      await opts.runtime.ensure(workspaceId);
      return opts.runtime.getEndpoint(workspaceId);
    }
  };
}

// packages/workspace-k8s/src/index.ts
var name = "@visecy/dsh-workspace-k8s";
var WorkspaceRuntimeService = class extends Service {
  constructor(ctx, config) {
    super(ctx, "workspaceRuntime");
    this.config = config;
    this.controller = config.controller ?? this.makeController();
  }
  config;
  controller;
  running = /* @__PURE__ */ new Set();
  inflight = /* @__PURE__ */ new Map();
  /** The pod controller (shared with the lifecycle manager wiring). */
  get podController() {
    return this.controller;
  }
  makeController() {
    const kc = new k8s2.KubeConfig();
    kc.loadFromDefault();
    return new K8sPodController(kc, {
      namespace: this.config.namespace,
      storageClassName: this.config.storageClassName,
      storageSize: this.config.storageSize
    });
  }
  async ensure(workspaceId) {
    const existing = this.inflight.get(workspaceId);
    if (existing !== void 0) return existing;
    const promise = this.doEnsure(workspaceId);
    this.inflight.set(workspaceId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(workspaceId);
    }
  }
  async doEnsure(workspaceId) {
    const pvcName = this.config.pvcName ?? await this.controller.ensurePvc(workspaceId);
    const spec = {
      namespace: this.config.namespace,
      workspaceId,
      image: this.config.image,
      daemonPort: this.config.daemonPort ?? 4390,
      pvcName,
      resources: this.config.resources,
      storageClassName: this.config.storageClassName,
      storageSize: this.config.storageSize
    };
    const name2 = await this.controller.ensurePod(spec);
    await this.controller.waitReady(this.config.namespace, name2);
    this.running.add(workspaceId);
    return this.controller.endpoint(this.config.namespace, workspaceId, spec.daemonPort);
  }
  async dispose(workspaceId) {
    await this.controller.deletePod(this.config.namespace, workspaceId);
    this.running.delete(workspaceId);
  }
  getEndpoint(workspaceId) {
    return this.controller.endpoint(this.config.namespace, workspaceId, this.config.daemonPort ?? 4390);
  }
  isRunning(workspaceId) {
    return this.running.has(workspaceId);
  }
};
function apply(ctx, config) {
  const runtime = new WorkspaceRuntimeService(ctx, config);
  const { resolveEndpoint } = wireWorkspaceLifecycle(ctx, {
    lifecycle: {
      controller: runtime.podController,
      namespace: config.namespace,
      image: config.image,
      daemonPort: config.daemonPort ?? 4390,
      storageClassName: config.storageClassName,
      storageSize: config.storageSize,
      graceMs: config.graceMs
    },
    runtime
  });
  ctx.provide("workspaceEndpointResolver", { resolve: resolveEndpoint });
}
export {
  WorkspaceRuntimeService,
  apply,
  name
};
