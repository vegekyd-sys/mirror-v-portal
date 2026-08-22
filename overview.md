# 默认租户收编中央 dealclaw-test Agent

## 追加修复：对话页 404（Ingress 路由缺失）

收编上线后，「对话」页发消息报 `Route not found`（`/v1/admin/tenants/default/chat` 404）。根因不在服务端——provisioning 的路由正常，是 **aochi Ingress（dealclaw.datathink.com）按路径白名单分流**，缺了 provisioning 的 4 条新路由，请求落到 `/v1` 兜底的 nexus-gateway。

修复（aochi commit `44b7ad5`，production + test 两个 overlay）：

| 新增路由 | 用途 |
|---|---|
| `/v1/admin/tenants` | 对话页聊天代理（含默认租户） |
| `/v1/admin/image-releases` | 镜像版本列表 / Jenkins 入库 |
| `/v1/admin/rollout-targets` | 批量更新目标 |
| `/v1/admin/default-tenant` | 默认租户 ensure |

均指向 `provisioning-service:8082`。ArgoCD 已同步，公网验证：无 token 返回 401（路由已达 provisioning）、带令牌 POST chat 返回 200 并收到中央 agent 应答。SPA 管理员 JWT 与该路由鉴权兼容（同一中间件）。**注意：镜像版本页的接口同批修复——它之前在线上也是 404。**

## 结论

按你的要求，默认租户（default）的 Agent 现在**就是 `dealclaw-nexus-production` 命名空间里那个中央 `dealclaw-agent`**（`DEALCLAW_TENANT_ID=dealclaw-test`，ArgoCD 管理）——不再单独给默认租户部署 Agent Pod。飞书应用 `cli_aae6930c69f8dbc1` 完全不影响本次改造（它只是该 Secret 里的一组键，聊天链路用不到）。

## 实现方式（commit `8fdf60b`，Build #39 已部署生产）

| 改动 | 说明 |
|---|---|
| `tenants` 表新增 `agent_endpoint` 列 | 非空 = 外部 Agent 模式：租户无自有 Pod，聊天直连该 URL |
| `default-tenant.ts` 重写 | 不再 provisionTenant；默认租户行指向 `http://dealclaw-agent.dealclaw-nexus-production:18789`，`k8s_namespace` 置 NULL；旧数据启动时自动迁移 |
| 聊天代理（admin-ops） | `agent_endpoint` 优先，普通租户仍走 per-tenant 服务 |
| 安全守卫 | 默认租户禁止删除；外部 Agent 租户禁止镜像 patch / 扩缩容（镜像归 ArgoCD/GitOps 管）；rollout 批量更新自动跳过（SQL 已过滤 NULL 命名空间） |

## 集群变更

- 删除了 `dealclaw-default` 命名空间（含 `dealclaw-agent-default`、其 PVC 和 Secrets）
- 中央 agent 保持 ArgoCD 管理，凭据沿用其 `tenant-config` Secret（已含 `DEEPSEEK_API_KEY`，模型 `deepseek/deepseek-chat`）

## 验证结果

1. **数据库**：default 租户 `agent_endpoint=http://dealclaw-agent.dealclaw-nexus-production:18789`，`k8s_namespace=NULL`，状态 active ✅
2. **端到端聊天**：从集群内调 `POST /v1/admin/tenants/default/chat`，HTTP 200，中央 agent 正常应答（"你好！我是 DealClaw，外贸顾问，功能正常…"）✅
3. **ops-agent rollout**：20:15 周期 total=1（只剩飞书租户）、0 失败，默认租户被干净排除 ✅
4. **迁移日志**：`[default-tenant] migrated to external agent mode (central dealclaw-test)` ✅

## 后续说明

- 中央 agent 的镜像更新走原有 GitOps 链路：Jenkins 构建 → 提交 tag 到 aochi → ArgoCD 同步（本次发现 ArgoCD 轮询有延迟，用 hard refresh 注解可立即触发）
- 管理后台「对话」页选「默认租户」即可与中央 dealclaw-test agent 聊天
- 其它租户的镜像手动更新机制（镜像版本页 promote）不受影响，且不会误碰默认租户

