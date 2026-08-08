---
name: "xingqing-ai-customer-profile-report"
description: "星擎客户画像报告：多源取数、画像维度、模板与触发规则"
---

# 星擎 AI 客户画像报告 Skill

## When to use

Use this skill when V needs to generate a structured **AI 客户画像报告** for 星擎 / V for 米奥 / 小龙虾服务场景.

Typical triggers:

1. **售前诊断**：销售、运营、管理员、康浩源、国琳或项目 owner 要求分析某个企业是否适合星擎 / 星域 / 星知 / 星声等产品。
2. **方案前准备**：客户已提交 11 问、需求确认表、公司资料、官网、PDF、CRM 记录或数据圈选结果，需要形成方案组可用的客户画像。
3. **服务中更新**：客户出现新产品、新目标市场、新预算、新联系人、新素材、新反馈或新交付数据，需要更新画像并给出下一步服务建议。
4. **客户群/DM 历史挖掘**：需要从飞书/企微/微信群聊、DM、任务分流群、项目文件、客户档案中抽取客户事实和服务历史。
5. **复盘 / 复购 / 分层**：要判断客户是否有复购、扩单、案例化、重点服务或培育价值。
6. **产品化沉淀**：星擎需要把个案转成商机评分、运营分配、热品洞察、作品展示或服务阶段自动化的数据输入。

Do **not** use this skill for casual customer notes, one-off small talk, unsupported guesses, credentials, private unrelated personal details, or customer-facing promises that sales/方案组 has not confirmed.

## Relationship to `makaron-customer-profile`

This skill **does not replace** the pending `makaron-customer-profile` skill.

- `makaron-customer-profile` = durable customer file / enterprise profile storage: facts, service records, links, preferences, follow-up hooks.
- `xingqing-ai-customer-profile-report` = analytical report generation: collect evidence from multiple sources, synthesize a customer portrait, score opportunity fit, and recommend service strategy.

Default handoff:

1. Before writing a report, search/read existing customer profile first if available.
2. After writing a report, update or recommend updating `makaron-customer-profile` storage with stable facts, service records, and links.
3. Do not duplicate entire reports into customer profiles; store report links and durable facts only.

## Core principles

1. **Evidence first**: every factual claim should come from chat history, customer materials, CRM/data API, official website, project memory, delivered docs, or known internal records.
2. **Separate facts from inference**: label `已确认事实`, `V 的推断`, `待确认问题` separately.
3. **Business-action oriented**: the report must guide sales,方案组,运营,出片,复盘,or product decisions; it is not just a biography.
4. **No unsupported budget/performance claims**: budget, package, acceptance, ROI, lead quality, and repurchase signal must be backed by evidence or marked unknown.
5. **Group boundaries and privacy**: never expose internal run IDs, tool logs, credentials, private unrelated personal data, or customer-specific records to external groups unless explicitly asked.
6. **Do not over-generalize 小龙虾 experience**: mark whether a rule is customer-specific, industry-specific, or generally applicable to 星擎.

## Inputs and data collection

### A. Identify the customer and report scope

Capture:

- Customer/company name, aliases, brand names, Chinese/English names.
- Requester and intended audience: internal PM, sales,方案组,运营,customer-facing.
- Report purpose: 售前诊断 / 方案前画像 / 服务中更新 / 复盘 / 复购判断 / 分层分配.
- Product line scope: 星擎 / 星域 / 星知 / 星声 / 星韵 / 星耀 / 星帆 / 小龙虾出片服务.
- Time range: e.g. last 30 days, since first contact, this service cycle.

### B. Source priority

Use the richest available sources in this order:

1. **Existing project/customer memory**
   - `memory/projects/xingqing/main.md`
   - `memory/projects/xingqing/customers/*.md`
   - related 小龙虾 / Makaron / customer project files
   - prior reports, SOPs, and product knowledge docs

