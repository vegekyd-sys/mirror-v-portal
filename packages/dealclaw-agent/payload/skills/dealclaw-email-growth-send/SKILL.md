---
name: "dealclaw-email-growth-send"
description: "Growth Send 规模化邮件触达：Resend发送、自动序列、预热控制、知识库素材检查。来源：田耕郡@格格"
author: ""
version: "3.2"
date: "2026-07-30"
---

# DC-Email Growth Send: 规模化触达

> DealClaw Skill | 产品更新、展会邀请、目录分发、再营销

## 何时用

- 用户确认了买家，想批量发送开发信/产品更新/展会邀请
- 用户说「发给这几个买家」「群发一轮」
- 触发条件：已有买家列表 + 已确认企业画像

## 执行流程

```
1. 飞书通知检查 → GET /bindings 查已有绑定，有则自动复用，无则提醒绑定
2. KB 素材检查 → 缺关键素材（认证/手册）则阻断通知
3. 生成邮件内容 → 公司口吻，含产品+差异化信息
4. 发送前检查买家时区 → `python3 work/mio-api/send_window.py --country <ISO> [--city <city>]`。不在工作日 8:00-18:00 则阻断，向用户说明原因及预计发送时间。批量发送时，取多数买家的时区判断；若买家跨时区，逐批检查。
5. 发送前校验 → 域名预热 / 收件人格式 / 业务邮箱验证
6. 发送 → Resend（自动退订+追踪）
7. 回写线索池 → 立刻更新每条记录的 阶段→已触达、最近触达→发送时间、触达渠道→邮件/WhatsApp。不可跳过
8. 自动序列 → 未回复则间隔跟进，回复则转人工
```

---

## 飞书通知自动绑定（Silent Bind）

**核心原则：绑定是服务端持久化的，不依赖 session。用户 /new 后不用重新绑。**

### 发送前自动检查

每次用户触发发送邮件时，静默执行：

```python
GET https://dealclaw.datathink.com/webhook/bindings
Header: X-Admin-Token: <token>
```

遍历返回的 `bindings` 数组，找 `agent_email == 默认发件地址` 的记录。

- **找到了且 `channel != "none"`**：静默复用，不发绑定提示，直接进入发送流程
- **找到了但 `channel == "none"`**：提醒用户「绑定已存在但通道不可用，要修复吗？」
- **没找到**：提醒「邮件通知未绑定，发之前先绑一下？」

### 绑定参数记忆

绑定 API 是 upsert，服务端已存储。V 不需要在 session 中记忆绑定参数。

`X-Admin-Token` 存储在 `workspace/.env` 的 `WEBHOOK_ADMIN_TOKEN`。

默认发件地址统一使用 `V@mail.dealclaw.io`。

### 默认绑定参数（当用户说「绑定邮件通知」时）

按以下优先级收集参数：

1. **agent_email** → 默认 `V@mail.dealclaw.io`
2. **webhook_url** → 用户在当前群触发，问「是绑到当前群吗？」→ 是 → 使用当前群的机器人 webhook URL
3. **mention_open_id** → 默认不填，除非用户说「有回信 @ 我」

---

## 发送前预检（MFG — Mandatory Flight Gate）

每次发送前必须通过以下检查，任一项未通过则阻断：

| 检查项 | 不过 → 行为 |
|--------|------------|
| 域名预热状态 | 阻断，引导完成域名入驻 |
| 日限额已满 | 排队到次日 |
| 知识库关键素材缺失 | 阻断 → 通知用户补全 → 补全后继续 |
| 收件人格式无效 | 跳过并告知 |
| 收件人非业务邮箱（@gmail.com/@qq.com 等） | ⚠️ 警告用户确认，不直接阻断 |
| 飞书通知未绑定 | 绑定已存在 → 静默复用；不存在 → 提醒绑定 |

---

## 邮件内容原则

