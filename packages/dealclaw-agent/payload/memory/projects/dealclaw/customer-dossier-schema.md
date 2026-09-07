# 客户档案结构（Customer Dossier Schema）

> 定位：跨场景通用的 customer / opportunity / interaction 唯一真相源。定义「一个客户 = 一份档案」的结构化底座 + 阶段/匹配度/优先级规则。
> 状态：2026-09-06 定稿（田耕郡确认，含 9 条修订 + 6 个决策 + schema 拆分落地）。
> 所有权：本文件定义跨场景通用模型；`exhibitions/schema.md` 只定义展会扩展字段 + 展会目录结构，引用本文件的 interaction 定义，不复制一套。

---

## 零、核心原则

1. **公司是「身份」，商机才有「阶段」**。grade / stage / followup_priority 挂在商机（opportunity）上，不挂公司（customer）。同一家公司跨届展会、跨年互不覆盖。
2. **沟通明细 = 唯一真相源**。客户的所有邮件 / WhatsApp / 会议 / 扫码都进 interaction，一行一次真实互动。档案文档是从 interaction 再生成的阅读层，不是真相源。
3. **数组不覆盖**。多联系人、多互动、多商机都是数组。
4. **原始记录 = 证据，提炼字段 = 信号，规则引擎 = 算阶段/优先级**。AI 不能无证据直接改 stage/priority。
5. **允许「证据不足」和「阶段回退」**。退信、否认需求、项目取消，不能永远停在最高级。
6. **「每个客户都有档案」是逻辑承诺，不等于立即建一篇飞书文档**。结构化档案人人有，可读文档按需生成。

---

## 一、三层结构

### ① customer —— 企业主体（长期身份，稳定字段）

```json
{
  "customer_id": "stable_internal_id",
  "company_cdp_id": "",
  "company": "",
  "website": "",
  "country": "",
  "buyer_type": "",
  "contact_policy": "active | paused | do_not_contact",
  "contacts": [
    { "contact_id": "", "name": "", "title": "", "email": "", "phone": "", "whatsapp": "" }
  ]
}
```

- `contacts[]` 是**完整联系人**数组，不覆盖。线索池前台只展示「主要联系人」，完整联系人永远在 customer.contacts[]，避免多联系人被覆盖丢失。
- `contact_policy`：active（正常跟进）/ paused（暂缓）/ do_not_contact（不再联系，如明确拒绝）。「停止触达/暂不跟进」落在这一层，不进优先级、不进商机阶段。

### ② opportunity —— 商机（每届展会 / 每次采购）

```json
{
  "opportunity_id": "",
  "exhibition_id": "",
  "year": "",
  "product_scope": [],
  "match_grade": "A | B | C | 待确认",
  "stage": "待触达 | 已触达 | 已回复 | 需求明确 | 报价中",
  "followup_priority": "优先跟进 | 普通跟进 | 长期培育",
  "priority_reason": "",
  "next_step": { "action": "", "due": "" },
  "opportunity_status": "active | paused | won | lost",
  "last_contact_at": "",
  "reply_count": 0,
  "updated_at": ""
}
```

- `match_grade`（匹配度）= 是不是理想买家，A/B/C/待确认。判定规则见「四、结构化规则」。
- `stage`（商机阶段）= 关系推进到哪里，证据驱动。判定规则见「四、结构化规则」。
- `followup_priority`（跟进优先级）= 现在先跟谁，**只保留三档**：优先跟进 / 普通跟进 / 长期培育。是唯一排序锚，跨场景统一。
- `priority_reason`（优先级理由）= 证据化理由，**每次排序必填**，一句说清为什么。
- `next_step`（下一步）= 具体做什么 + 截止时间。**不建负责人字段**（数据源最多只有联系人和职位）。
- `opportunity_status`：active（进行中）/ paused（暂停）/ won（成交）/ lost（失单）。报价/成交/失单放这里，不塞 stage。

### ③ interaction —— 沟通明细（一行一次真实互动）

