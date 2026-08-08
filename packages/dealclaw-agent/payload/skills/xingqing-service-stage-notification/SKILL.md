---
name: "xingqing-service-stage-notification"
description: "星擎服务阶段变更通知：识别策划/制作/交付/复盘并发送客户可见更新"
---

# Xingqing Service Stage Notification Skill（星擎服务阶段自动化通知）

## When to use

Use this skill when V needs to recognize or announce a service-stage change for 星擎 / 米奥 / 小龙虾 / Makaron customer-service work.

Typical triggers:

1. 飞书客户群、项目群、task room 或分流群里，客户/运营/销售明确说进入下一阶段，例如“策划案确认了”“可以开始制作”“样片已交付”“这单复盘一下”。
2. 飞书表格 / Base / 项目管理表中客户服务阶段、任务状态、owner、交付日期发生变化。
3. Makaron / PlanMode / 热品洞察 / 策划案 / 任务卡完成了关键里程碑，需要给客户或内部群一个可见、克制、准确的状态更新。
4. 人类要求 V“同步一下进度”“通知客户”“提醒下一步”“把状态发到客户群”。
5. 星擎运营需要跨客户群统一服务感知：策划 → 制作 → 交付 → 复盘，而不是靠人工临时措辞。

Do **not** use this skill when:

- 群里只是人类之间讨论，没有 @V、没有把任务交给 V、V 也不是该任务 owner；
- 阶段变化没有足够证据，只是 V 猜测；
- 通知会暴露内部工具、runId、成本、debug、失败堆栈、token、客户隐私；
- 发送对象、群聊或客户可见程度不明确；
- 用户明确要求静默、暂不通知或只内部记录。

## Core principle

A stage notification is a **customer-visible service promise**, not an internal log.

It must answer four questions:

1. 现在到哪一步了？
2. 已经完成了什么？
3. 接下来谁做什么？
4. 客户是否需要补充、确认或等待？

Keep messages short, useful, and non-spammy. Use task cards or service cards for long-running work; do not flood a customer group with every internal micro-step.

## Canonical service stages

Use these stages as the default Star Engine service lifecycle. Adapt names per project, but keep the underlying semantics.

| Stage | Chinese label | Meaning | Common evidence | Main notification goal |
|---|---|---|---|---|
| `intake` | 需求接收 / 素材收集 | Customer request or material just arrived | Customer sends brief/materials; sales creates task; table new row | Confirm receipt and ask for missing essentials. |
| `planning` | 策划 / 方案 | V/team is analyzing needs and designing direction | PlanMode card; B2B策划案; hot-product insight; customer profile | Make the approach visible and request confirmation only when needed. |
| `production` | 制作 / 执行 | Approved plan moves into Makaron, design, research, table filling, or document execution | Makaron task card started; runner status; assignee starts work | Reassure customer that execution has begun and set expectation. |
| `review` | 内部验收 / QC | Draft or generated output exists; V/team is checking before delivery | project completed; file generated; doc drafted; QC checklist | Avoid premature delivery; explain brief QC if visible update is needed. |
| `delivery` | 交付 | Customer-facing output is ready | video/file/link/card/doc sent; final table written | Deliver asset + next action + feedback request. |
| `iteration` | 反馈修改 / 迭代 | Customer or team requests changes after delivery | comments, reroll, revised brief, issue list | Confirm feedback captured and state revision scope. |
| `retrospective` | 复盘 / 建档 | Stage or project closes; experience should be captured | confirmation, customer acceptance, repurchase signal, postmortem | Summarize result, ask for feedback if appropriate, update customer profile/case. |
| `blocked` | 阻塞 / 待补充 | Cannot proceed safely or truthfully | missing materials, unclear language/market, permission, quota, API, access | State blocker, ask exact unblock item, do not pretend progress. |

## Stage detection

### A. Feishu group or DM message triggers

Treat a message as a potential stage signal when it contains:

- Intake signals: “帮我做 / 出几条 / 看下这些素材 / 需求是 / 客户发来了 / 新客户 / 新项目”.
- Planning signals: “先给方案 / 策划案 / 方向 / Plan / 选题 / 脚本 / 热品洞察 / 画像报告”.
- Production signals: “方案确认 / 可以开始做 / 直接出 / 开始制作 / 跑一下 / 生成 / 填表 / 写文档”.
- Review signals: “初稿 / 样片 / 预览 / 看看有没有问题 / QC / 验收”.
- Delivery signals: “交付 / 发客户 / 给链接 / 文件好了 / 已上传 / 已填完”.
- Iteration signals: “改一下 / 重做 / 换风格 / 不要这个 / 客户反馈 / 重新生成”.
- Retrospective signals: “复盘 / 建档 / 总结经验 / 案例 / 作品展示 / 下次怎么做”.
- Blocked signals: “素材没发齐 / 没权限 / 打不开 / 额度不足 / 不确定语言 / token / 表格权限 / 客户没确认”.