2. **Group chat / DM mining**
   - Product/service groups: 产品部、米奥 x Versa、V x 浩源、小龙虾出片群、任务分流群、客户服务群.
   - DM history with 管理员,康浩源,赵维杰,国琳,小明,销售/运营 owner.
   - Extract only business-relevant content: needs, objections, stage changes, decisions, materials, feedback, next actions.
   - If group chat access requires channel-specific skills/tools, follow the relevant Feishu/Lark/IM skill first.

3. **Structured business systems**
   - Zoho CRM: Accounts, Contacts, Deals, Sales Orders, stage, owner, amount, close probability, activity history.
   - 米奥数据圈选平台: company basics, trade/export trends, exhibitions, product tags,工商信息,会刊/展会 records.
   - Feishu Base/Bitable: service stage, task status, content plan, hot-product records, delivery metrics.

4. **Customer-provided materials**
   - VIP 需求确认表 / 11 问 / 调研表.
   - Company profile, PDF, PPT,官网,产品手册,certificates, images/videos.
   - Uploaded media and Makaron project links.

5. **External/public verification**
   - Official website, public social accounts, public trade/show records, public market facts.
   - Browse when facts are current, high-stakes, or not in provided materials.

### C. Data collection checklist

Collect and cite/record source notes for:

- Company basics: legal/company name, brand, website, location, industry/category, product lines.
- Contacts: business-relevant contacts, roles, decision maker, influencer, operator, owner.
- Sales stage: lead/source, visit stage, deal stage, budget, package, decision process, blockers.
- Needs: target markets, languages, platforms, account/video targets, goals, pain points.
- Business strength: factory scale, certifications, export markets, cases, production capacity, MOQ, delivery time.
- Online assets: website, TikTok/社媒账号, existing content, published videos, account matrix, website readiness.
- Materials: received files, photos/videos, product info, cases, certs, missing assets, shoot constraints.
- History: all delivered docs/videos/reports, revisions, customer/管理员/运营 feedback, unresolved issues.
- Budget signals: confirmed budget, package level, payment preferences, discount pressure, authority/decision signal.
- Repurchase/upsell signals: new materials, repeated requests, explicit satisfaction, new product lines, service continuation.
- Risks: missing decision maker, no budget, no materials, overclaim risk, privacy/confidentiality, language/company-name risk.

## Profile dimensions

The report should cover these dimensions. Unknown fields stay `待确认`.

### 1. 企业与业务画像

- Company identity and aliases.
- Industry/category and subcategory.
- Main products and priority SKUs.
- Factory/business capabilities: scale, certifications, OEM/ODM, production/delivery strengths.
- Target markets and buyer types.
- Competitive positioning.

### 2. 联系人与决策链

- Known contacts and roles.
- Decision maker confirmed? yes/no/unknown.
- Internal owner: sales, CSM,运营,方案组,PM.
- Communication style and response pattern.
- Required next contact/action.

### 3. 需求与痛点画像

- Stated goals: exposure, B2B inquiries, brand building, exhibition traffic, account asset, GEO, domestic social, etc.
- Buyer pain points and FAQ.
- Customer-side pain points: lack of content, no overseas marketing team, no materials, uncertain market, price pressure, low trust.
- Target buyer persona: distributor, wholesaler, project contractor, importer, end consumer, trade company, hotel owner, etc.

### 4. 素材与内容资产画像

- Received materials and quality.
- Shootable scenes: factory, showroom, product tests, packaging, exhibition booth, customer cases, team.
- Missing assets and required follow-up.
- Content formulas already validated.
- Makaron/AI generation constraints and QC risks.

### 5. 历史互动与服务阶段

- Timeline of key interactions.
- Delivered reports/docs/videos and links.
- Feedback and revision history.
- Current stage: 线索 / 初访 / 调研表 / 方案中 / 报价 / 合同 / 服务中 / 交付后 / 复购 / 暂停.
- Blockers and next milestone.

### 6. 预算与成交信号

- Confirmed budget/package/payment info.
- If unknown: infer only as `预算信号` with evidence, not as fact.
- Sales readiness: decision maker, filled survey, target market, material readiness, urgency, existing export team.
- Package fit: Pro/Max/星域/星知/星声/etc.

### 7. 星擎适配与服务策略

