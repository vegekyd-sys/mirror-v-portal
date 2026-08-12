# Host integration

## Scheduling

Invoke this Skill once per day at `10:00` in `Asia/Shanghai`. Every invocation must carry exactly one originating Feishu `chat_id`. Serialize initialization and business runs by `chat_id`; never run two overlapping jobs for one group.

The scheduler must enumerate configured group bindings, not globally search for knowledge documents or Bases. Do not schedule an unbound group.

## Required capabilities

| Operation | Required capability |
|---|---|
| Resolve originating group | Obtain one `chat_id` and read only that group's triggering/quoted content, pinned items, stable-paginated history, and group attachments with source metadata |
| Verify enterprise reviewer | Resolve configured approvers or current group owner/administrator by `open_id`; validate signed action callbacks when used |
| Persist binding and run state | Durable revisioned key-value read and compare-and-set update under the v7 `chat_id` key |
| Read/create knowledge document | `lark-cli` read/fetch by stored token; create draft and separate formal Docx with user identity and grant the originating group access |
| Isolate resource permissions | Verified Feishu API/client wrapper that closes public/link sharing; lists/adds/updates/deletes collaborators; grants one `openchat` group `edit`; returns live normalized readback for `resource_permission_guard.py` |
| Validate/create Base | `feishu-bitable` by app/table token; use user identity for creation when ownership requires it |
| Read/upsert records | `feishu-bitable` against the stored table ID and upsert by `唯一去重键` |
| Render lead card | Bundled `lead_card_renderer.py`; accept only delivery-guarded selected `push` records and the exact bound Base URL |
| Send group card | `message.send` or Feishu IM API with `msg_type=interactive` to the exact `chat_id`, preserving the rendered card and returning message ID or unknown-delivery status |
| Query buyers | Bundled Python entry point or generic HTTPS POST capability |
| Score isolated matches | Bundled `profile_matcher.py` or an exactly equivalent deterministic implementation |
| Validate history evidence | Bundled `profile_history_validator.py` or an exactly equivalent deterministic implementation |
| Validate enterprise review | Bundled `profile_confirmation_validator.py` or an exactly equivalent deterministic implementation |
| Guard tenant run | Bundled `tenant_run_guard.py`; exact equivalent substitutions are not allowed without passing the same fixtures |
| Retrieve and score leads | Bundled `scoped_lead_pipeline.py`; use this instead of direct scheduled API calls |
| Guard write and send | Bundled `delivery_guard.py` against a freshly reloaded v7 state and exact targets |
| Guard resource access | Bundled `resource_permission_guard.py`; persist only its redacted proof and fail closed on any mismatch |

Do not depend on drive-wide title search. Bot group membership is a prerequisite for some tenant-token group grants, but it is not itself document or Base authorization. Require the exact group collaborator and live proof defined in [resource-access-policy.md](resource-access-policy.md).

## Binding

Follow [binding-and-state.md](binding-and-state.md). Accept existing tokens only from URLs explicitly supplied in the current group invocation or pinned in that same group. Resolve and validate candidates by token. Stop on multiple candidates.

When there is no formal document candidate, follow [history-profile-generation.md](history-profile-generation.md). The host must read only the current group's history, validate exactly one company candidate, create the draft form of [company-profile-document.md](company-profile-document.md), and post its link to the same group. Store the token only in onboarding state; do not bind it or create the Base.

Follow [profile-confirmation.md](profile-confirmation.md) for review. Require an authorized same-group approver and exact version/hash for every modification or confirmation. Only then create a separate formal document and Base and atomically activate the binding. The scheduler must enumerate only completed active bindings, never onboarding drafts.

When creating a Base, use user identity if required, grant the automation identity access, create `买家线索`, and delete the platform's default table only when it was created in the same operation and remains untouched. Persist the app and table tokens atomically with the document token and company name.

Apply [resource-access-policy.md](resource-access-policy.md) before posting any generated resource URL. Clean unexpected explicit collaborators, add exactly `binding.chat_id` as `openchat/edit`, re-read permissions, and run `resource_permission_guard.py`. Store the draft proof under onboarding; store formal Docx and Base proofs under `resource_permissions`. Never activate a binding from API update success alone.

