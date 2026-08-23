# Enterprise review and formalization

Use a two-document workflow. A history-derived draft is never the bound knowledge document. Create the formal `企业名称｜企业知识库` only after an authorized enterprise approver confirms one exact draft version.

## Approver identity

Accept confirmation or modification only from an actor whose Feishu `open_id` is either:

1. configured in this `chat_id`'s `enterprise_approver_open_ids`; or
2. currently verified by the host as the originating group's owner/administrator.

If the host cannot verify either condition, stop with `无法验证企业确认人身份，请配置本群企业画像确认人`. Group membership, document edit access, message frequency, or being the original requester is not sufficient by itself.

## State machine

```text
unbound
  -> collecting_history
  -> draft_incomplete | ready_for_confirmation
  -> ready_for_confirmation (after each validated modification)
  -> formalizing
  -> active
```

- `draft_incomplete`: one company is known, but a core field is missing/conflicted. The enterprise may submit changes, but confirmation cannot formalize it.
- `ready_for_confirmation`: all three core requirements are explicit and non-conflicting, but no confirmation exists. Buyer retrieval and push remain blocked.
- `formalizing`: an exact version has been confirmed and formal document creation is pending. Block concurrent edits, confirmation, and buyer runs.
- `active`: the formal document token and Base tokens are atomically bound. Only this state may run AI buyer matching.

Never represent a pre-confirmation draft as `active`.

## Draft creation

Create `企业名称｜企业画像草稿｜v1` using [company-profile-document.md](company-profile-document.md). Apply [resource-access-policy.md](resource-access-policy.md) and persist the token plus validated `draft_permission_proof` under onboarding state; do not post the URL before validation and do not write it to `binding.knowledge_doc_token`. Do not create the company Base yet.

Post the draft URL and exact version to the originating group. Request one of these explicit same-group commands:

```text
确认企业画像 v1
修改企业画像 v1：<具体字段和新值>
```

The host may expose equivalent signed interactive actions, but the callback must contain `chat_id`, draft version, draft hash/fingerprint, and actor `open_id` and must be protected against replay.

## Modification

For a valid `修改企业画像 vN` command:

1. Require the command `chat_id`, actor authorization, `draft_doc_token`, version, and stored draft hash to match current onboarding state.
2. Treat the modification message itself as same-group enterprise evidence. Do not accept a vague command such as “改一下产品” without explicit values.
3. Re-run `profile_history_validator.py`; update only named fields and retain unaffected evidence.
4. Update the draft document through its stored token, append an audit row, increment to `vN+1`, and calculate a new normalized draft hash.
5. Clear any prior confirmation and return to `draft_incomplete` or `ready_for_confirmation`.
6. Post the new version and current missing/conflicted core fields. Require a new confirmation for the new version.

Direct edits to the draft document are accepted only when the host can verify every changed revision author as an authorized approver and can transform the edits into the same evidence manifest. Otherwise, detect the hash mismatch and ask for a group modification command; never formalize unknown edits.

Multiple or concurrent modification commands use revision compare-and-set. The loser reloads the current version and must not overwrite it.

## Confirmation

For a valid `确认企业画像 vN` command or signed equivalent:

1. Require the event to originate from the same `chat_id` and an authorized approver.
2. Require `vN`, `draft_doc_token`, current document hash, stored `draft_hash`, and state revision to match.
3. Re-read the draft directly by token and run the evidence/core-field validator again.
4. Reject confirmation when status is `draft_incomplete`, a conflict exists in company/product/category/target country, or the document contains unverified edits.
5. Persist the confirmation actor, message/action ID, time, exact version, and hash before starting formalization. Build `formalization_id = SHA-256(chat_id + "\n" + draft_doc_token + "\n" + version + "\n" + draft_hash)`.
6. Move state to `formalizing` with compare-and-set. Do not accept another confirmation or edit while it is pending.

An older confirmation never applies to a newer draft. A bare “确认”, emoji, reaction, document view, or silence is not confirmation.

## Formal document and activation

