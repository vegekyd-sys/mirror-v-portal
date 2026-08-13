# Mandatory v10 runtime orchestration

Use the bundled executable guard and pipeline for every preview and scheduled run. Skill prose alone is not a tenant boundary.

## Host inputs

1. Obtain exactly one invocation `chat_id`.
2. Load `dealclaw-buyer-leads-push/v10/<chat_id>` directly and capture its revision.
3. Require current formal Docx and Base permission proofs whose `permission_chat_id` and token fingerprints match this state; refresh them from live readback when the host policy requires revalidation.
4. Read the formal Docx directly through `binding.knowledge_doc_token`; never search by title.
5. Parse the scoring projection from that fresh read and compute its canonical `profile_hash` using the binding-time canonicalization.
6. Supply the invocation, v10 state, formal token/title/profile hash, fixed `run_at`, and timezone to `scoped_lead_pipeline.py run`.

The pipeline invokes `tenant_run_guard.py` before network retrieval. The host may also run the guard separately for a redacted preview.

## Enforced equalities

```text
invocation_chat_id = state.chat_id = binding.chat_id = profile.source_chat_id
binding.knowledge_doc_token = formal_document.token = profile.source_doc_token
binding.company_name + "｜企业知识库" = formal_document.title
formal_document.profile_hash = profile.normalized_hash
resource_permissions.permission_chat_id = invocation_chat_id
resource_permissions.formal_document.token_fingerprint = fingerprint(binding.knowledge_doc_token)
resource_permissions.base.token_fingerprint = fingerprint(binding.base_app_token)
```

Also require v10 active state, valid origin/confirmation provenance, non-empty Base tokens, one non-placeholder `binding.tradechina_supplier_id`, and `chat-isolation-v3` proofs showing both exact-group edit access and DealClaw owner/full-access management for both active resources. Any mismatch is terminal.

## Retrieval and scoring

The pipeline takes product names and target countries only from the verified formal profile, resolves countries, calls every `target country × product name` query with this binding's supplier ID, sanitizes records, and calls `profile_matcher.py`. It rejects more than 20 products, 20 target countries, 100 query jobs, 10 pages per job, or 500 possible page requests per run.

It returns `画像企业名称` only from the verified binding/formal title. Keep this separate from API `buyerCompany`, stored as `买家公司名称`. It also returns redacted supplier/document/Base fingerprints and a deterministic `run_context_id`.

Do not call the buyer endpoint from a free-form agent step. Do not pass a global supplier environment variable. Do not accept model-generated company, profile, or query values.

For the first run immediately after a generated profile is confirmed, require `post_confirmation_authorization` from `post_confirmation_flow.py authorize`. The persisted progress notice must already have a confirmed message ID. The pipeline must return `post_confirmation_execution` with the exact operation, formalization, and interface-call IDs, `fresh_interface_call = true`, and `pre_confirmation_candidates_reused = false`. A missing, stale, cross-profile, or cross-revision authorization is terminal. Scheduled and explicit later runs do not supply this authorization.

## Pre-write and pre-send gate

Immediately before Base upsert and each group send, generate distinct permission-read request IDs and re-read the live public permissions and collaborators for both active resources. Validate each through `resource_permission_guard.py` using the current `run_context_id`, then reload state and execute `delivery_guard.py validate` with those outputs as `live_permission_proofs` plus a timezone-qualified `delivery_at`. Both proofs must be distinct, bound to this run, and at most 60 seconds old at delivery. Require the revision used by the guarded run to remain current and active. For every record require:

```text
飞书群ID = invocation_chat_id
企业画像群ID = invocation_chat_id
画像企业名称 = guarded company_name
企业画像版本 = guarded profile_hash
运行上下文ID = guarded run_context_id
```

Write only to the guarded `base_app_token + base_table_id` and send only to the guarded `chat_id`. If the revision changed, discard the batch and restart from a fresh direct-token document read. Log only fingerprints, never full tokens or supplier IDs.

After the delivery gate succeeds, select no more than five `push` lead IDs and pass the full delivery-gate input, selected IDs, and exact bound Base URL to `lead_card_renderer.py`. The renderer validates the exact `/base/<token>` path, recomputes the raw/final score, core gate and action, and returns a batch ID tied to the actual selected lead set. Persist and send only its `interactive` card output. Do not let a model rebuild, summarize, translate, or enrich buyer fields in the rendered card.

For an immediate post-confirmation run, call `post_confirmation_flow.py complete` only after determinate card delivery (or a valid zero-card result) and send its result notice. Call `fail` on a later-stage error and persist its failure/unknown patch before notifying the group.

## Contact unlock runs

A contact unlock is an event-driven flow, never part of a scheduled matching run, and never triggered by a model decision. Accepted triggers are exactly:

1. A live `买家线索` record read showing `是否解锁 = 已解锁`, `飞书群ID = invocation chat_id`, and an empty `解锁推送消息ID` (`trigger = base_field`).
2. A verified same-group member command `解锁线索 <线索ID>` (`trigger = group_command`).

Enforced equalities for every unlock:

```text
invocation_chat_id = state.chat_id = base_record.飞书群ID
base_record.线索ID = requested lead_id = buyer-detail 线索ID
buyer-detail unlock_id = contact_unlock_guard unlock_id
state.unlocks[lead_id].status not in (pending_push, contact_pushed)
```

Chain: `contact_unlock_guard.py authorize` → persist `state.unlocks[lead_id] = pending_push` with the returned `unlock_id` → `tradechina_buyer_leads.py buyer-detail --supplier-id <binding.tradechina_supplier_id> --trend-id <lead_id> --unlock-id <unlock_id>` → `contact_card_renderer.py render` → send only the returned `interactive` card to the exact `chat_id` → `contact_unlock_guard.py complete` with the confirmed message ID → write the Base unlock system fields. Persist `unknown` and stop on an indeterminate send; never auto-resend. When the detail response carries no contact values, skip rendering and send the no-contact notice, still completing the unlock state.

Contact values are display-only in the group card. Never write them to the Base, durable state, prompts, or logs. When TradeChina ships a server-side unlock API, insert that call between guard authorization and the detail retrieval without changing this contract.
