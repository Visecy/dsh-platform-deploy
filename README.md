# dsh-platform-deploy

dsh-platform 的部署与运维仓库：helm charts、配置样例、本地测试集群。

- charts/dsh-control-plane：控制面（dsh web + 平台插件集 + 认证）
- charts/dsh-workspace：工作区执行 pod（sandbox daemon）
- config/：authentik 应用、kube-apiserver OIDC、准入白名单样例
- kind/：本地测试集群脚本
- docs/：部署/运维文档
