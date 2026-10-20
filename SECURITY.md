# 安全策略

本仓是 [`dsh-platform`](https://github.com/Visecy/dsh-platform) 的部署侧：Helm charts、
配置样例与本地测试集群脚本。**平台当前是预览版（preview），不面向生产**，也从未经过审计。
平台代码自身的安全模型见平台仓的 `SECURITY.md`，本文只讲部署侧。

## 报告漏洞

- 使用 GitHub 的**私密漏洞报告**：本仓 [Security](https://github.com/Visecy/dsh-platform-deploy)
  标签页 → **Report a vulnerability**。请不要开公开 issue。
- 插件、镜像或 daemon 的问题报到平台仓
  [Visecy/dsh-platform](https://github.com/Visecy/dsh-platform) 的 Security 标签页。
- 请附上 chart 版本或 commit、values（去掉真实凭据）、复现步骤与影响面。
- 修复发布前请勿公开细节。

## 认证契约（chart 的信任基础）

身份**只**来自同 pod 的 oauth2-proxy sidecar 注入的 `X-Forwarded-User` /
`X-Forwarded-Groups`（`--pass-user-headers=true`，chart 固定开启）。
这两个头**没有签名**，应用进程内没有任何认证组件，所以唯一屏障是拓扑：

1. **不得发布应用端口**：没有 Service / Ingress / NodePort 指向 dsh web 进程
   （chart 的 Service 只暴露 sidecar 的 4180）；`kubectl port-forward` 到应用端口同样算直达。
2. **应用只绑 loopback**：chart 用 `--host 127.0.0.1` 启动，官方 CLI 自己就拒绝 `--host 0.0.0.0`。
   但这条来自镜像 profile 而不是 chart 的 flag——**必须 pin chart 默认的那个 tag，
   不要跑旧的 `webserver-gated` 镜像**（那种镜像会同时监听 Pod IP）。
3. **入口策略与 NetworkPolicy 是纵深防御**，不是第 1、2 条的替代品。

`X-Auth-Request-*` 在本拓扑下由客户端可控：oauth2-proxy 只把它放在**浏览器响应**上，
从不清理客户端伪造的同名**请求头**，所以 chart 刻意不设置 `--set-xauthrequest`
（没有任何组件消费它，开着只会诱使后来者把它当身份）。若注入的架构里真有组件需要它，
应在 ingress 层剥离这批请求头——chart 自己清不掉。
`identity-bridge` 会拒绝对该族取值。

## 部署方必须自己补的部分

- **`oauth2Proxy.trustedProxyIps`（生产必需）**：sidecar 以 `--reverse-proxy=true` 运行。
  不设它不是认证绕过（会话 cookie 仍然必须过），但会让 sidecar 对 `X-Forwarded-Proto` /
  `Host` / `For` 的所有判断受客户端影响（`/oauth2/*` 重定向、cookie 安全标志、客户端 IP 日志），
  并且它会打印 `WARNING: --reverse-proxy is enabled but no --trusted-proxy-ip CIDRs were configured`。
  chart 不内置任何网段：填 ingress / gateway Pod 的 CIDR（链路上每个可能改写
  `X-Forwarded-*` 的跳都要列上）。CIDR 因部署而异，**不要**把它硬编码进 chart。
- **工作区 daemon 没有认证**：`sandbox-daemon` 在 4390 提供文件读写 / 命令执行 / PTY，
  没有任何凭据校验。`workspace.networkPolicy.enabled` 默认 **false**；打开后平台会为每个
  工作区建一条 NetworkPolicy，只允许带 `workspace.networkPolicy.controlPlanePodLabels`
  标签的 Pod 访问 4390（peer 是 label selector，`replicaCount > 1` 时会放行兄弟副本）。
  在不支持 NetworkPolicy 的 CNI 上它等于没有。**建议同时**在命名空间上做 default-deny ingress。
- **`oauth2Proxy.publicOrigin`**：identity-bridge 的 launch-token handoff 用它作为重定向
  base。留空时 chart 会按顺序从 `redirectUrl` / `auth.redirectUri` / ingress / istio 推导
  **origin**，推导不出来就**渲染失败**——不要让它回落到从请求头推导。子路径发布时在这里
  显式写单段 path（如 `https://dsh.example.com/dsh`），chart 据此派生入口前缀剥离、301、
  oauth2-proxy 回调与 cookie path（见 `docs/deployment.md` §4.4）。
- **Secret 与凭据**：连接串、OIDC client secret、cookie secret 都放在已有 Secret 里，
  chart 只引用名字（`dsh-db` / `dsh-oidc` / `dsh-oauth2-proxy`），不要把真值写进 values。
  cookie secret 必须是 16/24/32 字节（或其 base64url），否则 sidecar 直接退出。
- **入口必须支持长连接**：nginx-ingress 默认缓冲会静默切断 SSE（`/plugins/events`）与
  WebSocket（`/api/remote.mux`）；TLS 终止在 ingress / 网关，sidecar 到应用是 Pod 内明文。

## 已知限制（不是漏洞）

- **没有多租户授权**：所有通过认证的用户共享同一份控制面状态（会话、工作区、模型凭据），
  并且都能列出 / 休眠 / 删除彼此的工作区。**不要把预览版直接暴露给互相不可信的用户群。**
  （`replicaCount` 也必须保持 1：没有 leader election。）
- 删除工作区会删除它的 PVC，数据不可恢复。
- 只发布 `linux/amd64`；子路径发布仅支持单段前缀，且同 host 只能有一个 DSH 实例（DSH 会话
  cookie 是 authority 作用域且 `Path=/`，见 `docs/deployment.md` §4.4）；不支持
  ReadWriteMany、air-gapped 安装。

## 支持的版本

只有 `main` 与最新 tag 接受修复。chart 默认 pin 的 `image.dshWeb` 与 `workspace.image`
必须来自**同一个平台 tag**（两侧共享 daemon 协议，没有版本握手）。
