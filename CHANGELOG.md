# 变更日志（CHANGELOG）

本仓是 `dsh-platform` 的部署侧仓库（Helm charts、配置样例、本地测试集群），**自身不打 tag、
没有独立版本号**：镜像 tag 与插件版本都由平台仓的 `v*` tag 决定，因此下面按平台版本记录
部署侧的变化；平台本体（插件、镜像、DSH 基线）见平台仓的 `CHANGELOG.md`。

## 未发布（P2 子路径发布）

在 `v0.1.90` 基础上，部署侧新增**子路径发布**能力：控制面可以挂到同 host 的**单段**路径
前缀下（如 `https://dsh.example.com/dsh/`），与同 host 的其他服务共存。root 发布仍是默认
路径，渲染输出除 chart 版本 label 外不变。

- **默认镜像 tag 对齐平台 `v0.1.93`（chart 0.1.3 → 0.1.4）**：`image.dshWeb`、
  `workspace.image` 与 `charts/dsh-workspace` 的 daemon 引用一起提到 `v0.1.93`。该版本包含
  0.2.1 线上的三个修复：**v0.1.89/v0.1.90 的「新建终端」不可用**
  （`subprocess.terminalEnvironment` seam 缺失，v0.1.91 修复）、**v0.1.91 的工作区在 ensure
  失败后可能永久停在「正在唤醒」**（v0.1.92 修复），以及 **v0.1.92 的新建终端仍在 shell 解析
  阶段打到 loopback daemon（`sandbox daemon unreachable: fetch failed`）**（v0.1.93 修复：
  无 cwd 的 `resolveExecutable` 与工作区根 cwd 现在路由到默认工作区）。因此 chart 不再默认
  pin 旧 tag。root/prefix 渲染逻辑与 0.1.2 完全相同，本次只改默认 pin、文档与 CI 断言。

- **chart 从 `oauth2Proxy.publicOrigin` 的 path 派生全部前缀行为（单一真值）**：
  `dsh web --public-url` 保留带前缀的 root；ingress 主 Ingress 增加
  `nginx.ingress.kubernetes.io/use-regex` / `rewrite-target: /$2` 与
  `<prefix>(/|$)(.*)` 路径（前缀剥离后再交给 sidecar —— DSH 的 launch-token exchange 只认
  `/`），并新增一条 301 Ingress（`/` 与裸 `/<prefix>` → `<root>/`，保证相对资源基址和
  oauth2-proxy 登录回跳自愈）；Istio VirtualService 增加 prefix match + `rewrite.uri: /`
  与精确 match 的 301 route（redirect 用 path 而非绝对 URL —— Envoy 的 `path_redirect`
  会把绝对 URL 拼在 host 之后）。
- **oauth2-proxy 前缀感知**：`--redirect-url` 在子路径模式下派生为
  `<root>/oauth2/callback`；新增 `--cookie-path=/<prefix>/`（root 模式不渲染该 flag，输出
  保持不变）。
- **渲染期 fail-fast**：多段前缀、query / fragment / credentials / 空白、前缀但无路由层、
  前缀 + `ingress.className` 非 `nginx`、前缀 + 用户注解已含 `rewrite-target` /
  `use-regex`、前缀 + 显式 `redirectUrl` 不在前缀下 —— 全部渲染失败并给出明确 message。
- **文档**：`docs/deployment.md` §4.3 改为 root 允许 `host[/单段 prefix]`，新增 §4.4
  「子路径发布」（values 示例、IdP 回调注册、ingress/Istio 与 oauth2-proxy 配置要求表、
  301 行为、cookie 说明、限制）；§8 限制与 `SECURITY.md` 同步。
- **CI**：`.github/workflows/charts.yml` 增加前缀模式渲染断言、root 模式无前缀产物断言，
  以及 6 条 fail-render 负向用例。
- chart version `0.1.1` → `0.1.2`；**镜像 tag 未变**（仍为 v0.1.90）。

**限制（v1）**：只支持单段前缀，字符集 `[A-Za-z0-9_-]`（该值同时进入 nginx 正则 path 与
Istio prefix match，渲染期拒绝 `.`/括号/百分号编码/多段）；**同 host 只能有一个 DSH 实例**（DSH
会话 cookie 是 authority 作用域 + `Path=/`，上游行为，子路径只解决"与其它服务共存"）。**Istio 路径已通过
真实集群 e2e**（2026-10-21，chart 0.1.2 + 镜像 v0.1.90 / oauth2-proxy v7.15.5）：前缀模式
31/31 断言 PASS（含 B7 重定向表与 M1 兜底），root 模式回归 29/29 PASS；nginx-ingress 路径目前
只有 CI 渲染断言，上线前需在目标集群按同一断言表验证。oauth2-proxy 在入口 rewrite 后会把登录
回跳落到 `/`（上游 issue #1008/#1297，e2e 实测），由 `/` 与裸 `/<prefix>` → `<root>/` 的 301
兜底 —— 该 301 是登录链路的一部分，不是可选项。

## v0.1.90（预览）

`v0.1.90` 相对部署侧上一次记录的 `v0.1.88` 的变化（`v0.1.89` 只升级平台 DSH 基线到
`0.2.1-rc.2`，部署侧无需变更，chart 默认 pin 随本版一起更新）。**预览版，不面向生产**。

- **默认镜像 tag 对齐到平台 `v0.1.90`**：`charts/dsh-control-plane` 的 `image.dshWeb` /
  `workspace.image`、`charts/dsh-workspace/values.yaml` 的参考值与
  `kind/workspace-smoke.yaml` 示例全部指向同一 tag。
