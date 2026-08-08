# 06 — DealClaw Agent 系分

> 优先级: P3 | 部署: 客户 Pod 内 | 运行时: OpenClaw
> 前置依赖: Nexus Agent Gateway (P0)

## 1. 职责边界

DealClaw Agent 是运行在客户 Pod 内的 AI 外贸销售系统，以 V 为原型。它不处理鉴权、计费、审计——这些由前置 Gateway 完成。

```
Nexus Agent Gateway          DealClaw Agent           外部服务
      │                          │                      │
      │ POST /execute             │                      │
      │ (+ context headers)       │                      │
      │─────────────────────────▶│                      │
      │                          │──① 解析用户意图       │
      │                          │──② 选择 Skill         │
      │                          │──③ 调用米奥 API ─────▶│ 米奥 CRM
      │                          │◀── 数据 ─────────────│
      │                          │──④ 生成结果           │
      │◀── 响应 ────────────────│                      │
```

**Agent 不负责的事**: 身份验证、Credits 检查、支付、Bot 管理、基础设施操作。

## 2. 已有 Skill（可复用）

| # | Skill | 功能 | 典型用户意图 |
|---|-------|------|------------|
| 1 | CRM 查询 | 查客户、联系人、公司、阶段、合同/定金 | "查一下 ABC Corp" |
| 2 | 数据圈选 | 根据画像从米奥数据圈选潜在线索 | "找德国五金进口商" |
| 3 | 读 Sales 妙记 | 提炼痛点、异议、预算、下一步 | "分析上次跟客户聊了什么" |
| 4 | 销售话术拆解 | 赢单话术分析、异议应对 | "客户说价格太高怎么回" |
| 5 | 售前方案生成 | 整合多源信息生成客户方案 | "给 ABC Corp 出方案" |
| 6 | 拜访质量评分 | 判断质量、给复盘建议 | "帮我复盘上次拜访" |
| 7 | 客户下一步跟进 | 综合上下文生成推荐动作和话术 | "接下来该怎么跟进" |
| 8 | 客户历程/服务感知 | 全链路记录与展示 | "看看这个客户的完整情况" |

## 3. Agent 消息处理流程（时序图）

```
客户(Bot→Gateway)    Nexus Agent Gateway        DealClaw Agent         米奥 API
      │                      │                       │                    │
      │ "查ABC Corp并分析    │                       │                    │
      │  上次会议，出跟进方案"│                       │                    │
      │─────────────────────▶│                       │                    │
      │                      │──auth→credits→scene   │                    │
      │                      │──────────────────────▶│                    │
      │                      │                       │                    │
      │                      │                       │──① 意图解析         │
      │                      │                       │   提取:             │
      │                      │                       │   company="ABC Corp"│
      │                      │                       │   action=followup   │
      │                      │                       │   需要: CRM+妙记+方案│
      │                      │                       │                    │
      │                      │                       │──② Skill 编排       │
      │                      │                       │   并行调用:         │
      │                      │                       │                    │
      │                      │                       │──③ CRM查询 ────────▶│
      │                      │                       │◀── 公司信息 ────────│
      │                      │                       │                    │
      │                      │                       │──④ 读取妙记 ───────▶│
      │                      │                       │◀── 会议纪要 ────────│
      │                      │                       │                    │
      │                      │                       │──⑤ 整合+生成        │
      │                      │                       │   下一步跟进方案      │
      │                      │                       │                    │
      │                      │◀── 方案 ─────────────│                    │
      │◀── 结果 ────────────│                       │                    │
```

## 4. Skill 选择策略

```typescript
interface Intent {
  kind: 'chat' | 'command' | 'query' | 'action';
  text?: string;
  action?: string;
  args?: Record<string, string>;
}

// Skill 路由表
const SKILL_ROUTER: Record<string, string[]> = {
  // 关键词 → 推荐 Skill 列表
  '查公司|查客户|企业|company': ['crm_query', 'company_intel'],
  '跟进|follow|next': ['followup', 'meeting_notes', 'proposal'],
  '邮件|email|mail': ['email_draft', 'followup'],
  '方案|proposal': ['proposal', 'company_intel', 'crm_query'],
  '线索|lead|圈选': ['lead_search', 'data_mining'],
  '展会|expo|exhibition': ['expo_followup', 'lead_search'],
  '话术|script|怎么说': ['sales_script', 'objection_handler'],
  '复盘|review|评分': ['visit_scoring', 'meeting_notes'],
};

// 默认：先查 CRM，再分析，最后给跟进建议
const DEFAULT_PIPELINE = ['crm_query', 'company_intel', 'followup'];
```

## 5. Agent 输出格式

```json
{
  "type": "agent_response",
  "intent": "followup",
  "pipeline": ["crm_query", "meeting_notes", "followup"],
  "result": {
    "summary": "ABC Corp 是德国家居用品进口商，最近一次接触是 7月20日...",
    "action_items": [
      "1. 今天发邮件确认样品参数",
      "2. 三天后跟进报价反馈",
      "3. 准备 CE 认证文件"
    ],
    "draft_email": "Subject: Follow-up on sample requirements...",
    "risk_flags": ["客户对交期有顾虑，需确认工厂排期"],
    "confidence": 0.85
  },
  "credits_used": {
    "crm_query": 500,
    "meeting_notes": 3000,
    "followup": 2000,
    "total": 5500
  }
}
```

## 6. 与 Nexus Agent Gateway 的协议

DealClaw Agent 接收 Gateway 注入的 header，通过中间件解析：

```typescript
// Agent 侧: 解析 Gateway context（仅示例，实际由 OpenClaw 中间件处理）
interface GatewayContext {
  tenantId: string;
  userId: string;
  keyConfigRef: string;
  creditsRemaining: number;
  sceneUnlocked: string[];
  planTier: string;
}

// Agent 不主动调用 Credits 扣减——Gateway 在响应后会扣减
// Agent 只需要关心业务流程
```

## 7. M0 最小可行版本

M0 只做一件事：**客户上下文 → Skill → 可执行跟进动作**。

- 1 个渠道（飞书）
- 3 个核心 Skill: CRM查询 + 妙记分析 + 下一步跟进
- 1 个目标: 生成销售看得懂、敢复制、能发送的跟进话术
- 不涉及: 邮件自动发送、多市场、权限分级、付费（这些是 M1+）

## 8. 部署规格

```yaml
# 每个客户独立 Pod
cpu: 2-6 cores (按套餐)
memory: 4-12Gi (按套餐)
replicas: 1-3 (按套餐)

环境变量（Gateway 注入 header，不直接读取环境变量）:
  OPENCLAW_MODEL: deepseek-v4-pro
  MIO_API_KEY: <from Secret>
  SUPABASE_URL: https://cdn.makaron.app
```
