# Mirror V Portal

Mirror V 的多 Agent 门户：访客选择 Agent 模板，用同一个入口码在飞书或微信扫码，进入各自的授权流程并创建独立实例；管理员查看 Agent、客户、套餐、Skill 定价与管理员账户。当前提供 Mirror V 与 DealClaw 两个模板，模板列表由运行时接口提供，后续 Agent 可继续加入。钉钉扫码开通尚未接入。

## 代码与部署

- 产品代码：GitHub 私有仓库 [`vegekyd-sys/mirror-v-portal`](https://github.com/vegekyd-sys/mirror-v-portal)，`dev` 是当前部署分支。
- 历史来源：GitLab `d12/dealclaw` 中的网关、后台和计费代码，以及 DealClaw Elastic 运行时。历史模块与协议中的 `nexus` 标识暂时保留兼容。
- 线上入口：`https://mirror-v-portal.vercel.app/onboard`。Vercel 提供 HTTPS 门户入口，请求转发到腾讯云 Mirror V Lighthouse `43.134.135.143`。旧入口 `https://nexus-iota-topaz.vercel.app/onboard` 暂留作兼容。
- 管理后台：`https://mirror-v-portal.vercel.app/admin/agents`。
- 本地试用：运行 `scripts/mirror-v-local-tunnel.sh`，打开 `http://127.0.0.1:18080/onboard`。它连接同一台线上主机。

部署架构、发布和回滚步骤见 [Mirror V 部署说明](deploy/mirror-v/README.md)。仓库改名的兼容边界见 [品牌与内部标识](docs/portal-branding.md)。
统一扫码入口的状态和渠道边界见 [统一入口说明](docs/universal-scan.md)。

## 主要目录

- `packages/central-gateway`：扫码入口、模板选择、渠道接入。
- `packages/runtime-manager`：Elastic 实例生命周期、Agent 调用与聊天。
- `packages/admin-web`：管理后台。
- `packages/credits-ledger`：客户账户与 Credits 账本。
- `packages/agent-templates`：可上架的 Agent 模板与 payload。
- `deploy/mirror-v`、`deploy/vercel-edge`：线上部署配置。

历史 GitLab 架构与设计材料保留在 `docs/` 和其他 `packages/` 中，不能把其中的 Kubernetes 部署说明当作当前腾讯云主机的发布步骤。
