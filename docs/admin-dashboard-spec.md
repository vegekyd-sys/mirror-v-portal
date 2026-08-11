# 小元 管理后台 — 完整需求文档

> 给 Codex 开发用的完整规格。目标：替换当前简陋的单文件 HTML，做一个真正的 SaaS 管理后台。

---

## 一、项目背景

### 1.1 小元 是什么

小元 是一个 AI 外贸获客 Agent，帮助中国工厂/外贸企业：
- 搜索海外买家
- 分析目标市场和企业画像
- 生成多语言开发信
- 处理展会线索和买家邀约
- 导入历史客户

### 1.2 管理后台的用户

- **Tianyi**（创始人）— 查看所有客户消耗、调价、开通新客户
- **运营/销售** — 创建客户、查看用量、续费
- 不是给终端客户用的（客户有自己的 小元 Agent 对话界面）

### 1.3 计费模型

**Subscription + Credits** 双层计费：

- 三档套餐：¥19,800 / ¥39,800 / ¥88,800（授予不同初始 Credits）
- 每个 Skill 有固定 Credit 单价（从 `skill_prices` 表读取）
- Credits 消耗完需要续购
- 目标毛利率 ~65%
- 慧展套餐有冻结 Credits 保障交付权益

**计费模式**：

- **Live（正式计费）**：`skill_prices.status = 'live'`，调用时从账户实际扣费
- **Shadow（影子计费）**：`skill_prices.status = 'shadow'`，调用时记录日志但**不扣费**，用于新 Skill 上线前跟踪成本、客户试用等场景
- **Disabled（已禁用）**：不可调用

`skill_billing_events` 表的 `billing_mode` 字段记录每次调用的计费模式（live/shadow），由 Billing Hook 在 estimate 阶段从 `skill_prices.status` 同步写入。

### 1.4 技术架构

```
管理后台 (React/Vue/纯HTML)  →  admin-dashboard (Express :8088)
                                    ↓ proxy
                              credits-ledger (Express :8081)
                                    ↓
                              PostgreSQL (小元_test)
```

- **credits-ledger**：核心计费引擎，所有金额操作必须原子（SELECT FOR UPDATE）
- **admin-dashboard**：代理层 + 静态文件服务，Auth 通过 ADMIN_API_TOKEN
- **数据库**：PostgreSQL，9 张表（见下文）
- **部署**：Nginx → 8443 端口 → proxy_pass :8088

---

## 二、数据库 Schema

### 2.1 credits_accounts（核心账户表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | 格式 `acct_{tenant_id}` |
| tenant_id | VARCHAR(64) UNIQUE | 租户 ID |
| company_name | VARCHAR(128) | 公司名 |
| contact_name | VARCHAR(64) | 联系人 |
| contact_email | VARCHAR(128) | 联系邮箱 |
| plan_tier | VARCHAR(16) | 套餐档次 start/growth/ultra |
| plan_id | VARCHAR(32) | 关联 plan_templates |
| balance | BIGINT | 总余额（未减去冻结） |
| frozen_credits | BIGINT | 冻结额度（慧展权益预留） |
| frozen_reason | TEXT | 冻结原因 |
| lifetime_credited | BIGINT | 累计获得 |
| lifetime_consumed | BIGINT | 累计消耗 |
| monthly_allowance | BIGINT | 月额度上限 |
| monthly_used | BIGINT | 本月已用 |
| month_reset_at | TIMESTAMPTZ | 月度重置时间 |
| subscription_start | TIMESTAMPTZ | 订阅开始 |
| subscription_end | TIMESTAMPTZ | 订阅到期 |
| status | VARCHAR(16) | active/suspended/closed |
| created_at / updated_at | TIMESTAMPTZ | |

**可用余额 = balance - frozen_credits**（不是 balance）

### 2.2 credits_transactions（流水表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | UUID |
| account_id | VARCHAR(64) FK | 关联 credits_accounts.id |
| type | VARCHAR(16) | debit/credit/freeze/unfreeze |
| amount | BIGINT | 金额 |
| balance_before | BIGINT | 操作前余额 |
| balance_after | BIGINT | 操作后余额 |
| reference | VARCHAR(128) | 关联标识 |
| description | TEXT | 说明 |
| category | VARCHAR(32) | 分类 |
| idempotency_key | VARCHAR(128) UNIQUE | 幂等键 |
| created_at | TIMESTAMPTZ | |

