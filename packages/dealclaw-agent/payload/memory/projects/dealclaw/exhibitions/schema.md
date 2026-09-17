# 展会数据模型（展会扩展，引用 customer-dossier-schema）

> 定位：展会场景的扩展字段 + 展会目录结构。跨场景通用的 customer / opportunity / interaction 及结构化规则见 `customer-dossier-schema.md`，本文件只定义展会专属部分，不复制通用模型。
> 状态：2026-09-06 拆分定稿（通用部分迁至 `customer-dossier-schema.md`）。
> 来源：田耕郡@格格 2026-09-05 结构设计 + 2026-09-06 schema 所有权拆分。

---

## 零、引用关系（避免两个「唯一真相源」）

| 模型 / 规则 | 归属 |
|---|---|
| customer（企业主体） | `customer-dossier-schema.md`（跨场景通用） |
| opportunity（商机） | `customer-dossier-schema.md`（跨场景通用），本文件加展会扩展字段 |
| interaction（沟通明细） | `customer-dossier-schema.md`（跨场景通用），本文件引用，不复制 |
| stage / match_grade / 去重 / signals / 原始记录元数据 9 项 | `customer-dossier-schema.md` |
| 展会目录结构（meta.json / customers-index.json / reports） | 本文件 |
| 展会扩展字段（慧记/慧译 artifacts、展位、国家等） | 本文件 |

通用 interaction 字段表、signals 契约、stage 规则、匹配度规则、去重规则、原始记录元数据 9 项，全部以 `customer-dossier-schema.md` 为准，本文件不再重复定义。

---

## 一、展会扩展字段

### opportunity 展会扩展

在通用 opportunity 之上，展会场景追加：

| 字段 | 说明 |
|---|---|
| exhibition_id | 归属哪届展会（`meta.json` 的 sourceId 为机器主键） |
| product_scope | 本届关注的产品范围 |
| extracted | 从原始记录提炼的结构化需求字段（needs/quantity/budget/timeline/objections/quote_status），随真实数据联调校准 |

### 慧记 / 慧译 artifacts

- 慧记 transcript、慧译 translation **不是独立互动**，作为 `artifacts[]` 挂在对应的 meeting interaction 下（字段见 `customer-dossier-schema.md` 的 interaction.artifacts）。
- 原文存展会目录 `raw/`，按 `raw_record_ref` 下钻，不进主表 cell。
- 业务统计**不得**将 translation 视为独立沟通渠道；`source=translation` 枚举保留用于兼容和来源追踪。

---

## 二、物理存储目录

```
memory/projects/dealclaw/exhibitions/<展会slug>/
├── meta.json                 # 展会信息（名称/sourceId/时间/地点/展位/国家）
├── customers-index.json      # 索引：customer_id → company/match_grade/stage 摘要（Agent 默认读这个）
├── customers/
│   └── customer_001/
│       ├── profile.json          # customer 主体 + contacts（字段见通用 spec）
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
- profile.json / opportunities.json / interactions.jsonl 的字段口径一律引用 `customer-dossier-schema.md`，本文件不重复。

---

## 三、线索池双写（精简版）

展会 customer 落一份完整事件到展会 memory（本目录），同时抽核心字段写线索池，来源标「展会线索」+「报名参展展会=具体展会名」。

| 线索池字段 | 来源 |
|---|---|
| 公司名/官网/国家/买家类型 | customer 同名字段 |
| 公司CDPID | company_cdp_id |
| 推荐理由 | 证据化理由 |
| 跟进优先级 | opportunity.followup_priority（三档，见通用 spec） |
| 阶段 | opportunity.stage |
| 联系人 | 主要联系人，解锁时才写（完整联系人留在 customer.contacts[]） |
| 来源 | 展会线索 |
| 报名参展展会 | 具体展会名 |

> 冷热字段已退役，替换为「跟进优先级」三档。字段映射与迁移详见 `customer-dossier-schema.md` 的「旧邮件看板字段迁移映射」和「引用检查清单」。

### 展中推荐（现场即时推荐）落池：另一条路径，别混

| 项 | 值 |
|---|---|
| 触发 | `dc_onsite_recommend.py run`（展会现场未邀约买家即时推荐） |
| 来源 | **`展中推荐`**（**不是** `展会线索`） |
| 阶段 | `现场对接中` |
| 池 | **每届展会一个独立 Base**：`<展会名>｜展中推荐线索池`（`ensure_exhibition_lead_pool`），与企业主池分开 |
| 写路径 | `sync_exhibition_leads_to_pool`（与上面双写共用 `sync_records_to_pool` 幂等写路径） |

> 两者区别：以上「三、线索池双写」是**展后**展会 customer 的证据化跟进（来源 `展会线索`、落企业池）；
> 本条是**展中**的现场补枪推荐（来源 `展中推荐`、落本展会独立池），同一条线索不会互相覆盖。
> 字段清单与选项自愈细节见 `init-data-mapping.md` 第四节。
