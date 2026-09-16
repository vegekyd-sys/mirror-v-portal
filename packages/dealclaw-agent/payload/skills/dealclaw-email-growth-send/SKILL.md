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

### 任务驱动触发（展自动营销）

当展自动营销有**待发草稿**时，也走本 skill 生成内容并发送（与「用户确认买家后群发」同一套内容口径）：

```bash
# 拉待发清单
python3 work/mio-api/dc_marketing_automation_send.py --list --company-id <supplier_id>
```

- 只处理 `content_route == "dealclaw-email-growth-send"` 的（邀约类归 dealclaw-exhibition-invitation）。
- 每条含 `draft_id` / 买家 / 公司 / 展会 / `requires_approval`。
- 按本 skill 的「邮件内容原则」+「反垃圾控制」生成 subject + 正文（**不套死模板**），再回传发送：

```python
from dc_marketing_automation_send import send_one
send_one(company_id, draft_id, generator=<按本 skill 内容原则生成正文的函数>)
```

- `requires_approval=True` 的草稿**不自动发**，保持 `pending_confirmation` 等用户确认。
- 发送成功后 automation 自动关闭（`execution_ref=resend_id`）；退订 footer 由 send.mjs 自动注入。
- 既有前置不跳过：MFG 预检（域名预热 / 日限额 / 收件人校验）与窗口路由仍适用。

## 执行流程

```
1. 飞书通知检查 → GET /bindings 查已有绑定，有则自动复用，无则提醒绑定
2. KB 素材检查 → 缺关键素材（认证/手册）则阻断通知
3. 生成邮件内容 → 公司口吻，含产品+差异化信息
4. 发送时区窗口路由 → 交给统一入口自动处理（带 `--country`）：窗口内当场发，窗口外自动落待发队列，由 cron 到点自动发（当地下一个工作日 8:00）。批量取多数买家时区；跨时区逐批各带 `--country` 分批发。
5. 发送前校验 → 域名预热 / 收件人格式 / 业务邮箱验证
6. 发送 → `python3 work/mio-api/dc_email_send.py send --channel GS ...`（自动退订+追踪+批次回执）
7. 回写线索池 → 立刻更新每条记录的 阶段→已触达、最近触达→发送时间、触达渠道→邮件/WhatsApp。不可跳过
8. 自动序列 → 未回复则间隔跟进，回复则转人工
```

**发送进度按窗口批次通知，不逐封报。** 邮件不是一条连续进度，是「当下准备 + 多个时区窗口分批发」，三档：

- **当下（准备完成时）**报一句：「共 N 封，时区校验后 X 封窗口内立即发，Y 封排队——买家当地还在夜里/周末，约北京时间 HH:00 后自动发」。
- **窗口到点（cron 触发发送）**：每批发完推一条「本轮 X 封已发（某时区窗口），累计 Y/N」，不逐封报。
- **异常才打断**：退信、送达延迟、无邮箱挂起这类才主动推；正常全发完就一条汇总收尾。

一句话：把「发送进度」翻译成「当下能发多少 + 排队多少、大约几点发」，之后交给窗口批次 + 异常告警，不追实时逐封。

---

## 收件人选择

- 群发全发，不按优先级筛；有多个联系人时，优先用采购经理/总经理的邮箱，缺则顺延。

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

API Key 存储在 `work/mio-api/.env`。`dc_email_send.py` 发送时自动加载，无需手动 export。`domain-setup.mjs` 等域名管理脚本仍走 `scripts/resend/.env`（需 export）。

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

Resend 邮件事件通过 `dealclaw.datathink.com/webhook` 中间层转发到飞书群。**永远不要直接配 Resend webhook 到飞书 bot URL**。

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

## 发送脚本（统一入口）

```bash
python3 work/mio-api/dc_email_send.py send \
  --channel GS \
  --from 'Lawaken <V@mail.dealclaw.io>' \
  --to buyer1@x.com,buyer2@x.com \
  --subject '...' \
  --html '<p>...</p>' \
  --text '...' \
  --country BR \
  --enterprise <企业key> \
  --receipt-target oc_<当前群chat_id>
```

- `--channel GS` 走 Resend（自动退订+追踪）。
- `--country` 带则自动判窗口：窗口内当场发，窗口外落待发队列由 cron 到点自动发；不带则跳过窗口检查直接发。
- **`--enterprise` 必带**：填当前企业 key（如 `lpskcom`）。不传则 `dc_email_send.py` 里 `if enterprise:` 跳过落库，**发送日志不落 send_log、早报的「发送/送达/回复/退信」查不到、阶段也不回填**——这正是早报显示 0 的根因之一。
- `--receipt-target` 必带，填当前会话 id：群聊用 `oc_` chat_id，私聊用 `ou_` open_id。发送结果（成功/失败/定时到点）以机器人身份推一条批次回执回这个会话，不逐封。
- `RESEND_API_KEY` 由 `dc_email_send.py` 自动从 `work/mio-api/.env` 读取，无需手动 export。

---

## 脚本路径锚点（避免执行失败 + 禁止裸发）

- **发送一律走统一入口 `dc_email_send.py send`，禁止直接 `node scripts/resend/send.mjs` 裸发**。`send.mjs` 是底层发信脚本，只调 Resend 发信、不落 send_log、不回填阶段——直接裸发会导致早报查不到发送记录。
- 统一入口 `dc_email_send.py` 内部会去调 `send.mjs`（GS）/ `send-direct.mjs`（FD），并负责落 send_log + 批次回执 + 窗口路由，agent 不要绕过它。
- 从工作区根执行，用相对路径调用 `python3 work/mio-api/dc_email_send.py ...`。
- 不要拼 `/data/workspace` 等绝对路径前缀，也不要 `ls`/list 脚本目录来「确认脚本存在」——租户环境挂载根可能与预期不符；且 `.env`、`.reply-checkpoint.json` 等运行时文件不在镜像里（`.gitignore` 排除），列目录必失败。
- 脚本内部用 `__dirname` 自动定位同目录的 `.env`，无需手动指定。

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
| v3.3 | 2026-09-08 | 发送改走统一入口 dc_email_send.py：窗口路由 + 批次回执（机器人推回发起会话）+ 定时发送闭环。来源：田耕郡@格格 |
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

## 邮件计费上报（按发送次数，小元 credit）

> 2026-09-15 新增：每封邮件**成功发出后**，按**实际发出条数**上报一次。

```bash
xiaoyuan report-usage \
  --api-code "dealclaw-email-growth-send" \
  --api-name "批量开发信群发" \
  --quantity <本次成功发出的邮件条数>
```

- `--quantity` = 本次**真实成功发出**的条数；失败 / 被闸门拦截 / 被时区窗口阻断的**不计**
- 不传 `--credit` → 走平台定价表；**未配置则按 0 计**（所以 code 必须与定价表一致）
- 余额不足：服务端置 0、**不拒绝发送**（计费不阻断业务）
- 上报失败静默，不阻塞主流程；但**结果里要能看出是否已上报**（可观测）
- 与既有 `dealclaw-billing-record.sh`（shadow 记录）**并存**：shadow 继续记，本条是正式扣点

- 定价表单价：**200 credit/单位**（`credits-ledger/skill_pricing_full.tsv`）
