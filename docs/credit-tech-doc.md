# 小元统一 Credit 商业化技术文档

> 版本：V1.0 | 日期：2026-08-11 | 适用范围：DealClaw 内测

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        用户入口                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │ 飞书群聊  │  │ 飞书私聊  │  │ 管理后台  │  │ V 飞书指令   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘ │
└───────┼────────────┼─────────────┼───────────────┼─────────┘
        │            │             │               │
        ▼            ▼             ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              DealClaw Agent (Makaron)                 │  │
│  │                                                      │  │
│  │  理解意图 → 拆解 Skill Action → 调 Billing Adapter    │  │
│  │  → 执行 Skill → 汇总结果 → 展示消耗                   │  │
│  └──────────────────────┬───────────────────────────────┘  │
└─────────────────────────┼──────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Credits Ledger Service                      │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Wallet   │  │ Ledger   │  │ Catalog  │  │  Billing   │  │
│  │ 余额管理  │  │ 不可变账本│  │ 定价目录  │  │  生命周期   │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Customer │  │  Plans   │  │ V Cmd    │                  │
│  │ 客户管理  │  │ 套餐模板  │  │ 指令接口  │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

两层架构。Agent 层负责理解用户意图和拆分 Skill 动作，Credits Ledger 层负责所有计费逻辑。Agent 不直接操作余额，只通过 Billing Adapter 调 Ledger API。

---

## 二、数据模型

### 2.1 表结构

**credits_accounts（账户表）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | 账户 ID，格式 acct_{tenant_id} |
| tenant_id | VARCHAR(64) UNIQUE | 租户标识 |
| plan_tier | VARCHAR(16) | 套餐等级：start/growth/ultra/enterprise |
| plan_id | VARCHAR(32) FK | 关联 plan_templates |
| balance | BIGINT | 当前可用余额 |
| monthly_allowance | BIGINT | 月额度上限（0=不限） |
| monthly_used | BIGINT | 当月已用 |
| month_reset_at | TIMESTAMPTZ | 月额度重置时间 |
| lifetime_credited | BIGINT | 累计获得 Credit |
| lifetime_consumed | BIGINT | 累计消费 Credit |
| company_name | VARCHAR(128) | 公司名 |
| contact_name | VARCHAR(64) | 联系人 |
| contact_email | VARCHAR(128) | 联系邮箱 |
| subscription_start | TIMESTAMPTZ | 订阅开始 |
| subscription_end | TIMESTAMPTZ | 订阅到期 |
| status | VARCHAR(16) | active/frozen/closed |

**credits_transactions（交易账本，不可变）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | 交易 ID |
| account_id | VARCHAR(64) FK | 关联账户 |
| type | VARCHAR(16) | credit/debit |
| amount | BIGINT | 金额 |
| balance_before | BIGINT | 交易前余额 |
| balance_after | BIGINT | 交易后余额 |
| reference | VARCHAR(128) | 业务引用（如 skill:find-buyers） |
| category | VARCHAR(32) | 分类（如 skill.buyer） |
| idempotency_key | VARCHAR(128) UNIQUE | 幂等键 |
| created_at | TIMESTAMPTZ | 时间 |

**skill_prices（定价目录）**

| 字段 | 类型 | 说明 |
|---|---|---|
| skill_id | VARCHAR(128) PK | Skill 标识，如 dealclaw-find-buyers |
| skill_name | VARCHAR(256) | 面向用户的能力名称 |
| description | TEXT | 说明 |
| category | VARCHAR(64) | 分类：buyer/outreach/exhibition/insight/admin |
| credit_per_unit | BIGINT | 每次消耗的 Credit |
| billing_unit | VARCHAR(32) | 计费单位：per_item/per_email/per_use 等 |
| status | VARCHAR(16) | live/shadow/disabled |

**skill_billing_events（计费事件）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | 事件 ID |
| tenant_id | VARCHAR(64) | 租户 |
| task_id | VARCHAR(128) | Agent 任务 ID |
| skill_id | VARCHAR(128) | 触发的 Skill |
| quantity | INTEGER | 数量 |
| credit_amount | BIGINT | Credit 金额 |
| unit_price | BIGINT | 单价 |
| status | VARCHAR(16) | estimated/settled/released/refunded |
| transaction_id | VARCHAR(64) | 关联账本交易 ID |
| result_summary | TEXT | 执行结果摘要 |

