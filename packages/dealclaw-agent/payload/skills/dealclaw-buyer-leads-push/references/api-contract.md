# TradeChina API contract

## Endpoints

Both endpoints use `POST` with JSON bodies.

### Countries

`https://micro.tradechina.com/blade-purchaser/buyerLeadsPlaza/countries`

Request body:

```json
{}
```

Expected root keys: `code`, `success`, `data`, `msg`.

Each `data` item contains:

- `countryId`
- `enName`
- `cnName`

Resolve a knowledge-document market name by exact trimmed, case-insensitive match against `cnName` or `enName`. Do not use fuzzy country matching. Cache the list for one daily run.

### Buyer leads

`https://micro.tradechina.com/blade-purchaser/api/buyerLeadsPlaza/page`
Minimum normal request:

```json
{
  "supplierId": "<configured supplier ID>",
  "consolidatedDays": 7,
  "countryId": "<countryId>",
  "productKeyword": "<profile product>",
  "page": 1,
  "limit": 20
}
```

Require `supplierId` from the current `chat_id` binding's `tradechina_supplier_id`. The bundled script requires an explicit `--supplier-id`; it never reads a process-wide environment fallback and has no packaged default. The host must normally use `scoped_lead_pipeline.py`, which obtains the ID only after `tenant_run_guard.py` validates the current group binding. Treat empty values and obvious placeholders as preflight failures. Valid `consolidatedDays` values are `3`, `7`, `15`, and `30`.

Run `contract-check` with the current test group's bound supplier ID, one resolved country ID, and one explicit profile product. It sends `limit: 1` and returns schema keys only; it must not issue an unfiltered buyer query. Never test with a shared global supplier ID.

Expected pagination keys under `data`: `records`, `total`, `size`, `current`, `searchCount`, `pages`.

### Buyer lead detail

`https://micro.tradechina.com/blade-purchaser/api/buyerLeadsPlaza/detail`

Request body:

```json
{
  "supplierId": "<configured supplier ID>",
  "trendId": "<线索ID from the 买家线索 record>"
}
```

Call this endpoint only inside the contact-unlock flow with a `--unlock-id` issued by `contact_unlock_guard.py authorize`. Always send the binding's `supplierId` even though the live service currently tolerates its absence. The response `data` must echo the requested `trendId` as `id`; a mismatch is terminal.

Verified response `data` keys: `id`, `exhibitionId`, `exhibitionName`, `purchaserId`, `purchaserContactId`, `chatGroupId`, `countryId`, `expoCountryId`, `buyerCompany`, `buyerCountry`, `companyProfile`, `t1Id`, `t2Id`, `t1`, `t2`, `buyerTag`, `companyWebsite`, `contactName`, `jobTitle`, `buyerEmail`, `buyerMobile`, `buyerWhatsapp`, `unlockStatus`, `recentTrend`, `emailValid`, `mobileValid`, `whatsappValid`, `productList`, `hasHomeLifeRegisterLog`, `companyCdpId`, `videoDirect`, `videoApplyStatus`.

`unlockStatus` integer `-1` means the platform UI treats the contact as locked. Live probing shows the service currently returns unmasked contact values even when `unlockStatus = -1`; server-side enforcement must not be assumed. The Skill-side guard is therefore the only release gate until TradeChina ships a server-side unlock API; when that API exists, call it between guard authorization and this detail retrieval, and re-verify `unlockStatus` semantics. Non-`-1` values currently observed semantics are unconfirmed; treat them per the guard decision, not per interface inference.

## Approved contact field mapping (unlock-gated)

Release these fields only through `tradechina_buyer_leads.py buyer-detail` with a valid guard `unlock_id`, only into `contact_card_renderer.py`, and only to the originating group:

