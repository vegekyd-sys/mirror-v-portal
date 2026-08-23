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

---

# 方案 C 撤销 + registry-sync（commit 6f36ae5 / Build 待触发）

## 两项改动

### 1. 镜像版本改从 Docker Registry 自动同步（替代 Jenkins hook）

| 变更 | 内容 |
|---|---|
| `services/registry-sync.ts`（新增） | 复用 `registry-secret-vpc` 拉镜像凭据（Basic auth）调 Docker Registry HTTP API v2 `GET /v2/<repo>/<service>/tags/list`；解析 CI tag `<branch>.<git-sha>.<build>` 元数据；`INSERT ... ON CONFLICT (service, tag) DO NOTHING` 幂等入库，`created_by='registry-sync'` |
| `index.ts` | 启动时同步 + 每 30 分钟定时同步（unref） |
| `admin-ops.ts` | 删除 `POST /v1/admin/image-releases`（Jenkins hook）；新增 `POST /v1/admin/image-releases/sync` 手动触发；列表排序 `build_number::bigint DESC` |
| `admin-web` ImageReleasesPage | 删除手动登记表单；「从镜像仓库同步」+「刷新列表」按钮；挂载时静默同步 |
| aochi `f25aacb`（本地） | Jenkins pipeline 删除 `registerImageRelease()` 函数与调用点 |

单服务拉取失败不阻塞其它服务（per-service error 记录）；无凭据时匿名尝试并 warn。

### 2. 撤销 dealclaw-test 收编，全部 per-tenant

| 变更 | 内容 |
|---|---|
| `central-test-tenant.ts` | **删除**（连同测试） |
| `default-tenant.ts` 重写 | default 租户改 per-tenant：命名空间 `dealclaw-default`、agent `dealclaw-agent-default:18789`；`resolveTenantConfig` 读 runtime_configs（空/异常 → `waiting_config`，fail-closed）；`deploymentExists` 自愈；遗留外部 Agent 行自动迁移 |
| central-gateway | 删除死配置 `DEALCLAW_AGENT_URL`（orchestrator 声明未使用） |
| aochi `f25aacb`（本地） | 删除 `base/dealclaw-agent/`（Deployment/Service/PVC）与两 overlay 引用；central-gateway env 清理；tenant-config 删除 `DEEPSEEK_API_KEY`（唯一消费者是中央 agent） |

副产收益：rollout 批量滚动原先靠 `k8s_namespace IS NOT NULL` 过滤把 default 排除在外（盲区），default 拿到命名空间后自动纳入滚动覆盖。

## ⚠️ 部署顺序（关键，aochi 本地 commit f25aacb 暂不 push）

ArgoCD production Application 配置了 `automated + prune + selfHeal`，而 Jenkins `deployK8s` 会把 tag 更新自动 push 到 aochi main——一旦清理改动到达 main，中央 dealclaw-agent 会被立即 prune。因此必须：

1. 触发 Jenkins 构建 provisioning-service（预计 Build #43）→ ArgoCD 自动同步新镜像
2. 新 provisioning 启动 → `ensureDefaultTenant` 建 `dealclaw-default` ns + agent → Running
3. 管理后台「运行时配置」确认 default 租户配置（DeepSeek key），否则停在 waiting_config
4. 验证 `POST /v1/admin/tenants/default/chat` 200（走新 per-tenant agent）
5. **之后**才 push aochi `f25aacb`（先 `git pull --rebase` 拿回 Jenkins 的 kustomization 更新）→ ArgoCD prune 中央 agent
6. 构建部署 admin-web / central-gateway（镜像含本批前端与死配置清理）
7. 销毁 dealclaw-test：先 `kubectl delete` 中央 ns 的 `nexus-gateway-dealclaw-test` + `dealclaw-bot-dealclaw-test` Secret（deprovisionTenant 只删 `dealclaw-dealclaw-test` ns 资源），再 `DELETE /v1/tenants/dealclaw-test`
8. 验证：租户表无 dealclaw-test（destroyed）；中央 ns 无 nexus-gateway*/dealclaw-agent；image_releases 出现 `created_by='registry-sync'` 记录；手动 sync 端点可用

## 测试

provisioning-service 56 passed / 14 skipped；central-gateway 47 passed（registry-sync 新增 4 个用例：元数据写入、单服务 401 隔离、dry-run 跳过、匿名同步）。

---

# 上线执行记录（2026-08-23，Build #45/#46）

## 修复：registry-sync 401（commit `a116b1a` / Build #46）

