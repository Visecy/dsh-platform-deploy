# dsh-platform 部署指南

## 架构

```
Ingress (TLS)
  -> dsh-control-plane (Deployment, dsh-web-platform 镜像)
       dsh web :3080  —— 进程内 OIDC gate（@visecy/dsh-web-auth fork 的
       webserver request-gate + @visecy/dsh-auth-oidc），同一进程承载
       /api 网关（dsh-client-connection）、前端与 workspace REST API
  -> workspace pods (动态创建, dsh-workspace-k8s manager)
       sandbox-daemon                         :4390 (仅控制面可达, NetworkPolicy)
       workspace PVC (per workspace)
```

> DSH 0.1.2 起 `/api`（RPC/WS）由 dsh-client-connection 统一 Host/Origin
> fence 保护：`--trusted-host`（即 `dshWeb.trustedHosts`）必须列出部署的
> 公网 authority，否则所有 `/api` 请求 403。镜像构建时的 patch-dsh 补丁
> 绕过 0.1.2 新增的浏览器 Cookie 会话层——OIDC gate 是唯一会话层，因此
> 不要单独暴露 dsh web 端口。

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

# control plane
helm upgrade --install dsh-control-plane charts/dsh-control-plane -n dsh-platform \
  --set auth.oidcIssuer=https://authentik.<cluster>/application/o/dsh-platform/ \
  --set auth.oidcClientId=<client-id> \
  --set auth.redirectUri=https://dsh.<domain>/auth/callback \
  --set auth.oidcClientSecretRef=dsh-oidc \
  --set auth.sessionSecretRef=dsh-oidc \
  --set dshWeb.trustedHosts[0]=dsh.<domain> \
  --set ingress.enabled=true \
  --set ingress.host=dsh.<domain> \
  --set ingress.className=nginx \
  --set ingress.tlsSecret=dsh-tls
```

## 验证

- 未登录访问 `/` -> 302 到 authentik
- 登录回跳 -> 会话 cookie 生效，页面与 `/api` 正常（无 401/403）
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
- TLS 终止在 Ingress（gate 本身 HTTP；生产建议前置 oauth2-proxy 类做额外头卫生可选）
