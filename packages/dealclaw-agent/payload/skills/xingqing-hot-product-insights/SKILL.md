---
name: "xingqing-hot-product-insights"
description: "星擎热品洞察：从群聊、社媒、竞品与客户输入生成可入库洞察报告"
---

# Xingqing Hot Product Insights Skill（星擎热品洞察）

## When to use

Use this skill when V needs to analyze trending / hot products, viral product videos, competitive references, or product-market opportunities for 星擎 / 米奥 / 小龙虾 / B2B TikTok service work.

Trigger examples:

1. 客户或运营说：查某个产品 / 品类 / 市场的热门视频、爆品、热品、竞品、TikTok 优质内容、可复刻内容公式。
2. 群聊里出现连续的客户需求、素材、参考账号、竞品链接，需要提炼「热品洞察」而不是只做单条视频分析。
3. 产品 / 运营需要把小龙虾经验转成星擎热品洞察页、飞书多维表、客户策划案、需求池或入库数据。
4. 销售 / V for 米奥需要根据海外目标市场热销品，反推目标客户画像、数据圈选条件、销售切入点或二访方案。
5. 已有一批候选视频 / 表格记录，需要做 vision + ASR、可复刻 brief、结构化报告和入库前 QC。

Do **not** use this skill for:

- 单纯出片、改片、剪辑、字幕、素材压缩，不需要热品/竞品洞察的任务；
- 仅下载音乐 / 视频素材但不分析产品趋势；
- 未经用户 / 运营确认就自动入库；
- 把小龙虾单一客户经验无条件泛化到所有星擎客户。

## Core outcome

A good hot product insight is not a list of links. It must convert market evidence into a customer-executable report:

- 哪些产品 / 场景 / 卖点正在获得注意；
- 为什么这些视频或产品表现好；
- 客户可以复刻哪些镜头、钩子、信任点、CTA；
- 星擎 / Makaron / 销售可以下一步怎么用；
- 哪些记录可以进入热品库，哪些需要暂缓或补信息。

## Data sources

### 1. Group chats and service rooms

Typical sources:

- 星擎 / 米奥 / 小龙虾主群与分流群中的客户需求、素材、参考视频、运营反馈；
- task room / 任务卡中的项目链接、状态、交付反馈、客户修改意见；
- 客户连续发送的图片、视频、需求表、官网、PDF、展会现场素材；
- 销售 / 运营在群里提到的目标市场、目标买家、产品痛点、复购信号。

Rules:

- In group chats, respond only when V is clearly addressed, assigned, or already owns the task.
- For IM multi-material input, first acknowledge receipt and confirm whether all materials and requirements are complete before starting heavy analysis.
- Separate confirmed customer facts from V/team inference.
- Do not expose internal run IDs, tool logs, token names, costs, or debugging details in customer-visible outputs.

### 2. Web and social listening

Primary platforms:

- TikTok: B2B / B2C product videos, viral references, account benchmarks.
- Xiaohongshu / Douyin / Instagram Reels / YouTube Shorts: only when requested or relevant to market/channel.
- Google / official sites / competitor websites: for company/product validation, current specs, claims, or official references.
- Google Trends / search trend tools: for trend direction when requested.

Preferred collection pattern:

1. Expand keywords across product name, use case, local language, buyer wording, and market-specific terms.
2. Run metadata search first; do not download everything blindly.
3. Deduplicate links and creators.
4. Rank by relevance, engagement, target-market fit, and repeatable value.
5. Download / analyze only selected candidates after the sample is reasonable.

### 3. Direct user input

Inputs may include:

- 产品词、SKU、目标市场、平台、语种；
- 客户官网 / catalog / PDF / 产品图 / 展会素材；
- 竞品账号或视频链接；
- 已有飞书表格 / Base / 星擎热品记录；
- 目标用途：客户策划案、售前方案、热品库入库、出片 brief、销售圈选、二访方案。

If key inputs are missing, ask only the minimum needed:

1. 产品 / 品类是什么？
2. 目标市场和平台是什么？
3. 这次输出用于客户报告、出片 brief、入库，还是销售策略？
4. 期望样本量：先看 10 / 30 / 50 条？
5. 是否已有参考账号、竞品或必须排除的内容？

## Standard workflow

### Step 0 — Intake and scope

Create a batch context before collecting data:

- 批次 ID / 日期 / owner；
- 客户或项目；
- 产品 / 品类 / 关键词；
- 目标市场 / 语言 / 平台；
- 用途：报告、表格、入库、brief、销售策略；
- 样本量目标与筛选口径；
- 风险：数据缺失、语言不确定、claim 风险、版权/品牌风险。