V 根据买家背景和企业画像自主生成，不套死模板。核心原则：

- 公司对市场口吻，不假装一对一
- 开头证明你研究过对方业务
- 中间说清楚你是谁 + 差异化价值
- 结尾给一个轻行动引导
- HTML + 纯文本双版本
- 退订 footer 由 send.mjs 自动注入

### 反垃圾（Anti-Spam）控制 — 冷信首封必读

> 来源实践（2026-08-20 领艺首轮群发）：`trevor@expertmedicalsupplies.co.za` 被拒 `550 High probability of spam`（ContentRejected）。根因是营销词密度过高 + 冷群发语境。以下为硬约束：

1. **去营销化标题**：冷信标题不用「形容词+品牌堆砌」式（如 "German-standard … / premium …"），改用低调商务询价式（如 "Inquiry - <品类> for your product range" / "Regarding <品类> at the Johannesburg show"）。
2. **降营销词密度**：首封正文避免连用 "German-standard / century-old / full-solution / premium / luxury" 等密集形容词；一句话一个卖点，多留中性陈述（我是谁、做什么、何时在哪参展）。
3. **强一对一姿态**：标题和正文不重复品牌名 3 次以上；结尾用轻提问（"Could you let me know if this is useful?"）而非硬 CTA。
4. **新发送身份/新收件域逐批检查**：发件身份首次投递到某域，反垃圾误杀概率高；批量发前对每个新域做一次 check，单批控制发件节奏（≥0.5s 间隔），勿大并列。
5. **bounce 分级复盘**：`type=Transient / subType=ContentRejected` 属内容触发（可改内容重投，改后可自动重发）；`type=Permanent`（邮箱不存在/无效）才停止、记入无效名单待清。

> 未读本小节的 agent 在生成群发内容前，应默认按上述约束生成冷信。

---

## 自动跟进

首封发送后，买家未回复 → V 自动生成跟进邮件。间隔和频次由 V 根据买家类型判断（品牌厂试探期长，进口商节奏快），不硬编码天数。

三轮无回复 → 静默转入培育池，不发提醒，只进状态记录。

任何阶段买家回复 → 停止自动序列，转 Founder Direct 人工跟进。

---

## 预热与限额

发送前查域名预热状态。阶段和日限额由实际配置决定，此 skill 不做默认假设。

### Resend API Key 配置

API Key 存储在 `scripts/resend/.env`，domain-setup.mjs 和 send.mjs 均从此读取。调用 send.mjs 前需 export：

```bash
export RESEND_API_KEY=$(grep RESEND_API_KEY scripts/resend/.env | cut -d= -f2)
```

不在 `/home/openclaw/.openclaw/.env` 中读取。

### 域名管理（发送前置条件）

发送邮件前必须确认发件域名已在 Resend 验证通过。使用 `scripts/resend/domain-setup.mjs`：

```bash
# Step 1: 创建域名
export RESEND_API_KEY=***
node scripts/resend/domain-setup.mjs step1 --email sandkey@jasscup.com

# Step 2: 添加域名到 Resend
node scripts/resend/domain-setup.mjs step2 --domain mail.dealclaw.io

# Step 3: 获取 DNS 验证记录
node scripts/resend/domain-setup.mjs step3e --domain mail.dealclaw.io

# Step 4: 验证 DNS 已生效
node scripts/resend/domain-setup.mjs step4 --domain mail.dealclaw.io

# 检测 DNS 托管商
node scripts/resend/domain-setup.mjs dns-detect --domain mail.dealclaw.io
```

域名未验证 → 阻断发送，输出 DNS 记录给用户。

### 旧账号残留清理

如果 Resend API 返回非 dealclaw.io 的域名（如旧账号的 mail.dogarm.top），自动删除，不保留。

---

## 追踪

所有 Growth Send 邮件默认开追踪（open + click），send.mjs 自动处理。

---

## 飞书通知绑定 API 参考

