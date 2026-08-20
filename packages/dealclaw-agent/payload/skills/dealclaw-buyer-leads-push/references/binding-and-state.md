# Group binding and durable state

Use `chat_id` as the tenant key. Store state under:

```text
dealclaw-buyer-leads-push/v10/<chat_id>
```

The state store must survive process restarts, encrypt data at rest, restrict access to this automation, and support revision-based compare-and-set updates. Serialize initialization and daily runs by `chat_id`.

## State schema

```json
{
  "schema_version": 10,
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
  "binding_recovery": null,
  "resource_permissions": {
    "policy_version": "chat-isolation-v3",
    "permission_chat_id": "oc_xxx",
    "formal_document": {
      "status": "verified",
      "policy_version": "chat-isolation-v3",
      "permission_chat_id": "oc_xxx",
      "resource_type": "docx",
      "token_fingerprint": "0123456789ab",
      "external_access_entity": "closed",
      "link_share_entity": "closed",
      "group_permission": "edit",
      "observed_at": "2026-08-12T09:59:40+08:00",
      "verified_at": "2026-08-12T10:00:00+08:00",
      "expires_at": "2026-08-12T10:00:40+08:00",
      "verification_context_id": "binding:oc_xxx:1",
      "observation_id": "permission-read-docx-1",
      "owner_fingerprint": "111111111111",
      "permission_actor_fingerprint": "222222222222",
      "permission_actor_role": "owner",
      "permission_credential_type": "user_access_token",
      "automation_principal_fingerprint": "333333333333",
      "automation_role": "full_access"
    },
    "base": {
      "status": "verified",
      "policy_version": "chat-isolation-v3",
      "permission_chat_id": "oc_xxx",
      "resource_type": "bitable",
      "token_fingerprint": "abcdef012345",
      "external_access_entity": "closed",
      "link_share_entity": "closed",
      "group_permission": "edit",
      "observed_at": "2026-08-12T09:59:41+08:00",
      "verified_at": "2026-08-12T10:00:00+08:00",
      "expires_at": "2026-08-12T10:00:41+08:00",
      "verification_context_id": "binding:oc_xxx:1",
      "observation_id": "permission-read-base-1",
      "owner_fingerprint": "111111111111",
      "permission_actor_fingerprint": "222222222222",
      "permission_actor_role": "owner",
      "permission_credential_type": "user_access_token",
      "automation_principal_fingerprint": "333333333333",
      "automation_role": "full_access"
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
      "policy_version": "chat-isolation-v3",
      "permission_chat_id": "oc_xxx",
      "resource_type": "docx",
      "token_fingerprint": "fedcba987654",
      "external_access_entity": "closed",
      "link_share_entity": "closed",
      "group_permission": "edit",
      "observed_at": "2026-08-12T09:59:40+08:00",
      "verified_at": "2026-08-12T10:00:00+08:00",
      "expires_at": "2026-08-12T10:00:40+08:00",
      "verification_context_id": "draft:oc_xxx:3",
      "observation_id": "permission-read-draft-3",
      "owner_fingerprint": "111111111111",
      "permission_actor_fingerprint": "222222222222",
      "permission_actor_role": "owner",
      "permission_credential_type": "user_access_token",
      "automation_principal_fingerprint": "333333333333",
      "automation_role": "full_access"
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
    "feedback_cursor": "2026-08-12T10:00:00+08:00|record_id",
    "learned_rules": [],
    "rule_evidence": []
  },
  "run": {
    "last_success_at": "2026-08-12T10:00:00+08:00",
    "weight_version": "v10-32-24-18-10-6-4-2-2-2"
  },
  "post_confirmation": {
    "flow_version": "post-confirmation-v1",
    "operation_id": "sha256:...",
    "formalization_id": "sha256:...",
    "confirmation_event_id": "om_xxx",
    "status": "completed",
    "started_at": "2026-08-12T10:00:00+08:00",
    "formal_doc_fingerprint": "0123456789ab",
    "progress_message_id": "om_progress",
    "interface_call_id": "sha256:...",
    "fresh_record_count": 25,
    "pool_written_count": 8,
    "pushed_lead_count": 5,
    "batch_id": "sha256:...",
    "push_message_ids": ["om_card_1"],
    "completed_at": "2026-08-12T10:02:00+08:00"
  },
  "push": {
    "batches": {}
  },
  "unlocks": {
    "2077311290711822337": {
      "unlock_id": "sha256:...",
      "chat_id": "oc_xxx",
      "actor_open_id": "ou_xxx",
      "trigger": "base_field",
      "requested_at": "2026-08-12T22:00:00+08:00",
      "status": "contact_pushed",
      "push_message_id": "om_xxx",
      "completed_at": "2026-08-12T22:01:00+08:00"
    }
  }
}
```