Rules:

1. In group chats, first apply the Group Chat Rules: V should respond only when directly addressed, assigned, already owner of the task, or a real milestone/blocker/deliverable requires intervention.
2. Do not infer stage from a single ambiguous emoji or casual comment.
3. If customer materials arrive in multiple messages, acknowledge receipt and ask whether materials and requirements are complete before starting production.
4. If the human signal conflicts with tool/task status, trust the safer state and ask/verify before customer-visible notification.

### B. Task/card completion triggers

Use task-card or runner state as evidence when available:

- PlanMode submitted → `planning` complete, candidate transition to `production` if real materials exist and user confirmed.
- Makaron production card created → `production` started.
- Makaron project/video/file generated → candidate transition to `review`, not direct delivery until QC passes.
- QC passed + asset/link available → `delivery`.
- Customer clicks or says “确认交付” / positive acceptance → candidate `retrospective` and customer profile update.
- Reroll/revision requested → `iteration`.
- Runner timeout, project mismatch, missing asset, permissions, quota → `blocked`, but first check actual project/run status before announcing failure.

### C. Feishu table / Base / project-management triggers

When connected to a table or Base, map columns explicitly. Common fields:

- 客户 / 项目 / 群聊 / owner / service owner;
- 服务阶段 / 任务状态 / 下一步 / 截止时间;
- 方案策划状态;
- 样片或首轮交付状态;
- 交付物链接;
- 客户反馈;
- 是否已通知 / 上次通知阶段 / 上次通知时间 / 通知渠道.

Only send customer-visible notifications for mapped, confirmed fields. If schema is unknown, read the table header or ask the owner for field mapping first.

### D. Human override

Human instructions override automation when safe:

- “先别通知客户” → record internally, do not send.
- “只发内部群” → send only internal/CSM/task room.
- “帮我同步客户群” → prepare customer-safe notification and send only to the specified group.
- “这次不要卡片，发一句话” → send concise text unless a long-running task needs a card.

## Notification channels

Choose the least noisy channel that satisfies visibility.

| Channel | Use when | Notes |
|---|---|---|
| Feishu group text | Simple stage transition, low risk, short update | Default for customer-visible one-shot updates. |
| Feishu interactive card / task card | Long-running production, multiple milestones, files/links/buttons | Prefer one card updated in place instead of many text bubbles. |
| Task room / 分流群 | Complex production or internal coordination | Keep main customer group light; summarize only major milestones back to main group. |
| DM to owner / sales / CSM | Clarification, permission, sensitive blocker, internal assignment | Do not expose internal uncertainty directly to customer unless needed. |
| Feishu doc/table update | Durable status, project management, customer handoff | Link in message only after permissions are verified. |

## Default notification templates

Use warm, professional, concise wording. Replace placeholders. Remove any line that is not true.

### 1. Intake / material received

Customer-visible:

```text
收到，我们先把这次需求和素材归到「{项目/客户}」任务里。
我会先确认素材是否齐全，再进入策划/制作，避免中途返工。

目前我已收到：{素材/需求摘要}
还需要确认：{缺口，如无则写“暂无，若还有补充可以继续发”}
```

If multiple assets are still coming:

```text
收到这批素材了。为避免我抢跑漏掉后续内容，想确认一下：素材和具体要求都已经发齐了吗？
确认发齐后我再开始整理方案/制作。 
```

### 2. Planning started

```text
这单我先进入「策划」阶段：会把客户目标、素材可用性、目标市场/语言和可执行镜头先梳理清楚。
输出会尽量落到可制作的 brief / 选题 / 素材清单，不只停留在方向描述。

预计下一步：{下一步}
需要客户确认：{需要确认项或“暂不需要”}
```

### 3. Planning complete → production ready

```text
策划方向已整理完成，可以进入「制作」阶段。

本轮制作重点：{核心方向/卖点/视频数量/文档范围}
会特别检查：{语言/品牌名/素材文字/客户禁区/QC重点}
接下来我会用任务卡同步制作进度，完成后先做 QC 再交付。
```