**plan_templates（套餐模板）**

| 字段 | 类型 | 说明 |
|---|---|---|
| plan_id | VARCHAR(32) PK | start/growth/ultra/enterprise |
| plan_name | VARCHAR(64) | 面向用户的套餐名 |
| annual_fee_yuan | INTEGER | 年费（¥） |
| initial_credit | BIGINT | 初始 Credit |
| renewal_discount | DECIMAL(3,2) | 续充折扣 |
| renewal_price_per_100k | INTEGER | 续充每 100K 价格 |

**price_change_log（价格变更日志）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | SERIAL PK | 自增 |
| skill_id | VARCHAR(128) | Skill ID |
| old_credit | BIGINT | 旧价格 |
| new_credit | BIGINT | 新价格 |
| changed_by | VARCHAR(64) | 操作人 |
| created_at | TIMESTAMPTZ | 时间 |

### 2.2 分类默认定价

未在 skill_prices 表中精确匹配的 skill_id，按前缀分类使用默认值：

| 分类前缀 | 默认 Credit | 适用场景 |
|---|---|---|
| buyer.* | 300 | 买家搜索、线索 |
| insight.* | 5,000 | 报告、画像 |
| outreach.* | 80 | 邮件、WhatsApp、回复 |
| exhibition.* | 300 | 展会名片、邀约 |
| admin.* | 100 | 导入、日报 |
| 未知 | 100 | 全局兜底 |

---

## 三、API 设计

### 3.1 Billing API（Agent 调用）

#### POST /v1/billing/estimate — 任务前估算

Agent 执行 Skill 前调用，返回预计消耗，不改变余额。

```json
// 请求
{
  "tenantId": "zhenfeng",
  "accountId": "acct_zhenfeng",
  "taskId": "task_abc123",
  "skillId": "dealclaw-find-buyers",
  "quantity": 10,
  "metadata": { "country": "AE", "product": "water pump" }
}

// 响应
{
  "ok": true,
  "eventId": "evt_xxx",
  "estimatedCredit": 8000,
  "skillName": "搜索买家",
  "unitPrice": 800,
  "isDefault": false
}
```

#### POST /v1/billing/settle — 执行后结算

Skill 执行完成后调用，原子扣费并写入账本。

```json
// 请求
{
  "tenantId": "zhenfeng",
  "accountId": "acct_zhenfeng",
  "taskId": "task_abc123",
  "skillId": "dealclaw-find-buyers",
  "quantity": 10,
  "estimatedEventId": "evt_xxx",
  "resultSummary": "成功返回 10 条买家线索"
}

// 响应（成功）
{
  "ok": true,
  "eventId": "evt_xxx",
  "actualCredit": 8000,
  "skillName": "搜索买家",
  "unitPrice": 800,
  "transactionId": "txn_xxx"
}

// 响应（余额不足）
{
  "ok": false,
  "code": "INSUFFICIENT_CREDITS",
  "estimatedCredit": 8000,
  "error": "余额不足：需要 8000 Credit"
}
```

#### POST /v1/billing/can-afford — 余额检查

```json
// 请求
{ "accountId": "acct_zhenfeng", "skillId": "dealclaw-find-buyers", "quantity": 10 }

// 响应
{ "canAfford": true, "estimatedCredit": 8000, "balance": 500000 }
```

### 3.2 Skill Price API

| 端点 | 方法 | 说明 |
|---|---|---|
| /v1/skill-prices | GET | 列出所有定价，支持 ?category= 过滤 |
| /v1/skill-prices/:skillId | GET | 单个定价详情+变更历史 |
| /v1/skill-prices/:skillId | PUT | 创建或更新定价 |
| /v1/skill-prices/:skillId | DELETE | 禁用定价 |
| /v1/skill-prices/:skillId/history | GET | 价格变更历史 |
| /v1/skill-prices/estimate | POST | 估算成本（不记录事件） |
| /v1/skill-prices/summary | GET | 分类汇总 |

