# 变更日志（CHANGELOG）

本仓是 `dsh-platform` 的部署侧仓库（Helm charts、配置样例、本地测试集群），**自身不打 tag、
没有独立版本号**：镜像 tag 与插件版本都由平台仓的 `v*` tag 决定，因此下面按平台版本记录
部署侧的变化；平台本体（插件、镜像、DSH 基线）见平台仓的 `CHANGELOG.md`。

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
