---
name: "xingqing-ops-allocation-workload"
description: "星擎运营分配/负载判断：负载指标、阈值、分流决策与升级规则"
---

# 星擎运营分配 / 负载判断 Skill

## When to use

Use this skill when V needs to decide whether a 星擎 / V for 米奥 / 小龙虾 service task should be handled autonomously, assigned to a human operator, rerouted to another operator, or escalated to 管理员 / 康浩源 / 运营负责人.

Typical triggers:

1. 有新客户、新项目、新任务卡、新素材批次或新出片/画像/热品洞察需求，需要推荐 owner。
2. 用户问“这个客户/任务该分给谁”“谁现在有空”“运营是不是扛不住了”。
3. 已分配任务长时间无进展、无回复、排队过多、关键节点临近，需要判断是否催办、换人、拆任务或 V 自主处理。
4. 项目处于高压节点：方案策划未完成、样片未交付、调研表/11 问未闭环、客户反馈等待处理、展会/拜访/交付临近。
5. 星擎服务阶段自动化、客户画像、热品洞察、作品展示、CRM/数据圈选产生了新的执行动作，需要进入运营调度。

Do **not** use this skill to override explicit human decisions, promise customer-facing delivery times without owner confirmation, expose private workload details to customers, or auto-reassign people in external systems without permission.

## Core outcome

The output should be a routing recommendation with evidence:

- 当前任务应该由 V 自动处理、交给指定运营、拆分后多人协作、进入等待队列，还是升级给负责人；
- 判断依据：阶段压力、近期任务量、响应延迟、队列深度、截止时间、技能匹配、客户风险；
- 下一步动作：owner、输入、输出、截止/检查时间、升级条件；
- 不推荐的人和原因：高压节点未过、短周期项目堆叠、响应延迟、队列过深、技能不匹配等。

## Source context and integrations

Read relevant context before making a recommendation:

1. `memory/projects/xingqing/main.md` — 星擎定位、群入口、skill 候选、工作规则。
2. `memory/projects/xingqing/TODO.md` — 当前项目待办与已有 skill proposal 状态。
3. `memory/projects/ops-staff-allocation.md` — 小明讨论沉淀的人员分配判断规则。
4. `memory/projects/xingqing/customers/*.md` — 客户阶段、交付历史、素材缺口、反馈。
5. `memory/projects/xingqing/mio-product-knowledge.md` — 星擎 / 米奥销售阶段、调研表、商机分层、S1/S2 边界。
6. Feishu/Lark task rooms, service cards, CRM/Zoho, 米奥数据圈选平台, Feishu Base/Bitable when available and relevant.

Related skills:

- `xingqing-ai-customer-profile-report`: supplies customer stage, priority, risks, and next actions.
- `xingqing-hot-product-insights`: supplies hot-product task workload and入库/报告 tasks.
- `makaron` / task-card workflows: supplies generation state, blockers, delivery and feedback loops.
- Future `服务阶段自动化通知` skill: should call this skill before alerting or rerouting.

## Workload indicators

Assess workload across four dimensions. Do not rely on project count alone.

### 1. Recent task volume

Look at the operator's active work in the relevant window:

- Last 24 hours: urgent actions, customer messages, same-day deliveries, firefighting.
- Last 3 days: new customers assigned, unclosed task cards, pending方案/样片/交付/反馈.
- Last 7 days: total active projects, repeated delays, backlog trend.

Weighted task units:

| Task state | Weight | Why |
|---|---:|---|
| New customer assigned but not started | 3 | Context building + first response pressure |
| 方案策划未完成 | 5 | Highest-pressure stage |
| 样片未交付 | 4 | Second-highest-pressure stage |
| 客户反馈/改片待处理 | 3 | Customer-facing SLA and sentiment risk |
| 热品洞察 heavy analysis /入库 | 3 | Research + evidence + validation cost |
| 客户画像 / 商机卡 first draft | 2 | Analytical but often V-assisted |
| 已完成方案 + 样片的平稳期项目 | 1 | Long-tail follow-up, lower pressure |
| Blocked waiting for customer/material/permission | 1–2 | Lower execution load but needs monitoring |

### 2. Response latency

Track how quickly the operator or task owner responds or updates status:

| Signal | Severity |
|---|---|
| No acknowledgement within 2 business hours for urgent/customer-facing task | Yellow |
| No update within 4 business hours after clear assignment | Yellow |
| No update by agreed checkpoint | Yellow/Red depending on deadline |
| No update for 1 business day on active high-pressure node | Red |
| Repeated “马上/尽快” without concrete owner/time/output | Red |

Business hours should follow the current team norm if known. If unknown, mark timing assumption explicitly.

### 3. Queue depth

Count active unclosed items by pressure class:

- High pressure: 方案未完成, 样片未交付, same-day customer delivery, public demo/sales meeting due within 48h.
- Medium pressure: feedback/revision, data/report task due this week,入库待确认, customer profile /商机卡.
- Low pressure: follow-up, archive, case-library update, blocked items, long-tail monthly review.

Queue depth bands per operator:

