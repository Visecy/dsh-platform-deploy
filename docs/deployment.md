# dsh-platform 部署指南

## 架构

```
浏览器 ── Ingress / Istio internal-gateway（host 路由，不支持子路径）
  -> dsh-control-plane Pod（无状态：readOnlyRootFilesystem，无 PVC）
       oauth2-proxy sidecar :4180   OIDC 会话（cookie store，无 Redis/DB）
         └─ 向 dsh 注入身份头 X-Forwarded-User / -Groups（见下）
       dsh web 127.0.0.1:3080       本 chart 传 --host 127.0.0.1，Service 不指向
                                    它；是否真的只绑 loopback 取决于镜像（见下）
         ├─ /api 网关（dsh-client-connection，Host/Origin fence）
         ├─ 前端与 workspace REST API
         └─ session-persistence-rdb / storage-db -> Postgres
  -> workspace pods (动态创建, dsh-workspace-k8s manager)
       sandbox-daemon                         :4390 (仅控制面可达, NetworkPolicy)
       workspace PVC (per workspace)
```

认证已外置到同 pod 的 oauth2-proxy sidecar：Service 只暴露 sidecar 端口
（`http` → 4180），本 chart 以 `--host 127.0.0.1` 启动 dsh web 且没有任何 Service
指向它，所以身份头只可能由 sidecar 产生（结构性信任，而非策略性信任）。`--trusted-host`
（即 `dshWeb.trustedHosts`）仍需列出公网 authority：DSH 0.1.2 起 `/api`（RPC/WS）由
dsh-client-connection 的 Host/Origin fence 保护；sidecar 以 `--pass-host-header=true`
原样转发 Host，因此行为与直连一致，否则所有 `/api` 请求 403。

### loopback 绑定：两种状态，别把目标当成现状

"dsh web 只绑 loopback" 不是本 chart 单独能保证的事：**bind 由平台仓（dsh-platform）
的 profile 决定**。平台仓正在删除硬编码 `host: '0.0.0.0'` 的 `webserver-gated` fork 行
（`docker/profiles/web.cordis.patch.yml`）并恢复官方 webserver 行，与该 chart 改动属于
同一变更集。本 chart 无法从外部区分这两种状态，请按**实际部署的镜像**判断：

| 部署的镜像 | dsh web 监听 | pod IP:3080 路径的唯一屏障 |
| --- | --- | --- |
| 由改动前的 profile 构建（含 `webserver-gated` fork 行；任何早于平台改动的已发布镜像，包括过期的 `latest`） | `0.0.0.0:3080`，pod IP 可直连 | **只有 NetworkPolicy** |
| 由改动后的 profile 构建（官方 webserver 行，平台改动已进镜像） | `127.0.0.1:3080` | NetworkPolicy 只是纵深防御 |

第一态下不要把 NetworkPolicy 当成等价屏障，它有三个真实限制：

1. **依赖 CNI**：只有支持 NetworkPolicy 的 CNI 才强制执行；CNI 不支持或策略被禁用时它不存在；
2. **peer 是 label selector，不是 "本 pod"**：NetworkPolicy API 没有 "same pod" peer
   类型，匹配的是本 workload 自己的 `app.kubernetes.io/name` 标签，`replicaCount > 1`
   时同样放行兄弟副本；今天 `replicaCount: 1` 才让它恰好等于本 pod；
3. **loopback 流量不经策略**：sidecar → dsh 走 pod netns 内的 `127.0.0.1`，
   NetworkPolicy 根本不参与评估，这条规则只覆盖 "连 pod IP" 的路径。

4180 的入口规则则刻意不限来源（给 ingress controller / 内部网关 / port-forward 用）。

