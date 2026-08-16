# dsh-platform 部署指南

## 架构

```
Ingress (TLS)
  -> dsh-control-plane (Deployment)
       auth-gate (sidecar: OIDC 登录 + 转发)  :3080
       dsh-web   (loopback)                   :3000 (仅 gate 可达)
  -> workspace pods (动态创建, dsh-workspace-k8s manager)
       sandbox-daemon                         :4390 (仅控制面可达, NetworkPolicy)
       workspace PVC (per workspace)
```

## 前置

1. authentik OIDC 应用（见 config/authentik.example.md）：平台 client + kube-apiserver client
2. 镜像：`visecy/dsh-auth-gate`（auth-oidc 打包）、`visecy/dsh-sandbox-daemon`、dsh-web（runzhliu 基线）
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
- 登录回跳 -> 会话 cookie 生效
- `kubectl logs` 检查 gate 与 dsh-web 无错误

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
