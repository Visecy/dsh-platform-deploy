# dsh-platform-deploy

`dsh-platform` 的部署与运维仓库：Helm charts、配置样例、本地测试集群。

平台本体（插件 monorepo、控制面镜像、daemon 镜像）在
[`Visecy/dsh-platform`](https://github.com/Visecy/dsh-platform)。

| 目录 | 内容 |
|---|---|
| `charts/dsh-control-plane` | **要安装的 chart**：控制面 Deployment（dsh web + oauth2-proxy sidecar）、Service、Ingress / Istio VirtualService、NetworkPolicy、RBAC、必需 Secret 的引用 |
| `charts/dsh-workspace` | 工作区执行 pod 的**配置参考**（无模板，不直接安装）：逐项说明控制面 chart 的 `workspace.*` 取值如何映射到 `@visecy/dsh-workspace-k8s` 的选项 |
| `config/authentik.example.md` | authentik 侧的 OIDC 应用配置样例（任何 OIDC IdP 都可用，oauth2-proxy 不绑定厂商） |
| `docs/deployment.md` | **从这里开始**：前置条件、从零安装、验证、升级/回滚、备份、故障排查、已知限制 |
| `kind/` | 本地 kind 集群的冒烟脚本与工作区/daemon 测试清单（`smoke.sh` 自包含：集群、命名空间、开发用 PostgreSQL、全部 Secret） |
| `oidc-test/` | 端到端登录测试台（dex + 真实登录流程），dev only，见该目录 README |

快速开始见 [`docs/deployment.md`](docs/deployment.md)；平台内部结构见 dsh-platform 的
`docs/architecture.md`。
