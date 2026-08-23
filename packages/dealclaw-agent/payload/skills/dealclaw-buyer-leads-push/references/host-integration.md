# Host integration

## Scheduling

Invoke this Skill once per day at `10:00` in `Asia/Shanghai`. Every invocation must carry exactly one originating Feishu `chat_id`. Serialize initialization and business runs by `chat_id`; never run two overlapping jobs for one group.

The scheduler must enumerate configured group bindings, not globally search for knowledge documents or Bases. Do not schedule an unbound group. For `rebind_required`, do not run the buyer workflow; invoke only reminder-delivery reconciliation, then wait for an explicit same-group administrator rebind event.

## Required capabilities

| Operation | Required capability |
|---|---|
| Resolve originating group | Obtain one `chat_id` and read only that group's triggering/quoted content, pinned items, stable-paginated history, and group attachments with source metadata |
| Verify enterprise reviewer | Resolve configured approvers or current group owner/administrator by `open_id`; validate signed action callbacks when used |
| Persist binding and run state | Durable revisioned key-value read and compare-and-set update under the v10 `chat_id` key |
| Read/create knowledge document | Read/fetch by stored token; for Skill-generated resources require creation with an authorized current-group user's `user_access_token`, then call `feishu_permission_fix.py authorize-created` with that same token before publishing |
| Plan creator handoff | Bundled `permission_handoff_guard.py`; distinguish owner, creator app, DealClaw app, target group, and current roles |
| Isolate resource permissions | Verified Feishu client that resolves the real token actor, checks current-chat membership and live ownership, uses Drive permission-public v2, grants DealClaw full access and one `openchat` group edit, and returns a validated `chat-isolation-v3` proof |
| Validate/create Base | `feishu-bitable` by app/table token; use user identity for creation when ownership requires it |
| Reconcile Base schema | Bundled `base_schema_guard.py plan` against the live field list before any write or unlock sweep; apply its add-only plan, never retype user fields |
| Read/upsert records | `feishu-bitable` against the stored table ID and upsert by `唯一去重键` |
| Render lead card | Bundled `lead_card_renderer.py`; accept only delivery-guarded selected `push` records and the exact bound Base URL |
| Send group card | `message.send` or Feishu IM API with `msg_type=interactive` to the exact `chat_id`, preserving the rendered card and returning message ID or unknown-delivery status |
| Query buyers | Bundled Python entry point or generic HTTPS POST capability |
| Score isolated matches | Bundled `profile_matcher.py` or an exactly equivalent deterministic implementation |
| Validate history evidence | Bundled `profile_history_validator.py` or an exactly equivalent deterministic implementation |
| Validate enterprise review | Bundled `profile_confirmation_validator.py` or an exactly equivalent deterministic implementation |
| Continue after confirmation | Bundled `post_confirmation_flow.py`; durable progress/result message IDs and a newly authorized interface call |
| Guard tenant run | Bundled `tenant_run_guard.py`; exact equivalent substitutions are not allowed without passing the same fixtures |
| Retrieve and score leads | Bundled `scoped_lead_pipeline.py`; use this instead of direct scheduled API calls |
| Guard write and send | Bundled `delivery_guard.py` against a freshly reloaded v10 state, exact targets, and run-bound permission proofs no older than 60 seconds |
| Guard resource access | Bundled `resource_permission_guard.py`; persist only its redacted proof and fail closed on any mismatch |
| Guard binding health | Bundled `binding_resource_guard.py`; distinguish deleted/not-found from permission, type, and transient errors; persist `rebind_required` before one same-group reminder |
| Detect unlock intent | Option A Base automation posting `解锁线索 {线索ID}` to the bound group plus Option B scheduled sweep through bundled `contact_unlock_guard.py sweep`; both defined in "Contact unlock delivery (Options A + B)" |
| Guard contact release | Bundled `contact_unlock_guard.py authorize/complete`; no other component may decide a contact release |
| Render contact card | Bundled `contact_card_renderer.py` fed only by guard-authorized `buyer-detail` output |

Do not depend on drive-wide title search. Bot group membership is a prerequisite for some tenant-token group grants, but it is not itself document or Base authorization. Require the exact group collaborator and live proof defined in [resource-access-policy.md](resource-access-policy.md).

## Binding

Follow [binding-and-state.md](binding-and-state.md). The default entry is the intent path: collect the group's hunting intent, run `intent_profile_builder.py assess`, ask once for missing core slots (产品含类目 / 目标国家) or one approval signal for inferred slots, then provision the unified lead pool with `lead_pool_guard.py ensure` and bind with `document_origin = user_intent_profile`. A knowledge document remains an optional enhancement, not a prerequisite.