Resend 邮件事件通过 `webhook.dealclaw.io` 中间层转发到飞书群。**永远不要直接配 Resend webhook 到飞书 bot URL**。

### 概念：agent_email

`agent_email` 是**我方代理邮箱**（发送身份），不是买家邮箱。一个代理邮箱 ↔ 一个飞书群。地址大小写不敏感。

**默认发件地址：`V@mail.dealclaw.io`**

### 管理接口

**Base URL:** `https://dealclaw.datathink.com`（前缀 `/webhook`）
**认证头:** `X-Admin-Token: <WEBHOOK_ADMIN_TOKEN>`

限流：10次/分钟，burst 5，按调用方 IP 计。429 时退避重试。

### `GET /bindings` — 列出全部

```json
{"count": 1, "bindings": [{"agent_email": "...", "channel": "custom", ...}]}
```

密钥不回显完整值，只给 `*_hint` 掩码。

### `POST /bindings` — 新增或覆盖（upsert）

| 参数 | 必填 | 说明 |
|------|:--:|------|
| `agent_email` | ✅ | 代理邮箱，如 `V@mail.dealclaw.io` |
| `webhook_url` | ✅ | 飞书自定义机器人 webhook URL |
| `webhook_secret` | 否 | 机器人签名校验码 |
| `prefer` | 否 | `"custom"` (默认) |
| `mention_open_id` | 否 | 买家回信时 @ 的用户 open_id |
| `note` | 否 | 备注 |

### `POST /bindings/{agent_email}/test` — 验证

⚠️ 会真的往群里发一张测试卡片。返回 `{"sent": true, "bound": true}` = 生效。

### 错误码

| 码 | 含义 | 处理 |
|---|------|------|
| 400 | 参数不合法 | 检查参数 |
| 401 | ADMIN_TOKEN 缺失或不匹配 | 找运维 |
| 404 | 绑定不存在 | 检查 agent_email |
| 429 | 限流 | 退避重试 |

---

## 发送脚本

```bash
node scripts/resend/send.mjs \
  --from 'Lawaken <V@mail.dealclaw.io>' \
  --to buyer@x.com \
  --subject '...' \
  --html '<p>...</p>' \
  --text '...'
```

⚠️ `send.mjs` 的 Authorization header 直接传裸 API key，不加 `Bearer` 前缀。`RESEND_API_KEY` 格式为 `re_` 开头。

---

## 错误处理

| 场景 | 行为 |
|------|------|
| 收件人邮箱不存在 | 提示跳过 |
| Resend 发送失败 | 重试 1 次 → 提示手动处理 |
| bounce / complaint 超标 | 通知 + 建议排查 |
| ADMIN_TOKEN 缺失 | 提示用户向运维索取 |
| 发送前未绑定通知 | GET /bindings 查已有，有则复用无则提醒 |

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v3.2 | 2026-07-30 | 新增 Silent Bind：发送前自动 GET /bindings 检查已有绑定，/new 后无需重绑。修复 send.mjs Bearer 前缀 bug。来源：田耕郡@格格 |
| v3.1.1 | 2026-07-30 | 完善飞书通知绑定：补充全部管理接口、错误码表、agent_email概念、通道类型、密钥不回显设计、限流细节 |
| v3.1 | 2026-07-30 | 新增飞书通知绑定流程 + MFG 发送前预检 |
| v3.0 | 2026-07-29 | 吸收 dc-copy 内容生成，三轮序列改为原则级 |

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次完成邮件发送并交付结果后，必须异步记录一条计费事件：

```bash
# 计费埋点（正式链路）：tenantId = 当前租户（按 open_id/群 chat_id 从 scripts/billing-config.json 解析；解析不到自动 shadow 记录）
bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw-email-growth-send 1 &
```

- 必须在后台异步执行（加 `&`），不阻塞用户回复
- 失败静默，不影响主流程
- 只在结果已交付用户后才记录