### 3.3 Customer Admin API

| 端点 | 方法 | 说明 |
|---|---|---|
| /v1/admin/plans | GET | 套餐模板列表 |
| /v1/admin/customers | GET | 客户列表+统计 |
| /v1/admin/customers/:tenantId | GET | 客户详情 |
| /v1/admin/customers | POST | 创建客户+分配套餐 |
| /v1/admin/customers/:tenantId/topup | POST | 手动充值 |
| /v1/admin/customers/:tenantId/renew | POST | 续费（按套餐折扣自动算价） |

#### 续费接口示例

```json
// POST /v1/admin/customers/zhenfeng/renew
{ "creditAmount": 200000 }

// 响应（Growth 套餐用户）
{
  "ok": true,
  "balanceBefore": 300000,
  "balanceAfter": 500000,
  "planTier": "Growth 成长版",
  "pricePer100k": 900,
  "discount": 0.9,
  "estimatedCost": 1800,
  "creditAmount": 200000,
  "message": "续费成功！¥1,800 → 200,000 Credit（Growth 成长版 套餐 10% off）"
}
```

### 3.4 V 指令接口

POST /v1/admin/v-command，接收自然语言指令。

**支持的指令格式**：

| 指令 | 示例 | 执行的动作 |
|---|---|---|
| 开通套餐 | "给 振丰玩具 开通 start" | 创建客户账户，配 500K Credit |
| 续费充值 | "给 振丰玩具 续充 200K" | 按套餐折扣充值 |
| 查看客户 | "查看 振丰玩具" | 返回余额/消耗/到期日/套餐详情 |
| 客户列表 | "客户列表" | 返回全部客户的余额和消耗 |

---

## 四、Agent 集成（Billing Harness）

### 4.1 调用流程

Agent 执行任何收费 Skill 时，需要走以下标准流程：

```
1. Agent 理解用户意图："帮我找 10 家德国的水泵买家"
2. Agent 拆解 Skill Action：skillId=dealclaw-find-buyers, quantity=10
3. Agent 调 billing.estimate → 获取预计 8000 Credit
4. Agent 展示给用户：「本次预计消耗 8,000 Credit，确认搜索吗？」
5. 用户确认
6. Agent 执行 Skill（调 CDP/Apollo/Web 等）
7. Agent 调 billing.settle → 扣 8000 Credit，写入账本
8. Agent 展示结果+实际消耗
```

### 4.2 Agent 侧代码（伪代码）