### 4. Production started

```text
已进入「制作」阶段，任务卡已开始跟进。
当前在处理：{制作内容}

我会在关键节点更新：素材检查 → 生成/制作 → QC → 交付。
中间不会把内部生成日志刷到群里；有需要客户补充的地方我会单独说明。
```

### 5. Review / QC

```text
初稿/结果已出来，正在做交付前 QC。
我会重点检查：{语言、品牌名、产品外观、字幕/文字、链接权限、是否符合平台/客户目标}。
QC 通过后再发正式交付物，避免把半成品直接给客户。
```

### 6. Delivery

```text
已完成本轮交付：{交付物名称/数量}

交付链接/文件：{链接或附件说明}
建议下一步：{发布建议/客户确认/内部归档/继续修改}
如果客户这边有需要调整的点，可以直接按「画面/文案/节奏/语言/产品细节」反馈，我会按项整理进入迭代。
```

### 7. Iteration / revision

```text
收到反馈，我已把本轮修改点整理为：
1. {修改点1}
2. {修改点2}
3. {修改点3}

接下来进入「迭代」阶段。会优先保留已确认有效的部分，只调整上述范围，避免越改越偏。
预计下一步：{下一步/时间/需要补充项}
```

### 8. Retrospective / profile update

Customer-safe:

```text
这单已完成一轮复盘：本次有效的方向是「{有效方向}」，需要避免的是「{风险/教训}」。
我会把已确认的客户偏好、交付链接和后续建议沉淀到项目记录里，方便下次服务直接复用。
```

Internal / owner-facing:

```text
阶段复盘已完成：
- 客户/项目：{客户}
- 本轮交付：{交付物}
- 客户反馈：{反馈}
- 可复用经验：{经验}
- 待补信息：{缺口}
- 建议更新：客户档案 / 案例库 / 作品展示 / Skill 候选 / 暂不升级
```

### 9. Blocked

```text
这一步暂时卡住了，我不想在信息不完整的情况下继续推进，避免返工。

当前阻塞：{具体阻塞}
需要补充/确认：{一个或多个明确动作}
收到后我会继续推进到「{下一阶段}」。
```

## Anti-spam and cooldown rules

1. **Stage-change only**: Send a customer-visible update only when stage changes, blocker appears, deliverable is ready, or human asks for sync.
2. **One active card**: For long-running production, prefer one task card/service card updated in place. Do not send separate text for every internal sub-step.
3. **Cooldown**: Do not send repeated stage updates to the same chat for the same project/stage within 30 minutes unless:
   - customer asked for status;
   - blocker/deliverable changed;
   - correction is needed because a previous update was wrong.
4. **Main group light, task room detailed**: In main customer groups, send only intake, production start if useful, delivery, major blocker, and final recap. Keep detailed execution in task room/分流群.
5. **No duplicate notifications**: Before sending, check last known stage + last notification time if available. If already notified, update the card/table instead.
6. **No internal chatter**: Never expose run IDs, tool names, cost, stack traces, API tokens, project internals, or partial progress text.
7. **Quiet hours / business sensitivity**: If a group has quiet-hour or sales-control expectations, send to owner/CSM first unless the user explicitly requests customer sync.
8. **Correction rule**: If a notification was inaccurate, send one concise correction and explain the actual state without blaming tools.

Suggested notification state fields:

```yaml
project_id: "..."
customer: "..."
chat_id: "..."
stage: "planning|production|review|delivery|iteration|retrospective|blocked"
last_notified_stage: "..."
last_notified_at: "Asia/Shanghai timestamp"
last_channel: "group|card|dm|task_room|doc"
owner: "..."
next_action: "..."
needs_customer_action: true/false
cooldown_until: "..."
```

## Cross-group adaptation

### Xiaolongxia / Makaron service groups

- Keep the main group lightweight.
- Complex production should go to 分流群 / task room with task card.
- Customer-visible messages should emphasize material confirmation, production progress, QC, delivery links, and feedback.
- Use the existing Makaron skill for actual image/video production; this skill only governs stage notifications.

### Xingqing product / product-owner groups

- Use more structured status: requirement, owner, stage, blocker, next step, ETA.
- Prefer Feishu doc/table links after permission check.
- Good for 康浩源 / product owner alignment and PRD/service-card automation.

### MIO / CSM / sales groups

- Keep customer-facing claims conservative.
- Sales owns relationship, price, promise, and commercial commitment; V supports professional explanation,方案判断,商机卡,拜访建议.
- Sensitive blockers or data issues should go to owner/DM first, not broad customer group.

