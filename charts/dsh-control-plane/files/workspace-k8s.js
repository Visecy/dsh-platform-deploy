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
      await core.createNamespacedPod(spec.namespace, pod);
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
      await core.createNamespacedService(spec.namespace, svc);
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
      await core.deleteNamespacedPod(name2, namespace);
    } catch {
    }
    try {
      await core.deleteNamespacedService(this.svcName(workspaceId), namespace);
    } catch {
    }
  }
  async waitReady(namespace, name2, timeoutMs = 6e4) {
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      const pod = await core.readNamespacedPod(name2, namespace);
      const ready = pod.body.status?.conditions?.some(
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
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    const name2 = this.pvcName(workspaceId);
    const pvc = {
      metadata: { name: name2, namespace: this.namespace },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: this.pvc.storageSize ?? "10Gi" } },
        storageClassName: this.pvc.storageClassName
      }
    };
    try {
      await core.createNamespacedPersistentVolumeClaim(this.namespace, pvc);
    } catch (e) {
      const status = e.body?.message ?? String(e);
      if (!status.includes("already exists")) throw e;
    }
    return name2;
  }
  async deletePvc(workspaceId) {
    const core = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      await core.deleteNamespacedPersistentVolumeClaim(this.pvcName(workspaceId), this.namespace);
    } catch {
    }
  }
};

// packages/workspace-k8s/src/index.ts
var name = "@visecy/dsh-workspace-k8s";
var WorkspaceRuntimeService = class extends Service {
  constructor(ctx, config) {
    super(ctx, "workspaceRuntime");
    this.config = config;
    if (config.controller !== void 0) {
      this.controller = config.controller;
    } else {
      const kc = new k8s2.KubeConfig();
      kc.loadFromDefault();
      this.controller = new K8sPodController(kc);
    }
  }
  config;
  controller;
  running = /* @__PURE__ */ new Set();
  inflight = /* @__PURE__ */ new Map();
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
    const spec = {
      namespace: this.config.namespace,
      workspaceId,
      image: this.config.image,
      daemonPort: this.config.daemonPort ?? 4390,
      pvcName: this.config.pvcName,
      resources: this.config.resources
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
  new WorkspaceRuntimeService(ctx, config);
}
export {
  WorkspaceRuntimeService,
  apply,
  name
};