Quality gate:

- Do not assume target market or language if the customer did not provide it.
- Do not start costly video analysis until scope and first sample are clear.

### Step 1 — Search and candidate table

Collect candidate records into a structured table or report section.

Minimum fields:

| Field | Requirement |
|---|---|
| 批次 ID | Same for one search batch. |
| 客户 / 项目 | Internal or customer-facing name. |
| 产品 / 品类 | Required. |
| 目标市场 | Required if known. |
| 平台 | TikTok / XHS / Douyin / etc. |
| 搜索关键词 | Original keyword, including language. |
| 视频链接 / 来源链接 | Required for traceability. |
| 作者 / 账号 | If available. |
| 标题 / Caption | Preserve original language. |
| 发布时间 | If available. |
| 播放 / 点赞 / 评论 / 分享 / 收藏 | If available; never invent. |
| 语言 | Caption / subtitle / ASR / inference. |
| 初筛标签 | 相关 / 疑似相关 / 不相关 / 待判断. |
| 是否保留 | User / operator decision. |
| 备注 | Download failures, access issues, duplication, risk. |

Quality gate:

- Every candidate must trace back to a source link.
- Missing metrics stay blank with note; do not fabricate.
- User / operator must be able to delete, mark, or reject candidates before heavy analysis.

### Step 2 — Video understanding and evidence extraction

Analyze only retained candidates.

For each video, extract:

- 一句话定位：why this video matters;
- 前 2 秒钩子：visual/text/sound hook;
- 内容结构：opening / middle / ending;
- 产品卖点：only what is visible, said, or supported by provided facts;
- 目标受众：采购商 / 经销商 / 工程商 / 工厂客户 / 终端消费者;
- 画面信息密度：high / medium / low with evidence;
- 剪辑节奏：卡点、快切、慢推、ASMR、口播、对比、测试等;
- B2B 信任点：工厂、设备、证书、库存、测试、案例、买家到访、质检;
- 转化点：DM、WhatsApp、catalog、factory direct、limited offer, etc.;
- 为什么数据好：hook + structure + trust + conversion;
- 可复刻镜头：客户可拍 / AI 可生成 / 需补素材;
- 风险 / 禁区：夸大 claim、侵权、错误语言、不可复现画面、品牌误用。

Quality gate:

- Do not write conclusions only from title, cover, or view count.
- If video cannot be downloaded or is unreadable, mark the failure instead of forcing insight.
- For B2B clients, always inspect whether the video forms a trust chain, not just whether it looks good.

### Step 3 — Synthesis methodology

Analyze at three levels:

#### A. Product-market trend

- Which product types, use cases, or pain points repeat?
- Which target buyer is implied?
- Which market language and local buyer wording appear?
- Is demand seasonal, event-driven, exhibition-driven, or evergreen?

#### B. Content formula

Identify recurring formulas such as:

- negative pain hook → product fix → factory proof → CTA;
- comparison / teardown → superior material or process → proof;
- factory tour → capability → inventory → inquiry;
- test demonstration → result close-up → buyer benefit;
- AI imagination shot → real manufacturing proof → product detail;
- low-price / stock / direct factory CTA.

#### C. Execution and business action

Convert insight into actions:

- Customer shoot list: what to film next;
- Makaron / AI generation brief: what can be generated;
- Caption / hashtag / CTA suggestions by target language;
- Sales angle: what buyer pain to discuss;
- Data-circle / CRM angle: what customer type or product tag to search for;
- Star Engine入库 recommendation: 入库 / 暂缓 / 需补信息。

### Step 4 — Structured insights report

Default report format:

```markdown
# 热品洞察报告 — {客户/品类/市场}

## 1. 任务背景
- 客户 / 项目：
- 产品 / 品类：
- 目标市场 / 语言：
- 平台：
- 用途：客户策划案 / 出片 brief / 入库 / 销售策略 / 内部复盘
- 批次 ID / 日期：

## 2. 样本概览
- 搜索关键词：
- 候选数量：
- 保留分析数量：
- 样本筛选口径：
- 数据缺失或偏差：

## 3. 关键结论
1. ...
2. ...
3. ...

## 4. 热门视频 / 竞品拆解
| Rank | Link | Hook | Structure | Trust Point | CTA | Why It Works | Reusable Action | Risk |
|---|---|---|---|---|---|---|---|---|

## 5. 可复刻内容公式
### Formula 1 — {name}
- 适用产品 / 场景：
- 镜头顺序：
- 文案 / 口播方向：
- 需要素材：
- Makaron-ready brief：
- 风险：

## 6. 客户执行建议
- 补拍素材：
- AI 可生成素材：
- 优先出片方向：
- Caption / hashtag / CTA：
- 销售 / 二访切入点：

## 7. 入库建议
- 推荐入库：
- 暂缓入库：
- 需补信息：
- 确认人 / 下一步：

## 8. 风险与不确定项
- ...
```

