# Isolated profile parsing and nine-dimension matching

## Group isolation

Use `chat_id` as the profile namespace. Read exactly one company profile through the `knowledge_doc_token` bound to that `chat_id`.

- Never search for a profile by company name or title during a normal run.
- Never reuse a profile, hash, feedback rule, candidate set, prompt, or score from another `chat_id`.
- Treat two groups with the same company name as separate tenants.
- Require `state.chat_id`, `binding.chat_id`, invocation `chat_id`, and `profile.source_chat_id` to be identical.
- Run the matcher once per group. Never batch multiple groups in one input or model call.
- Require the formal bound state profile status `active` and valid origin provenance. For `formalized_from_group_history`, also require onboarding `completed` and matching confirmation/formalization provenance. A generated draft is readable for review but cannot be used as runtime matcher input; the validator projection remains inert until formalization.

## Profile schema

Extract only explicit, confirmed values from the bound document. For a history-generated document, these values must also be backed by same-group evidence accepted by `profile_history_validator.py`:

```json
{
  "source_chat_id": "oc_xxx",
  "products": [
    {
      "name": "绗缝被",
      "aliases": ["Quilt"],
      "categories": ["床上用品"]
    }
  ],
  "buyer_types": [
    {"name": "分销商", "aliases": ["Distributor"]}
  ],
  "target_countries": [
    {"name": "巴西", "aliases": ["Brazil"]}
  ],
  "moq": {"value": 500, "unit": "件"},
  "desired_buyer_tags": ["连锁零售"],
  "buyer_profile_keywords": ["家居用品进口商"],
  "intent_keywords": ["寻找新供应商"]
}
```

Require at least one product name, one category across the products, and one target country. Buyer types and other secondary fields may be empty and then score zero. Never borrow values from another group, external enrichment, prior model knowledge, or feedback.

Display placeholders such as `待确认`, `暂无可确认信息`, or a draft warning are document UI only. Never pass them as product names, categories, countries, buyer types, aliases, tags, keywords, or MOQ values.

Product/buyer-type aliases, categories, tags, and keywords must be written explicitly in the same bound document. For each explicit country, resolve the TradeChina country dictionary and store its returned `cnName` and `enName` as country aliases; do not generate any other country synonym. Preserve source-language values and normalize whitespace/case only.

For `moq`, require a positive numeric value and a non-empty unit. Do not convert units. Include the source `chat_id` and every scoring field in the canonical profile hash and store it only under that group's state key.

## Query construction

Use the `name` of each `target_countries` entry to define API retrieval scope and its validated API-returned aliases as the profile side of country scoring.

For every explicit target country and product name:

1. Resolve the country by exact Chinese or English name.
2. Submit one buyer query with that country ID and one explicit product keyword.
3. Follow pagination within the configured maximum.
4. Merge sanitized results by interface `id` within this `chat_id` only.

Do not combine products into an undocumented query expression. Stop when the current profile has no target country; do not borrow one from elsewhere.

## Weight table

Score exactly 100 possible points:

| Priority | Dimension | Weight | Match source |
|---|---:|---:|---|
| Core 1 | Product name | 32 | Profile product name/explicit alias vs `关注产品` |
| Core 2 | Product category | 24 | Profile explicit category vs `产品类别T1/T2` |
| Core 3 | Target-market country | 18 | Profile target country/API aliases vs `买家国家` |
| Secondary | Buyer type | 10 | Profile buyer type/explicit alias vs interface `买家类型` |
| Auxiliary | MOQ | 6 | Profile MOQ vs an explicit MOQ/quantity statement in `需求意向` |
| Auxiliary | Buyer tag | 4 | Profile desired tag vs the complete opaque `买家特征` value |
| Auxiliary | Buyer company profile | 2 | Explicit profile keyword contained in `买家公司简介` |
| Auxiliary | Purchase intent | 2 | Explicit intent keyword contained in `需求意向` |
| Auxiliary | Lead recency | 2 | `需求时间` relative to the fixed run time |

The core dimensions contribute 74 points and preserve `product name > product category > target-market country`. Buyer type contributes a 10-point secondary bonus; it is lower than every core weight and higher than every other auxiliary weight.