> **身份头契约（先记住这一句）**：`X-Forwarded-User`/`-Groups` 是唯一可信的上游身份对；
> `X-Auth-Request-*` 在本拓扑下由客户端可控，任何组件都**不得**把它当身份读取。
> identity-bridge 只读 `X-Forwarded-*`。
>
> 真正到达 DSH 进程的是请求头 `X-Forwarded-User` / `X-Forwarded-Groups` /
> `X-Forwarded-Email` / `X-Forwarded-Preferred-Username`
> （`--pass-user-headers=true`，本 chart 固定开启）。本 chart **刻意不设置
> `--set-xauthrequest`**：该选项只把 `X-Auth-Request-*` 加到**浏览器响应**上，本部署
> 没有任何组件消费这批名字，开着它反而会让后来的维护者误以为这个家族可信 ——
> 那才会变成真正的冒充漏洞。去掉它对 X-Forwarded-* 转发路径是安全中性的
> （实测：开与关，上游收到的头完全一致）。
>
> **实测结果（probe：`.dshcmp/tmp/header_probe.sh`，带伪造头的一次登录请求；
> 二进制取自 pinned v7.15.5 镜像层）**：客户端伪造的 `X-Forwarded-User/-Groups/-Email`
> 会在注入前被删除，上游只看到会话里的真实用户（`tester` / `testgroup`）；
> 但客户端伪造的 `X-Auth-Request-*` **不会**被删除，上游原样收到
> `X-Auth-Request-User: mallory` —— **与是否设置 `--set-xauthrequest` 无关**
> （用 `--set-xauthrequest=false` 重跑结果相同，差别只在**响应**头）。原因：oauth2-proxy
> 只清理它作为**请求头**注入的那批名字（`pkg/middleware/headers.go` 的 strip 链只覆盖
> `InjectRequestHeaders`），而 `X-Auth-Request-*` 是**响应头**家族，从来不在这条链里。
>
> **纵深防御（仅记录，未实现）**：若将来真有组件需要消费 `X-Auth-Request-*`，
> 可在 ingress 层剥离这批请求头（如 nginx `configuration-snippet`）；legacy 选项模式下
> 本 chart 自己清不掉它们（alpha config 会整体替换 upstream/header 装配，属另一次重构）。


## 前置

1. authentik OIDC 应用（见 config/authentik.example.md）：平台应用在 IdP 侧注册的回调
   地址是 `https://<host>/oauth2/callback`（oauth2-proxy 的路径），另需 kube-apiserver client
2. 镜像：`ghcr.io/visecy/dsh-web-platform:<tag>`（自包含控制面：官方 @deepseek-ai/dsh
   0.1.2-rc.1 + @visecy 平台插件，tag 与插件 npm 版本一致）、
   `ghcr.io/visecy/dsh-platform/dsh-sandbox-daemon:<tag>`
   （认证由本 chart 部署的 oauth2-proxy sidecar 承担：控制面镜像里没有任何进程内认证
   组件，也没有额外的认证镜像要构建）
3. helm 3 + kubeconfig

## 安装

```bash
# secrets
kubectl -n dsh-platform create secret generic dsh-oidc \
  --from-literal=oidc-client-secret=<client-secret> \
  --from-literal=session-secret=<random-32-bytes>

# oauth2-proxy 的 cookie 密钥：必须是 16/24/32 字节（或它们的 base64url），
# 与上面的 session-secret 要求不同，建议单独一个 secret
kubectl -n dsh-platform create secret generic dsh-oauth2-proxy \
  --from-literal=cookie-secret="$(python3 -c 'import os,base64; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')"

# control plane
#
# 注解值必须是字符串：用 --set-string（--set ...=3600 会被 helm 解析成 int64，
# metadata.annotations 是 map[string]string，API server 直接拒绝：
# json: cannot unmarshal number into Go struct field
# ObjectMeta.metadata.annotations of type string）
#
# oauth2Proxy.trustedProxyIps 是生产必需项：填 ingress/gateway Pod 的 CIDR
# （多个跳位依次加下标），留空 = 信任所有来源的 X-Forwarded-*（见"trustedProxyIps：
# 生产必需"）
#
# 注意：本命令里的注释不能夹在续行（\）中间——行尾反斜杠会把下一行的 # 变成同一
# 逻辑行的注释，吞掉后面的参数；占位符 <...> 也要先替换成实际值再执行。
helm upgrade --install dsh-control-plane charts/dsh-control-plane -n dsh-platform \
  --set auth.oidcIssuer=https://authentik.<cluster>/application/o/dsh-platform/ \
  --set auth.oidcClientId=<client-id> \
  --set auth.redirectUri=https://dsh.<domain>/oauth2/callback \
  --set oauth2Proxy.redirectUrl=https://dsh.<domain>/oauth2/callback \
  --set oauth2Proxy.publicOrigin=https://dsh.<domain> \
  --set oauth2Proxy.trustedProxyIps[0]=<ingress-pod-cidr> \
  --set oauth2Proxy.cookieSecretRef=dsh-oauth2-proxy \
  --set oauth2Proxy.cookieSecretKey=cookie-secret \
  --set auth.oidcClientSecretRef=dsh-oidc \
  --set auth.sessionSecretRef=dsh-oidc \
  --set dshWeb.trustedHosts[0]=dsh.<domain> \
  --set ingress.enabled=true \
  --set ingress.host=dsh.<domain> \
  --set ingress.className=nginx \
  --set ingress.tlsSecret=dsh-tls \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-buffering"=off \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-read-timeout"=3600 \
  --set-string ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-send-timeout"=3600
```