| Band | Suggested definition |
|---|---|
| Green | 0–1 high-pressure items and total weighted load < 8 |
| Yellow | 2 high-pressure items or weighted load 8–14 |
| Red | 3+ high-pressure items, weighted load 15+, or any overdue critical task |
| Black / overload | Red + customer-facing deadline within 24h, repeated misses, or no owner clarity |

### 4. Stage and cycle pressure

Apply the 星擎 / 小龙虾 stage rules:

1. 方案策划未完成 = highest pressure.
2. 样片未交付 = second-highest pressure.
3. PRO 3-month projects are intense early; do not underestimate them because duration is short.
4. MAX 1-year projects are not “heavy all year”; pressure concentrates in the first 3 months and around review/delivery milestones.
5. 已完成方案 + 样片的 older projects usually count as lower-pressure unless customer sentiment, data performance, or renewal risk is active.

## Thresholds and recommended action

### Task-level thresholds

| Condition | Recommended action |
|---|---|
| V can finish safely with existing context in <30 min, no external promise/write needed | V handles autonomously; report result to owner if needed |
| V can draft but human judgment is required for price, package, promise, or relationship | V prepares draft + asks human owner to confirm |
| New high-pressure customer task and assigned operator is Yellow | Assign with explicit checkpoint, or V pre-processes inputs to reduce load |
| New high-pressure customer task and assigned operator is Red | Recommend alternate operator or split task; notify responsible lead |
| Operator is Black / overload | Do not add new high-pressure work; escalate and propose reroute/scope cut |
| No response past checkpoint on urgent task | Send concise status nudge; if repeated, escalate to lead |
| Critical deadline within 24h and owner unclear | Escalate immediately with proposed owner/action/time |
| Data missing makes routing unreliable | Mark `[blocked]`, list missing source, propose temporary low-risk action |

### Operator-level reroute thresholds

Recommend rerouting when **any two** of the following are true:

- 2+ high-pressure tasks already active.
- Weighted load >= 12.
- Current task has customer-facing deadline within 48h.
- Response latency is Yellow twice in the last 3 business days.
- The task requires a skill the current operator does not own.
- Existing customer sentiment or sales urgency is high.

Escalate rather than quietly rerouting when:

- Current owner has been explicitly assigned by 管理员 / 康浩源 / 运营负责人.
- Customer-facing promise, pricing, contract, refund, legal claim, or sensitive evidence is involved.
- Reassignment would affect external visibility, deadlines, or human accountability.

## Decision tree

### Step 1 — Classify the task

Ask:

1. Is it customer-facing, internal, or product/backlog work?
2. What stage is it in: pre-intake,调研/画像,方案策划,样片,出片/热品/入库,交付,反馈,复盘,案例化?
3. Is there a hard deadline? Within 24h / 48h / this week / none?
4. What output is required: message, report, table, video, card, owner decision, escalation?

### Step 2 — Decide V-auto vs human handoff

V may handle autonomously when all are true:

- The task is internal or low-risk customer support.
- Required facts are available.
- No pricing, contract, promise, permission, external publication, or human relationship judgment is needed.
- V can produce a draft/report/table/card/update and verify it.

Human handoff is required when any are true:

- Price/package/discount/payment/refund/contract involved.
- Customer-facing commitment or public delivery date involved.
- Sales relationship, complaint, escalation, or political stakeholder risk involved.
- Sensitive evidence, watermarks, service screenshots, customer names, or confidential CRM data involved.
- V lacks access to the needed system or material.

Hybrid action is preferred when V can reduce load:

- V drafts customer profile, hot-product report,方案 skeleton,素材清单, task card, status summary, or next-question list;
- Human owner only confirms judgment, wording, business promise, or final send.

### Step 3 — Select operator or route

Rank candidates by:

1. Stage-fit and skill-fit.
2. Current high-pressure count.
3. Weighted load.
4. Response latency and recent reliability.
5. Customer continuity: existing relationship/context.
6. Deadline proximity and coverage.

Recommendation should include:

- Recommended owner.
- Backup owner or V-support action.
- Not recommended owner(s) and reasons.
- Checkpoint time.
- Escalation condition.

### Step 4 — Recommend action

Use one of these action labels:

- `V_AUTO`: V handles now.
- `V_DRAFT_HUMAN_CONFIRM`: V drafts; human confirms.
- `ASSIGN_GREEN`: assign to operator with normal checkpoint.
- `ASSIGN_WITH_SUPPORT`: assign but V pre-processes or splits work.
- `REROUTE`: recommend another operator due to overload/risk.
- `SPLIT_TASK`: separate research/production/QC/customer comms across owners.
- `QUEUE`: wait because blocked or low priority.
- `ESCALATE`: ask 管理员/康浩源/运营负责人 to decide.

## Output template

