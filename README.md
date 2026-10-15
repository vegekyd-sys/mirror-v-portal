# Mirror V Portal

Mirror V 的多 Agent 门户：访客选择 Agent 模板，再选择飞书或微信，页面一次显示对应渠道的一张码。飞书使用注册授权码；微信使用 iLink 原生授权码，需用微信扫一扫直接扫描电脑屏幕。授权完成后创建独立 Agent 实例；管理员查看 Agent、客户、套餐、Skill 定价与管理员账户。当前公开提供 DealClaw、Mirror V、星擎 Agent 和 Makaron，具体列表由运行时接口提供。Makaron 创建前需连接用户自己的账号。二维码和接口检查不能替代用户实际手机授权与后续聊天验收；钉钉扫码开通尚未接入。

## 代码与部署

- 产品代码：GitHub 私有仓库 [`vegekyd-sys/mirror-v-portal`](https://github.com/vegekyd-sys/mirror-v-portal)，`dev` 是当前部署分支。
- 历史来源：GitLab `d12/dealclaw` 中的网关、后台和计费代码，以及 DealClaw Elastic 运行时。历史模块与协议中的 `nexus` 标识暂时保留兼容。
- 线上入口：`https://mirror-v-portal.vercel.app/onboard`。Vercel 提供 HTTPS 门户入口，请求转发到腾讯云 Mirror V Lighthouse `43.134.135.143`。旧入口 `https://nexus-iota-topaz.vercel.app/onboard` 暂留作兼容。
- 管理后台：`https://mirror-v-portal.vercel.app/admin/agents`。
- 本地试用：运行 `scripts/mirror-v-local-tunnel.sh`，打开 `http://127.0.0.1:18080/onboard`。它连接同一台线上主机。

部署架构、发布和回滚步骤见 [Mirror V 部署说明](deploy/mirror-v/README.md)。仓库改名的兼容边界见 [品牌与内部标识](docs/portal-branding.md)。
扫码入口的状态和渠道边界见 [扫码入口说明](docs/universal-scan.md)。
本轮外观与响应式基线见 [UI 更新与发布记录](docs/portal-ui-release-20261015.md)，Makaron 源码、payload 与 Portal 的归属见 [跨库收尾交接](docs/makaron-portal-handoff-20261015.md)。开发代理入口为 [AGENTS.md](AGENTS.md)。

## 主要目录

- `packages/central-gateway`：扫码入口、模板选择、渠道接入。
- `packages/runtime-manager`：Elastic 实例生命周期、Agent 调用与聊天。
- `packages/admin-web`：管理后台。
- `packages/credits-ledger`：客户账户与 Credits 账本。
- `packages/agent-templates`：可上架的 Agent 模板与 payload。
- `deploy/mirror-v`、`deploy/vercel-edge`：线上部署配置。

历史 GitLab 架构与设计材料保留在 `docs/` 和其他 `packages/` 中，不能把其中的 Kubernetes 部署说明当作当前腾讯云主机的发布步骤。