Minimum output when time is short:

- 样本概览；
- 3–5 条关键结论；
- Top 3 视频拆解；
- 3 条可复刻内容公式；
- 入库/出片/销售下一步。

### Step 5 — Star Engine handoff and入库

Before入库:

- Confirm with user / operator / product owner.
- Ensure required fields are complete: batch ID, product, market, platform, source link, insight summary, reusable formula, recommended shots/materials, risk note, confirmation person/time.
- Map table fields to current 星擎 database fields.

After入库:

- Verify the online Star Engine hot product page or record can display the new item.
- Check core fields and source links are visible and correct.
- Update table/report with入库状态、线上链接、失败原因或重试清单。

Never report入库完成 without a read-back / online visibility check.

## Maintenance cadence

### Per task

- Update the candidate table, insight report, and入库 status.
- If a customer-specific rule emerges, update the customer profile or note it as a candidate update.
- If a workflow failure occurs, record a short lesson or failure mode.

### Weekly / project cadence

For active 星擎 / 小龙虾 / 米奥 service periods:

1. Review recent hot-product tasks and reports.
2. Identify repeated product categories, content formulas, data-source failures, and入库 blockers.
3. Promote stable formulas to customer profiles, Star Engine templates, or skill updates.
4. Keep one summary for product owner / 管理员 / 康浩源: what worked, what failed, what should be productized.

### Monthly / quarterly

- Compare hot-product insights with actual content performance, customer feedback, repurchase, and CRM/sales outcomes.
- Retire stale formulas that no longer perform.
- Update field schema if Star Engine database or reporting format changes.

## Quality checklist

Before calling the report done:

- [ ] Product / market / platform / batch ID are explicit.
- [ ] Candidate links are traceable.
- [ ] Metrics are not fabricated.
- [ ] Only retained videos received heavy analysis.
- [ ] Each analyzed video has hook, structure, selling point, trust point, CTA, reusable action, and risk.
- [ ] Report contains sample overview, top breakdowns, shared patterns, reusable formulas, action plan, and risk section.
- [ ] Insights are executable for content production, sales, or入库.
- [ ] User / operator confirmation exists before入库.
- [ ] 入库 result is verified online/read-back.
- [ ] Customer-specific defaults are scoped to that customer only.

## Failure modes and fixes

| Failure | Fix |
|---|---|
| Search results irrelevant | Expand keywords with product use cases, buyer terms, local-language terms; rerun a small probe. |
| Too many generic viral videos | Add industry, material, buyer, application, and B2B trust filters. |
| Metrics unavailable | Leave blank and note source limitation; do not fabricate. |
| Videos cannot be downloaded | Mark failure; keep source link; try alternate legal/available access if needed. |
| Report says only “looks good” | Rewrite into hook, structure, trust, CTA, reusable action. |
| Sample too small | State sample limitation and avoid strong claims. |
| Customer deletes many records | Respect user screening; analyze only retained candidates or collect a new batch. |
| 入库 fields incomplete | Block入库 and list missing fields. |
| Online page missing after入库 | Check script result, database record, front-end filters/cache; do not report completion until visible. |
| 小龙虾经验被泛化 | Re-scope as customer/market-specific or ask 管理员/product owner before promoting. |

## Safety and privacy

- Never store or expose tokens, credentials, internal tool logs, API errors with secrets, private phone/email unless explicitly business-necessary and permitted.
- Do not publish customer materials, competitor references, or internal reports to broader channels without permission.
- Separate customer facts, public evidence, and V/team inference.
- Be conservative with performance claims; viral metrics do not guarantee customer performance.
- For legal/regulated product claims, mark risk and require customer confirmation.

## Related project context

- `memory/projects/xingqing/main.md` — 星擎 1.2 热品洞察上线记录、产品定位、skill 候选方向。
- `memory/projects/xingqing/TODO.md` — 热品洞察 Skill 草案任务。
- `memory/projects/xingqing/sop/hot-product-insight-sop.md` — 搜索填表 → 视频理解 → 洞察报告 → 入库 SOP。
- `memory/projects/xingqing/customers/junye.md` — 骏业 TK 优质视频复盘，包含 B2B 工业内容公式示例。
- `memory/projects/xingqing/customers/README.md` — 客户档案更新规则。
- `memory/projects/xingqing/mio-product-knowledge.md` — 星擎 / 米奥业务定位和销售动作边界。