- Product fit: 星擎 / 星域 / 星知 / 星声 / 星韵 / 星耀 / 小龙虾出片.
- Recommended service path: first visit, second visit, planning doc, hot-product insight, sample video, account matrix, campaign, review.
- Content direction: themes, hooks, target markets, language, platform, CTA.
- Operational priority: A/B/C, key account, standard, nurture, not-fit.

### 8. 风险与待确认问题

- Missing decision maker/budget/materials/market.
- Unsupported claims/certifications/company name conflicts.
- Privacy/confidentiality and customer-facing wording risks.
- Data quality issues: old CRM stage, incomplete chat history, contradictory materials.
- Concrete questions to ask next.

## Report template

Use this Markdown template by default. For customer-facing reports, remove internal source notes, internal confidence scores, and sensitive fields.

```markdown
# {客户名}｜AI 客户画像报告

_Generated: YYYY-MM-DD_
_Report purpose: 售前诊断 / 方案前画像 / 服务中更新 / 复盘 / 复购判断_
_Audience: 内部 / 销售 / 方案组 / 运营 / 客户可读_
_Source window: ..._
_Confidence: 高 / 中 / 低（原因）_

## 0. 一页结论

- 客户定位：...
- 当前阶段：...
- 最强机会点：...
- 最大阻塞：...
- 推荐动作：...
- 建议优先级：A / B / C / 培育 / 暂不推进

## 1. 已确认客户事实

| 维度 | 内容 | 来源 |
|---|---|---|
| 企业名称 | ... | ... |
| 品类/行业 | ... | ... |
| 目标市场 | ... | ... |
| 联系人/角色 | ... | ... |
| 当前服务/销售阶段 | ... | ... |
| 已交付物 | ... | ... |

## 2. 企业与产品画像

- 主营产品：...
- 核心卖点：...
- 买家类型：...
- 出海/市场基础：...
- 可公开背书：...
- 待确认背书：...

## 3. 需求与痛点画像

- 明确需求：...
- 隐含需求 / V 的推断：...
- 目标买家关心的问题：...
- 客户当前短板：...

## 4. 素材与内容资产

- 已收素材：...
- 可拍/可用场景：...
- 素材缺口：...
- 内容机会：...
- 禁区/QC 风险：...

## 5. 历史互动与服务记录

| 日期 | 事件/交付 | 反馈/状态 | 链接 |
|---|---|---|---|
| ... | ... | ... | ... |

## 6. 预算、成交与复购信号

- 已确认预算/套餐：...
- 预算信号：...
- 决策链：...
- 成交正向信号：...
- 成交风险：...
- 复购/扩单信号：...

## 7. 星擎适配判断

| 项目 | 判断 | 理由 |
|---|---|---|
| 星擎适配度 | 高/中/低 | ... |
| 星域/高定潜力 | 高/中/低 | ... |
| 星知/GEO 适配 | 高/中/低 | ... |
| 星声/国内社媒适配 | 高/中/低 | ... |
| 小龙虾出片/样片适配 | 高/中/低 | ... |

## 8. 推荐服务路径

### 下一步 1：...
- Owner：...
- 输入：...
- 输出：...
- 截止/检查时间：...

### 下一步 2：...

## 9. 报告可转化资产

- 可进入客户档案的稳定事实：...
- 可进入商机卡/CRM 的字段：...
- 可进入热品洞察/内容 brief 的信息：...
- 可进入案例库的候选素材：...

## 10. 待确认问题

1. ...
2. ...
3. ...
```

## Opportunity scoring guide

Use scores to support, not replace, human judgment. If evidence is missing, mark unknown and reduce confidence.

Suggested 100-point internal score:

| Dimension | Points | Signals |
|---|---:|---|
| 产品/市场清晰度 | 15 | clear product line, target market, language, buyer type |
| 外贸/增长需求强度 | 15 | export need, new market push, inquiry/brand pressure |
| 决策链与预算 | 20 | decision maker, budget range, package interest, payment readiness |
| 素材与内容基础 | 15 | usable photos/videos, shootable scenes, public cases, website/social assets |
| 星擎产品适配 | 15 | TikTok matrix fit, B2B natural-flow fit, account/content goals |
| 数据/CRM/历史信号 | 10 | CRM stage, trade/export/exhibition data, prior interactions |
| 服务延展/复购潜力 | 10 | repeated needs, multi-product/multi-market, existing satisfaction |

