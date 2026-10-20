# dsh-platform 部署指南

面向运维：从零装到能用、怎么验证、怎么升级/回滚/备份，以及**必须自己补的那部分**。

- 平台版本与 DSH 版本的对应关系见 dsh-platform 的 `README.md`（兼容性矩阵）。
  本文按平台 `v0.1.90` + DSH `0.2.1-rc.2` 编写；镜像与插件版本由平台 tag 决定。
- 平台内部结构（组件、数据流、扩展点）见 dsh-platform 的 `docs/architecture.md`。

## 1. 架构

```
浏览器 ── TLS ── Ingress / Istio gateway（按 host + 可选单段前缀路由；前缀由入口剥离）
  │
  └─ dsh-control-plane Pod（无状态：readOnlyRootFilesystem，无 PVC）
       ├─ oauth2-proxy sidecar :4180   ← Pod 唯一入口（Service 只暴露它）
       │    OIDC 会话（cookie store，无 Redis / DB）
       │    向上游注入 X-Forwarded-User / -Groups（已认证身份）
       └─ dsh web 127.0.0.1:3080       ← 只绑 loopback，Service 不指向它
            └─ 平台插件 → PostgreSQL（会话 / 工作区记录 / 凭据）
  │
  └─ workspace Pod（每工作区一个，由控制面动态创建/回收）
       ├─ sandbox-daemon :4390         ← files / commands / pty，**无认证**
       └─ PVC（ReadWriteOnce）挂到 /workspaces/<id>
```

两条边界必须记住：

1. **身份只来自 sidecar 注入的请求头**，所以 dsh web 必须只绑 loopback、且没有任何
   Service / Ingress / NodePort 指向它（`kubectl port-forward` 也算直达）。
2. **工作区 daemon 没有认证**：能连到 4390 的 Pod 就能读写工作区文件、执行命令、开 PTY。
   控制面必须能直连工作区 Pod IP；其余来源要靠 NetworkPolicy 挡住（见 §5.3）。

## 2. 前置条件

| 项 | 要求 |
|---|---|
| Kubernetes | 任意主流发行版；RBAC 可用。`kubectl` + `helm` 3 |
| CNI | 不强制；但**要挡住工作区 daemon 就必须有能执行 NetworkPolicy 的 CNI**（Calico / Cilium 等） |
| 存储 | 一个可用的 StorageClass 供每个工作区建 2Gi PVC（`ReadWriteOnce`）。**没有 `local-path` 的集群必须显式设置**，否则 PVC 永远 Pending |
| PostgreSQL | **必需**：平台镜像只提供 PostgreSQL 后端（会话、事件、工作区记录、平台凭据）。任意可达实例；连接串放进 Secret（§3.2） |
| OIDC IdP | 任意标准 OIDC（authentik / Keycloak / Entra / dex…）。需要能注册回调 URL，并**在 ID token 里带 groups claim**（`oauth2Proxy.groupsClaim`，默认 `groups`） |
| 入口 | nginx-ingress 或任意支持长连接的 Ingress；或 Istio 网关（chart 自带 VirtualService） |
| 镜像 | `ghcr.io/visecy/dsh-web-platform` 与 `ghcr.io/visecy/dsh-platform/dsh-sandbox-daemon` 可匿名拉取；私有化部署见 §5.5 |
| 命名空间 | 下文以 `dsh-platform` 为例；chart 用 `.Release.Namespace`，可以换 |

> 预览版的限制（单副本、无多租户授权、无 ARM64 等）见 §8，先读一遍再规划。

## 3. 从零安装

### 3.1 命名空间

```bash
kubectl create namespace dsh-platform
```

### 3.2 数据库与连接串 Secret

生产用你已有的 PostgreSQL / CloudNativePG；只要满足两点：控制面可达，且连接串放在
Secret `dsh-db` 的 `DSH_PG_CONNECTION_STRING` 键里。

```bash
kubectl -n dsh-platform create secret generic dsh-db \
  --from-literal=DSH_PG_CONNECTION_STRING='postgres://USER:PASSWORD@HOST:5432/DBNAME'
```

