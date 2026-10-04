# authentik 配置样例（dsh-platform OIDC 对接）

> 环境：visecy 集群 authentik（SSO 中台）。oidc-bridge 转接层不在方案内。
>
> 认证由部署里的 oauth2-proxy sidecar 终止：sidecar 完成 OIDC 授权码流程，把会话放在
> 它自己的加密 cookie 里，并在转发给 dsh web 的上游请求上注入 `X-Forwarded-User` /
> `X-Forwarded-Groups`。dsh web 容器不读任何 OIDC 环境变量、不注册认证回调路由、也没有
> 平台自己的会话 cookie —— 这些都属于已退役的进程内 gate，本目录不再包含其配置。

## 1. 平台 OIDC 应用（dsh 控制面登录）

在 authentik 创建 Provider + Application：

- **Provider 类型**：OIDC Provider
  - Client Type: Confidential
  - **Redirect URIs/Origins**: `https://<host>/oauth2/callback`
    （oauth2-proxy 的固定回调路径；不是应用自己的路由，应用不提供任何回调端点）
  - Scopes: openid, profile, email, groups
    （`groups` 必留：chart 的 `oauth2Proxy.scope` 请求它，缺了它上游
    `X-Forwarded-Groups` 就是空的）
  - **Signing Key**：RS256
  - **Access token validity**：短时（如 5 min）
- **Application**：slug `dsh-platform`，关联上述 Provider
- 授权边界就是 authentik 里"谁被分配到该 Application"：sidecar 以 `--email-domain=*`
  运行（应用分配本身即边界），登录成功后不再做二次组判断；因此不要再为该应用之外的
  入口暴露控制面。

## 2. 平台侧配置（Helm values）

完整安装命令见 `docs/deployment.md`（同目录的样例值都通过 `--set` 传入，不写进镜像）。
与 authentik 相关的字段：

| values | 说明 |
| --- | --- |
| `auth.oidcIssuer` | authentik issuer，如 `https://authentik.<cluster>/application/o/dsh-platform/`（含尾斜杠） |
| `auth.oidcClientId` | 上面 Provider 的 client id |
| `auth.oidcClientSecretRef` | Secret 名（key `oidc-client-secret`）；sidecar 以 `OAUTH2_PROXY_CLIENT_SECRET` 读取 |
| `oauth2Proxy.cookieSecretRef` / `.cookieSecretKey` | sidecar 会话 cookie 的签名+加密密钥，必须 16/24/32 字节；名字留空时回落到 `auth.sessionSecretRef` |
| `auth.redirectUri` | 公网回调地址；只有它的 **origin** 参与推导：`oauth2Proxy.redirectUrl` 留空时 sidecar 的 `--redirect-url` = `<origin>/oauth2/callback` |
| `oauth2Proxy.publicOrigin` | 公网 origin（`https://<host>`，无尾斜杠），作为 `DSH_PUBLIC_ORIGIN` 注入应用，供 launch-token handoff 使用；留空则从上面的 origin 推导 |
| `oauth2Proxy.trustedProxyIps` | 生产必需：ingress/gateway Pod 的 CIDR，否则 sidecar 信任所有来源的 `X-Forwarded-*` |

```yaml
# 与安装命令里的 --set 等价的示意（非直接 apply 的 values 文件）
auth:
  oidcIssuer: https://authentik.<cluster>/application/o/dsh-platform/
  oidcClientId: <client-id>
  redirectUri: https://<host>/oauth2/callback   # 仅 origin 被消费
  oidcClientSecretRef: dsh-oidc                # key: oidc-client-secret
  sessionSecretRef: dsh-oidc                   # cookie secret 回落来源
oauth2Proxy:
  redirectUrl: https://<host>/oauth2/callback  # 留空则由 redirectUri 的 origin 推导
  publicOrigin: https://<host>                 # DSH_PUBLIC_ORIGIN，无尾斜杠
  cookieSecretRef: dsh-oauth2-proxy            # key: cookie-secret
  cookieSecretKey: cookie-secret
  scope: "openid email profile groups"
  groupsClaim: groups
  trustedProxyIps: [<ingress-pod-cidr>]        # 生产必需
```

> authentik issuer 通常是 `https://<auth>.${domain}/application/o/<slug>/`（含尾斜杠）。
> 会话 cookie 是 oauth2-proxy 自己的（默认名 `_oauth2_proxy`；`--cookie-secure=true`
> 即默认值时带 `Secure`），不存在平台侧的 session secret。

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

1. 浏览器打开平台 → 302 到 authentik 登录页 → 登录成功回跳 `/`；sidecar 的会话 cookie
   （默认 `_oauth2_proxy`）生效
2. 未登录访问任意路径（含 `/api/*`）→ 302 到 IdP：拦截发生在 sidecar，请求到不了应用，
   所以这里看到的是重定向而不是应用返回的 401
3. 身份以请求头 `X-Forwarded-User` / `X-Forwarded-Groups` 到达应用
   （`--pass-user-headers=true`，本 chart 固定开启）。`X-Auth-Request-*` 在本拓扑下由
   客户端可控，任何组件都不得把它当身份读取
4. 集群侧：工作区 pod 内 `kubectl auth whoami` 显示 OIDC 用户名；`kubectl auth can-i --list`
   与组权限一致
5. authentik 日志确认 token 签发/刷新无异常