### 公网 origin：`DSH_PUBLIC_ORIGIN`

identity-bridge 用官方 launch-token handoff 提供首页：需要重定向时调用
`authenticatedUrl()`，其 origin 取自应用容器的 `DSH_PUBLIC_ORIGIN`。chart 按以下顺序解析
（命中即止），并把它作为普通 env 注入 dsh-web 容器：

1. `oauth2Proxy.publicOrigin`（`https://<host>`，无尾斜杠；推荐显式设置）
2. `oauth2Proxy.redirectUrl` 的 origin
3. `auth.redirectUri` 的 origin
4. `ingress.enabled=true` 时的 `https://<ingress.host>`
5. `istio.enabled=true` 时的 `https://<istio.host>`

以上都取不到时 chart **渲染即失败**，不会静默回落到"从请求推导"。显式值不是
`scheme://host`（带路径或尾斜杠）时同样直接报错。

为什么要钉住：不设时 handoff 会用请求的 `X-Forwarded-Proto`/`Host` 推导 origin，而这组头
在 `oauth2Proxy.trustedProxyIps` 为空时任何客户端都能提供。应用自身的 authority fence
（未知 authority → 403 且不带 `Location`）目前挡住了带 token 的 URL 外泄，但那是兜底，
不是主控制；生产环境请同时设置 `oauth2Proxy.publicOrigin` 与 `oauth2Proxy.trustedProxyIps`。

### trustedProxyIps：生产必需

sidecar 以 `--reverse-proxy=true` 运行，即信任上游给的 `X-Forwarded-Proto`/`Host`；"谁有
资格提供这组头"由 `oauth2Proxy.trustedProxyIps`（→ oauth2-proxy `--trusted-proxy-ip`）决定。

- **生产环境必须设置**：值为 ingress/gateway Pod 的 CIDR，链路上每个可能追加或改写
  `X-Forwarded-*` 的跳都要列上（`--set oauth2Proxy.trustedProxyIps[0]=...`，多跳依次加下标）。
- 保持为配置项：网段因部署而异，chart 不会内置任何网段。
- 留空 = oauth2-proxy 的向后兼容模式：信任所有来源，并在启动时打印
  `WARNING: --reverse-proxy is enabled but no --trusted-proxy-ip CIDRs were configured.
  All connecting IPs are trusted to supply X-Forwarded-* headers by default (0.0.0.0/0, ::/0)`。

留空会退化什么（**不是**认证绕过：访问仍然要过 sidecar 的会话 cookie）：

1. 任何客户端都能提供 `X-Forwarded-Proto`/`Host`/`For`，sidecar 自身的逐请求判断
   （`/oauth2/*` 的重定向、cookie 安全标志、客户端 IP 日志）都受其影响；
2. 应用侧 handoff 的重定向 origin 若未被 `oauth2Proxy.publicOrigin` 钉住，同样受其影响
   —— 这正是要钉住 `DSH_PUBLIC_ORIGIN` 的原因；
3. 将来任何读取 `X-Forwarded-*` 的组件都会继承这层信任。