本地 kind 集群想要一个一次性数据库，直接用 `kind/smoke.sh`（它自己建 PostgreSQL 与全部
Secret）。骨架如下，仅供试验：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: dsh-dev-postgres }
spec:
  replicas: 1
  selector: { matchLabels: { app: dsh-dev-postgres } }
  template:
    metadata: { labels: { app: dsh-dev-postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - { name: POSTGRES_USER, value: dsh }
            - { name: POSTGRES_PASSWORD, value: change-me }
            - { name: POSTGRES_DB, value: dsh }
          ports: [{ containerPort: 5432 }]
```

### 3.3 IdP 应用与两个 Secret

1. 在 IdP 注册应用，回调地址 **必须是** `https://<host>/oauth2/callback`
   （oauth2-proxy 的固定路径；应用自身不注册任何回调路由）。子路径发布时是
   `https://<host>/<prefix>/oauth2/callback`，见 §4.4。
   `groups` scope 必须请求到，否则 `ctx.dshAuth` 的用户组为空。
   authentik 样例见 `config/authentik.example.md`。
2. 两个 Secret：

```bash
# client secret（IdP 侧生成的）
kubectl -n dsh-platform create secret generic dsh-oidc \
  --from-literal=oidc-client-secret='<client-secret>' \
  --from-literal=session-secret='<用于继承旧部署，可留空占位>'

# sidecar 的 cookie 密钥：必须是 16/24/32 字节（或它们的 base64url）
kubectl -n dsh-platform create secret generic dsh-oauth2-proxy \
  --from-literal=cookie-secret="$(python3 -c 'import os,base64; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"
```

`auth.sessionSecretRef` 只是 `oauth2Proxy.cookieSecretRef` 为空时的回退，本指南显式设置后者。

### 3.4 安装控制面

```bash
# 用与 chart 版本一致的 tag（两处必须是同一 tag：控制面与工作区 daemon 共享协议）
TAG=v0.1.90

helm upgrade --install dsh-control-plane ./charts/dsh-control-plane -n dsh-platform \
  --set image.dshWeb=ghcr.io/visecy/dsh-web-platform:${TAG} \
  --set workspace.image=ghcr.io/visecy/dsh-platform/dsh-sandbox-daemon:${TAG} \
  --set workspace.storageClassName=<你的 StorageClass> \
  --set auth.oidcIssuer=https://<idp>/application/o/dsh-platform/ \
  --set auth.oidcClientId=<client-id> \
  --set auth.redirectUri=https://dsh.<domain>/oauth2/callback \
  --set oauth2Proxy.publicOrigin=https://dsh.<domain> \
  --set oauth2Proxy.trustedProxyIps[0]=<ingress/gateway Pod CIDR> \
  --set oauth2Proxy.cookieSecretRef=dsh-oauth2-proxy \
  --set oauth2Proxy.cookieSecretKey=cookie-secret \
  --set auth.oidcClientSecretRef=dsh-oidc \
  --set dshWeb.trustedHosts[0]=dsh.<domain> \
  --set ingress.enabled=true \
  --set ingress.host=dsh.<domain> \
  --set ingress.className=nginx \
  --set ingress.tlsSecret=dsh-tls \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-buffering"=off \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-read-timeout"=3600 \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-send-timeout"=3600
```

注意：

- 注解值必须是字符串（用 `--set-string`）：`metadata.annotations` 是
  `map[string]string`，`--set ...=3600` 会被 helm 解析成 int64，API server 直接拒绝。
- 这条命令里的 `#` 注释不能夹在续行（`\`）中间；占位符 `<...>` 先替换再执行。
- 没设 `dshWeb.trustedHosts` 的话，`/api`（RPC / WebSocket）会被 DSH 的 Host/Origin
  fence 全部 403。
- 没设 `oauth2Proxy.trustedProxyIps` 时 oauth2-proxy 会打印
  `WARNING: --reverse-proxy is enabled but no --trusted-proxy-ip CIDRs were configured ...`
  并信任任何来源的 `X-Forwarded-*`：**生产必须设置**（见 §4.2）。
- 两处镜像 tag 必须相同；`image.dshWeb` 默认已 pin 到与 chart 同期发布的 tag，不要用
  `latest`。

### 3.5 验证

```bash
kubectl -n dsh-platform get pods            # dsh-web 与 oauth2-proxy 都 Running
kubectl -n dsh-platform logs deploy/dsh-control-plane-dsh-control-plane -c oauth2-proxy | head

# 未登录访问根路径应 302 到 IdP（--skip-provider-button=true，没有中间登录页）
curl -sI https://dsh.<domain>/ | head -3

# 应用容器 env 应只有字面值的那几个（无任何 OIDC/会话变量）
kubectl -n dsh-platform get deploy -o jsonpath='{range .items[*].spec.template.spec.containers[?(@.name=="dsh-web")].env[*]}{.name}={.value}{"\n"}{end}'

# 启动脚本里应有 chart 推导出的 --public-url（见 §4.3）
kubectl -n dsh-platform get deploy -o jsonpath='{range .items[*].spec.template.spec.containers[?(@.name=="dsh-web")].command[*]}{@}{"\n"}{end}' | grep -- --public-url
```

期望：`DSH_HOME` / `DSH_TELEMETRY_DISABLED` / `WS_*` 有字面值，
`DSH_PG_CONNECTION_STRING` 来自 Secret；应用容器的启动参数里有
`--public-url <公网 root>`（见 §4.3），且**没有** `DSH_PUBLIC_ORIGIN`（该 env 只保留为
手工 manifest 的显式覆盖）。
登录后页面与 `/api` 正常（无 401/403），cordis 装配日志里没有
`patch: entry "…" not found` 之类的 warn。

## 4. 认证契约

### 4.1 身份头

`X-Forwarded-User` / `X-Forwarded-Groups` 是唯一可信的上游身份对（oauth2-proxy 的
`--pass-user-headers=true`，本 chart 固定开启）。**`X-Auth-Request-*` 在本拓扑下由客户端可控，
任何组件都不得把它当身份读取。**

实测（v7.15.5，带伪造头的一次登录请求）：客户端伪造的 `X-Forwarded-User/-Groups/-Email`
会在注入前被删除，上游只看到会话里的真实用户；而客户端伪造的 `X-Auth-Request-*` **不会**
被删除，与是否设置 `--set-xauthrequest` 无关（该族是**响应头**，不在请求头清理链里）。
本 chart 因此刻意不设置 `--set-xauthrequest`：没有任何组件消费它，开着只会诱使后来者把它当身份。

纵深防御（未实现，仅记录）：若将来真有组件需要消费 `X-Auth-Request-*`，应在 ingress 层剥离
这批请求头；legacy 选项模式下 chart 自己清不掉。

### 4.2 `oauth2Proxy.trustedProxyIps`（生产必需）

sidecar 以 `--reverse-proxy=true` 运行，即信任上游给的 `X-Forwarded-Proto` / `Host`。
"谁有资格提供这组头"由 `oauth2Proxy.trustedProxyIps`（→ `--trusted-proxy-ip`）决定，
值为 ingress/gateway Pod 的 CIDR（链路上每个可能追加或改写 `X-Forwarded-*` 的跳都要列上）。

留空不是认证绕过（仍要过会话 cookie），但它会让 sidecar 自身所有基于这些头的判断
（`/oauth2/*` 重定向、cookie 安全标志、客户端 IP 日志）受客户端影响。网段因部署而异，
chart 不会内置任何网段。

### 4.3 `oauth2Proxy.publicOrigin` 与 `dsh web --public-url`

chart 把推导出的公网 root 作为 `dsh web --public-url` 传给应用容器。这是部署对外 URL 的
**唯一真值**：0.2.1 起 profile 把 `web-runtime.publicUrl` 转发到官方的
`webApp.getAdvertisedUrl()`，identity-bridge 用同一个 root 作为 launch-token handoff 重定向
的 base，`DSH_WEB_URL` 与运行时上下文也用它。应用容器**不再需要** `DSH_PUBLIC_ORIGIN`
env（平台 profile 仍把它作为 identity-bridge 的显式覆盖项，供手工 manifest 使用）。
root 中可选的 path 同时是子路径发布的挂载点唯一真值（见 §4.4），不要另外配第二份前缀。

chart 的解析顺序（命中即止）：

1. `oauth2Proxy.publicOrigin`（`https://<host>[/<prefix>]`，无尾斜杠；推荐显式设置）
2. `oauth2Proxy.redirectUrl` 的 origin
3. `auth.redirectUri` 的 origin
4. `ingress.enabled=true` → `https://<ingress.host>`
5. `istio.enabled=true` → `https://<istio.host>`

都取不到时 chart **渲染即失败**，不会回落到"从请求推导"。取值仍受约束：只接受
`http(s)://host[/单段prefix]`，query / fragment / credentials / 空白 / 多段 path 都会让渲染
失败。第 2–5 项只能派生 **origin**；要发布到子路径必须在 `oauth2Proxy.publicOrigin` 里显式
写 path（v1 只支持单段，见 §4.4）。

**镜像要求**：`--public-url` 需要 DSH 0.2.1 线（平台 `v0.1.90+`）的镜像；更早的镜像不认识
这个 flag。子路径发布还要求同一版本线的 identity-bridge 支持带前缀的 advertised root
（`v0.1.90` 已包含），因此同样不能配更早的镜像。chart 默认 pin 与该能力同批发布。

### 4.4 子路径发布（`https://<host>/<prefix>/`）

chart 支持把控制面挂到**单段**路径前缀下（如 `https://dsh.example.com/dsh/`），与同 host 的
其他服务共存。**唯一需要改的值是 `oauth2Proxy.publicOrigin` 的 path**：路由、oauth2-proxy
回调、sidecar cookie path 全部由它派生，不要另外配第二个前缀真值。

```bash
helm upgrade --install dsh-control-plane ./charts/dsh-control-plane -n dsh-platform \
  ...（§3.4 的必填项：镜像 tag、数据库 Secret、OIDC Secret、cookie Secret）...
  --set oauth2Proxy.publicOrigin=https://dsh.<domain>/dsh \
  --set auth.redirectUri=https://dsh.<domain>/dsh/oauth2/callback \
  --set dshWeb.trustedHosts[0]=dsh.<domain> \
  --set ingress.enabled=true \
  --set ingress.host=dsh.<domain> \
  --set ingress.className=nginx \
  --set ingress.tlsSecret=dsh-tls \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-buffering"=off \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-read-timeout"=3600 \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-send-timeout"=3600
```

要点：

- **入口路径必须是规范根**（带尾斜杠）：`https://dsh.<domain>/dsh/`。`/` 与裸
  `/dsh` 都会被 chart 渲染的 301 规则送到 `<publicRoot>/`（否则相对资源会解析到 host 根，
  oauth2-proxy 登录后也可能落回 `/`）。
- **IdP 回调**：在 IdP 新增/修改为 `https://dsh.<domain>/dsh/oauth2/callback`（旧 root 回调
  过渡期可保留）。`oauth2Proxy.redirectUrl` 留空时 chart 按 `<publicRoot>/oauth2/callback`
  派生；显式设置且 path 不在前缀下会**渲染失败**。
- **路由层二选一**：ingress（`ingress.className` 必须是 `nginx`，否则渲染失败）或 Istio
  （`--set istio.enabled=true --set istio.host=dsh.<domain>` 替代三个 ingress 值）。两者都
  不启用时前缀无法剥离，渲染失败。
- **root 发布不受影响**：`publicOrigin` 不带 path 时渲染输出与旧版本一致（除 chart 版本
  label），回滚只需把 path 去掉再 `helm upgrade`。
- `dshWeb.trustedHosts` 仍填公网 authority（fence 只看 authority，不看 path）；
  `oauth2Proxy.trustedProxyIps` 仍必须设（§4.2）。

**入口/组件要求**（前缀必须由入口剥离，chart 已按此渲染）：

| 组件 | 要求 | 原因 |
|---|---|---|
| ingress 路径 | `/<prefix>(/\|$)(.*) → /$2`（`use-regex` + `rewrite-target: /$2`） | dsh web 的 launch-token exchange 只认 path `/`；assets / `/api` / boot 资源也依赖剥离 |
| Istio 路由 | `match.uri.prefix: /<prefix>/` + `rewrite.uri: /` | 同上；Istio 的 prefix rewrite 只替换匹配到的前缀 |
| `/` 与 `/<prefix>` | 301 到 `<publicRoot>/`（chart 自动生成第二条 Ingress / 第二条 VS route） | 相对资源按文档 URL 目录解析；oauth2-proxy 登录回跳可能丢前缀，301 兜底 |
| oauth2-proxy `--redirect-url` | `<publicRoot>/oauth2/callback`（派生；root 模式行为不变） | IdP 回跳必须落在前缀下，再被入口剥成 `/oauth2/callback` |
| oauth2-proxy `--cookie-path` | `/<prefix>/`（派生；root 模式不渲染该 flag） | sidecar 会话 cookie 不发给同 host 其他服务；与 DSH 自己的 cookie 不冲突 |
| `--upstream` / `--proxy-prefix` | 不变（`http://127.0.0.1:<port>` / 默认 `/oauth2`） | 剥离发生在入口，不在 sidecar |
| 流式 | nginx 仍需 `proxy-buffering: "off"` + 长 read/send timeout | SSE `/plugins/events`、WS `/api/remote.mux`（既有要求，前缀不变） |

**cookie 与限制**（v1）：

- **同 host 只能有一个 DSH 实例**：DSH 的会话 cookie 按 authority 作用域且 `Path=/`（上游
  行为，本仓不改），两个前缀实例会互相覆盖会话。子路径解决"与其它服务共存"，不解决
  "同 host 多实例"。
- **前缀只支持单段，字符集 `[A-Za-z0-9_-]`**：该值同时进入 nginx 的正则 path 与 Istio 的
  prefix match，所以含 `.`、括号、百分号编码（如 `%2F`）、`..` 或多段的 root 会**渲染失败**；
  需要其它字符时先改 chart 模板（加上转义/校验）再放开。
- sidecar 会话 cookie 从 `Path=/` 收窄到 `/<prefix>/` 后，最坏情况是**多登录一次**；数据库与
  cookie authority 未变，不需要迁移数据。
- 无前缀书签/旧入口会走 301 到规范根，多一跳但不断链。
- **验证口径**：**Istio 路径已通过真实集群 e2e**（2026-10-21，`oidc-test/` rig + 新增
  `oidc-test/subpath-vs.yaml`，chart 0.1.2 + 镜像 v0.1.90 / oauth2-proxy v7.15.5）：31/31 断言
  PASS，包括 B7 重定向表、302(IdP) → 303(prefix callback) → 302(rd=/) → 301(M1) →
  302(`/<prefix>/?token`) → 303(`./` + cookie) → 200、assets 与相对 boot 资源 200、
  `/<prefix>/api` 401（带 cookie 后到应用 handler）、WS `/api/remote.mux` 101、未信任 Host →
  403、伪造 token 不 500；同一 chart 的 root 模式回归 29/29 PASS。nginx-ingress 路径目前只有
  `helm template` 渲染断言（chart CI 覆盖）；用 nginx-ingress 上线前，建议按同一张断言表在
  目标集群验证一遍。
- **已知上游行为（B7）**：oauth2-proxy 在入口 rewrite 后会把它自己的登录后回跳落到 `/`
  （上游 issue #1008/#1297；e2e 实测回调后正是 `302 Location: /`）。chart 的
  `/ → <publicRoot>/` 301（M1）**是登录链路的一部分**，不是可选项；e2e 已验证它把浏览器送回
  `/<prefix>/` 并完成后续 handoff。若目标集群观测到回跳不收敛，记录重定向表并评估 Alt B
  （oauth2-proxy 与 app 之间加一层前缀剥离 hop）。

## 5. 工作区运行时

工作区 Pod 由控制面动态创建（不在任何 Helm release 里），配置入口是控制面 chart 的
`workspace.*`，经容器 env 传给 `@visecy/dsh-workspace-k8s`。逐项映射见
`charts/dsh-workspace/values.yaml`。

### 5.1 常用取值

| value | 默认 | 说明 |
|---|---|---|
| `workspace.image` | 与 chart 同期 tag | **必须与控制面镜像同 tag**（没有版本握手） |
| `workspace.storageClassName` | `local-path` | 空串 = 集群默认类。**非 local-path 集群必须设置**，否则 PVC Pending、工作区起不来 |
| `workspace.storageSize` | `2Gi` | 每个工作区 PVC |
| `workspace.runtimeClassName` | 空 | runc → gvisor → kata 的隔离升级；类必须已存在于集群 |
| `workspace.cpu` / `workspace.memory` | `2` / `2Gi` | 工作区 Pod 的 requests = limits |
| `workspace.idleTimeoutMs` | `300000` | 空闲多久回收 Pod（保留 PVC） |
| `workspace.graceMs` | `10800000` | 有遗留命令时的宽限上限 |
| `workspace.networkPolicy.*` | 关闭 | 见 §5.3 |

### 5.2 镜像与协议

控制面插件与 daemon 之间**没有版本握手**：daemon 只提供 `/healthz`。协议变化靠 tag 同步保证，
所以升级时 `image.dshWeb` 与 `workspace.image` 必须一起改。已运行的 Pod 会在空闲回收后
按新镜像重建（面板上会显示"镜像漂移 · 空闲后回收"）。

### 5.3 挡住工作区 daemon（默认不做，强烈建议做）

daemon 无认证。默认情况下，**同集群任何能访问到工作区 Pod IP 的 Pod 都可以读写工作区文件、
执行命令、开 PTY**。两种补法：

1. **平台自带**（要求 CNI 支持 NetworkPolicy）：

   ```bash
   helm upgrade dsh-control-plane ./charts/dsh-control-plane -n dsh-platform \
     --reuse-values \
     --set workspace.networkPolicy.enabled=true
   ```

   它会为每个工作区建一条 NetworkPolicy：只允许带
   `app.kubernetes.io/name=dsh-control-plane` 标签的 Pod 访问 4390。
   你的控制面 Pod 标签不同时，用转义后的 key 覆盖（示例是默认值本身）：

   ```bash
   helm upgrade dsh-control-plane ./charts/dsh-control-plane -n dsh-platform \
     --reuse-values \
     --set workspace.networkPolicy.enabled=true \
     --set 'workspace.networkPolicy.controlPlanePodLabels.app\.kubernetes\.io/name=my-control-plane'
   ```

   开关默认关闭是因为策略在**不支持 NetworkPolicy 的 CNI 上等于没有**，而 selector 写错会让
   所有工作区不可达。

2. **集群侧默认拒绝**：在命名空间上做 default-deny ingress，再放行控制面 → 4390。
   这与第 1 种可以同时存在。

### 5.4 控制面 ↔ 工作区网络

解析顺序是 **Pod IP → `<id>-svc.<ns>.svc.cluster.local`**。默认拒绝 egress 的策略、
Istio STRICT mTLS、或控制面跑在集群外，都会让 fs / 命令 / PTY 全部不可用，
而且没有 port-forward 兜底（RBAC 里没有 `pods/exec`、`pods/portforward`）。

### 5.5 私有 registry

镜像公开可拉。要镜像到自己仓库时：`docker pull` → `tag` → `push`，然后

```bash
helm upgrade ... --reuse-values \
  --set image.dshWeb=<registry>/dsh-web-platform:${TAG} \
  --set workspace.image=<registry>/dsh-sandbox-daemon:${TAG} \
  --set imagePullSecrets[0].name=<pull-secret>
```

工作区 Pod 用的也是 `imagePullSecrets`（由控制面把 Pod spec 交给 API server，secret 必须存在于
同一个命名空间）。

## 6. 升级与回滚

```bash
# 1) 先备份数据库（见 §7）—— 数据库 schema 是单向迁移的，回滚镜像不等于回滚数据
# 2) 改 tag：image.dshWeb 与 workspace.image 用同一个新 tag
helm upgrade dsh-control-plane ./charts/dsh-control-plane -n dsh-platform \
  --reuse-values \
  --set image.dshWeb=ghcr.io/visecy/dsh-web-platform:vX.Y.Z \
  --set workspace.image=ghcr.io/visecy/dsh-platform/dsh-sandbox-daemon:vX.Y.Z
kubectl -n dsh-platform rollout status deploy/dsh-control-plane-dsh-control-plane
```

- **回滚**：`helm rollback dsh-control-plane` 只回滚控制面工作负载；如果新版本已经迁移过
  数据库，旧版本可能拒绝启动（schema 版本不匹配），需要同时恢复数据库备份。
- 每个平台版本对应的 DSH 版本见平台 README 的兼容性矩阵；不要只改 DSH 依赖而不重建镜像。

## 7. 备份与恢复

| 数据 | 位置 | 备份方式 |
|---|---|---|
| 会话 / 事件 / 工作区记录 / 平台凭据 | PostgreSQL | `pg_dump`（或 CNPG 的 Backup）。这是**唯一**记录会话↔工作区关联的地方 |
| 工作区文件 | 每个工作区自己的 PVC | VolumeSnapshot，或起一个挂该 PVC 的 Pod 拷出来 |
| 配置 | Helm values | 把 `helm get values` 存进版本库 |

⚠️ **删除工作区会删除它的 PVC**（数据不可恢复）。面板与 API 都有这条语义。

## 8. 预览版已知限制

- 控制面**单副本**：无 leader election，多副本会互相回收对方在工作区 Pod（`replicaCount` 保持 1）。
- **没有多租户授权**：所有通过认证的用户共享同一份会话 / 工作区 / 模型凭据，且都能操作
  彼此的工作区。不要把它直接暴露给互相不可信的用户群。
- 只发布 `linux/amd64` 与 `linux/arm64` 两种架构（多架构从下一个 tag 起；更早的 tag 只有 amd64）；air-gapped 安装未提供离线清单。
- 子路径发布只支持**单段**前缀（`https://host/dsh`，需 nginx-ingress 或 Istio 做前缀剥离 +
  根路径 301，见 §4.4）；且**同 host 只能有一个 DSH 实例**（会话 cookie 是 authority 作用域
  且 `Path=/`），子路径只解决"与其它服务共存"。
- 工作区 PVC 固定 `ReadWriteOnce`。
- 需要 `metrics-server` 才有工作区资源指标（没有时面板显示"指标不可用"，不影响使用）。

## 9. 故障排查

| 症状 | 先看 |
|---|---|
| Pod `CreateContainerConfigError` | Secret 名字/键：`dsh-db`（`DSH_PG_CONNECTION_STRING`）、`dsh-oidc`（`oidc-client-secret`）、`dsh-oauth2-proxy`（`cookie-secret`） |
| sidecar 起不来，日志 `cookie_secret must be 16, 24, or 32 bytes` | cookie secret 长度（16/24/32 字节或对应 base64url） |
| 浏览器 `/api` 全 403 | `dshWeb.trustedHosts` 是否包含公网 authority |
| 未登录访问根路径没有跳 IdP | `auth.oidcIssuer` / `auth.oidcClientId` / 回调注册是否与 `https://<host>/oauth2/callback` 一致（子路径：`https://<host>/<prefix>/oauth2/callback`）；`kubectl logs -c oauth2-proxy` |
| 子路径下访问 `/<prefix>/` 返回 401（token exchange） | 入口没有剥前缀：检查主 Ingress 的 `rewrite-target` / VS 的 `rewrite.uri`，以及 `/` 与裸 `/<prefix>` 的 301 是否存在（§4.4） |
| 子路径下登录后又落回 host 根 / 404 | oauth2-proxy 的上游 B7 行为；确认 `/ → <publicRoot>/` 的 301 Ingress / VS route 已渲染并生效（`kubectl get ingress -o yaml \| grep permanent-redirect`），IdP 回调在 `/<prefix>/oauth2/callback`（§4.4） |
| 工作区一直"创建中"或 PVC Pending | `workspace.storageClassName` 是否是该集群真实存在的类 |
| fs / 命令全部失败 | 控制面能否直连工作区 Pod IP:4390（egress 策略、mTLS、控制面是否在集群内） |
| 想确认启动期没有配置告警 | `kubectl logs <pod> -c dsh-web \| grep -i warn`，特别是 `patch: entry "…" not found` |
