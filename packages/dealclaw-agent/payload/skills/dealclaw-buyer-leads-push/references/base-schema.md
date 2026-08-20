# Feishu Base schema

Reuse the unified lead pool via `ensure_company_lead_pool`（企业名称线索池，主表「线索池」）。评分明细、参展行为作为关联子表（双向关联）。

## Interface fact fields

These fields contain only sanitized interface values:

| Field | Recommended type | API source |
|---|---|---|
| 线索ID | Text, primary field | `id` |
| 买家CDPID | Text | `companyCdpId` |
| 联系人ID | Text | `purchaserContactId` |
| 买家公司名称 | Text | `buyerCompany` |
| 买家公司简介 | Long text | `companyProfile` |
| 买家国家 | Text | `buyerCountry` |
| 产品类别T1 | Text | `t1` |
| 产品类别T2 | Text | `t2` |
| 需求意向 | Long text | `recentTrend` |
| 关注产品 | Long text | `productList` (formatted) |
| 买家类型 | Text | `buyerType` |
| 买家特征 | Text | `buyerTag` |
| 报名参展展会 | Text | `exhibitionName` |
| 需求时间 | Text | `lastConsolidatedTime` |

Do not add `数据来源`, `原始详情`, `公司官网`, `联系人姓名`, email, phone, WhatsApp, WeChat, or other contact fields. Preserve `买家类型` only from the interface `buyerType`; never derive it from other fields.

## AI fields

| Field | Recommended type |
|---|---|
| AI匹配分 | Number |
| AI原始分 | Number |
| 反馈扣分 | Number |
| AI匹配等级 | Single select: 高、中、低 |
| 核心匹配通过 | Checkbox |
| AI匹配理由 | Long text |
| 评分明细 | Long text or JSON text |
| 线索明确MOQ | Text |
| 评分权重版本 | Text |
| 企业画像版本 | Text |
| 企业画像群ID | Text |
| 画像企业名称 | Text |
| 运行上下文ID | Text |
| AI处理时间 | Date time |

## User-feedback fields

| Field | Recommended type |
|---|---|
| 是否匹配 | Single select: 待确认、✅ 匹配、❌ 不匹配 |
| 不匹配原因 | Multi-select: 产品名称不匹配、产品类别不匹配、买家类型不匹配、国家不匹配、MOQ不匹配、买家标签不匹配、买家简介不匹配、需求意向不匹配、需求已过期、线索质量低、重复线索、其他 |
| 反馈说明 | Long text |
| 反馈人 | Person |
| 反馈时间 | Date time |
| 跟进状态 | Single select: 未跟进、已联系、已回复、已转化、关闭 |
| 跟进备注 | Long text |
| 是否解锁 | Single select: 未解锁、已解锁（创建时默认 未解锁） |

`是否解锁` is the Base-side unlock trigger. When it changes from `未解锁` to `已解锁`, the host reads the live record and runs the contact-unlock flow in [message-template.md](message-template.md): `contact_unlock_guard.py authorize` (trigger `base_field`) → `tradechina_buyer_leads.py buyer-detail` → `contact_card_renderer.py render` → send to the record's `飞书群ID`. The field records unlock intent only; contact values themselves are never written to any Base field.

## Unlock system fields

| Field | Recommended type |
|---|---|
| 解锁人 | Person |
| 解锁时间 | Date time |
| 解锁方式 | Text: `线索池下拉` or `群内指令` |
| 解锁推送消息ID | Text |

Write these only after the contact card is confirmed sent (`contact_unlock_guard.py complete` with `contact_pushed`). Skip records whose `是否解锁` is `已解锁` and `解锁推送消息ID` is already non-empty; they were released before and must not trigger a duplicate send.

The two triggers converge on the same final record state: after a successful `群内指令` (group-command) unlock, the host must also set the record's `是否解锁` to `已解锁` together with the four system fields above (`解锁方式 = 群内指令`), so the Base row always reflects a completed unlock regardless of which path triggered it. A failed or `unknown` unlock send never changes `是否解锁`.

## System fields

| Field | Recommended type |
|---|---|
| 唯一去重键 | Text |
| 飞书群ID | Text |
| 首次入池时间 | Date time |
| 最近更新时间 | Date time |
| 首次推送时间 | Date time |
| 最近推送时间 | Date time |
| 推送次数 | Number |
| 最近推送批次ID | Text |
| 推送消息ID | Text |

Build `唯一去重键` as `chat_id + ":" + 线索ID`. Upsert by this key. Never create a second record for the same key.

Reject a record before Base write when `线索ID` is empty. Never create the partial key `chat_id + ":"`.

Read feedback from the feedback fields on records in this same `买家线索` table and filter `飞书群ID == current chat_id`. Reject a cross-group record instead of using its feedback. There is no separate feedback-records table. Preserve all user-feedback and follow-up fields when upserting interface or AI fields.

## Views

Create these reusable views when the host supports view configuration:

- 今日新线索
- 待确认
- 匹配线索
- 不匹配线索
- 已跟进
- 已解锁线索 (`是否解锁 = 已解锁`)
- 高匹配机会 (`AI匹配分 >= 70` and `核心匹配通过 = true`)

Treat hidden fields as presentation only, not as a security boundary. Contact data must not be stored in this Base at all — not after an unlock either. The Base records only the unlock state (`是否解锁`, `解锁人`, `解锁时间`, `解锁方式`, `解锁推送消息ID`); released contact values exist solely in the group contact card.

Resolve the Base and table only from the `chat_id` binding's stored `base_app_token` and `base_table_id`. Do not search by title during daily runs.

Set `企业画像群ID` to the current `chat_id` on every AI result. Refuse to write an AI score when it differs from the record's `飞书群ID` or the bound state `chat_id`.

Write `评分权重版本` as `v10-32-24-18-10-6-4-2-2-2`. `评分明细` must preserve the nine per-dimension points and evidence returned by the deterministic matcher. Do not let a generated narrative replace this audit record. Refuse all buyer-record writes unless the v10 guard and pipeline succeeded and the formal profile is active.

Set `画像企业名称` only from the guarded binding/formal title. Set `运行上下文ID` only from `tenant_run_guard.py`. Keep `画像企业名称` distinct from interface `买家公司名称`. Immediately before upsert, recheck the current state revision and every equality in [runtime-orchestration.md](runtime-orchestration.md).

Set `核心匹配通过` only for the product-name, product-category, and target-market-country gate. Buyer type is a 10-point secondary bonus and must not change the checkbox directly.

## Schema reconciliation

A bound Base may predate the current schema (for example, a historical 线索池 without the v15 unlock columns). Reconcile it **additively**:

1. Run reconciliation when an existing Base is bound and at the start of every daily run, before the first record upsert or unlock sweep. Read the live `买家线索` field list and pass it to `scripts/base_schema_guard.py plan`.
2. The guard emits an add-only `add_plan`: create exactly the listed fields with the listed types and select options. For `是否解锁`, create the single-select with options `未解锁`、`已解锁` and default new records to `未解锁`.
3. Never rename, retype, reorder, or delete existing fields, and never remove user-added options. Extra user fields and extra options are tolerated.
4. A same-named field with a different type, or a select field missing a mandated option, is `incompatible_fields`: stop the run's Base writes and unlock flows, and report the exact field and expectation to the group administrator for a manual decision. Do not auto-convert user data.
5. A missing or non-text `线索ID` primary field is terminal for that Base; it cannot be reconciled automatically.
6. Record writes, upserts, feedback reads, and unlock sweeps may proceed only when the guard reports `ok` or its `add_plan` has been fully applied to the live table.
