# 邮件事实与统计口径 v1（设计稿）

> 状态：**设计定稿，未切生产**。实施顺序：旧数据 Adapter → 回放 → 新旧对账报告 → 数字通过才切。
> 适用范围：早晚报（`dc_daily_report`）、EmailProvider（`dc_email_provider`）、看板（`dc_growth_dashboard`）**统一读口径**。
> 核心判据：先把邮件事实保存完整，再清楚区分「今天发生了什么 / 哪批邮件有效 / 哪个买家值得跟进」。

---

## 0. 现状缺陷（本设计要修掉的）

| 缺陷 | 位置 | 症状 |
|------|------|------|
| 「今日数据」实为全量 | `dc_daily_report.collect_metrics` 无日期过滤 | 发送/送达/退信 = 开户以来累计 |
| 回复口径双写且一条恒 0 | `dc_email_provider._count_replied` 读 `direction`，落盘字段是 `record_type` | 回复恒 0 |
| 已回复判成待跟进 | `_has_reply` 读 `resend_id`，入站存 `resend_received_id` | 待跟进虚高 |
| 回信归属丢失 | 匹配不到 outbound 时落 `_unmatched/` | 按 company 查不到回信 |
| 「今日」用 UTC 日 | `store.count_sent_today` 用 `utc_now()[:10]` | 00:00–08:00 CST 错位一天 |

---

## 1. 事实层（只写事实，一个统计都不算）

### 1.1 时间字段

- 只存 `occurred_at_utc` 与 `ingested_at_utc`（UTC ISO）。
- **不存 `business_date`**。日报归属日期由 `metrics_view` 按 `report_timezone` 现算。
- 理由：时区规则会变、历史要回放，日期属于「口径」而非「事实」。

### 1.2 两类事件物理分开

- `delivery_state`：`accepted` / `delivered` / `bounced` / `failed` —— 单封邮件的投递状态。
- `engagement`：`opened` / `clicked` / `complained` / `unsubscribed` / `replied` —— 独立追加。
- **`complained` / `unsubscribed` 不得覆盖送达状态**：只表示「该封有投诉/退订」，delivery_state 不变。
- `delivery_state` **不是简单线性**：允许 delivered 之后出现延迟 bounced。
  → 存 `delivery_events[]`（按 occurred_at 时序）+ `delivery_state_projection`（投影值 + 投影时间 + 依据 event_id）。
  → **终态投影不能被晚到事件覆盖**；晚到事件只追加、只更新投影依据，不回写历史。

### 1.3 `sent` 口径

- `sent` = **Provider accepted**（拿到 provider 受理 id 的那一刻），**不等于 outbound 记录条数**。
- 旧数据 Adapter 映射不出 accepted 事件的，单列 `unverified`，**不计入 sent**。

### 1.4 入站归巢

- `inbound_received` **只存一次**；reply 关系与商机回复分别由「关联」和「signal」派生，**禁止双写**。
- 归属优先级：`In-Reply-To` → `References` → `thread_id`（强匹配，直接挂原 outbound）。
- **弱匹配只能标 `ambiguous`（待确认）**，不得硬挂。
- 未匹配 → `unassigned` / `ambiguous` + 原因，**进待认领队列**；既不静默丢弃，**也不计入 Campaign**。

### 1.5 商机回复

- 作为**可追溯 signal** 单独存，**不写进原始邮件事实**。
- 用 `source_message_id` 回指原邮件；原始事实保持干净。

---

## 2. 派生层

### 2.1 回复的四个数（永不合并）

| 字段 | 含义 |
|------|------|
| `inbound_messages` | 入站消息数 |
| `unique_repliers` | 唯一回复买家数 |
| `replied_threads` | 已回复线程数 |
| `confirmed_opportunity_repliers` | 已确认商机回复买家数（来源 signal，见 1.5） |

**`unique_repliers` 去重优先级**：`lead_id / customer_id` > `contact_id` > `normalized_email`。
不按公司名或域名强合并；冲突标 `ambiguous`。

### 2.2 待跟进（followup）

**唯一 lead / opportunity 计数，不统计邮件数。** 条件全满足才计入：

1. 序列 active
2. 最近邮件已送达
3. `next_touch_at` 已到
4. 无人工回复（**自动回复不算人工回复**）
5. 未达最大轮次
6. 未退订 / 投诉 / 拒绝
7. 有有效渠道（**无有效渠道 → 进「待补联系人」，不计待跟进**）
8. 未人工暂停
9. 有明确商机 `next_step` 的，**不重复计入普通待跟进**

### 2.3 两个视图分开

- `activity_view(company, date_range, report_timezone)` —— **日活动**：今天发生了什么。
- `campaign_view(company, campaign_id)` —— **批次效果**：这个批次最终如何（分子分母都取自该批次）。
- **禁止用当天发送数计算当天回复率**（分子分母不同期，会得出无意义数字）。

### 2.4 时区

- 早晚报使用**企业 `report_timezone`**，默认 `Asia/Shanghai`。
- **买家时区**只用于发送窗口；**展会时区**只用于现场提醒。
- **原始事实全部 UTC。**

---

## 3. 读入口（唯一）

`metrics_view` 是早晚报 / EmailProvider / 看板**唯一**读入口。
现有三处各自聚合的实现**全部下线**——三处各算各的，正是数字不一致的根因。

字段名另有 `EMAIL_SCHEMA` 常量作唯一来源，禁止代码里出现字面量字段名（本次 bug 的根因是 `direction` vs `record_type`、`resend_id` vs `resend_received_id` 两套名混用，读错不报错、静默返回 0/False）。

---

## 4. 上线方式

1. 旧数据 Adapter（把历史 outbound / inbound / webhook 映射成新事实层）
2. 回放（按新口径重算）
3. **新旧对账报告**
4. 数字验证通过 → 才切生产

---

## 5. 对账验收（用途达真实数据）

指标：**发送（provider accepted）· 送达 · 退信 · 当天回复 · 累计回复 · 待跟进人数**

每条数字必须能列出：

- 脱敏 `message_id` / `event_id`
- **计入理由**（满足哪条口径）
- 来源层（事实层 / 派生层）

---

## 6. 未决 / 待补

- 途达租户的**只读数据位置**（见对账前置条件）。
- `EMAIL_SCHEMA` 常量的具体字段命名（实施时定稿）。
- 旧数据 Adapter 对历史 `provider_status` 的 `unverified` 判定阈值。