1. Create a new Feishu Docx from the confirmed snapshot, titled `企业名称｜企业知识库`. Remove the draft warning and add `企业确认版本：vN`, confirmer display name, and confirmation time. Do not rename or reuse the draft token.
2. Grant the originating group access and capture the returned formal document token.
3. Create or validate the company's unified lead pool `企业名称｜企业线索池` (`线索池` / `评分明细` / `参展行为`) through `lead_pool_guard.py ensure` and capture its app/table tokens only now.
4. Require an authorized administrator to provide the TradeChina supplier ID for this exact `chat_id`. Validate it with a filtered contract check. Do not read a global environment fallback or copy another group's value.
5. Apply the group-isolated resource access policy to the separate formal Docx and Base. Atomically persist the complete binding `chat_id -> company_name + knowledge_doc_token + base_app_token + base_table_id + tradechina_supplier_id`, both validated permission proofs, set profile status `active`, and store confirmation/formalization provenance. Any permission failure leaves the state inactive.
6. Retain the draft as review history; do not treat it as a runtime source. After activation, call `post_confirmation_flow.py start` with the exact confirmation result and canonical formal document/Base URLs. Compare-and-set its `state_patch` under `post_confirmation`, then send its exact progress message to the same group with its idempotency key. Persist the returned message ID and set `post_confirmation.status = progress_notified` before any buyer API call.
7. Call `post_confirmation_flow.py authorize` against the newly reloaded active state. Immediately pass its authorization to a new `scoped_lead_pipeline.py run`. This call must query the interface again using only the newly bound formal profile and this group's supplier ID. Never reuse pre-confirmation candidates, API responses, scores, Base-write plans, selected lead IDs, or card batches. Do not defer this first run to the next scheduled task.
8. Complete the normal delivery permission gate, Base upsert, card render, pending-batch persistence, and send sequence. Then call `post_confirmation_flow.py complete`, persist its state patch, and send its exact result notice with the returned idempotency key—even when zero new leads meet the push threshold.
9. On retrieval, permission, write, render, or send failure after the progress notice, call `post_confirmation_flow.py fail`. Persist `failed`; use `unknown` for an indeterminate card send. Send the sanitized failure result to the same group and resume the persisted stage after repair. Never silently fall back to old candidates or start another formalization.

All later reads/writes use only the formal stored tokens and this group's supplier binding. Buyer query, scoring, Base upsert, and push may start only after the `active` state and normal preflight both pass.

Persist a pending external-operation record before document/Base creation. When creation delivery is unknown, set formalization status `unknown` and require reconciliation; do not blindly create a second formal document or Base. If compare-and-set loses after creation, quarantine the duplicate resource for administrator review and never select it by title.

## Intent confirmation

The intent path (`document_origin = user_intent_profile`) replaces the two-document workflow when the group has no knowledge document. It is handled by `scripts/intent_profile_builder.py`:

1. Collect the hunting intent from the triggering message and same-group history and run `intent_profile_builder.py assess`. Core slots are `products` (each with at least one 类目) and `target_countries`.
2. `needs_input` — send the guard's follow-up question to the group exactly once, asking only for the missing slots, and wait for the user's reply. Merge the reply into the intent and re-assess. Never re-ask on a schedule.
3. `needs_confirmation` — one or more core slots carry `origin = inferred`. Post the profile summary with the guard's confirmation question and wait for exactly one same-group approval signal recognized by `intent_profile_builder.py confirm` (`这批没问题`, `继续`, `就按这个方向`, …). Rejection signals (`不对`, `别推`, `停止`, …) take priority over any approval word in the same message and restart slot collection. Ambiguous messages change nothing.
4. `ready` — every core slot is `user_stated`; no confirmation round is needed.
5. Activate the profile with `source_kind = user_intent`, empty `source_doc_token`, and `intent_confirmation = {actor_open_id, signal, confirmed_at}` where `signal` is `user_stated` for a ready profile or `approved` after a recognized approval. Only an `active` intent profile passes `tenant_run_guard.py`; a `pending_confirmation` profile blocks buyer runs.
6. New user messages that change core slots produce a new assessment and a new `intent_confirmation`; the old confirmation never carries over.

## Changes after activation

An edit to the formal document does not silently change the active matcher profile. Require an authorized `发起企业画像更新` command, copy the current formal snapshot into a new draft version, apply verified changes, and repeat confirmation and formalization. Until the new formal token is atomically bound, continue using the previous active token or pause pushes when the requested change affects a core field. Never search for the updated document by title.
