# Group binding and durable state

Use `chat_id` as the tenant key. Store state under:

```text
dealclaw-buyer-leads-push/v7/<chat_id>
```

The state store must survive process restarts, encrypt data at rest, restrict access to this automation, and support revision-based compare-and-set updates. Serialize initialization and daily runs by `chat_id`.

## State schema

```json
{
  "schema_version": 7,
  "revision": 1,
  "status": "active",
  "chat_id": "oc_xxx",
  "binding": {
    "chat_id": "oc_xxx",
    "company_name": "示例企业",
    "knowledge_doc_token": "docx_xxx",
    "base_app_token": "bascn_xxx",
    "base_table_id": "tbl_xxx",
    "tradechina_supplier_id": "supplier_xxx",
    "bound_at": "2026-08-12T10:00:00+08:00",
    "bound_by": "ou_xxx",
    "document_origin": "formalized_from_group_history"
  },
  "resource_permissions": {
    "policy_version": "chat-isolation-v1",
    "permission_chat_id": "oc_xxx",
    "formal_document": {
      "status": "verified",
      "policy_version": "chat-isolation-v1",
      "permission_chat_id": "oc_xxx",
      "resource_type": "docx",
      "token_fingerprint": "0123456789ab",
      "external_access_entity": "closed",
      "link_share_entity": "closed",
      "group_permission": "edit",
      "verified_at": "2026-08-12T10:00:00+08:00"
    },
    "base": {
      "status": "verified",
      "policy_version": "chat-isolation-v1",
      "permission_chat_id": "oc_xxx",
      "resource_type": "bitable",
      "token_fingerprint": "abcdef012345",
      "external_access_entity": "closed",
      "link_share_entity": "closed",
      "group_permission": "edit",
      "verified_at": "2026-08-12T10:00:00+08:00"
    }
  },
  "onboarding": {
    "status": "completed",
    "company_name": "示例企业",
    "draft_doc_token": "docx_draft_xxx",
    "draft_version": 3,
    "draft_hash": "sha256:...",
    "draft_status": "ready_for_confirmation",
    "draft_permission_proof": {
      "status": "verified",
      "policy_version": "chat-isolation-v1",
      "permission_chat_id": "oc_xxx",
      "resource_type": "docx",
      "token_fingerprint": "fedcba987654",
      "external_access_entity": "closed",
      "link_share_entity": "closed",
      "group_permission": "edit",
      "verified_at": "2026-08-12T10:00:00+08:00"
    },
    "enterprise_approver_open_ids": ["ou_xxx"],
    "confirmation": {
      "actor_open_id": "ou_xxx",
      "message_or_action_id": "om_xxx",
      "confirmed_at": "2026-08-12T10:00:00+08:00",
      "draft_version": 3,
      "draft_hash": "sha256:..."
    },
    "formalization_id": "sha256:...",
    "formalization_status": "completed"
  },
  "profile": {
    "source_chat_id": "oc_xxx",
    "source_doc_token": "docx_xxx",
    "source_kind": "group_history",
    "status": "active",
    "confirmed_draft_version": 3,
    "confirmed_draft_hash": "sha256:...",
    "normalized_hash": "sha256:...",
    "products": [
      {"name": "示例产品", "aliases": ["Example Product"], "categories": ["示例分类"]}
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
    "intent_keywords": ["寻找新供应商"],
    "updated_at": "2026-08-12T10:00:00+08:00"
  },
  "generation": {
    "history_scope": {
      "source_chat_id": "oc_xxx",
      "from": "2025-08-12T00:00:00+08:00",
      "to": "2026-08-12T10:00:00+08:00",
      "message_count": 1234,
      "complete": false,
      "stop_reason": "365_day_limit"
    },
    "evidence_manifest_hash": "sha256:...",
    "history_cursor": "2026-08-12T10:00:00+08:00|om_xxx",
    "generated_at": "2026-08-12T10:00:00+08:00",
    "generated_by": "ou_xxx"
  },
  "feedback": {
    "cursor": "2026-08-12T10:00:00+08:00|record_id",
    "learned_rules": []
  },
  "run": {
    "last_success_at": "2026-08-12T10:00:00+08:00",
    "weight_version": "v7-32-24-18-10-6-4-2-2-2"
  },
  "push": {
    "batches": {}
  }
}
```

