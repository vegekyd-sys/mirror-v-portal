# Nexus 计费接入指南（按租户 Credit 计费）

> 给 Nexus 开发同事的接入说明。目标：让**每个租户（客户）**接入 credits-ledger 的 Credit 计费，estimate→settle 全自动。
>
> 详细 API 参考见 `docs/credit-tech-doc.md`（数据模型/完整端点），本文聚焦 **Nexus 该怎么接**。

---

## 0. 一句话结论

计费是 **estimate → 执行 → settle** 三段式，全在 credits-ledger（`http://<ledger-host>:8081`）上完成。Nexus 的职责只有两件事：

1. **用自己配置里的 `tenantId` 作为计费身份**（每个租户一个 gateway 实例，`config.tenantId` 是注入好的）；
2. **在调 agent 前后，各打一次 estimate 和 settle**。

其余（扣费、幂等、订阅/月额度校验、shadow 计费）ledger 全包了。Nexus 不需要自己算钱、也不需要自己扣余额。

---

## 1. 架构定位

```
飞书事件
   │
   ▼
nexus-gateway  ──(config.tenantId)──►  credits-ledger :8081
   │                                        ▲  estimate / settle
   │  POST /execute                          │
   ▼                                        │
dealclaw-agent  ──►  OpenClaw runtime
```

- **credits-ledger**：唯一记账方（PostgreSQL）。所有扣费/余额/事件都走它。
- **nexus-gateway**：每个租户一个实例，负责 Feishu 接入 + 计费编排。**计费身份来自它自己的 `config.tenantId`**。
- **dealclaw-agent**：纯执行，不碰钱。

---

## 2. 核心模型：tenant 与 account

| 概念 | 说明 |
|---|---|
| `tenantId` | 计费租户，例如 `xiaoyuan-wenhua`、`dealclaw-sanlian`。**由 gateway 配置注入** |
| `accountId` | 该租户的 credit 账户，**约定恒为 `acct_<tenantId>`** |

所有 billing 请求都要同时带 `tenantId` 和 `accountId`（ledger 用它定位账户）。

### 计费身份 = tenantId，不是 open_id

- **跨租户 = 每个租户自己的飞书 app + 自己的 gateway**，物理隔离。每个 gateway 只服务自己的租户，`config.tenantId` 天然正确，**不会发生「同一个 open_id 撞到两个租户」**。
- **open_id 是 app 内 ID**，只在单个租户 app 内有意义；跨租户用不上它、也不需要它。
- **open_id / group_id 只作为审计元数据**（「这笔账是谁触发的」），写进 estimate/settle 的 `metadata` 字段，**绝不用于解析或切换 tenant**。

> ⚠️ 早期方案里「open_id → tenant 全局映射（`billing-config.json` 的 `users`）」已废弃。原因：open_id 是 app 内 ID，全局映射在多租户下会错误路由。**不要再填 open_id 映射。**

---

## 3. 计费流程（Nexus 必须遵守）

对每一次**需要计费**的 skill 执行：

```
1. canAfford(accountId, skillId, qty)      // 可选：先查能不能付，余额不足直接 402 拦掉
2. estimate(tenantId, accountId, skillId, qty)   // 创建事件，status='estimated'，返回 eventId
3. 执行 skill（调 dealclaw-agent）
4. 成功 → settle(tenantId, accountId, skillId, eventId, qty)   // 原子扣费，status='settled'
   失败 → 不 settle（事件停留在 estimated，不扣费）
```

**幂等**：settle 内部用 `accountId + eventId` 做幂等键，重复调用不会重复扣费。

---

## 4. 直接用封装好的 BillingClient（推荐）

已经把上面三段式封装成 `src/services/billing-client.ts`（`BillingClient` 类）。Nexus 直接 import，不用手写 fetch。

```ts
import { BillingClient } from './services/billing-client.js';

const client = new BillingClient({
  ledgerUrl: process.env.CREDITS_LEDGER_URL,     // 默认 http://localhost:8081
  token:     process.env.CREDITS_LEDGER_TOKEN,   // 服务令牌
});

// —— 完整一次计费执行 ——
const { settled } = await client.billAround(
  {
    tenantId: config.tenantId,  // 必填：gateway 自己的租户（跨租户正确）
    openId:   senderOpenId,     // 可选：审计元数据，只记「谁触发的」，不参与计费路由
    groupId:  chatId,           // 可选：审计元数据
    skillId:  'dealclaw-find-buyers',
    quantity: 1,
  },
  async () => {
    // 真正调 dealclaw-agent /execute 的代码
    return await forwardToAgent(req.body);
  },
);

// settled.actualCredit > 0 表示已实扣（live）；=0 表示 shadow 只记账不扣
```

### 关键行为

- `billAround` 内部自动：estimate → 执行你的 `run()` → settle。
- **`tenantId` 必填**；缺了会抛 `BillingError('tenantId is required', 'TENANT_REQUIRED')`。
- `openId` / `groupId` 会被合并进 estimate/settle 的 `metadata`（审计用），不影响扣费目标。

### 单独调用（Nexus 自管编排时）

```ts
await client.canAfford(tenantId, skillId, qty);            // { canAfford, estimatedCredit, balance, reason? }
const est = await client.estimate(tenantId, skillId, qty); // { eventId, estimatedCredit, billingMode }
const set = await client.settle(tenantId, skillId, est.eventId!, qty); // { actualCredit, ... }
await client.balance(tenantId);                            // { balance, available, lifetimeConsumed }
```

---

## 5. 计费模式（billingMode）

由 `skill_prices` 表决定，ledger 返回，Nexus 不用判断、照常调用即可：