```json
{
  "interaction_id": "",
  "customer_id": "",
  "opportunity_id": "",
  "channel": "email | whatsapp | meeting | scan",
  "direction": "outbound | inbound | bidirectional | system",
  "occurred_at": "",
  "subject": "",
  "summary": "",
  "raw_record_ref": "",
  "send_status": "",
  "has_reply": false,
  "thread_id": "",
  "source_record_id": "",
  "signals": [
    { "type": "product_need", "value": "户外桌", "normalized_value": "outdoor table",
      "evidence_text": "原文证据句", "confidence": 0.9,
      "origin": "agent_extracted | user_confirmed | system",
      "extractor_version": "1.0.0", "extracted_at": "2026-09-05T23:00:00Z" }
  ],
  "artifacts": [
    { "artifact_id": "", "kind": "transcript | translation | attachment",
      "source": "慧记 | 慧译 | ...", "content_ref": "", "language": "" }
  ]
}
```

- `channel` 只 4 种：email / whatsapp / meeting / scan。**translation 不是独立渠道**。
- `direction`：outbound（发出）/ inbound（收到）/ bidirectional（双向）/ system（系统动作，如扫码入池）。
- 一个客户所有邮件、WA、会议、扫码通过 `customer_id` 串成时间线，**不再把 N 封邮件塞进一个单元格**。
- `artifacts[]`：慧记 transcript、慧译 translation **不是独立互动、不各自新增一行**，作为 artifacts 挂在对应的 meeting interaction 下。原文仍按 `raw_record_ref` 下钻。**禁止因 artifacts 重复计算会议数和互动次数**（统计只数 interaction 行，不数 artifacts）。
- `signals[]`：从原始记录提取的可重算信号，是阶段判断唯一硬证据来源。契约见「四、结构化规则」。
- `source_record_id` + `thread_id`：来源系统记录 ID + 线程 ID，防重复同步、串时间线。
- 兼容：`source` 枚举里的 `translation` 保留用于来源追踪，但业务统计中**不得**将 translation 视为独立沟通渠道。

---

## 二、线索池前台（主表，一行一客户，案例摘要）

| 字段 | 类型 | 来源 |
|---|---|---|
| 公司 | text | customer.company |
| 主要联系人 | text | customer.contacts 主联系人 name |
| 职位 | text（可空） | 主联系人 title |
| 国家 | text | customer.country |
| 匹配度 | select A/B/C/待确认 | opportunity.match_grade |
| 商机阶段 | select | opportunity.stage |
| 跟进优先级 | select 优先/普通/长期培育 | opportunity.followup_priority |
| 优先级理由 | long text | opportunity.priority_reason |
| 下一步动作 | text | opportunity.next_step.action |
| 截止时间 | datetime | opportunity.next_step.due |
| 最近联系时间 | datetime | opportunity.last_contact_at |
| 买家回复数 | number | 由 interaction 聚合 |
| 跟进档案链接 | url | 档案文档链接 |

- 前台**只重点展示「跟进优先级 + 下一步」**，匹配度和阶段作为 AI 判断依据，不必铺满界面。
- 「冷热」字段退役。

---

## 三、跟进优先级（followup_priority）

- 只三档：**优先跟进 / 普通跟进 / 长期培育**。
- 多因子综合判断，**不写死单一信号**（不定「已回复=优先、待触达=长期培育」）：
  - 正向：匹配度 + 明确需求与采购信号 + 时间紧迫性 + 当前阶段 + 下一步是否到期
  - 负向：拒绝、失效、身份冲突等负面信号
- **必须输出证据化理由**，但内部不必固化成不可调整的单一数值公式（可演进）。
- 示例理由：「本届确认到展，产品高度匹配，明确询价并承诺今日发报价，当前已超期 4 小时」。

---

## 四、结构化规则

### 1. 商机阶段 stage（证据驱动，5 阶段）

原始记录提供证据，提炼字段（signals）提供信号，规则引擎计算阶段。AI 不能无证据改阶段。