## Match rules

Use deterministic normalization: Unicode text as returned, trim/collapse whitespace, and case-fold. Do not translate, perform fuzzy matching, or add model-generated synonyms.

### Product name — 32

Award 32 when a profile product name or its explicit alias exactly matches one item from `关注产品`. Split `关注产品` only on the script-generated line boundary and ` / ` delimiter. Otherwise award 0.

### Product category — 24

Award 24 when an explicit category attached to the matched profile product exactly matches `产品类别T1` or `产品类别T2`. A category belonging only to another profile product cannot score. Otherwise award 0.

### Target-market country — 18

Award 18 when `买家国家` exactly matches an explicit target-country name or its `cnName`/`enName` alias returned by the country endpoint. Otherwise award 0. Do not infer regions or create additional aliases. This is a core condition because the group should receive buyers only from markets that this supplier explicitly wants to develop.

### Buyer type — 10

Award 10 when the non-empty interface `买家类型` exactly matches a profile buyer type or explicit alias. Otherwise award 0. Never infer buyer type from another field. A missing or unmatched buyer type does not fail the core gate; it only loses this bonus.

### MOQ — 6

Award 6 only when both sides are explicit:

1. The group profile has a positive MOQ value and unit.
2. `需求意向` contains `MOQ`, `minimum order`, `minimum quantity`, `起订`, `最小起订量`, `采购量`, or `需求量`, followed or preceded by one positive number and the same explicit unit. Thousands separators are allowed.
3. Units match after whitespace/case normalization.
4. The explicit buyer quantity is greater than or equal to the enterprise MOQ.

Do not convert units, interpret ranges, use annual volume, or extract a bare number without an allowed marker. When any condition fails, award 0 and leave `线索明确MOQ` blank.

### Buyer tag — 4

Treat `买家特征` as one opaque value. Award 4 only when the entire non-empty value exactly matches one explicit desired buyer tag from the group profile. Do not split or reinterpret it.

### Buyer company profile — 2

Award 2 when one explicit `buyer_profile_keywords` phrase occurs literally in `买家公司简介` after whitespace/case normalization. Otherwise award 0. Do not use semantic similarity.

### Purchase intent — 2

Award 2 when one explicit `intent_keywords` phrase occurs literally in `需求意向`. Otherwise award 0. The same text may supply an explicit MOQ and an intent phrase because they are independent evidence.

### Recency — 2

Parse `需求时间` and compare it with one fixed ISO-8601 `run_at` for the entire group run:

- At or before `run_at` and no older than 3×24 hours: 2 points.
- Older than 3 days but no older than 7×24 hours: 1 point.
- Future, older than 7 days, absent, invalid, or timezone-ambiguous: 0 points.

Do not use the local process clock separately for each lead.

## Push gate and actions

Calculate the raw score as the sum of the nine dimensions, then subtract same-group feedback penalties and clamp to 0–100.

Set `核心匹配通过` only when product name = 32, product category = 24, and target-market country = 18 before penalties. Buyer type is not part of the gate.

- Final score at least 80 **and** core gate passes: upsert and consider for push.
- Final score 65–79, or score at least 80 with a failed core gate: upsert without push.
- Final score below 65: do not upsert.

This prevents auxiliary evidence from replacing a missing core product/type match. Sort by final score descending, raw score descending, valid demand time descending, then lead ID ascending.

Write one evidence item per dimension, including zero-point reasons. An AI may make the Chinese wording more concise but must not alter points, matched values, MOQ extraction, core-gate result, or action.

## Feedback penalties

Read feedback only from this `chat_id`'s bound table. After at least 3 rejected records for the same explicit canonical value, persist one rule under the same group:

| Dimension | Penalty |
|---|---:|
| Product name | 10 |
| Product category | 8 |
| Country | 6 |
| Buyer type | 4 |
| MOQ | 3 |
| Buyer tag | 2 |
| Buyer company profile | 1 |
| Purchase intent | 1 |

Do not learn a recency penalty. Apply each rule at most once per lead. Use rule keys `chat_id + dimension + normalized canonical profile value`, retain source record IDs for audit, and never copy rules across groups. Feedback changes the final score but does not change whether the three core fields originally matched.
