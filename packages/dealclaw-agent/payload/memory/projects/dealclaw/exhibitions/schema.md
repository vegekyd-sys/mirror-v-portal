# 展会数据模型（唯一真相源）

> 定位：展会现场「客户事件」的数据结构唯一真相源。承载一个买家跨届展会、跨年度的「完整一生」。
> 状态：2026-09-05 定稿。与 `lead-pool-fields.md`（线索池）互补——本文件管「展会现场事件」，线索池管「长期营销档案」。
> 来源：田耕郡@格格 2026-09-05 结构设计。

---

## 零、核心原则

1. **公司是「身份」，商机才有「阶段」**。grade / stage 挂在商机（opportunity）上，不挂在公司（customer）上。同一家公司可能 2026 墨西哥展 A 级待报价、2027 巴西展 C 级接触，互不覆盖。
2. **逻辑挂 customer 下，物理单独存储**。原始记录（慧记/慧译/邮件/WA 原文）不塞进一个巨大的 customers.json——Agent 默认只读索引 + 提炼字段，追问原文时才按 `raw_record_ref` 精确读取。省 Token、好更新。
3. **数组不覆盖**。名片、会议、现场、跟进都是数组，一个买家可以有多张名片、多次会议、多届记录。
4. **原始记录 = 证据，提炼字段 = 信号，规则引擎 = 算阶段**。AI 不能无证据直接改 stage/grade。
5. **允许「证据不足」和「阶段回退」**。退信、否认需求、项目取消，不能永远停在 A 级。

---

## 一、三层结构

### ① 企业主体档案（customer）——长期身份，稳定字段

```json
{
  "customer_id": "stable_internal_id",   // 内部稳定主键（非 CDP ID，CDP ID 可能变）
  "company_cdp_id": "",                   // 买家 CDP ID（幂等键，对齐线索池「公司CDPID」）
  "company": "",
  "website": "",
  "country": "",
  "buyer_type": "",                       // 只用接口 buyerType，禁止推导

  "contacts": [                            // 多联系人，数组不覆盖
    { "contact_id": "", "name": "", "title": "", "email": "", "phone": "" }
  ]
}
```

### ② 商机（opportunity）——每届展会/每次采购，grade/stage 挂这里

```json
{
  "opportunity_id": "",
  "exhibition_id": "",                    // 属于哪届展会
  "year": "2026",
  "product_scope": ["outdoor table"],     // 本届关注的产品范围

  "grade": "A|B|C|待确认",                // 带证据的分级，见「六、grade 规则」
  "grade_evidence": [],                   // 为什么是这个级（证据句数组）
  "stage": "已接触|已留资|已沟通|需求明确|商务跟进",   // 阶段建议，见「五、stage 规则」
  "stage_evidence": [],                   // 推进到该阶段的证据
  "opportunity_status": "active|paused|won|lost",  // 报价/成交/失单/暂停放这里，不塞 stage

  "extracted": {                          // 从原始记录提炼的结构化字段（信号）
    "needs": "", "quantity": "", "budget": "", "timeline": "",
    "objections": [], "quote_status": ""
  },

  "interactions": [                       // 多次互动，数组不覆盖
    {
      "interaction_id": "",
      "source": "meeting|card|onsite|email|whatsapp|translation|scan",
      "occurred_at": "",                  // 沟通发生时间
      "contact_id": "",
      "summary": "",                      // 提炼摘要（仅展示，不作为 confirmed 硬证据）
      "raw_record_ref": "raw/meeting/record_xxx.txt",   // 指向物理原文
      "signals": [                        // 结构化信号数组（阶段判断唯一硬证据来源，见「九」）
        {
          "type": "product_need",
          "value": "户外桌",
          "normalized_value": "outdoor table",
          "evidence_text": "原文证据句",
          "confidence": 0.9,
          "origin": "agent_extracted|user_confirmed|system",
          "extractor_version": "1.0.0",
          "extracted_at": "2026-09-05T23:00:00Z"
        }
      ]
    }
  ],

  "next_step": { "action": "", "owner": "", "due": "", "status": "pending|done" },
  "updated_at": ""
}
```

### ③ 原始记录（raw）——物理单独存，一字不丢

见「四、物理存储目录」。

---

## 二、字段口径（对齐线索池）

| 本模型字段 | 线索池字段 | 说明 |
|---|---|---|
| company_cdp_id | 公司CDPID | 幂等键 |
| company | 买家公司名称 | |
| website | 官网 | |
| country | 国家 | |
| buyer_type | 买家类型 | 只用接口值 |
| contacts[] | 联系人 | 线索池「联系人」解锁时才写，本模型完整存 |

---

## 三、物理存储目录

```
memory/projects/dealclaw/exhibitions/<展会slug>/
├── meta.json                 # 展会信息（名称/sourceId/时间/地点/展位/国家）
├── customers-index.json      # 索引：customer_id → company/grade/stage 摘要（Agent 默认读这个）
├── customers/
│   └── customer_001/
│       ├── profile.json          # 企业主体 + contacts
│       ├── opportunities.json    # 商机列表（含 interactions 摘要 + raw_record_ref）
│       ├── interactions.jsonl    # 互动摘要流（追加式，一条一行）
│       └── raw/
│           ├── card_001.json
│           ├── meeting_001.txt        # 慧记原文
│           ├── translation_001.txt    # 慧译原文
│           ├── email_001.eml
│           └── whatsapp_001.json
└── reports/
    └── 2026-mexico-day-1.md    # 每日作战简报 / 展后复盘
```