The optional `binding_recovery` object is additive to schema v10 and defaults to `null`. When a direct-token read proves that the formal knowledge Docx is deleted or not found, `binding_resource_guard.py` sets state `status = rebind_required` and stores only `reason`, the failed token fingerprint, detection time, and reminder-delivery metadata. Keep the full inactive token only in the existing binding; never put it in reminder text or routine logs. No buyer retrieval, scoring, feedback read, Base write, push, or unlock sweep is permitted while `status = rebind_required`.

The `unlocks` map is additive to schema v10 and defaults to `{}` for states created before it existed. It is keyed by `线索ID` and scoped by the state record's own `chat_id`; require `unlocks[<id>].chat_id == state.chat_id` before use. It stores only unlock metadata (authorization ID, actor, trigger, timestamps, delivery status, message ID). Never store contact values, buyer names, or raw detail responses inside `unlocks`. Persist `pending_push` before the contact-card send and finalize with `contact_unlock_guard.py complete`; a lead whose entry already holds `contact_pushed` or `pending_push` must not be released again — send the duplicate-unlock notice instead.

Before formalization, `binding` and active `resource_permissions` are absent, `profile.status` is not `active`, and onboarding holds the draft token/version/hash plus its validated permission proof. Do not synthesize empty formal tokens or permission proofs. Do not store buyer records, contact data, API credentials, or raw API responses in this state. Draft/formal document, Base tokens, and `tradechina_supplier_id` are sensitive resource/account identifiers; never print their full values in routine logs or group errors.

## First binding

1. Acquire the initialization lock for the exact `chat_id`. Read only the current invocation's group-scoped content: the triggering message or quoted context and pinned items from the same `chat_id`.
2. Extract Feishu document and Base URLs from those sources. Treat a URL as explicit only when its token is present in that content; title-only mentions are not candidates.
3. Stop before resolution when there are multiple document URL candidates. Report candidate titles when available and masked token fingerprints only to an authorized administrator; never expose full tokens or choose the first.
4. With exactly one candidate, require its source message/pin actor to be an authorized enterprise approver, resolve its token, require an accessible formal Docx title matching `企业名称｜企业知识库`, and apply [resource-access-policy.md](resource-access-policy.md); then handle the Base as steps 7–9 below and record `document_origin = group_supplied_formal`. A title containing `草稿` is not a formal candidate and cannot be bound.
5. With zero candidates, follow [history-profile-generation.md](history-profile-generation.md): resolve exactly one company from same-group evidence, generate `企业名称｜企业画像草稿｜v1`, apply the resource access policy, and atomically store its returned token plus validated proof under onboarding. Do not post the draft URL until the proof succeeds. Zero or multiple company candidates stop without creating a draft.
6. Follow [profile-confirmation.md](profile-confirmation.md). Do not create a formal binding or Base until an authorized enterprise approver confirms the exact current version/hash and the draft is `ready_for_confirmation`.
7. After confirmation, create a separate formal `企业名称｜企业知识库`. Require exactly one supplier ID explicitly configured for this `chat_id` by an authorized administrator; never copy it from a global environment variable, another group, company name, or example. Require zero or one group-supplied Base URL candidate. Stop before resolution when multiple Base URLs are present. If one was supplied, require an accessible Base whose title is `企业名称｜企业线索池`.
8. If no Base URL was supplied, create one Base for the confirmed company using user identity, create/validate `买家线索`, delete only the verified untouched default table, and capture its app/table tokens.
9. Require the formal document and Base company prefixes to match after trimming whitespace and normalizing the separator to `｜`. Apply the resource access policy to each resource and validate live readback independently.
10. Write the complete formal binding, `resource_permissions`, this group's `tradechina_supplier_id`, active profile, and confirmation/formalization provenance with compare-and-set against the pending onboarding revision. If another initializer/formalizer won the race, do not overwrite it; keep duplicate resources private and quarantine them for administrator review.