### 2.3 skill_billing_events（Skill 调用记录）

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | UUID |
| tenant_id | VARCHAR(64) | 租户 ID |
| task_id | VARCHAR(64) | 任务 ID |
| skill_id | VARCHAR(128) | Skill 标识 |
| skill_name | VARCHAR(256) | Skill 中文名 |
| quantity | INT | 调用次数 |
| credit_amount | BIGINT | Credit 金额 |
| unit_price | BIGINT | 单价 |
| status | VARCHAR(16) | estimated/settled |
| billing_mode | VARCHAR(8) | live/shadow — 计费模式 |
| transaction_id | VARCHAR(64) | 关联 transaction |
| result_summary | TEXT | 结果摘要 |
| created_at | TIMESTAMPTZ | |

### 2.4 skill_prices（Skill 定价表）

| 列 | 类型 | 说明 |
|---|---|---|
| skill_id | VARCHAR(128) PK | 如 `小元-find-buyers` |
| skill_name | VARCHAR(256) | 中文名 |
| category | VARCHAR(64) | buyer/insight/outreach/exhibition |
| credit_per_unit | BIGINT | 每次 Credit |
| billing_unit | VARCHAR(32) | per_item/per_person/per_email 等 |
| status | VARCHAR(16) | live/shadow/disabled |
| sort_order | INT | 排序 |

**当前价格（定价的唯一真相源）**：

| skill_id | skill_name | credit_per_unit |
|---|---|---|
| 小元-find-buyers | 搜索买家 | 800 |
| 小元-analyze-company | 企业画像分析 | 2,000 |
| 小元-market-insight | 市场洞察报告 | 10,000 |
| 小元-email-growth-send | 批量开发信 | 50 |
| 小元-email-founder-direct | 一对一开发信 | 100 |
| 小元-smart-reply | 处理买家回复 | 50 |
| 小元-exhibition-leads | 展后线索处理 | 800 |
| 小元-exhibition-invitation | 展会邀约 | 200 |
| 小元-lead-import | 导入线索 | 100 |
| 小元-review | 画像偏好标注 | 0 |
| 小元-knowledge-base | 知识库浏览 | 0 |
| 小元-email-bindings | 邮箱绑定 | 0 |

**前端必须从 API 读取，不得硬编码价格。**

### 2.5 plan_templates（套餐模板）

| 列 | 类型 |
|---|---|
| plan_id | VARCHAR(32) PK |
| plan_name | VARCHAR(64) |
| tier | VARCHAR(16) |
| annual_fee_yuan | INT |
| initial_credit | BIGINT |
| seats_min / seats_max | INT |
| renewal_discount | NUMERIC(3,2) |
| renewal_price_per_100k | INT |
| monthly_allowance | BIGINT |
| features | TEXT |

### 2.6 其他表

- **tenants**：租户元数据（公司名、状态、k8s_namespace 等）
- **price_change_log**：定价变更历史
- **tenant_status_log**：租户状态变更日志
- **credits_monthly_usage**：月度使用汇总

---

## 三、API 接口

