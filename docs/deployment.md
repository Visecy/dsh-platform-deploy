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

> **身份头**：`--set-xauthrequest` 产生的 `X-Auth-Request-*` 是返回给**浏览器**的
> 响应头（nginx auth_request 风格）；真正到达 DSH 进程的是请求头
> `X-Forwarded-User` / `X-Forwarded-Groups` / `X-Forwarded-Email` /
> `X-Forwarded-Preferred-Username`（`--pass-user-headers=true` 默认开启）。
> identity-bridge 读 `X-Forwarded-*`。已在本地用镜像内的 v7.15.5 二进制实测。


## 前置

1. authentik OIDC 应用（见 config/authentik.example.md）：平台 client + kube-apiserver client
2. 镜像：`ghcr.io/visecy/dsh-web-platform:<tag>`（自包含控制面：官方 @deepseek-ai/dsh
   0.1.2-rc.1 + @visecy 平台插件 + patch-dsh 补丁，tag 与插件 npm 版本一致）、
   `ghcr.io/visecy/dsh-platform/dsh-sandbox-daemon:<tag>`、可选 `visecy/dsh-auth-gate`（sidecar 形态已不再使用）
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
helm upgrade --install dsh-control-plane charts/dsh-control-plane -n dsh-platform \
  --set auth.oidcIssuer=https://authentik.<cluster>/application/o/dsh-platform/ \
  --set auth.oidcClientId=<client-id> \
  --set auth.redirectUri=https://dsh.<domain>/auth/callback \
  --set oauth2Proxy.redirectUrl=https://dsh.<domain>/oauth2/callback \
  --set oauth2Proxy.cookieSecretRef=dsh-oauth2-proxy \
  --set oauth2Proxy.cookieSecretKey=cookie-secret \
  --set auth.oidcClientSecretRef=dsh-oidc \
  --set auth.sessionSecretRef=dsh-oidc \
  --set dshWeb.trustedHosts[0]=dsh.<domain> \
  --set ingress.enabled=true \
  --set ingress.host=dsh.<domain> \
  --set ingress.className=nginx \
  --set ingress.tlsSecret=dsh-tls \
  --set ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-buffering"=off \
  --set ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-read-timeout"=3600 \
  --set ingress.annotations."nginx\.ingress\.kubernetes\.io/proxy-send-timeout"=3600
```

### 迁移到 sidecar 必须做的三件事

1. **IdP 新增回调地址** `https://dsh.<domain>/oauth2/callback`（oauth2-proxy 的
   路径；旧的 `/auth/callback` 属于已删除的进程内 gate）。只改 origin 不改路径
   也可以：`oauth2Proxy.redirectUrl` 留空时由 `auth.redirectUri` 的 origin +
   `/oauth2/callback` 推导。
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
- `kubectl logs <pod> -c oauth2-proxy` 无启动告警（`trusted-proxy-ip` 未设置时会
  打印 "trusting all source IPs"）
- `kubectl logs` 检查无 cordis 装配告警（未知 patch 行会打印 "patch: entry ... not found"）

## 工作区运行时

工作区 pod 由控制面 lifecycle manager 动态创建（参数映射见 charts/dsh-workspace/values.yaml）。
关键配置：
- daemon 镜像、PVC StorageClass/容量
- RuntimeClass（runc -> gvisor -> kata 隔离升级）
- NetworkPolicy：控制面命名空间放行 4390；出站按需（API server/registry）

## 已知限制（v1）

- 控制面单副本（多副本 = Plan 后续：共享状态后端 + 会话粘滞）
- 平台插件（fs-k8s/subprocess-k8s/workspace-k8s/auth-oidc/user-domain）的 cordis 装配待控制面镜像集成
- TLS 终止在 Ingress / Istio gateway（sidecar 与 dsh 之间是 pod 内明文 loopback ——
  仅在"loopback 绑定"表里的第二态成立；sidecar 以 `--reverse-proxy=true` 信任网关的
  `X-Forwarded-Proto`/`Host`，生产环境**必须**把 `oauth2Proxy.trustedProxyIps` 设为
  网关/ingress Pod 的 CIDR：留空等于信任所有来源的 `X-Forwarded-*`，在
  `auth.redirectUri` 与 `oauth2Proxy.redirectUrl` 都为空时可用于开放重定向/钓鱼）
