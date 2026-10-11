# 贡献指南

本仓是 `dsh-platform` 的部署侧仓库：Helm charts、配置样例、本地 kind 测试集群。
平台本体（插件、镜像）在 [Visecy/dsh-platform](https://github.com/Visecy/dsh-platform)。
**平台当前是预览版（preview）**，改动前先读本仓 `docs/deployment.md` 与平台仓 README
的「已知限制」。

## 环境

| 项 | 要求 |
|---|---|
| Helm | 3（CI 用 v3.16.4） |
| Kubernetes | 任意主流发行版；跑本地冒烟需要 `kind`、`kubectl`、`docker` |
| 集群能力 | 要真正挡住工作区 daemon，需要能执行 NetworkPolicy 的 CNI |

## 提交前必须跑的检查

```bash
helm lint charts/dsh-control-plane charts/dsh-workspace

# 与 docs/deployment.md 里给运维的同一条命令形状（占位值）：
helm template dsh-control-plane charts/dsh-control-plane -n dsh-platform \
  --set auth.oidcIssuer=https://authentik.example.com/application/o/dsh-platform/ \
  --set auth.oidcClientId=test-client \
  --set auth.redirectUri=https://dsh.example.com/oauth2/callback \
  --set oauth2Proxy.publicOrigin=https://dsh.example.com \
  --set oauth2Proxy.trustedProxyIps[0]=10.0.0.0/8 \
  --set oauth2Proxy.cookieSecretRef=dsh-oauth2-proxy \
  --set oauth2Proxy.cookieSecretKey=cookie-secret \
  --set auth.oidcClientSecretRef=dsh-oidc \
  --set dshWeb.trustedHosts[0]=dsh.example.com \
  --set ingress.enabled=true --set ingress.host=dsh.example.com \
  --set ingress.className=nginx --set ingress.tlsSecret=dsh-tls > /dev/null
```

`.github/workflows/charts.yml` 会跑这两步，并额外断言两件事：**缺少必填值时必须渲染失败**
（fail-closed，不允许渲染出一个无法认证任何人的控制面），以及 `charts/dsh-workspace`
仍然只渲染空内容。本地改完请自己按上面的命令复现一遍。

## chart 约定

- **必须是 values 驱动且厂商中立**：不硬编码 registry、namespace、域名、StorageClass 网段。
  示例与文档一律用占位符（`dsh.example.com`、`ghcr.io/...`、`10.0.0.0/8`、
  `<你的 StorageClass>`），真实取值由 `--set` / values 文件提供。
- **认证相关取值必须 fail-closed**：`auth.oidcIssuer`、cookie secret 引用、`DSH_PUBLIC_ORIGIN`
  的推导链取不到值时要让 `helm template` 直接报错，而不是渲染出半可用的部署。
- **不要发布应用端口**：Service 只暴露 oauth2-proxy sidecar 的端口；dsh web 由 chart 以
  `--host 127.0.0.1` 启动，任何指向它的 Service / Ingress / NodePort 都等于取消认证。
- **不要碰身份头契约**：`X-Forwarded-User` / `X-Forwarded-Groups` 是唯一的可信上游身份对；
  `X-Auth-Request-*` 在本拓扑下由客户端可控，不要新增对它的消费，也不要加 `--set-xauthrequest`。
- **`charts/dsh-workspace` 是配置参考，不是可安装 chart**：它没有 template，也不拥有工作区
  Pod（Pod 由控制面的 `@visecy/dsh-workspace-k8s` 动态创建）。它的 `values.yaml` 必须始终是
  平台实际行为的**真实**参考——改控制面默认值时同步更新它，新增未被平台实现的项要明确标注
  「未实现」，不要写成已支持。
- **注解值一律用字符串**：`metadata.annotations` 是 `map[string]string`，模板里要显式加引号，
  以免 `--set ...=3600` 被解析成 int64 后被 API server 拒绝。
- **文档里的命令要能直接跑**：续行里不要夹 `#` 注释，占位符统一用 `<...>` 或 `dsh.example.com`。

## 本地冒烟

```bash
bash kind/smoke.sh
```

`kind/smoke.sh` 期望**自包含**：自己建 kind 集群、命名空间、一次性 PostgreSQL 与 chart 需要的
全部 Secret（`dsh-db` / `dsh-oidc` / `dsh-oauth2-proxy`），除了 `kind` / `kubectl` / `helm` /
`docker` 之外不依赖任何预置资源。它只验证 chart 能装上、控制面 Pod 能 Ready
（OIDC 登录流程不在其中：issuer 是 dummy、跳过 discovery）。其他脚本：
`kind/daemon-smoke.sh`（daemon 镜像）、`kind/workspace-smoke.yaml`（工作区运行时）、
`oidc-test/`（dex 真实登录测试台，dev only）。

## 提交与 PR

- 提交信息用 `type(scope): 说明`，例如 `fix(control-plane): …`、`docs(kind): …`、
  `feat(control-plane): …`；scope 用目录或组件名（`control-plane`、`kind`、`config`、`oidc-test`）。
- 一个 PR 做一件事；说明改了哪些 values / 模板、为什么，以及你跑了哪些 `helm lint` /
  `helm template` / 冒烟命令。
- 文档与注释以中文为主，values 的键名、Kubernetes / Helm 字段保持原文。
- 不要把真实凭据、域名、registry 或内网网段提交进仓库。

## 发布与版本

本仓不打 tag，也没有独立版本号。控制面与工作区 daemon 镜像由平台仓的 `v*` tag 决定，
chart 默认 pin 的 `image.dshWeb` 与 `workspace.image` 必须来自**同一个平台 tag**
（两侧共享 daemon 协议，没有版本握手）。平台发新 tag 时，同步改这两个默认值并更新
`docs/deployment.md` 里的 `TAG` 示例。

## 许可证

本仓采用 MIT，见 [LICENSE](LICENSE)。提交即表示你同意以该许可证发布你的贡献。