### 迁移到 sidecar 必须做的三件事

1. **IdP 注册回调地址** `https://dsh.<domain>/oauth2/callback`（oauth2-proxy 的固定
   路径，应用自身不注册任何回调路由）。`auth.redirectUri` 只有 origin 参与推导：
   `oauth2Proxy.redirectUrl` 留空时得到 `<origin>/oauth2/callback`，因此路径写错不会
   改变渲染结果，但请照实写，便于审计。
2. **cookie secret** 长度必须是 16/24/32 字节，否则 sidecar 启动即失败
   （`cookie_secret must be 16, 24, or 32 bytes to create an AES cipher`）。
   `oauth2Proxy.cookieSecretRef` 留空会回落到 `auth.sessionSecretRef` 的
   `session-secret`，只有在那个值恰好合规时才可用。
3. **长连接注解**（仅 nginx 需要）：SSE `/plugins/events` 需要 `proxy-buffering: "off"`，
   WebSocket `/api/remote.mux` 与 SSE 需要 `proxy-read-timeout`/`proxy-send-timeout`。
   Istio/Envoy 默认流式转发、route timeout 默认关闭，无需注解；sidecar 自身已用
   `--flush-interval=1s` 与 `--upstream-timeout=1h` 调优。

## 验证

- 未登录访问 `/` -> 302 到 IdP（`--skip-provider-button=true`，无中间登录页）
- 登录回跳 -> sidecar 会话 cookie 生效，页面与 `/api` 正常（无 401/403）
- 应用容器 env 已收敛（认证变量只存在于 sidecar）：
  `kubectl -n dsh-platform get deploy dsh-control-plane-dsh-control-plane -o jsonpath='{range .spec.template.spec.containers[?(@.name=="dsh-web")].env[*]}{.name}={.value}{"\n"}{end}'`
  -> 有字面值的只有 `DSH_HOME` / `DSH_TELEMETRY_DISABLED` / `DSH_PUBLIC_ORIGIN` /
  `WS_NAMESPACE` / `WS_IMAGE`（`DSH_PG_CONNECTION_STRING` 来自 Secret），
  `DSH_PUBLIC_ORIGIN` 必须等于部署的公网 origin；应用侧不再有任何 OIDC/会话变量
  （认证变量只存在于 sidecar，见 `OAUTH2_PROXY_*`）
- `kubectl logs <pod> -c oauth2-proxy`：`trusted-proxy-ip` 未设置时会有启动告警
  （`WARNING: --reverse-proxy is enabled but no --trusted-proxy-ip CIDRs were configured.
  All connecting IPs are trusted to supply X-Forwarded-* headers by default (0.0.0.0/0, ::/0)`），
  生产部署不应出现这条告警（见"trustedProxyIps：生产必需"）
- `kubectl logs` 检查无 cordis 装配告警（未知 patch 行会打印 "patch: entry ... not found"）

## 工作区运行时

工作区 pod 由控制面 lifecycle manager 动态创建（参数映射见 charts/dsh-workspace/values.yaml）。
关键配置：
- daemon 镜像、PVC StorageClass/容量
- RuntimeClass（runc -> gvisor -> kata 隔离升级）
- NetworkPolicy：控制面命名空间放行 4390；出站按需（API server/registry）

## 已知限制（v1）

- 控制面单副本（多副本 = Plan 后续：共享状态后端 + 会话粘滞）
- 平台插件集随控制面镜像内置（fs-k8s / subprocess-k8s / workspace-k8s /
  workspace-picker / identity-bridge / storage-db / session-persistence-rdb /
  platform-domain），版本与镜像 tag 绑定：无法单独升级某个插件而不重建镜像
- TLS 终止在 Ingress / Istio gateway（sidecar 与 dsh 之间是 pod 内明文 loopback ——
  仅在"loopback 绑定"表里的第二态成立；sidecar 以 `--reverse-proxy=true` 信任网关的
  `X-Forwarded-Proto`/`Host`，生产环境**必须**设置 `oauth2Proxy.trustedProxyIps`，
  否则所有来源的 `X-Forwarded-*` 都被信任：见"trustedProxyIps：生产必需"）