```typescript
// DealClaw Agent 执行 Skill 时插入的 Billing Hook

const LEDGER = process.env.CREDITS_LEDGER_URL || 'http://credits-ledger:8081';

async function executeSkillWithBilling(ctx: AgentContext, skillId: string, quantity: number) {
  const accountId = `acct_${ctx.tenantId}`;

  // Step 1: 估算
  const est = await fetch(`${LEDGER}/v1/billing/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: ctx.tenantId,
      accountId,
      taskId: ctx.taskId,
      skillId,
      quantity,
    }),
  }).then(r => r.json());

  if (!est.ok) throw new Error('Billing estimate failed');

  // Step 2: 告知用户
  if (est.estimatedCredit > HIGH_COST_THRESHOLD) {
    await ctx.reply(`本次预计消耗 ${est.estimatedCredit.toLocaleString()} Credit，确认执行吗？`);
    const confirmed = await ctx.waitForConfirmation();
    if (!confirmed) return;
  }

  // Step 3: 执行 Skill
  const result = await executeActualSkill(skillId, quantity, ctx.params);

  // Step 4: 结算
  const settle = await fetch(`${LEDGER}/v1/billing/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: ctx.tenantId,
      accountId,
      taskId: ctx.taskId,
      skillId,
      quantity,
      estimatedEventId: est.eventId,
      resultSummary: result.summary,
    }),
  }).then(r => r.json());

  if (settle.code === 'INSUFFICIENT_CREDITS') {
    await ctx.reply(`余额不足，当前可用 ${settle.balance} Credit，本次需要 ${settle.required} Credit。请联系管理员续费。`);
    return;
  }

  // Step 5: 展示结果
  await ctx.reply(`✅ 完成。消耗 ${settle.actualCredit.toLocaleString()} Credit。\n${result.text}`);
}
```

### 4.3 免费 Skill 处理

定价为 0 的 Skill（review、knowledge-base、email-bindings）直接跳过 billing 调用，无需 estimate 和 settle。

### 4.4 对话不扣费

普通对话不触发 Billing Harness。判断依据：只有 Agent 内部路由到 DealClaw Skill（dc-agent.md 中列出的收费 Skill）时才进入计费流程。聊天、问问题、展示结果、引导话术都不走计费。

---

## 五、用户全链路

### 5.1 客户开通

```
FDE/V 指令 → 创建 credits_accounts 记录 → 按套餐配初始 Credit
```

一个命令完成：`给 XX 开通 start`。

### 5.2 客户日常使用

```
客户在飞书群提问
  → Agent 理解意图
  → 普通对话：直接回复，不扣费
  → 触发收费 Skill：
      → estimate 返回预计 Credit
      → 展示给客户
      → 客户确认（高消耗任务需二次确认）
      → 执行 Skill
      → settle 扣费 + 写账本
      → 展示结果 + 实际消耗
```

### 5.3 余额不足

Billing Hook 在 settle 阶段检测余额不足 → 返回 402 + 余额信息 → Agent 提示客户「余额不足，当前 XX Credit，本次需要 XX Credit」→ 引导联系管理员续费。

### 5.4 续费

客户余额不足 → FDE 在管理后台点「续费」按钮，选额度 → 按套餐折扣自动计费 → 充值完成，客户可继续使用。

或飞书里对 V 说：`给 XX 续充 200K`。

### 5.5 升级

客户频繁超额 → FDE 在后台重新分配套餐 → 系统计算升级差价 → 余额和 Credit 额度更新。

---

## 六、管理运营

### 6.1 定价变更

修改 skill_prices 表（通过 API 或管理后台），即时生效。每次变更自动写入 price_change_log。

### 6.2 新增 Skill

开发新增 dealclaw-* Skill → sync-skills.py 每小时自动扫描 → 按分类算出建议价 → 入库 shadow → FDE 审核后切 live。

### 6.3 查看消耗

管理后台「客户」标签页，按客户查看余额、消耗量、预警（<20% 黄 / <10% 红）。

### 6.4 月额度

credits_accounts.monthly_allowance 可配置月度上限。monthly-reset 定时任务自动重置。当前测试期月额度默认 0（不限制）。

---

## 七、迁移清单

从当前开发环境迁移到 K8s 测试环境：

| 迁移项 | 内容 | 说明 |
|---|---|---|
| 数据库表 | skill_prices, plan_templates, price_change_log, skill_billing_events | 迁移脚本在 credits-ledger/src/db/migrate.ts |
| 扩展字段 | credits_accounts 新增 plan_id, company_name, contact_*, subscription_* | ALTER TABLE 已纳入迁移 |
| 种子数据 | 12 个 Skill 定价 + 4 个套餐模板 | migrate.ts 自动执行 |
| 后端 API | skill-prices, billing, customer-admin, V-command | credits-ledger/src/routes/ |
| Agent 改造 | executeSkill 前后加 estimate/settle 调用 | 两行 HTTP 请求 |
| Agent 上下文 | 传 tenant_id | X-DealClaw-Tenant-ID header |
| 管理后台 | standalone.html | 丢到 admin-dashboard public 目录 |
| 定时同步 | sync-skills.py | 加到服务器 crontab，每小时执行 |

不需要迁移：飞书文档、飞书多维表格（云端）。

---

## 八、安全与幂等

- 所有扣费在 PostgreSQL 事务中执行（SELECT FOR UPDATE）
- idempotency_key 保证同一请求不重复扣费
- credits_transactions 表只允许 INSERT，不 UPDATE/DELETE
- 多租户隔离以 tenant_id 为一级字段

---

## 九、规模演进

当前 MVP 为单服务模块化设计。后续调用量增大时可拆分：

- Wallet Service（余额、Lot 管理）
- Catalog Service（定价目录）
- Billing Service（生命周期、结算）
- 拆分后通过统一 Billing Contract 通信