Bands:

- 85–100: A 级强商机 / key account candidate.
- 70–84: B 级有效商机 / standard follow-up.
- 55–69: C 级观察池 / information completion first.
- <55: 培育或暂不推进.

Always include `评分依据` and `降分原因`.

## Procedure

1. **Confirm scope**
   - Identify customer, audience, purpose, timeframe, and whether output is internal or customer-facing.

2. **Search existing records**
   - Search/read project memory and customer profile.
   - If a pending/live `makaron-customer-profile` profile exists, use it as the baseline.
   - Check customer aliases to avoid duplicate profiles.

3. **Collect sources**
   - Pull group chat/DM/project files only as needed for the timeframe.
   - Read CRM/data APIs when available and relevant.
   - Read customer materials and prior deliverables.
   - Browse official/current sources when facts may be outdated or high-stakes.

4. **Extract facts into a working table**
   - Columns: dimension, fact, source, date, confidence, contradiction/notes.
   - Separate `confirmed`, `inferred`, `unknown`, `contradictory`.

5. **Analyze and score**
   - Fill profile dimensions.
   - Apply opportunity scoring if useful.
   - Explain key judgment, not just numeric output.

6. **Generate report**
   - Use the report template.
   - For internal reports, include source notes and confidence.
   - For customer-facing reports, simplify language and remove internal operational details.

7. **QC**
   - Verify no unsupported facts, wrong company name, invented budget, leaked credentials, run IDs, or private irrelevant details.
   - Check every recommendation maps to evidence.
   - Check next actions have owner/input/output.

8. **Store/handoff**
   - Save/report in the requested location.
   - Update or recommend updating the customer profile with stable facts and report link.
   - If the report generates CRM/Base fields, write only after schema/permission verification.

## Generation triggers and default actions

| Trigger | Default action |
|---|---|
| New 11 问 / 调研表 received | Generate internal pre-solution profile; list missing info before方案组投入 |
| Sales asks “这个客户适合吗” | Generate short A/B/C fit report with evidence and next questions |
| Customer enters service stage | Generate full profile report + handoff to customer profile storage |
| New materials uploaded | Update素材画像 and recommend content directions |
| Delivery completed | Add service history, feedback, next-step and repurchase signal |
| Quarterly review | Batch summarize served customers; classify复购/新需求/待跟进/暂无信号 |
| CRM/data platform sync completed | Generate combined商机卡 + 客户画像 report |

## Output standards

Short report response:

```markdown
已生成：{客户名} AI 客户画像报告
用途：...
存储/链接：...
判断：A/B/C + 1 sentence reason
下一步：owner + action + input needed
待确认：top 3 unknowns
```

If blocked:

```markdown
[blocked] 无法生成可靠画像：缺少 {source/material/permission}
已确认：...
仍缺：...
建议下一步：...
```

## Failure modes

- Treating inferred budget as confirmed budget.
- Copying raw chat logs instead of synthesizing business dimensions.
- Ignoring existing customer profile and creating duplicate narratives.
- Writing a customer-facing report with internal tool logs, run IDs, costs, or uncertainty notes that should stay internal.
- Overfitting one 小龙虾 customer’s language/style to all 星擎 clients.
- Making a recommendation without owner/input/output.
- Not updating customer profile / CRM / Base handoff after generating a report.

## Safety and privacy

- Never store or reveal credentials, tokens, passwords, API keys, private personal data unrelated to service, or internal debugging identifiers.
- Follow channel/group rules: do not mine or post into external customer groups unless the user explicitly asks and permissions are clear.
- External sharing, Base/Wiki creation, or customer-facing publication can change visibility; ask first when audience/permission is unclear.
- For legal/financial claims, public performance metrics, price, refund/payment terms, and product guarantees, use only confirmed sources and quote carefully.
