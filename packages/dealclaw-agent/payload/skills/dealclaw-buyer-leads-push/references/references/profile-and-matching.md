# Profile parsing and matching

## Profile source

Use exactly one group-visible document whose title matches `企业名称｜企业知识库`. Derive the company name from the title and read the current document blocks on every daily run.

Extract explicit profile facts such as:

- Company name
- Main and target products
- Target-market countries
- OEM or ODM capabilities
- MOQ
- Certifications
- Market-specific buyer identity, product, and requirement preferences

Do not infer missing profile facts. Preserve the source language for query terms unless the document explicitly provides another language.

## Query construction

For every explicit target market and target product:

1. Resolve the market through the country endpoint.
2. Submit one buyer query with that `countryId` and one explicit product keyword.
3. Follow pagination within the configured maximum.
4. Merge results by interface `id`.

Do not combine several products into one undocumented query expression.

## Match policy

Use only explicit company-profile facts and sanitized interface fields. Suggested scoring:

- Explicit product relevance: 50
- Explicit target-market match: 20
- Explicit company capability or certification relevance: 15
- Explicit buyer tag (买家特征) or purchase-intent relevance: 10
- Data recency within the selected window: 5

Scores are AI/system conclusions, not buyer facts. Keep them in `AI匹配分` and `AI匹配理由`.

Use these actions by default:

- Score at least 80: upsert and push, subject to the daily maximum.
- Score 65–79: upsert without push.
- Score below 65: exclude from normal lead-pool views.

## Feedback

Read `是否匹配`, `不匹配原因`, and `反馈说明` before matching. When a record is marked `❌ 不匹配`:

- If reason is product-related: reduce product keyword match weight for that specific product in this company's profile.
- If reason is market-related: reduce confidence for the target country that produced the lead.
- If reason is buyer-type-related: adjust the buyer-type preference signal for this company.
- Accumulate repeated feedback (≥3 times same reason) → persist as a learned exclusion rule.
- Do not permanently blacklist a product, market, or buyer type from a single label.

Never write feedback-derived assumptions into buyer fact fields. Never automatically modify the knowledge document; produce a separate profile-improvement suggestion when useful.

**Before scoring new leads**, check the feedback records table for previously rejected lead patterns. If a new lead shares the same product category, country, or buyer profile as ≥3 previously marked `❌ 不匹配` leads, reduce its AI matching score by 20 points.