| stage | 推进条件（证据） |
|---|---|
| 待触达 | 无任何触达证据 |
| 已触达 | 有名片 / 扫码 / 到展 / 现场接触 / 单向邮件 / 单向 WA 任一 |
| 已回复 | 有效会议、邮件回复、WA 双向沟通 任一 |
| 需求明确 | 确认产品需求 + 数量/用途/预算/交期/规格/项目背景 至少一项 |
| 报价中 | 买家提出报价/样品/合同/付款/交期确认/下一轮谈判 |

- **报价状态、成交、失单、暂停** 放独立字段 `opportunity_status`（active/paused/won/lost），不塞进 stage。
- 只填 next_step 不能单独推动 stage；单向邮件无买家响应不算「已回复」。
- 阶段判断实现见 `work/mio-api/dc_opportunity_stage.py`（纯函数，输入 opportunity+interactions+previous_evaluation+manual_override，输出 proposed_stage/effective_stage/status/evidence/conflicts/max_stage_reached/opportunity_status）。该文件需迁移到本口径。

**回退 / 证据不足**：
- 邮箱退信 → 跟进类 stage 回退。
- 联系人否认需求 / 项目取消 → 商机降级。
- 来源不足 / 身份冲突 / 缺会议纪要 → match_grade 标 `待确认`，不硬判。

### 2. 匹配度 match_grade（带证据，对外只显级别 + 为什么）

| match_grade | 判定标准 |
|---|---|
| A | 明确产品、数量或项目，且有下一次沟通安排 |
| B | 产品和渠道匹配，但预算、数量或时间未确认 |
| C | 只有交换名片或泛泛咨询 |
| 待确认 | 来源不足、身份冲突或会议记录缺失 |

- 对外只显示 A/B/C/待确认 + 证据（「为什么重要」），不暴露内部评分。

### 3. 去重合并规则（跨来源身份合并）

1. **有 company_cdp_id / customer_id** → 按主键合并，最权威，所有来源挂它下。
2. **无主键**（只 OCR 名片没扫码）→ 按「公司名 + 国家」soft-match 到已有 customer；匹配不上 → 新建「待关联」customer，等补 id 后归并。
3. **身份冲突**（同 id 不同名 / 同名不同 id）→ 标 `待确认`，不自动合并，等人工仲裁。

### 4. interaction signals 数据契约

signals 是从原始记录提取的**可重算数据**，是阶段判断的唯一硬证据来源。

**signal 字段（8 项）**：

| 字段 | 含义 |
|---|---|
| type | 信号类型（见下方枚举） |
| value | 原始值 |
| normalized_value | 归一化值（数量区间、币种、产品名归一） |
| evidence_text | 原文证据句，**必须能在 raw_record_ref 原文中找到**；找不到（空）时该信号不能标记 confirmed |
| confidence | 提取可信度 0-1，**只表示提取可信度，不等于商机等级或成交概率** |
| origin | agent_extracted / user_confirmed / system；**user_confirmed 优先于 agent_extracted** |
| extractor_version | 提取器版本 |
| extracted_at | 提取时间 |

**signal type 枚举（分组）**：

| 分组 | type | 用途 |
|---|---|---|
| 产品需求 | product_need / needs | 需求明确的前置 |
| 业务信息 | quantity / usage / budget / timeline / spec / project_context | 需求明确（产品需求 + 至少一项） |
| 商务推进 | quote_request / sample_request / contract / payment / delivery_confirm / next_negotiation / commercial | 报价中 |
| 负面 | deny_need / identity_mismatch | 冲突检测 |
| 机会状态 | delayed / cancelled / won / deal_closed | opportunity_status |
| 联系人 | email_bounced / contact_invalid | 联系人可达性（不回退 stage、不直接 lost） |

**硬约束**：
- **不得修改** `raw_record_ref` 指向的原文。
- **summary 只展示**，绝不作为 confirmed 硬证据（阶段判断不读 summary）。
- **旧平铺字段兼容**：product_need / quantity / quote_request / deny_need / delayed / cancelled / bounced 等旧字段经 normalization adapter 转换，输出 deprecated 提示，后续迁移到 signals 数组。
- **未知 signal type 忽略并记录 warning**，不导致引擎崩溃。
- **email_bounced / contact_invalid**：只更新联系人可达性，不降低 stage、不直接置 lost；多联系方式只失效一个时保留其他有效渠道。

