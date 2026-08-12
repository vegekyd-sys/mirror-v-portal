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
  "supplierId": "1234",
  "consolidatedDays": 7,
  "countryId": "<countryId>",
  "productKeyword": "<profile product>",
  "page": 1,
  "limit": 20
}
```

Keep `supplierId` fixed as the string `"1234"`. Valid `consolidatedDays` values are `3`, `7`, `15`, and `30`.

Expected pagination keys under `data`: `records`, `total`, `size`, `current`, `searchCount`, `pages`.

## Approved buyer field mapping

Only output these fields:

| Base field | Interface source | Rule |
|---|---|---|
| 线索ID | `id` | Preserve the returned value as text. |
| 买家CDPID | `companyCdpId` | Preserve the returned string. |
| 联系人ID | `purchaserContactId` | Preserve the returned string. |
| 买家公司名称 | `buyerCompany` | Preserve the returned string. |
| 买家公司简介 | `companyProfile` | Preserve the returned string. May be in English. |
| 买家国家 | `buyerCountry` | Preserve the returned string. |
| 产品类别T1 | `t1` | Top-level product category in Chinese. |
| 产品类别T2 | `t2` | Sub-level product category in Chinese. |
| 需求意向 | `recentTrend` | Preserve the returned string. |
| 关注产品 | `productList` | Use only `productName` and `productNameEn`; join values for display without translation. |
| 买家特征 | `buyerTag` | Renamed from 买家标签. Preserve as opaque text; do not split or reinterpret. |
| 报名参展展会 | `exhibitionName` | Output only when `hasHomeLifeRegisterLog` is integer `1` and the name is non-empty. |
| 需求时间 | `lastConsolidatedTime` | Preserve the returned datetime string. |

`productList` is an array of objects with `productName` and `productNameEn` keys. When both names exist, format one product as `productName / productNameEn`. When only one exists, use that value. Join multiple products with line breaks.

## Forbidden handling

- Do not output any other response field.
- Do not output raw response records to logs.
- Do not store or pass contact fields to a model, even if a later interface version adds them.
- Do not infer buyer type, region, website, purchase quantity, budget, deadline, or any unreturned fact.
- Do not convert an absent value into a buyer fact. Leave it empty or omit it from a group message.