> 所有接口通过 admin-dashboard (8088) 代理到 credits-ledger (8081)。  
> /api/* 前缀的接口在 admin-dashboard 层，/v1/* 在 credits-ledger 层。

### 3.1 客户管理

#### GET /api/admin/customers
列出所有客户。

Response:
```json
{
  "customers": [{
    "accountId": "acct_xiaoyuan-wenhua",
    "tenantId": "xiaoyuan-wenhua",
    "companyName": "小元内测-文华",
    "planTier": "start",
    "planId": "start",
    "balance": 472400,
    "frozenCredits": 0,
    "availableBalance": 472400,
    "frozenReason": null,
    "monthlyAllowance": 0,
    "monthlyUsed": 749050,
    "lifetimeConsumed": 27600,
    "totalConsumed": 27600,
    "totalTasks": 3,
    "status": "active",
    "subscriptionEnd": "2026-08-10T...",
    "createdAt": "..."
  }],
  "stats": {
    "active": 11,
    "totalBalance": 5196650,
    "totalConsumed": 307750,
    "total": 18,
    "closed": 7
  }
}
```

**前端注意**：
- 消耗 = `lifetimeConsumed`（数据库字段），不要用 `500000 - balance` 算
- 可用余额 = `availableBalance` = balance - frozenCredits
- 余额 = `balance`（原始值，包含冻结部分）

#### GET /api/admin/customers/:tenantId
客户详情（含完整审计轨迹）。

Response:
```json
{
  "tenantId": "xiaoyuan-hongchun",
  "companyName": "小元内测-洪春",
  "balance": 486000,
  "frozenCredits": 0,
  "availableBalance": 486000,
  "lifetimeConsumed": 17600,
  "lifetimeCredited": 503600,
  "planTier": "start",
  "planName": "Start 启航版",
  "planDetails": {
    "annualFee": 19800,
    "renewalPrice": 1000,
    "renewalDiscount": 1.0,
    "seatsRange": "1-3"
  },
  "status": "active",
  "auditLog": [{
    "id": "uuid",
    "type": "debit",           // debit/credit/freeze/unfreeze
    "amount": 800,
    "balanceBefore": 486800,
    "balanceAfter": 486000,
    "reference": "skill:小元-find-buyers|task:...",
    "description": "搜索买家 × 1",
    "category": "skill.buyer",
    "time": "2026-08-11T06:16:38.000Z",
    "source": "credits_transactions (DB)"
  }],
  "billingEvents": [{
    "id": "uuid",
    "skillId": "小元-analyze-company",
    "skillName": "企业画像分析",
    "credit": 2000,
    "quantity": 1,
    "status": "settled",       // estimated/settled
    "billingMode": "live",      // live/shadow
    "resultSummary": "Analyzed jxhkb.com",
    "time": "2026-08-11T...",
    "source": "skill_billing_events (Agent实时写入)"
  }],
  "liveBreakdown": {
    "搜索买家": 12800,
    "企业画像分析": 4000
  },
  "shadowBreakdown": {
    "AI猎客基础买家": 1500
  },
  "dailyConsumption": [{
    "day": "2026-08-11",
    "skill": "搜索买家",
    "totalCredit": 800,
    "callCount": 1
  }],
  "dailyTotals": [{
    "day": "2026-08-11",
    "total": 3600
  }],
  "dataSources": {
    "transactions": "credits_transactions — 扣费/充值记录 (T+1回填)",
    "billingEvents": "skill_billing_events — Agent Skill调用后实时写入 (~1s延迟)",
    "dailyConsumption": "按日汇总 aggregating skill_billing_events WHERE settled"
  }
}
```

**前端注意**：
- `auditLog` = 所有转账记录（扣费/充值/冻结/解冻），来源 `credits_transactions`，非实时（T+1 回填）
- `billingEvents` = Agent 调用 Skill 时的实时记录，来源 `skill_billing_events`，近实时（<1s），含 `billingMode` 字段（live/shadow）
- `liveBreakdown` = 正式计费的已结算 Skill 汇总（从 `skill_billing_events WHERE billing_mode='live'` 聚合）
- `shadowBreakdown` = 影子计费的已结算 Skill 汇总（从 `skill_billing_events WHERE billing_mode='shadow'` 聚合，**不扣费**）
- `dailyConsumption` = 按日×Skill 的正式计费汇总
- `dailyTotals` = 按日汇总（适合画趋势图，仅正式计费）
- 每个字段的 `source` 标注了数据来源表
- 前端展示时 shadow 计费用蓝色/灰色 badge 区分，live 用正常绿色

#### POST /api/admin/customers
创建客户并分配套餐。

Request:
```json
{
  "tenantId": "xiaoyuan-new",
  "companyName": "新客户",
  "contactName": "张三",
  "contactEmail": "zhang@example.com",
  "planId": "start"
}
```

#### POST /api/admin/customers/:tenantId/topup
充值 Credits。

Request:
```json
{
  "amount": 100000,
  "reason": "手动充值"
}
```

#### POST /api/admin/customers/:tenantId/renew
续费（按套餐定价计算）。

### 3.2 套餐管理

#### GET /api/admin/plans
列出所有套餐模板。

#### POST /api/admin/plans
创建/更新套餐。

Request:
```json
{
  "planId": "growth",
  "planName": "Growth 成长版",
  "tier": "growth",
  "annualFeeYuan": 39800,
  "initialCredit": 1000000,
  "renewalPricePer100k": 850,
  "renewalDiscount": 0.85,
  "monthlyAllowance": 0
}
```

#### DELETE /api/admin/plans/:planId
删除套餐。

### 3.3 Skill 定价

#### GET /api/skill-prices
列出所有 Skill 价格 + 分类汇总。

#### PUT /api/skill-prices
创建/更新价格。

#### GET /api/skill-prices/:skillId/history
价格变更历史。

### 3.4 账户操作（credits-ledger 直接）

#### POST /v1/accounts/:accountId/freeze
冻结 Credits（慧展权益预留）。

```json
{"amount": 100000, "reason": "慧展权益-150条买家线索", "reference": "huizhan_150"}
```

#### POST /v1/accounts/:accountId/unfreeze
解冻 Credits。

#### GET /v1/accounts/:accountId/full
完整账户信息（含 frozen/available）。

### 3.5 Billing（Agent 用）

#### POST /v1/billing/estimate
预估费用（不扣费，用于 shadow billing）。

#### POST /v1/billing/settle
执行扣费。

#### POST /v1/billing/can-afford
余额检查。

### 3.6 其他

- `GET /api/tenants` — 租户列表
- `GET /api/health` — 服务健康
- `GET /api/audit` — 审计日志
- `GET /api/credits/summary` — Credits 总览
- `GET /api/orders` — 支付订单

---

## 四、页面需求

### 4.1 整体要求

- **技术栈**：你来选（React / Vue / 纯 HTML+JS 都行），部署为静态文件
- **认证**：页面加载时检查 localStorage `小元_admin_token`，无则显示登录框；Token 通过 `Authorization: Bearer {token}` 头发送
- **风格**：SaaS 管理后台，深色或浅色主题。当前是浅色白底 + 紫色 accent（#5b5af7）
- **部署**：静态文件放到 `admin-dashboard/public/`，通过 Express static 中间件服务

### 4.2 客户列表页（主页面）

**顶部统计卡片**（4 个）：
- 活跃客户数
- 总余额（Credit）
- 总消耗（Credit）
- 冻结/预留总额

**筛选 & 排序**：
- 搜索框：模糊匹配公司名
- 套餐筛选：下拉选择 start/growth/ultra
- 排序：消耗从高到低、从低到高、余额从低到高、按名称
- 刷新按钮

**表格列**：
| 客户 | 套餐 | 余额 | 已消耗 | 冻结 | 占比 | 操作 |

- 余额列：显示 `balance`，如果有冻结则在下面显示小字"可用 XX K"
- 冻结列：有冻结显示蓝色数字，无冻结显示 "—"
- 占比列：进度条 + 百分比
- 操作列：「续费」按钮

**点击行展开**：
- 显示该客户的 Skill 消耗明细（已结算 + 内测预估两部分）
- 显示冻结信息（如有）
- 再次点击收起

**点击客户名**：
- 跳转到客户明细页（同页跳转，不新开 tab）

### 4.3 客户明细页

**路由**：`/customer.html?tid={tenantId}`（或 SPA 路由 `/customers/:tenantId`）

**顶部**：
- 面包屑：客户列表 > 公司名
- 数据来源标注条（黄色背景）：说明各数据的来源和延迟

**客户信息卡片**（6 个指标）：
- 余额、冻结/预留、可用余额、累计消耗、套餐、状态
- 每个指标下标注数据来源（小字灰色）

**每日消耗趋势图**：
- 近 30 天柱状图（纯 CSS 或轻量图表库）
- 数据来源 `dailyTotals`

**Skill 消耗分布**：
- 已结算部分：按 Skill 排序，进度条 + 金额 + 百分比
- 内测预估部分：同样展示，蓝色主题区分

**Tab 切换**（三个 tab）：
1. **Skill 调用日志**（默认激活）：表格显示每次 Skill 调用的时间、名称、Credit、次数、状态（estimated/settled 用不同颜色 badge）、数据来源
2. **转账日志**：表格显示所有 debit/credit/freeze/unfreeze 记录，包含时间、类型（彩色 badge）、金额（扣费红色、充值绿色）、余额变化（XX K → XX K）、说明、来源
3. **按日明细**：表格显示每天每个 Skill 的汇总 Credit 和调用次数

### 4.4 续费弹窗

- 点击「续费」按钮弹出模态框
- 显示客户名、当前余额、套餐信息
- 输入充值 Credit 数量和原因
- 显示预估价格（根据套餐续费单价计算）
- 确认后调用 API，刷新列表

### 4.5 创建客户弹窗

- 输入 tenantId、公司名、联系人、邮箱
- 选择套餐（从 API 读取套餐列表）
- 提交后显示开通结果

### 4.6 Skill 定价页

- 分类统计卡片（buyer/insight/outreach/exhibition 等，点击筛选）
- 表格：Skill ID、名称、分类、Credit/单位（大字体，高价红色、中价黄色、低价绿色）、计费单位、状态（live/shadow/disabled 彩色 badge）
- 新增/编辑弹窗：Skill ID、名称、分类、Credit、单位、状态
- 价格变更历史弹窗

### 4.7 套餐模板页

- 表格：套餐 ID、名称、档次、年费、初始 Credit、续费单价、折扣
- 新增/编辑/删除

---

## 五、交互规范

1. **所有数据操作后刷新列表**（创建客户、续费、改价后）
2. **价格不可在前端硬编码**，必须从 API 读取
3. **消耗数据用 `lifetimeConsumed`**，不要用公式推算
4. **余额显示用 `balance`**，可用余额用 `availableBalance`
5. **数据来源标注**：每个数据区块下方显示来源表名
6. **错误处理**：API 失败时显示错误提示，不要让页面崩溃
7. **空状态**：列表为空或无消耗数据时显示友好提示
8. **Token 过期**：返回 401 时清除 token 并跳转登录
9. **同一页面不要同时存在主控台和管理后台两套 UI**，统一为管理后台

---

## 六、当前状态 vs 期望

| 维度 | 当前（standalone.html） | 期望 |
|---|---|---|
| 文件结构 | 单文件 21KB HTML 内嵌 CSS+JS | 模块化前端项目 |
| 客户列表 | ✅ 基本可用 | 保持现有功能 + 更好 UI |
| 客户明细 | ✅ customer.html 可用 | 整合为一个页面，Tab 切换 |
| Skill 定价 | ❌ 混在主控台 index.html | 独立页面，完整 CRUD |
| 套餐管理 | ❌ 无前端 | 独立页面 |
| 租户总览 | ❌ 混在主控台 | 整合或合并到客户列表 |
| 数据标注 | ❌ 无 | 每个区块标注来源 |
| 定价同步 | ⚠️ 部分硬编码 | 全部从 API 读取 |
| JS 质量 | ⚠️ 字符串拼接容易出错 | 模板引擎或框架 |

---

## 七、你可以发挥的方向

1. **UI/UX 设计** — 你认为好的 SaaS 管理后台该长什么样，就怎么做
2. **框架选择** — React/Vue/Svelte/纯 HTML，选你最擅长的
3. **组件拆分** — 你觉得该拆成哪些组件就拆
4. **图表** — 消耗趋势图用什么方式呈现（CSS bar / Chart.js / ECharts）
5. **交互优化** — 搜索防抖、加载骨架屏、乐观更新等

当前的后端 API 和数据模型是完整的、经过验证的，不需要改。你专注做前端即可。

---

## 八、部署信息

- **服务器**：43.156.232.2
- **管理后台端口**：8443（HTTPS，nginx 代理）
- **admin-dashboard**：localhost:8088
- **credits-ledger**：localhost:8081
- **Auth Token**：存在 `/tmp/小元-admin-token` 文件
- **数据库**：localhost:5432，数据库名 `小元_test`
- **构建**：`cd packages/admin-dashboard && npx tsc`
- **重启**：`sudo systemctl restart 小元-admin-dashboard`
- **静态文件目录**：`packages/admin-dashboard/public/`