Accept existing tokens only from URLs explicitly supplied in the current group invocation or pinned in that same group. Resolve and validate candidates by token. Stop on multiple candidates.

When there is no formal document candidate, follow [history-profile-generation.md](history-profile-generation.md). The host must read only the current group's history, validate exactly one company candidate, create the draft form of [company-profile-document.md](company-profile-document.md), and post its link to the same group. Store the token only in onboarding state; do not bind it or create the Base.

Follow [profile-confirmation.md](profile-confirmation.md) for review. Require an authorized same-group approver and exact version/hash for every modification or confirmation. Only then create a separate formal document and Base and atomically activate the binding. The scheduler must enumerate only completed active bindings, never onboarding drafts.

When creating a Base for this Skill, require the authorized current-group user's identity. Treat create + `authorize-created` + proof persistence as one unpublished operation. Persist the token and expose its URL only after `chat-isolation-v3` validation. Do not fall back to an “AI猎客” app creator for generated resources; app-created existing resources use the separate owner-handoff path.

Apply [resource-access-policy.md](resource-access-policy.md) before posting a generated URL. The host must pass the creation token and the same creator `user_access_token` directly to `feishu_permission_fix.py authorize-created`, persist its validated proof, and only then publish. For existing resources, run the handoff plan with a verified owner/full-access actor. Never activate from API update success alone.

All normal runs must address the knowledge document, Base, and table directly through stored tokens. Pass every normalized formal-document read outcome through `binding_resource_guard.py`. A proven deleted/not-found document transitions the exact chat to `rebind_required`, sends one persisted reminder, and re-enters the same-group binding workflow only after explicit administrator intent. A permission failure, renamed/moved resource, type mismatch, or transient error stops separately and does not authorize a search for a replacement.

## Configuration

Store exactly one TradeChina supplier ID inside each encrypted v10 `chat_id` binding as `tradechina_supplier_id`. Require an authorized administrator to configure and contract-check it for that group. Do not set or read `TRADECHINA_SUPPLIER_ID`; never copy an ID from another group, company name, example, or prior global configuration.

Configure one immutable DealClaw application OpenID as `dealclaw_principal`. The DealClaw bot must be in every bound group to receive pushes and read group context, but group membership alone does not grant document/Base access. Generated resources use the creator user's token; `authorize-created` resolves that user's actual OpenID, checks `/members/is_in_chat`, verifies live ownership, grants the exact group and DealClaw principal, and returns the v3 proof. Verify the user token carries the required Drive creation and permission-management scopes before enabling automation. Never assume another app's OpenID equals DealClaw's.

Follow [runtime-orchestration.md](runtime-orchestration.md) for every preview and scheduled run. The host must perform a fresh direct-token formal-document read, run the guard/pipeline, then re-read live formal Docx/Base permissions and recheck state revision immediately before Base write and message send.

Optional analysis Skills do not replace the built-in history evidence path. Use them only after an explicit user request; post their output link to the originating group and require an explicit administrative rebind before it can replace an existing token.

## Contact unlock delivery (Options A + B)

The Skill's unlock chain (`contact_unlock_guard.py authorize` → `buyer-detail` → `contact_card_renderer.py render`) is trigger-agnostic. The host must provide exactly these two delivery mechanisms for the `是否解锁 = 已解锁` Base intent; no third mechanism is permitted.

### Option A — Base automation (primary, real-time)

Configure one automation inside each bound Base's main table (`线索池`, or legacy `买家线索`) (Base → 自动化 → 创建自动化):

1. **Trigger**: 当记录内容修改后，满足条件 `是否解锁 = 已解锁` 且 `解锁推送消息ID 为空`。
2. **Action**: 通过机器人「发送飞书消息」到该 Base 绑定的群（`binding.chat_id`），消息文本为 `解锁线索 {线索ID}`，其中 `{线索ID}` 插入记录的线索ID字段值。
3. Enable the automation and verify the bot is a member of the bound group.

Sender routing rule: a group message `解锁线索 <线索ID>` whose sender is an application/automation (`sender_type = app`) must **not** be treated as a `group_command`. The host discards the message as an actor source, re-reads the live main-table record by `线索ID`, and runs the `base_field` path with `actor_open_id` taken from the record's last-modifier (修改人) person field. Only human-authored (`sender_type = user`) commands may use `group_command`, with the author as `actor_open_id`, after verifying group membership. This prevents automation messages from bypassing the live-record check and keeps 解锁人 attribution accurate.

### Option B — Scheduled sweep (fallback, reconciliation)