ACR 拒绝直接 Basic auth 调 v2 API，401 响应带 `WWW-Authenticate: Bearer realm=...` 挑战。实现标准 Docker token flow：Basic 请求 tags/list → 401 挑战 → 携凭据到 realm 换 scoped token（service+scope 参数）→ Bearer 重试。已在集群内实测验证（dockerauth-vpc.cn-hangzhou.aliyuncs.com）。测试增至 60 passed。

## 上线顺序实录

1. Build #43（provisioning-service）由用户触发部署，`[default-tenant] migrated from external-agent mode to per-tenant mode`
2. 用户 push aochi `1eb413d` → ArgoCD prune 中央 dealclaw-agent
3. **注意**：`dealclaw-agent-default` 首启会 CrashLoopBackOff 若干次（全新 PVC 上安装 deepseek 插件期间 healthz 503，探针周期 15s×3 次杀死容器），重启 7 次后进入稳态——与飞书租户 agent 当初的行为一致，属已知启动竞态，无需干预
4. Build #45（admin-web + central-gateway）✅；Build #46（provisioning-service，含 401 修复）✅
5. 销毁 dealclaw-test：kubectl 删中央 ns 的 gateway Deployment/Service + 3 个 Secret → `DELETE /v1/tenants/dealclaw-test` → destroyed

## Jenkins API 触发要点

- 地址 `https://ops-dealclaw.datathink.com:8443/jenkins/`，job `dealclaw-nexus`
- `DEPLOY_SERVICE_LIST` 是 ExtendedChoiceParameter（PT_CHECKBOX）：**多值必须用重复表单字段**传递（`DEPLOY_SERVICE_LIST=admin-web&DEPLOY_SERVICE_LIST=central-gateway`），逗号拼接字符串会被静默丢弃回退到 SERVICE_NAME（Build #44 因此失败）
- 首次失败教训：Build #44 用了默认服务列表 `dealclaw-nexus`，Dockerfile 路径不存在报错退出

## 最终验证（全部通过）

| 项目 | 结果 |
|---|---|
| 默认租户聊天（per-tenant agent） | 200，"Pong ⚡" |
| 租户表 | default=active、飞书租户=active、dealclaw-test=destroyed |
| 中央 ns | 无 nexus-gateway* / dealclaw-agent / dealclaw-test 残留 |
| registry-sync boot | `ok — dealclaw-agent: +2/2; nexus-gateway: +6/6` |
| image_releases | 8 条 `created_by='registry-sync'`，含 git_commit/build_number/branch 元数据 |
| 手动同步 `POST /v1/admin/image-releases/sync` | 200，幂等（inserted=0） |
| 线上版本 | admin-web/central-gateway=`a116b1a0.45`、provisioning=`a116b1a0.46` |

---

# 2026-08-23（二）：移除内置默认租户

需求：不再需要默认租户——系统初始化不创建任何租户，租户列表保持为空，全部租户经管理后台显式创建。

## 代码改动（commit `a299bcd`，9 文件 +23/-290）

- 删除 `services/default-tenant.ts`（boot + 每 10 分钟周期 ensure 引导逻辑）
- 删除 `POST /v1/admin/default-tenant/ensure` 管理路由；index.ts 移除调用
- tenants API：SELECT/响应中去掉 `is_default`，删除 `DEFAULT_TENANT_IMMUTABLE` 删除守卫（DB 列保留仅作历史）
- admin-web：ChatPage 移除默认租户置顶排序/状态横幅/「（默认租户）」标签，空态引导改为「前往客户管理」；types.ts 删 `isDefault`
- 注释清理：migrate.ts / provisioning.ts / feishu-binding.ts 中提及默认租户的过时注释

配套（aochi `b02e81b`）：production/test 两个 ingress 删除 `/v1/admin/default-tenant` 路径。

## 上线与销毁（Build #47）

1. Jenkins Build #47（provisioning-service + admin-web）SUCCESS，ArgoCD 同步 `a299bcd1.47`
2. `DELETE /v1/tenants/default` → 守卫已移除，deprovision 成功，`dealclaw-default` 命名空间完全回收
3. 租户表：default=destroyed、dealclaw-test=destroyed、飞书租户=active（唯一活跃）

## 验证

| 项目 | 结果 |
|---|---|
| `dealclaw-default` 命名空间 | NotFound（完全删除） |
| `POST /v1/admin/default-tenant/ensure` | 404（路由已删） |
| provisioning boot 日志 | 无 default-tenant 引导；registry-sync 正常 `+0/2; +0/6`（幂等） |
| 飞书租户聊天回归 | 200 "pong"（首次闲置后偶发空回复，重试正常，代理代码未改动） |