---

# 飞书绑定功能：管理控制台给租户智能体绑定飞书 App（commit 8a917b3 / Build #41）

## 功能

管理后台「客户详情」页新增「飞书绑定」面板，可为任意租户的智能体绑定飞书 APP ID / App Secret，使其能通过飞书聊天；支持换绑与解绑。

## 实现

| 组件 | 变更 |
|---|---|
| `services/feishu-binding.ts`（新增） | 凭据先调飞书 open API 换 tenant_access_token 校验；绑定=upsert `dealclaw-bot-<tenantId>` Secret + 部署/重启 nexus-gateway；解绑只删 gateway 保留 agent |
| `k8s-client.ts` | 新增 `putSecret`（upsert）、`restartDeployment`（rollout restart） |
| `routes/tenants.ts` | `GET/PUT/DELETE /v1/tenants/:id/feishu-binding`；飞书 App 与租户一对一守卫 |
| `admin-web` CustomerDetailPage | 飞书绑定面板（状态展示 + 绑定/换绑/解绑） |

关键设计：nexus-gateway 用飞书 WS 长连接（出站），绑定无需改 Ingress；外部 Agent 租户（默认租户）的 gateway 部署到中央命名空间并指向中央 agent。

## 验证（线上）

- GET 绑定状态：default 未绑定、飞书租户 bound `cli_aae4b7670ff8dbb4`（均 200）
- PUT 假凭据：`INVALID_CREDENTIALS` 400（真实调飞书 API 校验），状态未被污染
- admin-web 线上 bundle 已含「飞书绑定」面板
- 回归：默认租户聊天 200（"pong"）

注意：Build #40 曾构建旧代码（提交未 push），push 后 Build #41 才带上本功能；教训：触发 Jenkins 前确认 `git status -sb` 无 ahead。

---

# 方案 C：dealclaw-test 收编进租户体系（commit a7bcda5 / Build #42）

## 目的

旧中央 nexus-gateway（ArgoCD 管理，凭据写死在 tenant-config）游离于租户体系之外：管理后台看不到、飞书 App 唯一性守卫查不到，且存在双网关抢 WS 长连接的隐患。收编后统一由管理后台「飞书绑定」面板管理。

## 实现

| 变更 | 内容 |
|---|---|
| `services/central-test-tenant.ts`（新增） | 启动时（+每 10min）ensureCentralTestTenant：读 tenant-config 旧凭据 → 建 dealclaw-test 租户行（外部 agent 模式）→ 复用 bindTenantFeishuApp 验证并部署 `nexus-gateway-dealclaw-test` |
| `index.ts` | 启动挂钩（fire-and-forget，与 default-tenant 同模式） |
| `k8s-client.ts` | 新增 `deploymentExists()` |
| aochi `1e42ad9` | 移除 base/nexus-gateway（ArgoCD prune 旧网关）；/v1 兜底改指 central-gateway |
| aochi `ae08d34` | tenant-config 清理旧网关专属键；删除 base/nexus-gateway 目录 |

收编语义：幂等（至多执行一次）；尊重管理后台显式解绑（不再自动重绑）；网关意外丢失时用租户行上的凭据自愈重建。

## 验证（线上）

- Boot 日志：`adopted — gateway nexus-gateway-dealclaw-test in dealclaw-nexus-production`
- 新网关 WS 长连接 connected，凭据迁至 `dealclaw-bot-dealclaw-test` Secret
- 公网 `GET /v1/tenants/dealclaw-test/feishu-binding` → bound `cli_aae6930c69f8dbc1`
- 租户表 3 个租户全部 active：dealclaw-test / default / 王建测试-真实飞书
- 回归：默认租户聊天 200；/v1 未匹配路径 404（central-gateway 兜底）
- tenant-config 只剩 DEEPSEEK_API_KEY + 两个控制面令牌

## 注意事项

- 部署顺序：先 aochi 下线旧网关，再部署新 provisioning，避免双网关抢 WS
- ArgoCD 对 Secret 删除 data 键有盲区：需手动 `kubectl patch --type=json` remove（selfHeal 不会回滚该操作）