Inside every daily run, after normal matching completes, read the bound main table (`线索池`, or legacy `买家线索`) projecting only `线索ID`, `飞书群ID`, `是否解锁`, `解锁推送消息ID`, and the last-modifier person field, filtered to `飞书群ID == current chat_id`. Pass the projection with the current `state.unlocks` to:

```text
python "<skill-root>/contact_unlock_guard.py" sweep < "<sweep-input.json>"
```

Process each returned candidate through the standard unlock chain (`authorize` → `buyer-detail` → `render` → send → `complete` → Base write-back). The `skipped` list is audit-only; never force-process a skipped record. The sweep reconciles automation events that were missed, disabled, or failed to deliver; per-lead idempotency (`state.unlocks` + non-empty `解锁推送消息ID`) guarantees no duplicate contact push between the two mechanisms. Hosts may additionally run the sweep on a shorter interval (15–30 minutes) when faster fallback is required.

After every `contact_pushed` completion, write the record back to the converged state defined in [base-schema.md](base-schema.md): `是否解锁 = 已解锁`, `解锁人`, `解锁时间`, `解锁方式` (`线索池下拉` or `群内指令`), `解锁推送消息ID`. An `unknown` send leaves the record untouched so the next sweep retries it.

## Idempotency

- Serialize runs by `chat_id` and update state with compare-and-set.
- Reject empty lead IDs and upsert by `chat_id:线索ID`.
- Compute and persist the deterministic batch ID before sending.
- Persist every returned message ID immediately.
- Do not automatically retry a send whose delivery status is unknown.
- Preserve existing user-feedback and follow-up fields during upsert.
- Keep supplier IDs, profile caches, feedback cursors, learned rules, candidate sets, and model calls separate by `chat_id`.

## Installation validation

Validate in this order:

1. Run the bundled offline `self-test`, including `feishu_permission_fix.py self-test`; require its Drive v2, actor-identity, membership, exact-group, DealClaw-management, and fail-closed publication contract checks to pass.
2. Run all bundled self-tests, including `permission_handoff_guard.py`, `resource_permission_guard.py`, `binding_resource_guard.py`, `tenant_run_guard.py`, `post_confirmation_flow.py`, `scoped_lead_pipeline.py`, `feedback_rule_builder.py`, and `state_migrator.py`; verify creator/DealClaw mismatch, non-owner user tokens, missing management handoff, actor-outside-chat, public links, stale proofs, wrong groups, token/profile mismatches, and query explosions are rejected.
3. Validate durable state read, compare-and-set, and restart persistence using a test `chat_id`.
4. Bind one test group from exactly one explicit formal knowledge-document URL supplied/pinned by an authorized enterprise approver and either one explicit Base URL or a newly created Base.
5. Test a group with no document candidate: collect bounded history, generate `企业画像草稿｜v1`, post it to that group, and persist only onboarding draft/provenance state. Verify there is no binding or Base.
6. Test history with zero and multiple company candidates. Both must stop without creating a document. Test multiple formal document candidates; it must stop without choosing the first.
7. Test `draft_incomplete` and `ready_for_confirmation`. Neither may query TradeChina, score, create/write Base, or push.
8. Test confirmation from a normal member, another group, an old version, a mismatched hash, a reaction, and a bare “确认”; reject all. Test one authorized exact-version confirmation.
9. Test a modification after confirmation; verify version increments, the old confirmation clears, and formalization cannot use it.
10. Verify the formal document receives a different token from the draft, Base creation occurs only after valid confirmation, both resources have live-validated group-only permission proofs, and the per-group supplier ID is atomically included in the formal binding.
11. After confirmation, verify the progress notice is sent and its message ID persisted before retrieval; verify the pipeline makes a new interface call with the authorization and refuses stale pre-confirmation candidates. Verify completion and zero-result notices, and verify duplicate callbacks resume without another call or batch.
12. Simulate unknown formal-document creation and compare-and-set loss; verify no blind duplicate creation or title-based selection.
13. Verify direct token reads after removing document/Base titles from every discovery path. Verify scheduled runs fail if the guard/pipeline is skipped.
14. Delete the bound formal knowledge Docx in a test group. Verify `binding_resource_guard.py` persists `rebind_required` before the reminder, sends the reminder only to that group, suppresses a second scheduled reminder after its message ID is stored, and blocks buyer query/Base write/push/unlock work. Verify permission denial and transient errors do not enter the deletion path. Then explicitly rebind one new same-group formal document with fresh `chat-isolation-v3` proofs and verify a fresh match runs immediately. Test zero and multiple replacement candidates.
15. Bind two test groups with the same company name but different drafts and different supplier IDs. Verify that each supplier fingerprint, approver set, confirmation, history scope, evidence hash, profile hash, matcher input, feedback cursor, rule set, candidate set, and Base write contains only its own `chat_id` data.
16. Run filtered `contract-check` with a valid supplier, country, and product; record whether `buyerTypeFieldPresent` is true.
17. Run `profile_matcher.py self-test`, verify all nine weights total 100, and inspect one score input against the approved projection.
18. Verify the core push gate: missing product name, category, or target-market country must prevent push even if the numeric score reaches 70. Verify that missing buyer type only removes its 10-point bonus and does not fail the gate.
19. Test MOQ with matching units, mismatched units, below-MOQ quantity, a range, and a bare number without an allowed marker. Only explicit compatible values may score.
20. Run Base upserts using non-sensitive test data, including a missing-ID rejection case and a retry.
21. Run `lead_card_renderer.py self-test`; preview a card containing company, score, intent, products, buyer traits, recommendation reason, the raw Base URL, feedback guidance, and primary button. Verify exhibition name appears only when the sanitized interface field is non-empty.
22. Send one interactive-card test batch, open the Base button, persist its message ID, and verify that rerunning does not resend it. Reject a plain-text fallback, token-in-query Base URL, score/action mismatch, `pool_only` record, or card sent to another group; verify different selected lead sets get different batch IDs.
23. In a designated real test group, use a current member's `user_access_token` to create one draft Docx, one formal Docx, and one Base, and run `authorize-created` immediately on each exact token. Verify the creator is the live owner, the group appears exactly once as `openchat/edit`, DealClaw is owner/full-access, public/link sharing is closed, and `publish_allowed=true`. Then verify any bound-group member can open and edit all three resources; a same-tenant user outside the group cannot open them; and a forwarded URL grants no access. Also verify an outside-group token and a non-owner token both fail before publication.
24. Configure the Option A Base automation on a test Base; set `是否解锁 = 已解锁` on a test record and verify the automation posts `解锁线索 <线索ID>` to the bound group, the host routes it to the `base_field` path (never `group_command`), the contact card arrives once, and the record converges to `已解锁` with `解锁方式 = 线索池下拉` and a non-empty `解锁推送消息ID`. Verify a human-authored `解锁线索` command uses `group_command` with the author as actor and converges with `解锁方式 = 群内指令`. Verify a repeated unlock sends only the duplicate notice.
25. Disable the automation, mark another test record `已解锁`, and run the Option B sweep; verify `contact_unlock_guard.py sweep` returns it as a candidate, the contact card is delivered by the daily run, and a second sweep skips it. Verify cross-group, `未解锁`, already-released, and missing-actor records are skipped with reasons and never processed.
26. Bind a legacy test Base missing the v15 unlock fields; run `base_schema_guard.py plan`, apply its add-only plan, and verify the five unlock fields appear with exact types and `是否解锁` options `未解锁`/`已解锁`. Verify a same-named field with a wrong type or a select missing a mandated option stops Base writes with an administrator-facing report instead of an automatic conversion, and that user-added fields/options survive reconciliation untouched.
27. Verify the unified lead pool: run `lead_pool_guard.py ensure` for a test company and confirm a new pool `企业名称｜企业线索池` is planned with tables `线索池`/`评分明细`/`参展行为`; run it again against the created pool and confirm `reuse`; remove one sub-table and confirm `reconcile_tables` names it. Verify a pool titled for another company is rejected. Run `lead_pool_guard.py map` over guarded test records: confirm `唯一去重键 = company_id:线索ID`, `来源 = AI猎客`, exhibition rows appear only for leads with 报名参展展会, and contact-like/cross-group/duplicate-key inputs are rejected. Run `base_schema_guard.py plan --schema pool` against the live `线索池` field list and apply its add-only plan.
28. Verify the intent path end to end: in a test group with no document, state 主营产品（含类目）+ 目标国家 in one message, confirm `intent_profile_builder.py assess` returns `ready` and the binding activates with `document_origin = user_intent_profile`, empty `knowledge_doc_token`, Base-only permission proofs, and an immediate first match. Test a message missing the target country: exactly one follow-up question is sent asking only for 目标国家, and the reply completes activation. Test an inferred profile: `needs_confirmation` blocks matching until one same-group approval signal arrives, and a rejection signal restarts slot collection. Verify `tenant_run_guard.py` rejects an intent profile missing `intent_confirmation` or carrying a document token.
29. Enable the schedule only after all previous checks pass.

Real Feishu permission, Base, and message tests require a designated test group and authorized identities.