### 5. 原始记录元数据（每条 raw 记录必带 9 项）

| 字段 | 含义 |
|---|---|
| source_record_id | 来源系统记录 ID，防重复同步 |
| occurred_at | 沟通发生时间 |
| synced_at | 入库时间 |
| source_system | 慧记 / 慧译 / 邮箱 / WhatsApp / 名片OCR |
| language | 原文语言，方便翻译检索 |
| content_hash | 内容哈希，合并时判断是否同一条 |
| participants | 谁和谁谈的 |
| opportunity_id（可含 exhibition_id） | 归属哪笔商机、哪届展会 |
| visibility | 涉及私人联系方式时的读权限控制 |

---

## 五、档案文档（可再生阅读层）

- 所有客户底层都有完整结构化档案（customer + opportunity + interaction）。
- 优先跟进客户自动生成飞书档案文档。
- 普通客户只在多维表中管理，需要时按需生成文档。
- 客户升级为优先跟进 → 生成文档；降级 → 文档归档，不删除。
- 文档**不是原始数据唯一来源**，随时可从 interaction 重新生成。
- **用户修正必须回写结构化数据**（customer/opportunity/interaction），不能只改渲染文档。

档案文档结构（示例）：

```
Casa Outdoor

优先跟进 · 报价中
下次动作：9月10日前发送正式报价

为什么优先
本届确认到展；采购户外桌椅约200套；买家主动询价，要求11月前交付。

客户概况
墨西哥酒店家具渠道商
联系人：Maria Lopez｜采购总监

沟通时间线
09/08  现场会谈，确认酒店项目需求
09/08  已发送产品目录
09/09  买家邮件回复，索要报价
09/10  待发送正式报价

▸ 查看会议原文   ▸ 查看邮件往来   ▸ 查看WhatsApp记录
```

正文默认展示摘要 + 关键原话，完整邮件/会议/WA 放折叠区或链接至沟通明细记录，避免文档越滚越长。

---

## 六、与 exhibitions/schema.md 的引用关系

| 模型 | 归属 |
|---|---|
| customer（企业主体） | 本文件（跨场景通用） |
| opportunity（商机） | 本文件（跨场景通用），展会场景加 exhibition_id / 展会扩展字段 |
| interaction（沟通明细） | 本文件（跨场景通用），`exhibitions/schema.md` 引用，不复制 |
| 结构化规则（stage/匹配度/去重/signals/原始记录元数据） | 本文件 |
| 展会目录结构（meta.json / customers-index.json / reports） | `exhibitions/schema.md` 专属 |
| 展会扩展字段（慧记/慧译 artifacts、展位、国家等） | `exhibitions/schema.md` 专属 |

`exhibitions/schema.md` 只保留：展会目录结构 + 展会扩展字段 + 慧记/慧译 artifacts 定义。通用 customer/opportunity/interaction 及结构化规则引用本文件，避免出现两个「唯一真相源」。

---

## 七、旧邮件看板字段迁移映射

旧「邮件跟进」表（`dc_feishu_standard.py` FOLLOWUP_FIELDS）→ 新结构：

| 旧字段 | 新位置 | 说明 |
|---|---|---|
| 公司名 | customer.company | |
| 官网 | customer.website | |
| 国家 | customer.country | |
| 买家类型 | customer.buyer_type | |
| 联系人名 | customer.contacts[].name（主联系人） | |
| 联系人信息 | customer.contacts[]（email/phone/whatsapp 拆开） | 完整联系人进数组 |
| 跟进状态 | opportunity.stage | |
| 已发邮件数 | interaction 聚合计数 | 可做冗余计数，非主字段 |
| 买家回复数 | opportunity.reply_count | 聚合 |
| 已跟进轮次 | interaction 聚合 | |
| 最近联系时间 | opportunity.last_contact_at | |
| 邮件全部内容 | **删除**，拆到 interaction 表（一行一封） | 乱源所在 |

---

## 八、分阶段实现顺序