Never use drive-wide search, title-only search, recent global results, or a resource from another `chat_id` to initialize a binding.

## Profile isolation

- Store one profile object inside the state record for the same `chat_id`; do not maintain a company-name-keyed or document-title-keyed profile cache.
- Require `profile.source_chat_id == state.chat_id == binding.chat_id == invocation.chat_id` before use.
- Require `profile.source_doc_token == binding.knowledge_doc_token`. Refresh from that token on mismatch; never look for another document.
- Require `resource_permissions.permission_chat_id == state.chat_id`, policy `chat-isolation-v3`, verified creator/actor/DealClaw management roles, and formal Docx/Base token fingerprints equal to the binding tokens.
- Include `source_chat_id` and `source_doc_token` in the normalized profile hash input.
- Store only the explicit scoring fields defined in `profile-and-matching.md`. Do not copy unrelated company-document text into matcher input or durable profile facts.
- Require onboarding status to be one of `collecting_history`, `draft_incomplete`, `ready_for_confirmation`, `formalizing`, `formalization_unknown`, or `completed`.
- A draft is stored under onboarding and is never `profile.status = active`. Only a separately created formal token with matching confirmation provenance may enter the binding and active profile.
- Require products/categories and target countries in every active v10 profile. Permit an empty `buyer_types` array; it contributes no bonus and does not invalidate the core gate.
- Scope feedback cursor and every learned rule to the same `chat_id`. Never read another group's Base for feedback.
- For a group-history-generated document, persist only its bounded history scope, cursor, evidence-manifest hash, timestamps, and validated scoring projection. Do not persist the full message archive or personal contact data.

For v1–v6, do not use the automated migrator. Re-onboard into v10 per `chat_id`, rebind the supplier ID, re-read all scoring fields, and require enterprise confirmation.

For v7–v9, stop that group's scheduler and atomically change the exact legacy state to `inactive_for_v10_migration`. Close public/link access, repair collaborators, complete the creator-to-DealClaw management handoff, and obtain two distinct `chat-isolation-v3` readbacks no older than 60 seconds with context `migration:<chat_id>:<source revision>`. Then run `state_migrator.py migrate`. Never migrate an active legacy state, missing handoff, unknown/global supplier ID, public-link proof, or cross-group resource.

## Normal runs

