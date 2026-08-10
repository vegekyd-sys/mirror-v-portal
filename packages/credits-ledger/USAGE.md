# Skill Pricing & Billing Hook

## 5 个 P0 核心 Skill（定价已确定，其他 Skill 按分类默认定价）

| Skill ID | 名称 | Credit | 单位 |
|---|---|---|---|
| `buyer.exhibition_basic` | AI慧展基础买家推荐 | 100 | 条 |
| `buyer.standard_search` | AI猎客标准买家搜索 | 2,000 | 条 |
| `buyer.verified_contact` | 双重验证关键联系人 | 5,000 | 条 |
| `content.outreach_copy` | 个性化开发信/邀约文案 | 30 | 人 |
| `outreach.email_send` | 邮件发送（客户自有账号） | 5 | 封 |

## 其他 Skill 分类默认定价

未在 skill_prices 表中精确匹配的 skill_id，按 category 前缀使用默认值：

| 分类 | 默认 Credit | 适用 Skill ID 前缀 |
|---|---|---|
| `buyer.*` | 500/条 | 买家搜索、线索、联系人等 |
| `content.*` | 100/条 | 文案、脚本、翻译等 |
| `outreach.*` | 20/条 | 邮件、WhatsApp、跟进等 |
| `video.*` | 8,000/条 | 视频生成、配音等 |
| `insight.*` | 5,000/份 | 市场报告、企业画像等 |
| `exhibition.*` | 300/人 | 展会名片、邀约、复盘等 |
| `admin.*` | 500/次 | 会议纪要、日报、知识库等 |
| 未知 | 100/次 | 全局兜底 |

## Agent Billing Hook 使用方式

### 在 DealClaw Agent 中调用（通过 HTTP API）

```typescript
const LEDGER_URL = process.env.CREDITS_LEDGER_URL || 'http://credits-ledger:8081';
const ACCOUNT_ID = tenantAccountMap[tenantId]; // 从租户→账户映射获取

// 步骤 1: 估算成本（展示给用户）
const estimate = await fetch(`${LEDGER_URL}/v1/billing/estimate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tenantId: 't_001',
    accountId: ACCOUNT_ID,
    taskId: 'task_abc123',
    skillId: 'buyer.standard_search',
    quantity: 10,
  }),
}).then(r => r.json());

// estimate = { ok: true, estimatedCredit: 20000, skillName: "AI猎客标准买家搜索", unitPrice: 2000, isDefault: false }

// 步骤 2: 用户确认后执行 → 结算
const settle = await fetch(`${LEDGER_URL}/v1/billing/settle`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tenantId: 't_001',
    accountId: ACCOUNT_ID,
    taskId: 'task_abc123',
    skillId: 'buyer.standard_search',
    quantity: 10,
    estimatedEventId: estimate.eventId,
    resultSummary: '成功返回 10 条买家线索',
  }),
}).then(r => r.json());

// settle = { ok: true, actualCredit: 20000, transactionId: "..." }
```

### 快捷余额查询

```typescript
const check = await fetch(`${LEDGER_URL}/v1/billing/can-afford`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    accountId: ACCOUNT_ID,
    skillId: 'buyer.verified_contact',
    quantity: 5,
  }),
}).then(r => r.json());
// { canAfford: true, estimatedCredit: 25000, balance: 500000 }
```

## 管理后台

访问 admin-dashboard → **Skill 定价** 标签页。

功能：
- 查看所有 Skill 定价（按分类汇总）
- 搜索/筛选 Skill
- 在线修改价格（自动记录变更历史）
- 新增 Skill 定价
- 切换 live/shadow/disabled 状态
- 查看价格变更历史

## 价格变更规则

1. 修改价格时自动写入 `price_change_log` 表
2. 支持 live（正式扣费）、shadow（只记录不扣费）、disabled（禁用）
3. 价格修改即时生效（测试期间无审批流）
4. 后续可加审批流和灰度发布

## API 端点汇总

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v1/skill-prices` | GET | 列出所有定价 |
| `/v1/skill-prices/:skillId` | GET | 单个定价+历史 |
| `/v1/skill-prices/:skillId` | PUT | 创建/更新定价 |
| `/v1/skill-prices/:skillId` | DELETE | 禁用定价 |
| `/v1/skill-prices/:skillId/history` | GET | 价格变更历史 |
| `/v1/skill-prices/estimate` | POST | 估算成本 |
| `/v1/skill-prices/summary` | GET | 分类汇总 |
| `/v1/billing/estimate` | POST | Agent 估算 |
| `/v1/billing/settle` | POST | Agent 结算扣费 |
| `/v1/billing/can-afford` | POST | 余额检查 |
| `/v1/billing/events` | GET | 账单查询 |
