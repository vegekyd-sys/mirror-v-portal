# Build a company profile from one group's history

Use this fallback only when the current `chat_id` has no persisted formal knowledge-document binding, no active onboarding draft, and the same group contains zero explicit or pinned knowledge-document URL candidates. A Base URL does not count as a knowledge document.

## Hard boundary

- Acquire the per-`chat_id` initialization lock before reading history. Recheck binding and document candidates under the lock immediately before creation.
- Read messages, pinned items, quoted messages, and accessible attachments only from the invocation `chat_id`. Reject any item whose returned `chat_id` differs.
- Do not use drive-wide search, another group's messages, contacts, a company-name lookup, a website crawl, model memory, or external enrichment.
- Do not send group history or attachments to an unapproved external service.
- Never extract or persist personal email, phone, WhatsApp, WeChat, social accounts, or other direct contact data.

## History collection

Read newest-to-oldest with stable pagination until the earliest available message, a configured retention boundary, 365 days, or 10,000 messages is reached, whichever occurs first. The host may use a smaller documented privacy/retention limit, but it must not silently claim the history is complete. Save only this audit scope in state:

```json
{
  "source_chat_id": "oc_xxx",
  "from": "2025-08-12T00:00:00+08:00",
  "to": "2026-08-12T10:00:00+08:00",
  "message_count": 1234,
  "complete": false,
  "stop_reason": "365_day_limit"
}
```

Normalize messages into deterministic order `(sent_at ascending, message_id ascending)`. Resolve edits to their latest visible revision, retain deletion markers without deleted text, and expand quoted-message text only when the quoted message belongs to the same `chat_id`.

## Evidence model

Every accepted claim must include at least one evidence item:

```json
{
  "source_chat_id": "oc_xxx",
  "message_id": "om_xxx",
  "sent_at": "2026-08-10T09:30:00+08:00",
  "author_id": "ou_xxx",
  "excerpt": "我们的主打产品是绗缝被，属于床上用品",
  "source_kind": "message"
}
```

`source_kind` is one of `message`, `pinned_message`, or `group_attachment`. Keep excerpts short and sufficient to verify the fact. The ordinary generated document may show a short excerpt and time. Keep the full manifest only in a restricted transient work area while generating, persist its canonical hash and cursor, then discard it according to host retention policy.

Accept a fact only when it is explicit. Do not translate, infer synonyms, derive company facts from a sender's employer, turn a discussed prospect into the supplier, or treat a market-news mention as the group's target market.

## Company resolution

Create company candidates only from explicit self-identification such as “我们公司是…”, an explicit supplier/company profile shared for this group, an official company name in a group attachment, or a group administrator's unambiguous statement.

- Exactly one normalized company candidate: continue.
- Zero candidates: stop with `当前群历史消息无法确认唯一企业名称，请管理员在群内明确公司全称或提供企业知识库文档`.
- More than one candidate: stop with `当前群历史消息出现多个企业候选，已停止生成；请管理员明确本群对应企业` and report candidate names plus evidence times. Never select the first, newest, most frequent, or group-name match.

## Claim resolution

Supported fields are the document slots in [company-profile-document.md](company-profile-document.md) and the nine-dimension profile fields in [profile-and-matching.md](profile-and-matching.md).

- Deduplicate identical normalized values while retaining all evidence.
- For singleton fields, distinct values are a conflict. A later value replaces an earlier value only when the later message explicitly corrects or supersedes it and cites the old statement; otherwise mark the slot `待确认`.
- For repeated fields such as products, categories, certifications, markets, buyer types, and materials, multiple values are additive unless a message explicitly rejects one.
- Attach each product category to a specific product. A free-floating category can appear in the document as `待关联`, but cannot enter matcher input.
- Treat “existing market” and “target market” as different fields. Only explicit development/target-market language may populate `target_countries`.
- A country mentioned only as an exhibition location, customer example, past shipment, or market news is not a target market unless the message explicitly says the supplier wants to develop it.
- Aliases, buyer types, tags, profile keywords, intent keywords, and MOQ must be explicit in the same group evidence. Do not generate them from semantics.
- MOQ requires one positive number and a unit. Conflicting quantities or units remain `待确认` and score zero.

Run `profile_history_validator.py validate` on the evidence manifest. Its `draft_status`, `confirmation_ready`, `missing_core_fields`, and deterministic matcher projection are authoritative. The projection is for review only until enterprise confirmation and formalization finish.

## Draft readiness

- `ready_for_confirmation`: exactly one company candidate; at least one confirmed product name; that same product has at least one confirmed category; at least one confirmed target-market country; no unresolved conflict in those core claims. This is still a draft and cannot run AI buyer matching.
- `draft_incomplete`: company is unique, but a core field is missing or conflicted. Create the document for review, mark it `草稿｜核心字段待补充`, and request explicit modifications.
- Do not create any document when the company candidate is zero or ambiguous.

Optional missing fields do not block confirmation readiness; they appear as `待确认` and later contribute zero to scoring.

## Create and publish the draft

1. Recheck under the same `chat_id` lock that no binding and no explicit/pinned document candidate now exists. Stop on one candidate and bind it; stop on multiple candidates.
2. Build the document exactly from [company-profile-document.md](company-profile-document.md), using user identity for creation.
3. Title it `企业名称｜企业画像草稿｜v1`. Always put `草稿｜尚未经过企业确认，不可用于AI猎客推送` at the top.
4. Grant the originating group access and post the created document link to that exact group. Do not grant another group based on company name.
5. Apply [resource-access-policy.md](resource-access-policy.md) to the created draft and validate live readback. Capture the returned token as `onboarding.draft_doc_token`; it is not `binding.knowledge_doc_token`. Persist the validated `draft_permission_proof`, version, draft hash, readiness, evidence hash, and history scope atomically. Do not post the URL or create the Base when permission validation fails.
6. If compare-and-set loses, do not overwrite the winner; archive or mark the duplicate generated resource for administrator review.
7. Continue only through [profile-confirmation.md](profile-confirmation.md). Create the separate formal knowledge document, Base, and active binding only after a valid enterprise confirmation.

## Refresh policy

Do not silently regenerate the draft on every run. While onboarding, read it only by `draft_doc_token`. A history refresh or modification requires an authorized same-group instruction and uses only messages newer than the stored cursor plus the current draft. Preserve human-authored content outside automation-owned blocks, append an audit entry, validate again, increment the version, and clear any prior confirmation. Only the confirmation/formalization workflow can produce `active`.