- 目录名用「展会名+年份」slug（agent 友好），`meta.json` 里存 `sourceId` 当机器主键。
- `customers-index.json` 是「轻索引」，Agent 日常只读它 + 商机的提炼字段；用户追问「去年谈了什么」才按 `raw_record_ref` 下钻原文。

---

## 四、原始记录元数据（每条 raw 记录必带 9 项）

| 字段 | 含义 |
|---|---|
| source_record_id | 来源系统记录 ID，防重复同步 |
| occurred_at | 沟通发生时间 |
| synced_at | 入库时间 |
| source_system | 慧记 / 慧译 / 邮箱 / WhatsApp / 名片OCR |
| language | 原文语言，方便翻译检索 |
| content_hash | 内容哈希，合并时判断是否同一条 |
| participants | 谁和谁谈的 |
| exhibition_id + opportunity_id | 归属哪届展会、哪笔商机 |
| visibility | 涉及私人联系方式时的读权限控制 |

---

## 五、stage 自动推进规则（证据驱动，5 个阶段）

原始记录提供证据，提炼字段提供信号，规则引擎计算阶段。AI 不能无证据改阶段。

| stage | 推进条件（证据） |
|---|---|
| 已接触 | 有名片 / 扫码 / 到展 / 现场接触 任一证据 |
| 已留资 | 获得可用联系方式，并确认对应联系人 |
| 已沟通 | 存在有效会议、邮件回复或 WhatsApp 双向沟通 |
| 需求明确 | 确认产品需求 + 数量/用途/预算/交期/规格/项目背景 至少一项 |
| 商务跟进 | 买家提出报价/样品/合同/付款/交期确认/下一轮谈判 |

- **报价状态、成交、失单、暂停** 放独立字段 `opportunity_status`（active/paused/won/lost），不塞进 stage。
- 只填 next_step 不能单独推动 stage；单向邮件无买家响应不算已沟通。
- 阶段判断实现见 `work/mio-api/dc_opportunity_stage.py`（纯函数，输入 opportunity+interactions+previous_evaluation+manual_override，输出 proposed_stage/effective_stage/status/evidence/conflicts/max_stage_reached/opportunity_status）。

**回退 / 证据不足**：
- 邮箱退信 → 跟进类 stage 回退，不能停在「已安排下一步」。
- 联系人否认需求 / 项目取消 → 商机降级，不能永远停在 A 级。
- 来源不足 / 身份冲突 / 缺会议纪要 → grade 标 `待确认`，不硬判。

---

## 六、grade 分级规则（带证据，对外只显级别 + 为什么）

| grade | 判定标准 |
|---|---|
| A | 明确产品、数量或项目，且有下一次沟通安排 |
| B | 产品和渠道匹配，但预算、数量或时间未确认 |
| C | 只有交换名片或泛泛咨询 |
| 待确认 | 来源不足、身份冲突或会议记录缺失 |

- 对外只显示 A/B/C/待确认 + grade_evidence（「为什么重要」），不暴露内部评分。
- 每个重点买家要显示「为什么重要」+「下一步做什么」。

---

## 七、去重合并规则（跨来源身份合并）

1. **有 company_cdp_id / customer_id** → 按主键合并，最权威，所有来源挂它下。
2. **无主键**（只 OCR 名片没扫码）→ 按「公司名 + 国家」soft-match 到已有 customer；匹配不上 → 新建「待关联」customer，等补 id 后归并。
3. **身份冲突**（同 id 不同名 / 同名不同 id）→ 标 `待确认`，不自动合并，等人工仲裁。

---

## 八、线索池双写（精简版）

展会 customer 落一份完整事件到展会 memory，同时抽核心字段写线索池，来源标「展会线索」+「报名参展展会=具体展会名」。

| 线索池字段 | 来源 |
|---|---|
| 公司名/官网/国家/买家类型 | customer 同名字段 |
| 公司CDPID | company_cdp_id |
| 推荐理由 | grade_evidence |
| 冷热 | A/B→🔥热，C→❄️冷 |
| 阶段 | opportunity.stage 映射 |
| 联系人 | 解锁时才写 |
| 来源 | 展会线索 |
| 报名参展展会 | 具体展会名 |

---

## 九、interaction signals 数据契约

interaction 的 `signals` 是从原始记录提取的**可重算数据**，是阶段判断的唯一硬证据来源。

### signal 字段（8 项）

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

### signal type 枚举（分组）

| 分组 | type | 用途 |
|---|---|---|
| 产品需求 | product_need / needs | 需求明确的前置 |
| 业务信息 | quantity / usage / budget / timeline / spec / project_context | 需求明确（产品需求 + 至少一项） |
| 商务推进 | quote_request / sample_request / contract / payment / delivery_confirm / next_negotiation / commercial | 商务跟进 |
| 负面 | deny_need / identity_mismatch | 冲突检测 |
| 机会状态 | delayed / cancelled / won / deal_closed | opportunity_status |
| 联系人 | email_bounced / contact_invalid | 联系人可达性（不回退 stage、不直接 lost） |

### 硬约束

- **不得修改** `raw_record_ref` 指向的原文。
- **summary 只展示**，绝不作为 confirmed 硬证据（阶段判断不读 summary）。
- **旧平铺字段兼容**：product_need / quantity / quote_request / deny_need / delayed / cancelled / bounced 等旧字段经 normalization adapter 转换，输出 deprecated 提示，后续迁移到 signals 数组。
- **未知 signal type 忽略并记录 warning**，不导致引擎崩溃。
- **email_bounced / contact_invalid**：只更新联系人可达性，不降低 stage、不直接置 lost；多联系方式只失效一个时保留其他有效渠道。