All normal runs must address the knowledge document, Base, and table directly through stored tokens. A permission failure or renamed/moved resource requires an explicit administrative rebind; it does not authorize a search for a replacement.

## Configuration

Store exactly one TradeChina supplier ID inside each encrypted v7 `chat_id` binding as `tradechina_supplier_id`. Require an authorized administrator to configure and contract-check it for that group. Do not set or read `TRADECHINA_SUPPLIER_ID`; never copy an ID from another group, company name, example, or prior global configuration.

Follow [runtime-orchestration.md](runtime-orchestration.md) for every preview and scheduled run. The host must perform a fresh direct-token formal-document read, run the guard/pipeline, then re-read live formal Docx/Base permissions and recheck state revision immediately before Base write and message send.

Optional analysis Skills do not replace the built-in history evidence path. Use them only after an explicit user request; post their output link to the originating group and require an explicit administrative rebind before it can replace an existing token.

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

1. Run the bundled offline `self-test`.
2. Run all bundled self-tests, including `resource_permission_guard.py`, `tenant_run_guard.py`, and `scoped_lead_pipeline.py`; verify public links, wrong/multiple groups, unexpected collaborators, cross-group evidence, multiple companies, unauthorized reviewers, stale versions, token/title/profile-hash mismatches, placeholder supplier IDs, and fixed wrong enterprise titles are rejected.
3. Validate durable state read, compare-and-set, and restart persistence using a test `chat_id`.
4. Bind one test group from exactly one explicit formal knowledge-document URL supplied/pinned by an authorized enterprise approver and either one explicit Base URL or a newly created Base.
5. Test a group with no document candidate: collect bounded history, generate `企业画像草稿｜v1`, post it to that group, and persist only onboarding draft/provenance state. Verify there is no binding or Base.
6. Test history with zero and multiple company candidates. Both must stop without creating a document. Test multiple formal document candidates; it must stop without choosing the first.
7. Test `draft_incomplete` and `ready_for_confirmation`. Neither may query TradeChina, score, create/write Base, or push.
8. Test confirmation from a normal member, another group, an old version, a mismatched hash, a reaction, and a bare “确认”; reject all. Test one authorized exact-version confirmation.
9. Test a modification after confirmation; verify version increments, the old confirmation clears, and formalization cannot use it.
10. Verify the formal document receives a different token from the draft, Base creation occurs only after valid confirmation, both resources have live-validated group-only permission proofs, and the per-group supplier ID is atomically included in the formal binding.
11. Simulate unknown formal-document creation and compare-and-set loss; verify no blind duplicate creation or title-based selection.
12. Verify direct token reads after removing document/Base titles from every discovery path. Verify scheduled runs fail if the guard/pipeline is skipped.
13. Bind two test groups with the same company name but different drafts and different supplier IDs. Verify that each supplier fingerprint, approver set, confirmation, history scope, evidence hash, profile hash, matcher input, feedback cursor, rule set, candidate set, and Base write contains only its own `chat_id` data.
14. Run filtered `contract-check` with a valid supplier, country, and product; record whether `buyerTypeFieldPresent` is true.
15. Run `profile_matcher.py self-test`, verify all nine weights total 100, and inspect one score input against the approved projection.
16. Verify the core push gate: missing product name, category, or target-market country must prevent push even if the numeric score reaches 80. Verify that missing buyer type only removes its 10-point bonus and does not fail the gate.
17. Test MOQ with matching units, mismatched units, below-MOQ quantity, a range, and a bare number without an allowed marker. Only explicit compatible values may score.
18. Run Base upserts using non-sensitive test data, including a missing-ID rejection case and a retry.
19. Run `lead_card_renderer.py self-test`; preview a card containing company, score, intent, products, buyer traits, recommendation reason, the raw Base URL, feedback guidance, and primary button. Verify exhibition name appears only when the sanitized interface field is non-empty.
20. Send one interactive-card test batch, open the Base button, persist its message ID, and verify that rerunning does not resend it. Reject a plain-text fallback, wrong Base URL, `pool_only` record, or card sent to another group.
21. Verify that a bound-group member can open and edit the draft, formal document, and Base; a same-tenant user outside the group cannot open them; and a forwarded URL grants no access.
22. Enable the schedule only after all previous checks pass.

Real Feishu permission, Base, and message tests require a designated test group and authorized identities.