1. **Schema 拆分落地**：把 `exhibitions/schema.md` 通用部分迁到本文件，展会 schema 改为引用本文件。
2. **沟通明细 interaction 落库**：邮件/WA/会议/扫码统一进明细，慧译慧记挂 artifacts，删「邮件全部内容」列。
3. **优先级三档 + 多因子理由**：followup_priority 落地，冷热退役，contact_policy / opportunity_status 补上。
4. **线索池主表字段重构**：主要联系人、匹配度、阶段、优先级、下一步、截止时间、档案链接，旧邮件看板迁移。
5. **档案文档生成层**：优先自动生成、普通按需、降级归档、回写结构化。
6. **前台收敛 + 回归测试**：只展示优先级+下一步，全套回归。

---

## 九、已定决策（2026-09-06 田耕郡拍板）

1. **stage 口径**：采用本文件新口径「待触达 / 已触达 / 已回复 / 需求明确 / 报价中」。`dc_opportunity_stage.py` 旧「已接触/已留资/已沟通/需求明确/商务跟进」同步迁移，不保留两套。
2. **冷热退役**：直接同步改，三处硬引用（`dc_company_registry.py` / `dc_growth_dashboard.py` / `dc_after_exhibition_recommend.py`）随迁移一并替换为 followup_priority。
3. **Bitable 表策略**：线索池主表 + 沟通明细子表（同一 base 下主子表）。旧「邮件跟进」表废弃。
4. **buyer-leads-push 例外**：先不动，`lead_pool_guard.py` 保持独立，不与本 spec 合并。
5. **慧译/慧记 artifacts 归属**：都存在对应买家（customer）信息里，artifacts 挂在该 customer 下；慧译使用范围很小，不单独建模。
6. **物理落库边界**：权威真相源 = 本地 memory JSON（统一 customer 主键），agent 读写这一份；飞书 Bitable（线索池主表 + 沟通明细子表 + 档案文档）= 展示/协作层，从本地同步上去，用户前台修改回写本地；富文本原文（慧记/慧译/邮件正文）只在本地，飞书只放摘要 + raw_record_ref 引用。

---

## 十、引用检查清单（迁移时需同步改动的文件）

### 冷热 → followup_priority

| 文件 | 位置 | 改动 |
|---|---|---|
| `dc_company_registry.py` | LEAD_POOL_FIELDS_JSON 冷热字段 + EXPECTED_FIELD_NAMES + 默认值 `❄️冷` | 删冷热字段，加「跟进优先级」字段 |
| `dc_growth_dashboard.py` | LEAD_POOL_FIELDS `("hot_cold", "冷热")` | 换成 followup_priority |
| `dc_memory_data.py` | 归集映射 `hot_cold`（3 处） | 换成 followup_priority |
| `dc_after_exhibition_recommend.py` | `to_lead_pool` 的 `"冷热": "🔥热" if ... else "❄️冷"` | 换成 followup_priority 三档 |

### 邮件跟进表 → 沟通明细子表

| 文件 | 位置 | 改动 |
|---|---|---|
| `dc_feishu_standard.py` | EMAIL_FOLLOWUP_TABLE + FOLLOWUP_FIELDS（含「邮件全部内容」坏字段） | 废弃或改为沟通明细子表 schema，删「邮件全部内容」 |
| `dc_memory_data.py` | email_followup 归集/表快照 | 改为 interaction 聚合 |
| `dc_daily_cycle.py` | `_refresh_email_followup` 刷新「邮件跟进」表 | 改为刷新沟通明细子表 |
| `dc_daily_report.py` | `_followup_table_url`（跟进明细链接，指向 followup_table_id） | 改为指向沟通明细子表 |
| `dc_after_exhibition_runtime.py` | `resolve_lead_pool_links` 的跟进记录链接（指向 followup_table_id） | 改为指向沟通明细子表 |

> 「展会活动推荐买家加跟进记录」正是 `dc_after_exhibition_runtime.py` 的 `resolve_lead_pool_links`，它的「跟进记录」链接现在指向旧「邮件跟进」表，迁移时同步改为沟通明细子表链接。