Before formalization, `binding` and active `resource_permissions` are absent, `profile.status` is not `active`, and onboarding holds the draft token/version/hash plus its validated permission proof. Do not synthesize empty formal tokens or permission proofs. Do not store buyer records, contact data, API credentials, or raw API responses in this state. Draft/formal document, Base tokens, and `tradechina_supplier_id` are sensitive resource/account identifiers; never print their full values in routine logs or group errors.

## First binding

1. Acquire the initialization lock for the exact `chat_id`. Read only the current invocation's group-scoped content: the triggering message or quoted context and pinned items from the same `chat_id`.
2. Extract Feishu document and Base URLs from those sources. Treat a URL as explicit only when its token is present in that content; title-only mentions are not candidates.
3. Stop before resolution when there are multiple document URL candidates. Report candidate titles when available and masked token fingerprints only to an authorized administrator; never expose full tokens or choose the first.
4. With exactly one candidate, require its source message/pin actor to be an authorized enterprise approver, resolve its token, require an accessible formal Docx title matching `企业名称｜企业知识库`, and apply [resource-access-policy.md](resource-access-policy.md); then handle the Base as steps 7–9 below and record `document_origin = group_supplied_formal`. A title containing `草稿` is not a formal candidate and cannot be bound.
5. With zero candidates, follow [history-profile-generation.md](history-profile-generation.md): resolve exactly one company from same-group evidence, generate `企业名称｜企业画像草稿｜v1`, apply the resource access policy, and atomically store its returned token plus validated proof under onboarding. Do not post the draft URL until the proof succeeds. Zero or multiple company candidates stop without creating a draft.
6. Follow [profile-confirmation.md](profile-confirmation.md). Do not create a formal binding or Base until an authorized enterprise approver confirms the exact current version/hash and the draft is `ready_for_confirmation`.
7. After confirmation, create a separate formal `企业名称｜企业知识库`. Require exactly one supplier ID explicitly configured for this `chat_id` by an authorized administrator; never copy it from a global environment variable, another group, company name, or example. Require zero or one group-supplied Base URL candidate. Stop before resolution when multiple Base URLs are present. If one was supplied, require an accessible Base whose title is `企业名称｜AI猎客商机池`.
8. If no Base URL was supplied, create one Base for the confirmed company using user identity, create/validate `买家线索`, delete only the verified untouched default table, and capture its app/table tokens.
9. Require the formal document and Base company prefixes to match after trimming whitespace and normalizing the separator to `｜`. Apply the resource access policy to each resource and validate live readback independently.
10. Write the complete formal binding, `resource_permissions`, this group's `tradechina_supplier_id`, active profile, and confirmation/formalization provenance with compare-and-set against the pending onboarding revision. If another initializer/formalizer won the race, do not overwrite it; keep duplicate resources private and quarantine them for administrator review.

Never use drive-wide search, title-only search, recent global results, or a resource from another `chat_id` to initialize a binding.

## Profile isolation