| Display field | Interface source | Rule |
|---|---|---|
| 联系人姓名 | `contactName` | Preserve the returned string. |
| 职位 | `jobTitle` | Preserve the returned string. |
| 邮箱 | `buyerEmail` | Preserve the returned string. |
| 电话 | `buyerMobile` | Preserve the returned string. |
| WhatsApp | `buyerWhatsapp` | Preserve the returned string. |
| 公司官网 | `companyWebsite` | Preserve the returned string. |
| 邮箱有效 | `emailValid` | Integer `1` → 已验证, `0` → 未验证, otherwise no badge. |
| 电话有效 | `mobileValid` | Same badge rule. |
| WhatsApp有效 | `whatsappValid` | Same badge rule. |
| 解锁状态 | `unlockStatus` | `-1` → `locked`; absent → `unknown`; other integer → `unlocked`. Never use this field as the release decision. |

Without a guard `unlock_id`, `buyer-detail` returns only the locked projection (`线索ID`, `买家公司名称`, `unlockStatus`, `解锁状态`) and strips every contact field.

## Approved buyer field mapping

Only output these fields:

| Base field | Interface source | Rule |
|---|---|---|
| 线索ID | `id` | Require a non-empty string or integer and preserve it as trimmed text. Reject the record otherwise. |
| 买家CDPID | `companyCdpId` | Preserve the returned string. |
| 联系人ID | `purchaserContactId` | Preserve the returned string. |
| 买家公司名称 | `buyerCompany` | Preserve the returned string. |
| 买家公司简介 | `companyProfile` | Preserve the returned string. May be in English. |
| 买家国家 | `buyerCountry` | Preserve the returned string. |
| 产品类别T1 | `t1` | Top-level product category in Chinese. |
| 产品类别T2 | `t2` | Sub-level product category in Chinese. |
| 需求意向 | `recentTrend` | Preserve the returned string. |
| 关注产品 | `productList` | Use only `productName` and `productNameEn`; join values for display without translation. |
| 买家类型 | `buyerType` | Preserve a returned string unchanged. Leave empty when absent; never infer it from other fields. |
| 买家特征 | `buyerTag` | Renamed from 买家标签. Preserve as opaque text; do not split or reinterpret. |
| 报名参展展会 | `exhibitionName` | Output only when `hasHomeLifeRegisterLog` is integer `1` and the name is non-empty. |
| 需求时间 | `lastConsolidatedTime` | Preserve the returned datetime string. |

`productList` is an array of objects with `productName` and `productNameEn` keys. When both names exist, format one product as `productName / productNameEn`. When only one exists, use that value. Join multiple products with line breaks.

## Forbidden handling

- Do not output any other response field.
- Do not output raw response records to logs.
- Contact fields (`contactName`, `jobTitle`, `buyerEmail`, `buyerMobile`, `buyerWhatsapp`, `companyWebsite`, and their validity flags) flow only along the unlock path: `contact_unlock_guard.py authorize` → `buyer-detail --unlock-id` → `contact_card_renderer.py` → the originating group. Never store them in the Base, durable state (including `unlocks`), profile data, history evidence, matcher input, or logs, and never echo them in free-form model messages. Outside this path they remain forbidden, even though the detail interface currently returns them.
- Do not infer buyer type when `buyerType` is absent. Do not infer region, website, purchase quantity, budget, deadline, or any unreturned fact.
- Do not convert an absent value into a buyer fact. Leave it empty or omit it from a group message.
- Count rejected missing-ID records only as `rejectedMissingLeadId`; never include their raw values or derive an alternate ID.

`contract-check` reports `buyerTypeFieldPresent`. This is a coverage signal, not permission to derive the field. When false, buyer-type matching contributes zero points.

## Matcher field projection

After sanitization, project only these fields into the isolated matcher together with `飞书群ID`: `线索ID`, `产品类别T1`, `产品类别T2`, `关注产品`, `买家类型`, `买家国家`, `需求意向`, `买家特征`, `买家公司简介`, and `需求时间`.

The matcher may extract `线索明确MOQ` only from `需求意向` under the strict marker/number/unit rule in `profile-and-matching.md`. This is an auditable parsing result, not a new interface fact. Never search other fields or raw response data for MOQ.