| 模式 | 触发条件 | settle 效果 |
|---|---|---|
| `live` | `status != 'shadow'` 且 `activation_status = 'approved'` | 真实扣费 |
| `shadow` | `status = 'shadow'` | 只记录事件，`actualCredit = 0` |
| `unapproved` | `activation_status != 'approved'` | 同 shadow |

> ⚠️ 当前所有 skill 在 DB 里都是 `shadow` 状态（内测期，先只记账不扣费）。**要真正开始扣费，把对应 skill 的 `status` 改成 `live`**（`PUT /v1/skill-prices/:skillId`）。这不是 Nexus 改的，是定价方/管理员改的。

---

## 6. 错误码（settle / can-afford 返回）

| code | 含义 | Nexus 该做什么 |
|---|---|---|
| `INSUFFICIENT_CREDITS` | 余额不足 | 返回 402 + 提示充值 |
| `SUBSCRIPTION_EXPIRED` | 订阅到期 | 返回 402 + 提示续费 |
| `MONTHLY_LIMIT_EXCEEDED` | 月额度用完 | 返回 402 + 提示联系客服 |
| `ACCOUNT_SUSPENDED` / `ACCOUNT_CLOSED` | 账户停用/关闭 | 返回 402 |
| `UNKNOWN_SKILL` | skill 未登记 | 记日志，不扣费 |
| `ACCOUNT_NOT_FOUND` | accountId 不存在 | 排查 tenant 是否已开通 |

ledger 的 HTTP 状态码：余额类问题返回 **402**，参数/内部错误返回 400/500。

---

## 7. nexus-gateway 现状（已实现，按租户计费）

`src/app.ts` 计费链路已接好，**计费身份 = gateway 自己的 `config.tenantId`**：

- `resolveBillingContext()` 中间件：从入站事件里取 `open_id` / `chat_id`，**只作为审计元数据**挂到 `req.billingMeta`，不解析 tenant。
- `billingAccountFor(req, config)`：返回 `{ tenantId: config.tenantId, accountId: config.keyConfig.creditsAccountId }`。
- `creditsCheckMiddleware` + `billingEstimateMiddleware` + execute 后 settle：estimate/settle 的 `metadata` 里带 `openId` / `groupId`（审计）。
- webhook 路径 `/v1/agent/:tenantId/webhook` 里的**余额查询拦截**用的是 `config.keyConfig.creditsAccountId`（= 本租户账户），一致。

> 提示：`/v1/agent/:tenantId/webhook` 这条路径目前**只做余额查询拦截 + 转发**，普通消息不经过 estimate→settle。如果 webhook 也要对 skill 执行计费，需要补三段式——但计费身份仍用 `config.tenantId`。

---

## 8. 服务令牌鉴权

所有 `/v1/accounts`、`/v1/billing`、`/v1/skill-prices`、`/v1/admin/*` 都挂在 `requireServiceOrAdmin` 后面，需要：

```
Authorization: Bearer <service-token>
```

令牌来源（三选一，按优先级）：
1. 环境变量 `DC_BILLING_TOKEN`；
2. 本机 `scripts/.billing-token` 文件（gitignored）；
3. admin 登录换的 JWT（`POST /v1/admin/auth/login`）。

**不要把 token 写进代码或提交仓库。**

---

## 9. 失败策略：fail-open vs fail-close

Nexus 现有代码默认 **fail-close**（ledger 挂了就 503 拦请求，除非 `DEALCLAW_CREDITS_FAIL_OPEN=true`）。

- **生产**：保持 fail-close（宁可不服务，不错记账）。
- **本地联调**：设 `DEALCLAW_CREDITS_FAIL_OPEN=true` 放行。

---

## 10. 本地联调 & 验证清单

> `billing.mjs` / `billing-config.json` / `.billing-token` 目前在 **Makaron 工作区**（`workspace/scripts/`，由 V 维护），不在 dealclaw 仓库里。Nexus 联调时可以直接 curl credits-ledger，或用下面的 `BillingClient` 冒烟脚本。

```bash
# 1. ledger 健康
curl http://localhost:8081/healthz

# 2. 手动走三段式（curl）
TOKEN=$(cat <path-to>/.billing-token)
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  http://localhost:8081/v1/billing/estimate \
  -d '{"tenantId":"xiaoyuan-wenhua","accountId":"acct_xiaoyuan-wenhua","skillId":"dealclaw-find-buyers","quantity":1}'   # 记 eventId
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  http://localhost:8081/v1/billing/settle \
  -d '{"tenantId":"xiaoyuan-wenhua","accountId":"acct_xiaoyuan-wenhua","skillId":"dealclaw-find-buyers","quantity":1,"estimatedEventId":"<eventId>"}'

# 3. 查账
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8081/v1/billing/events?tenantId=xiaoyuan-wenhua"
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8081/v1/accounts/acct_xiaoyuan-wenhua/full"
```

验证要点：
- [ ] 计费用的是 `config.tenantId`（不是 open_id 解析）；
- [ ] estimate 返回 eventId + billingMode；
- [ ] live 模式下 settle 后余额确实减少、事件 status='settled'、有 transactionId；
- [ ] shadow 模式下 settle 后余额不变、actualCredit=0；
- [ ] 余额不足返回 402 `INSUFFICIENT_CREDITS`；
- [ ] estimate/settle 的 `metadata` 里有 `openId` / `groupId`（审计可追溯）。

---

## 11. 待办（需要谁做）

| 事项 | 负责人 |
|---|---|
| 决定何时把 skill 从 `shadow` 切到 `live`（正式收费） | 定价方 |
| 补齐 webhook 路径的 skill 执行计费（若它是实际入口，计费身份仍用 `config.tenantId`） | Nexus 开发 |
| 真实支付（支付宝/微信）接入 | 支付/财务，尚未启动 |
