# authentik 配置样例（dsh-platform OIDC 对接）

> 环境：visecy 集群 authentik（SSO 中台）。oidc-bridge 转接层不在方案内。

## 1. 平台 OIDC 应用（dsh 控制面登录）

在 authentik 创建 Provider + Application：

- **Provider 类型**：OIDC Provider
  - Client Type: Confidential
  - Redirect URIs/Origins: `https://<dsh.example.com>/auth/callback`
  - Scopes: openid, profile, email, groups
  - **Signing Key**：RS256
  - **Access token validity**：短时（如 5 min）
- **Application**：slug `dsh-platform`，关联上述 Provider

## 2. 平台侧配置（auth-oidc 插件）

```yaml
oidc:
  issuer: https://authentik.<cluster>/application/o/dsh-platform/  # authentik OIDC issuer
  clientId: <client-id>
  clientSecret: <client-secret>          # env 引用，勿入库
  redirectUri: https://<dsh.example.com>/auth/callback
  scopes: [openid, profile, email, groups]
sessionSecret: <random-32-bytes>         # 会话 cookie HMAC 密钥
adminGroups: [dsh-admins]                # 平台管理员组（authentik 组名）
```

> authentik issuer 通常是 `https://<auth>.${domain}/application/o/<slug>/`（含尾斜杠）。

## 3. 集群 OIDC 认证（kube-apiserver，供工作区集群访问复用）

kube-apiserver 参数（static pod 或 kubeadm 配置）：

```
--oidc-issuer-url=https://authentik.<cluster>/application/o/kube-apiserver/
--oidc-client-id=<kube-client-id>        # authentik 中 kube-apiserver 应用的 client id（作 audience）
--oidc-username-claim=preferred_username
--oidc-groups-claim=groups
--oidc-username-prefix=                  # 可选：去掉前缀，直接用用户名
```

集群 RBAC 绑定（"集群读者/集群管理员" = authentik 组 + ClusterRoleBinding）：

```yaml
# 管理员组（authentik: k8s-admins）→ 集群 admin
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: dsh-k8s-admins }
subjects:
  - kind: Group
    name: k8s-admins          # authentik 组名（--oidc-groups-claim 发出的组）
    apiGroup: rbac.authorization.k8s.io
roleRef: { kind: ClusterRole, name: cluster-admin, apiGroup: rbac.authorization.k8s.io }
---
# 读者组（authentik: k8s-readers）→ 只读
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: dsh-k8s-readers }
subjects:
  - kind: Group
    name: k8s-readers
    apiGroup: rbac.authorization.k8s.io
roleRef: { kind: ClusterRole, name: view, apiGroup: rbac.authorization.k8s.io }
```

## 4. 验证清单（部署环境执行）

1. 浏览器打开平台 → 302 到 authentik 登录页 → 登录成功回跳 `/`，cookie `dsh_session` 生效
2. 未登录访问 `/api/*` → 401 JSON
3. 管理员组用户登录后 `x-dsh-user` 头正确、管理路由可访问
4. 集群侧：工作区 pod 内 `kubectl auth whoami` 显示 OIDC 用户名；`kubectl auth can-i --list` 与组权限一致
5. authentik 日志确认 token 签发/刷新无异常