- Read tokens from the binding and address resources directly by token.
- Normalize the direct formal-document read as `accessible`, `deleted`, `not_found`, `permission_denied`, `type_mismatch`, or `transient_error`, then run `binding_resource_guard.py evaluate`. Only `deleted` and `not_found` may create `rebind_required`; permission and transient failures remain repair/retry errors.
- Commit the returned `rebind_required` patch with compare-and-set before sending its exact same-group reminder. Persist the returned reminder message ID with `binding_resource_guard.py complete-reminder`. A later scheduled run must suppress another reminder after `reminder_status = sent`.
- If state is `rebind_required`, stop before reading feedback, accessing the Base, querying TradeChina, scoring, pushing, or sweeping unlocks. Only the explicit rebind flow below may reactivate it.
- Refuse any run whose formal Docx or Base permission proof is missing, not verified, cross-group, public-link enabled, or token-fingerprint mismatched. Refresh only by direct token readback; never search for another resource.
- Run `tenant_run_guard.py` on the current invocation, v10 state, and direct formal-document projection. Then run `scoped_lead_pipeline.py`; do not invoke the buyer API directly from an unguarded model step.
- Check resource type, accessibility, title prefix, and stored company name on every run.
- Re-read the bound document and rebuild the isolated nine-dimension profile for this `chat_id` before scoring.
- Stop before TradeChina query unless binding tokens exist, the formal profile is `active`, and origin provenance is valid. For `formalized_from_group_history`, additionally require onboarding `completed` with matching confirmation version/hash.
- Stop when `binding.tradechina_supplier_id` is absent, placeholder-like, or not part of this exact `chat_id` state. Never fall back to `TRADECHINA_SUPPLIER_ID`.
- Stop on mismatch. Do not search for a replacement.
- Update state only with the revision read at run start. Reload and reconcile if compare-and-set fails.

## Immediate post-confirmation run

Treat one accepted confirmation as one durable operation keyed by `SHA-256(chat_id + formalization_id + confirmation message/action ID)`. After formal activation, persist `awaiting_progress_notice`; send the exact progress notice and persist its message ID before changing to `progress_notified`. Only `post_confirmation_flow.py authorize` may then authorize the first buyer retrieval. Pass that authorization to `scoped_lead_pipeline.py`, which records a unique `interface_call_id` and proves that pre-confirmation candidates were not reused.

Continue through the ordinary live-permission, Base-write, card, and batch gates. Persist `completed` and the exact result notice after determinate delivery, including zero-push results. Persist `failed` for retrieval/write/render failures and `unknown` for an indeterminate card send. A duplicate confirmation callback with the same operation ID resumes the stored stage; it never creates another formal document, interface call, or card batch. A different confirmation operation cannot overwrite an unfinished one.

## Rebinding

For a deleted/not-found bound knowledge document, use this sequence:

1. Persist `status = rebind_required` with `binding_recovery.reason = knowledge_document_deleted` before notifying the group. Preserve the existing Base binding, feedback cursor/rules, push history, and unlock metadata.
2. Send the exact reminder from [message-template.md](message-template.md) only to the originating `chat_id`, persist its message ID, and suppress repeat scheduled reminders. If sending is indeterminate, keep `reminder_status = pending` and reconcile delivery before retrying.
3. Require an explicit same-group administrator command `重新绑定企业知识库` or `重新绑定企业知识库 <飞书文档URL>`. A deletion signal alone is not permission to replace a token.
4. Re-enter the ordinary binding candidate rules for this same `chat_id`: inspect only the URL in that command, same-group explicit URLs, and same-group pinned items. Stop on multiple candidates. Never use a global title search or select the first result.
5. With exactly one candidate, require an authorized source actor, validate the formal title/company, parse required profile fields, and obtain a fresh `chat-isolation-v3` permission proof for its returned token. Reuse the existing Base only when its token, company prefix, schema, and fresh `chat-isolation-v3` proof remain valid; otherwise require an explicit Base repair/rebind.
6. With zero candidates, run the same-group history onboarding path, create a new draft, require exact-version enterprise confirmation, and create a separate formal knowledge document. Do not bind the draft. The existing Base may be reused only under the validation in step 5.
7. Atomically replace only the validated formal-document binding/provenance and dependent profile fields, clear `binding_recovery`, increment the revision, and set `status = active`. Record the rebind actor/time and the previous token fingerprint; never retain deleted-document content as the active profile.
8. Immediately run a fresh guarded buyer match after activation. Do not reuse candidates, scores, batches, or permission proofs from before the deletion or rebind.

For other rebind reasons, still require an explicit administrator instruction naming the `chat_id` and replacement group-scoped URL. Validate the replacement before changing state. Record the actor and time. Never treat a missing resource, renamed title, permission failure, or transient read error as automatic permission to replace a token.

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