```markdown
# 运营分配/负载判断 — {任务/客户}

## 1. 一句话结论
- 建议动作：V_AUTO / V_DRAFT_HUMAN_CONFIRM / ASSIGN_GREEN / ASSIGN_WITH_SUPPORT / REROUTE / SPLIT_TASK / QUEUE / ESCALATE
- 推荐 owner：...
- 检查时间：...

## 2. 任务判断
- 客户/项目：...
- 阶段：方案策划 / 样片 / 出片 / 热品洞察 / 画像 / 交付 / 反馈 / 复盘 / 其他
- 截止时间：...
- 风险等级：低 / 中 / 高

## 3. 负载证据
| 候选人 | 高压任务数 | 加权负载 | 响应延迟 | 队列状态 | 备注 |
|---|---:|---:|---|---|---|
| ... | ... | ... | Green/Yellow/Red | ... | ... |

## 4. 推荐理由
- 推荐：...
- 不推荐：...
- V 可先做：...

## 5. 下一步
1. Owner：...；动作：...；输入：...；输出：...；截止/检查：...
2. 若到 ... 仍无进展：升级给 ... / 改派 ... / V 继续处理 ...

## 6. 不确定项
- ...
```

Short response format:

```markdown
建议：{action} → {owner}
理由：{top 2 evidence}
V 先做：{pre-processing if any}
检查点：{time}
升级条件：{condition}
```

## Integration with xingqing workflows

### Customer profile workflow

When `xingqing-ai-customer-profile-report` produces A/B/C priority, service stage, risks, or next actions:

1. Use those fields as workload inputs.
2. If priority is A and current owner is Yellow/Red, consider V pre-draft + human confirm or reroute.
3. If profile is C/培育 and operators are overloaded, queue or V-only lightweight response is acceptable.

### Hot-product insight workflow

When `xingqing-hot-product-insights` creates search, analysis, report, or入库 work:

- V can run search/table/report drafts if tools and scope are clear.
- 入库 and customer-visible report release require operator/product confirmation unless explicitly delegated.
- Heavy video analysis should not be assigned to an overloaded operator without scope and sample gate.

### Service-stage automation workflow

When table/card/CRM status changes:

1. Classify stage transition.
2. Evaluate whether the owner is overloaded.
3. Send only human-readable milestone/blocker/action updates.
4. Avoid noisy reminders; alert only on Yellow/Red/Black conditions or agreed checkpoints.

### Makaron / task card workflow

For image/video production tasks:

- V should handle card creation, material completeness check, status read-back, and failure summary when safe.
- Human owner handles customer expectation, creative approval, pricing/package, and final relationship-sensitive messaging.
- If generation is done but card remains stale, V can verify and update status following the Makaron workflow.

### CRM / 米奥数据圈选 workflow

For sales allocation:

- Use商机评分,客户阶段,预算/决策人/material readiness, S1/S2 responsibility boundary.
- V can generate商机卡,二访提纲,缺口问题; sales owns relationship, price, commitment, and contract path.
- Do not route high-intent A opportunities to an overloaded or contextless owner without explicit lead approval.

## Quality checklist

Before finalizing a routing recommendation:

- [ ] Task stage, deadline, output, and audience are explicit.
- [ ] At least two workload indicators were checked when data exists.
- [ ] Project count was weighted by stage pressure, not counted flatly.
- [ ] Existing customer continuity was considered.
- [ ] V-auto vs human-handoff boundary is clear.
- [ ] Recommendation includes owner, reason, input, output, checkpoint, and escalation condition.
- [ ] Sensitive internal workload details are not sent to customer-visible channels.
- [ ] If data is missing, uncertainty and temporary action are stated.

## Failure modes and fixes

| Failure | Fix |
|---|---|
| Counting all projects equally | Re-weight by方案/样片/feedback/deadline pressure |
| Assigning to familiar operator despite overload | Compare high-pressure count, weighted load, and latency first |
| V oversteps into sales promise | Switch to V_DRAFT_HUMAN_CONFIRM or ESCALATE |
| Silent reroute against explicit human owner | Escalate with evidence instead of changing owner directly |
| Over-notifying humans | Alert only on thresholds, checkpoints, or blocker changes |
| Customer sees internal load details | Rewrite as neutral service timeline and next action |
| No reliable workload data | Mark confidence low and ask for task table/status source |

## Safety and privacy

- Do not expose private operator performance judgments, internal queue details, CRM secrets, customer confidential data, or tool logs to external customers.
- Do not change owners, write CRM/Base/task-room assignments, or notify external channels unless explicitly permitted.
- For customer-facing messages, translate workload concerns into service-safe language: “我们会先整理材料并在 X 前同步下一步”， not “某运营爆了”。
- Escalate pricing, contract, refund, legal claims, public evidence, and relationship-sensitive issues to humans.

## Example

Input: 新客户江门市星澜卫浴 / PRO 正式版，需要分配运营。曹雨凡、郭希儿均有多个方案未完成或样片未交付；吕凡旧项目多数已过方案 + 样片节点。

Output:

```markdown
建议：ASSIGN_GREEN → 吕凡
理由：PRO 短周期前期压力高；吕凡旧项目多已进入平稳期，未过方案/样片节点较少。曹雨凡/郭希儿不推荐，因为当前高压节点更多。
V 先做：整理客户背景、调研表缺口、首轮任务卡草稿。
检查点：分配后 4 个工作小时内确认启动；24 小时内给出方案计划或缺口清单。
升级条件：若检查点无响应，升级给运营负责人重新分配。
```