### New customer group

Before first notification, infer or ask for:

- customer name and company;
- service package / expected stage names;
- owner / sales / CSM;
- customer-visible vs internal groups;
- whether task cards are acceptable;
- language and market defaults;
- what must never be said in customer-visible messages.

Do not copy another customer's defaults, language, delivery count, or style without confirmation.

## Standard workflow

### Step 0 — Confirm context

Identify:

- customer / project;
- current chat and intended audience;
- prior stage if known;
- evidence for stage change;
- owner / next action;
- whether the notification is customer-visible or internal.

If any of audience, stage, or evidence is unclear, ask the minimum clarifying question or send owner/DM instead of customer group.

### Step 1 — Determine stage

Use the canonical stage table and evidence hierarchy:

1. explicit human instruction;
2. verified table/card/task state;
3. generated asset/doc/link availability;
4. customer feedback;
5. V inference from context.

Mark V inference as inference internally; do not present it as confirmed fact.

### Step 2 — Choose channel

- Simple change → group text.
- Long-running work → task card / service card.
- Complex internal execution → task room.
- Sensitive/unclear → DM owner.
- Durable project status → table/doc update + optional group link.

### Step 3 — Draft message

Use the template for the stage, then compress to the situation. Include:

- current stage;
- completed evidence;
- next step;
- owner or customer action;
- ETA only if known.

Do not include:

- internal tools/logs;
- unsupported promises;
- vague “正在处理” without the next step;
- too many emojis or salesy exaggeration.

### Step 4 — Send or update

Before sending:

- Check cooldown / duplicate status if available.
- Check group rules and user permission.
- Verify any link/file permissions.
- If a card exists, update the card instead of sending another message unless the user asked for text.

After sending/update:

- Record last notified stage and timestamp if the project has a table/card/state file.
- For delivery or retrospective stages, check whether customer profile, case library, works showcase, or TODO should be updated.

### Step 5 — Follow-up

- If customer asks questions, answer in the same thread/channel with customer-safe facts.
- If customer gives feedback, transition to `iteration`.
- If customer confirms acceptance, transition to `retrospective` and update durable memory/profile when appropriate.

## Quality checklist

Before customer-visible notification:

- [ ] V is allowed/expected to respond in this group or channel.
- [ ] The stage transition has evidence.
- [ ] The audience is clear: customer / internal / owner / task room.
- [ ] Message states current stage, completed item, next step, and needed action.
- [ ] No internal run IDs, tool logs, costs, token names, debug text, or sensitive data.
- [ ] Links/files are accessible to the intended audience.
- [ ] Not a duplicate within cooldown.
- [ ] If long-running, uses card/task-room instead of message spam.
- [ ] Customer-specific defaults are not copied across groups.
- [ ] If blocked, asks for specific unblock item instead of vague apology.

## Failure modes and fixes

| Failure | Fix |
|---|---|
| V speaks in group without being addressed | Apply Group Chat Rules; stay silent unless owner/milestone/blocker/deliverable requires it. |
| Repeated “progress” spam | Consolidate into one card; send only stage changes or blockers. |
| Stage inferred incorrectly | Verify table/card/project state or ask owner before notifying. |
| Customer sees internal debug | Send correction, remove internal details from future template, record lesson. |
| Delivery link inaccessible | Verify permissions before sending; if failed, send corrected link once. |
| Production claimed complete before QC | Insert `review` stage; deliver only after QC. |
| Blocker hidden too long | Notify owner/customer with exact unblock item once it materially delays the service. |
| Another customer’s defaults copied | Re-scope defaults to current customer and ask language/market/style confirmation. |
| Task card lags behind actual project | Check project/run status and update card before customer asks if possible. |

## Related context

- `memory/projects/xingqing/main.md` — 星擎 product context; service-stage automation candidate; 1.3 service progress automation direction.
- `memory/projects/xingqing/TODO.md` — P2 Skill 化候选.
- `memory/projects/xiaolongxia-output-group/main.md` — group service rules, task card usage, material confirmation, delivery checklist.
- `memory/projects/xiaolongxia-output-group/retrospective-2026-06-26.md` — validated 分流群 + 任务卡 pattern and stage-delivery lessons.
- `memory/projects/ops-staff-allocation.md` — service pressure nodes: 方案策划 and 样片交付.
- `~/.agents/skills/makaron/SKILL.md` — actual Makaron production workflow; this skill should not duplicate or bypass it.