- **对外 URL 单一真值**：控制面 chart 现在把推导出的公网 root 作为 `dsh web --public-url`
  传给应用容器，并移除了 `DSH_PUBLIC_ORIGIN` env。平台 v0.1.90 的 identity-bridge 从
  官方 advertised URL（`webApp.getAdvertisedUrl()`）取 handoff base，因此 chart 与
  profile 不再各自维护一份 origin。`oauth2Proxy.publicOrigin` 的推导顺序、渲染期
  fail-closed 行为不变；取值仍只支持 origin（无路径）。
- **镜像要求**：`--public-url` 需要平台 `v0.1.90+` 镜像（DSH 0.2.1 CLI 才认识该 flag）；
  不要用本 chart 配 `v0.1.88`/`v0.1.89` 镜像。
- 文档：`docs/deployment.md` §4.3 改为 `--public-url` 语义；验证步骤改为检查启动参数而不是
  env；`charts/dsh-control-plane` chart version 0.1.0 → 0.1.1。

## v0.1.88（预览）

`v0.1.88` 相对上一个已发布平台 tag（`v0.1.87`）的部署侧变化。**预览版，不面向生产**，部署限制见
`docs/deployment.md` §8。本轮目标是让第一次预览发布前，chart、文档与平台实际行为不再互相矛盾。

### 发布就绪修正

- **默认镜像 tag 对齐到平台 `v0.1.88`**：`image.dshWeb`、`workspace.image`、
  `charts/dsh-workspace/values.yaml` 的参考值、`kind/workspace-smoke.yaml` 与
  `docs/deployment.md` 的示例全部指向同一 tag（控制面与 daemon 共享协议，必须同 tag）。
- **部署文档重写为从零快速开始**：`docs/deployment.md` 现在按顺序覆盖前置条件、
  命名空间、数据库连接串 Secret、IdP 回调与两个 Secret、安装命令（含必须同步的两个镜像 tag）、
  验证、认证契约（身份头 / `trustedProxyIps` / `DSH_PUBLIC_ORIGIN` 的推导顺序）、
  工作区运行时、升级与回滚、备份与恢复、预览版已知限制、故障排查。
- **控制面 chart 接线补全**：原先部分 `workspace.*` knob 只写在 `values.yaml` 里、没有出口，
  现在全部 `WS_*` 运行时开关（`WS_NAMESPACE` / `WS_IMAGE` / `WS_STORAGE_CLASS` /
  `WS_STORAGE_SIZE` / `WS_RUNTIME_CLASS` / 空闲与宽限 / 收敛与指标间隔 / 资源上限 /
  NetworkPolicy 开关与 peer 标签）都真正传进应用容器；镜像 tag 默认 pin 到与 chart 同期发布的
  tag，工作区 daemon 镜像必须用同一个 tag。
- **镜像拉取与 Pod 加固**：`imagePullSecrets` 变为可配置（私有 registry 场景，控制面与工作区
  Pod 都生效），工作区 Pod 设置 `seccompProfile: RuntimeDefault`（此前 `restricted` 命名空间
  会拒绝）。
- **工作区配置参考与实现对齐**：`charts/dsh-workspace/values.yaml` 逐项标注控制面 values →
  容器 env → `@visecy/dsh-workspace-k8s` 配置的映射，并明确记录平台**未实现**的项
  （每工作区 egress 允许清单、每工作区 ServiceAccount），而不是让它们看起来已支持。
- **新增 chart CI**：`.github/workflows/charts.yml` 在 `push: main` 与 PR 上跑
  `helm lint`（两个 chart）、用文档里的占位值 `helm template` 控制面、断言缺少必填认证值时
  渲染失败（fail-closed），并断言工作区参考 chart 仍然为空渲染。此前本仓没有任何 CI。
- **本地冒烟自包含**：`kind/smoke.sh` 自己建集群、命名空间、一次性 PostgreSQL（平台镜像没有
  其它后端）与全部 Secret，并断言 dev cookie secret 的字节数合法（16/24/32，否则 sidecar
  直接退出、整个控制面不可用）。

### 认证与网络

- 身份契约写死在 chart 与文档里：可信上游身份对只有 `X-Forwarded-User` /
  `X-Forwarded-Groups`；`X-Auth-Request-*` 在本拓扑下由客户端可控，chart 刻意不设置
  `--set-xauthrequest`，任何组件都不得把它当身份读取。
- `oauth2Proxy.trustedProxyIps` 明确标注为**生产必需**（留空时 oauth2-proxy 会信任任何来源的
  `X-Forwarded-*`，并打印对应 WARNING）；CIDR 因部署而异，chart 不内置任何网段。
- Service 只暴露 oauth2-proxy sidecar 端口，应用进程绑 loopback；入口 NetworkPolicy 与
  工作区 daemon 的 NetworkPolicy 都只作为纵深防御，文档里不再把任一者写成"认证屏障"。
- 工作区 daemon（4390，files / commands / pty）**没有认证**：`workspace.networkPolicy.enabled`
  默认 false，必须由部署方显式打开或在命名空间上做 default-deny。
- **配置样例与测试台**：`config/authentik.example.md` 按 sidecar 架构重写（回调注册在
  `https://<host>/oauth2/callback`，即 oauth2-proxy 的固定路径）；`oidc-test/` 测试台改为走
  identity-bridge 与 sidecar 回调并断言会话 cookie，旧的 in-process auth gate 链路已删除。

## v0.1.87 及更早

部署侧没有逐版本记录，早期平台 tag（`v0.1.2` … `v0.1.87`）也没有留下逐版本说明，本文件不补造
历史条目。需要某个平台 tag 对应的 chart 状态时，用 `git log` 按时间对齐查询。