- Store one profile object inside the state record for the same `chat_id`; do not maintain a company-name-keyed or document-title-keyed profile cache.
- Require `profile.source_chat_id == state.chat_id == binding.chat_id == invocation.chat_id` before use.
- Require `profile.source_doc_token == binding.knowledge_doc_token`. Refresh from that token on mismatch; never look for another document.
- Require `resource_permissions.permission_chat_id == state.chat_id`, policy `chat-isolation-v1`, and verified formal Docx/Base proofs whose token fingerprints equal the current binding tokens.
- Include `source_chat_id` and `source_doc_token` in the normalized profile hash input.
- Store only the explicit scoring fields defined in `profile-and-matching.md`. Do not copy unrelated company-document text into matcher input or durable profile facts.
- Require onboarding status to be one of `collecting_history`, `draft_incomplete`, `ready_for_confirmation`, `formalizing`, `formalization_unknown`, or `completed`.
- A draft is stored under onboarding and is never `profile.status = active`. Only a separately created formal token with matching confirmation provenance may enter the binding and active profile.
- Require products/categories and target countries in every active v7 profile. Permit an empty `buyer_types` array; it contributes no bonus and does not invalidate the core gate.
- Scope feedback cursor and every learned rule to the same `chat_id`. Never read another group's Base for feedback.
- For a group-history-generated document, persist only its bounded history scope, cursor, evidence-manifest hash, timestamps, and validated scoring projection. Do not persist the full message archive or personal contact data.

When upgrading from v1–v6, create a new v7 state record per `chat_id`. Carry only a formal, non-draft document binding and confirmed push message IDs. Do not migrate a process-wide or unknown supplier ID. Require an authorized administrator to bind the correct supplier ID separately for every group. A history-generated document created before explicit enterprise confirmation must be downgraded to onboarding draft state and must not remain active. Re-read every scoring field and require v7 confirmation before reactivation; do not migrate cached profile facts, scores, or learned rules.

When upgrading an earlier v7 installation that used public-link editing, mark every binding inactive before its next run. Resolve only its stored tokens, close external/link access, clean collaborators, add the exact bound `openchat` group, validate fresh proofs, and then reactivate with compare-and-set. Never keep an old `anyone_*` result or infer a proof from successful access by the automation identity.

## Normal runs

- Read tokens from the binding and address resources directly by token.
- Refuse any run whose formal Docx or Base permission proof is missing, not verified, cross-group, public-link enabled, or token-fingerprint mismatched. Refresh only by direct token readback; never search for another resource.
- Run `tenant_run_guard.py` on the current invocation, v7 state, and direct formal-document projection. Then run `scoped_lead_pipeline.py`; do not invoke the buyer API directly from an unguarded model step.
- Check resource type, accessibility, title prefix, and stored company name on every run.
- Re-read the bound document and rebuild the isolated nine-dimension profile for this `chat_id` before scoring.
- Stop before TradeChina query unless binding tokens exist, the formal profile is `active`, and origin provenance is valid. For `formalized_from_group_history`, additionally require onboarding `completed` with matching confirmation version/hash.
- Stop when `binding.tradechina_supplier_id` is absent, placeholder-like, or not part of this exact `chat_id` state. Never fall back to `TRADECHINA_SUPPLIER_ID`.
- Stop on mismatch. Do not search for a replacement.
- Update state only with the revision read at run start. Reload and reconcile if compare-and-set fails.

## Rebinding

Require an explicit administrator instruction naming the `chat_id` and replacement group-scoped URL. Validate the replacement before changing state. Record the actor and time. Never treat a missing resource or renamed title as automatic permission to rebind.

## Push idempotency

Build the batch ID as SHA-256 over UTF-8 text:

```text
chat_id + "\n" + Asia/Shanghai calendar date + "\n" + sorted unique lead IDs joined by "\n"
```

Store each batch as `pending`, `sent`, or `unknown` with its lead IDs, created time, country card groups, and message IDs.

1. Persist `pending` before sending.
2. If the sender supports an idempotency key, pass the batch ID.
3. Persist each returned message ID immediately.
4. Mark `sent` only after every card has a confirmed message ID.
5. Mark `unknown` when delivery times out or the host cannot determine the result. Do not automatically resend an `unknown` batch; require reconciliation or an explicit administrator retry.
6. Skip any lead whose successful push record already has a message ID, even when it appears in a later query.
