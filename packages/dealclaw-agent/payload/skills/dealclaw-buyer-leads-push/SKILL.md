---
name: "dealclaw-buyer-leads-push"
description: Bind one isolated company profile and TradeChina supplier ID per Feishu group; create chat-isolated Feishu documents and Bases that only the exact bound openchat group may edit; build and confirm a profile from same-group history when needed; then run guarded retrieval, nine-dimension scoring, and deterministic Feishu interactive-card lead pushes with buyer details, conditional exhibition data, Base links, buttons, and feedback guidance. Use for group binding, group-only permissions, profile onboarding, tenant-safe previews or daily pushes, lead cards, lead-pool maintenance, supplier-binding repair, or match-feedback processing.
---

# Buyer Leads Feishu Push

Run a one-company-per-group buyer-lead workflow without inventing buyer facts. Treat the bound knowledge document as the profile source, the bound company Base as the lead system of record, and `chat_id` as the tenant boundary.

## Fixed rules

- Use the document title pattern `企业名称｜企业知识库` and Base title pattern `企业名称｜AI猎客商机池`.
- Persist one binding per group as `chat_id -> company_name + knowledge_doc_token + base_app_token + base_table_id + tradechina_supplier_id`.
- Never globally search documents or Bases. Never select the first item from multiple candidates.
- When the current group has no document candidate, use only that group's historical messages, pinned items, and group attachments to build an evidence-backed draft. Multiple company candidates are an error; do not choose one.
- Never use a generated draft as the knowledge-document binding. Require an authorized same-group enterprise confirmation for the exact draft version/hash, then create a separate formal document and bind its returned token.
- Never read a global `TRADECHINA_SUPPLIER_ID`. Require one administrator-confirmed `tradechina_supplier_id` inside this exact `chat_id` binding.
- After binding, read and write only by the stored tokens. A title search is never a runtime fallback.
- Isolate profile facts, hashes, learned rules, candidate leads, prompts, and run state by `chat_id`. Never reuse another group's profile or cache, even when the company name is identical.
- Score only the nine dimensions defined in [references/profile-and-matching.md](references/profile-and-matching.md). Make product name, product category, and target-market country the core push gate. Treat buyer type as a secondary bonus; auxiliary dimensions may improve ranking but cannot replace a missing core match.
- Use one Base table named `买家线索`. Delete an auto-created default table only immediately after creating a new Base and only after verifying that it is the untouched default table.
- Apply [references/resource-access-policy.md](references/resource-access-policy.md) to every draft Docx, formal Docx, and Base. Keep the resource private, close external and link access, grant `edit` to exactly `binding.chat_id` as `member_type = openchat`, remove unexpected explicit collaborators, and validate the live readback with `scripts/resource_permission_guard.py`. Never use `anyone_*` or `tenant_*` link sharing. Do not post, bind, activate, query, write, or push when the permission proof is absent or invalid.
- Run daily at `10:00` in `Asia/Shanghai` only when invoked by a host scheduler.
- Query the most recent 7 days by default. Require a configured TradeChina `supplierId`; do not use a packaged default.
- Push at most 5 new leads per group and use 80 as the default push threshold.
- Reject buyer records without a non-empty interface lead ID.
- Never invent, enrich, infer, translate, or complete buyer facts.
- Never expose or persist email, phone, WhatsApp, WeChat, social account, website, or other direct contact data.
- Keep interface facts separate from AI match score and match reason.

## Required host capabilities

This Skill runs inside the DealClaw/OpenClaw Agent runtime and requires:

- **Group context/history reader** — obtain exactly one originating `chat_id`; read only its triggering/quoted content, pinned items, stable-paginated historical messages, and group attachments; return `chat_id`, message ID, author ID, and timezone-qualified sent time for every item.
- **Group role/action reader** — verify group owner/administrator or configured enterprise approvers and receive same-group modification/confirmation commands or signed callbacks.
- **Durable state store** — atomically read, compare-and-set, and update state keyed by `dealclaw-buyer-leads-push/v7/<chat_id>`.
- **Verified Feishu permission client** — read/create a Docx by token, update public permissions, add/update/delete/list collaborators, and return normalized live permission snapshots. Do not assume an unverified `lark-cli` permission subcommand.
- **`feishu-bitable` Skill** — validate, create, and read/write a Base by app/table token.
- **`message.send`** — send to the originating group and return a message ID or an explicit unknown-delivery result.
- **`scripts/tradechina_buyer_leads.py`** — query TradeChina and emit sanitized records.
- **`scripts/profile_matcher.py`** — enforce `chat_id` isolation, calculate the nine-dimension score, and enforce the core push gate.
- **`scripts/profile_history_validator.py`** — reject ambiguous/cross-group history evidence and decide whether a draft is incomplete or ready for enterprise confirmation.
- **`scripts/profile_confirmation_validator.py`** — reject unauthorized, cross-group, stale-version, hash-mismatched, ambiguous, or unsigned profile review events before state transition.
- **`scripts/tenant_run_guard.py`** — require exact equality across invocation group, v7 binding, formal document token/title/hash, active profile, Base, and per-group supplier binding.
- **`scripts/scoped_lead_pipeline.py`** — derive queries only from the guarded formal profile, call TradeChina with that group's supplier ID, sanitize records, and run deterministic scoring.
- **`scripts/delivery_guard.py`** — reload and validate the current state, target group/Base, and every pipeline provenance field immediately before write/send.
- **`scripts/resource_permission_guard.py`** — reject public links, external access, wrong/multiple groups, unexpected collaborators, and token/chat mismatches before a resource can be posted or activated.
- **`scripts/lead_card_renderer.py`** — accept only delivery-guarded `push` records and render deterministic Feishu interactive cards with safe fields, conditional exhibition display, the exact bound Base URL, button, and feedback guidance.

The history fallback is part of this Skill and does not authorize external company research. Optional company-analysis Skills may be used only after an explicit user request and their output cannot silently replace the current group's evidence.

## Workflow

1. Obtain exactly one originating group `chat_id`. Stop if the invocation is unbound to a group or could refer to multiple groups.
2. Read [references/binding-and-state.md](references/binding-and-state.md). Load the state for this exact `chat_id`.
3. If no binding exists, inspect only document/Base URLs explicitly supplied in the current group invocation or pinned in that same group. Stop on multiple knowledge-document candidates. With exactly one formal knowledge document supplied/pinned by an authorized enterprise approver, validate its content and its live group-isolated permissions before binding it with `document_origin = group_supplied_formal`. With zero, read [references/history-profile-generation.md](references/history-profile-generation.md), collect only this group's history, validate the evidence with `profile_history_validator.py`, and create `企业名称｜企业画像草稿｜v1` following [references/company-profile-document.md](references/company-profile-document.md). Apply the resource access policy and persist `onboarding.draft_permission_proof` before posting the draft URL. Do not create a draft when the company candidate is zero or multiple. Persist draft/onboarding state only; do not bind the draft token or create a Base.
4. For a generated draft, read [references/profile-confirmation.md](references/profile-confirmation.md). Accept changes or confirmation only from an authorized enterprise approver in the same `chat_id` and only for the current version/hash. Every modification creates a new draft version and clears prior confirmation. When confirmed, create a separate `企业名称｜企业知识库`, create/validate the Base, require this group's administrator-confirmed TradeChina supplier ID, apply the resource access policy independently to the formal Docx and Base, and atomically persist their verified proofs with all formal identifiers. Stop before buyer retrieval until state is `active`.
5. If a binding exists, verify that its stored `chat_id` equals the invocation `chat_id`, state is `active`, and both formal resource permission proofs match this exact `chat_id` and the stored token fingerprints. Read the formal knowledge document directly by `knowledge_doc_token` and access the Base directly by `base_app_token + base_table_id`. Do not rediscover either resource by title.
6. Extract the company name from the formal document title prefix and require an exact normalized match with `binding.company_name`. On mismatch, permission failure, moved/deleted resource, or token/type mismatch, stop and require an explicit rebind. Do not silently repair the binding.
7. Read table-aware formal-document blocks and extract the current group's explicit products/categories, target countries, buyer types, MOQ, desired buyer tags, buyer-profile keywords, and purchase-intent keywords. Require non-empty product names, product categories, target countries, valid origin provenance, and `profile.status == active`; history-formalized documents additionally require matching enterprise confirmation version/hash. Otherwise stop with `当前群企业画像尚未完成企业确认或核心字段不完整，禁止猎客推送`. Buyer type and other secondary dimensions may be absent and then score zero. Store the profile with its source `chat_id`, formal document token, provenance kind, and status; compare its normalized hash with the same group's state and never place profile facts in a cross-group cache.
8. Read feedback fields from records in the bound `买家线索` table changed after this group's `feedback_cursor`, filtering `飞书群ID == chat_id`. Reject any feedback record whose group ID differs. Apply dimension-scoped rules from [references/profile-and-matching.md](references/profile-and-matching.md), then persist them under the same `chat_id` after a successful run.
9. Read [references/runtime-orchestration.md](references/runtime-orchestration.md). Build one runtime context only from the invocation `chat_id`, its v7 state, and a fresh direct-token formal-document read. Run `tenant_run_guard.py validate`; stop on any mismatch.
10. Run `scoped_lead_pipeline.py run` by absolute path as the mandatory normal entry point. It resolves each verified target country, queries every verified target-country/product pair with `binding.tradechina_supplier_id`, sanitizes records, attaches this `chat_id`, and calls the matcher. Never call the buyer API directly from a free-form model step or scheduled run.
11. Use only guarded pipeline output. Never pass raw buyer responses into a model, log, message, or Base write. Treat its company name, profile hash, run-context ID, scores, gate, action, MOQ, and evidence as authoritative.
12. Immediately before upsert/send, re-read live permissions for the formal Docx and Base, validate both snapshots with `resource_permission_guard.py`, reload current state, and pass the returned redacted proofs to `delivery_guard.py validate`. Require the same revision, target group/Base, company, profile hash, run-context ID, record group IDs, and live group-isolated access. Follow the matcher action: upsert `pool_only` without notification, upsert and notify only `push`, and do not upsert `exclude`. Preserve user-feedback and follow-up fields.
13. Read [references/message-template.md](references/message-template.md). Build a deterministic batch ID, persist the pending batch, select at most 5 not-previously-sent `push` leads, and run `lead_card_renderer.py render` with the exact `delivery_guard.py` input and bound Base URL. Send only its returned `interactive` cards to the exact `chat_id`; serialize each returned `card` object once as message `content` when using Feishu OpenAPI. Persist returned message IDs before marking the batch sent. Never fall back to plain text for lead pushes and never blindly retry an unknown-delivery send.
14. Atomically update profile hash, feedback cursor, learned rules, successful-run time, and push state. Do not replace a newer state revision.

## Interface commands

Resolve `<skill-root>` from the installed Skill/package location. Store the supplier ID only inside encrypted v7 state for the exact `chat_id`. Direct API commands are diagnostics and require an explicit ID from a designated test binding.

```text
python "<skill-root>/tradechina_buyer_leads.py" resolve-country --name "巴西"
python "<skill-root>/tradechina_buyer_leads.py" buyers --supplier-id "<test binding ID>" --country-id "<id>" --product-keyword "绗缝被"
python "<skill-root>/tradechina_buyer_leads.py" contract-check --supplier-id "<test binding ID>" --country-id "<id>" --product-keyword "绗缝被"
python "<skill-root>/tradechina_buyer_leads.py" self-test
python "<skill-root>/profile_matcher.py" self-test
python "<skill-root>/profile_matcher.py" score < "<isolated-input.json>"
python "<skill-root>/profile_history_validator.py" self-test
python "<skill-root>/profile_history_validator.py" validate < "<group-history-evidence.json>"
python "<skill-root>/profile_confirmation_validator.py" self-test
python "<skill-root>/profile_confirmation_validator.py" validate < "<profile-review-event.json>"
python "<skill-root>/tenant_run_guard.py" self-test
python "<skill-root>/tenant_run_guard.py" validate < "<v7-run-context.json>"
python "<skill-root>/scoped_lead_pipeline.py" self-test
python "<skill-root>/scoped_lead_pipeline.py" run < "<v7-pipeline-input.json>"
python "<skill-root>/delivery_guard.py" self-test
python "<skill-root>/delivery_guard.py" validate < "<v7-delivery-input.json>"
python "<skill-root>/resource_permission_guard.py" self-test
python "<skill-root>/resource_permission_guard.py" validate < "<permission-snapshot.json>"
python "<skill-root>/lead_card_renderer.py" self-test
python "<skill-root>/lead_card_renderer.py" render < "<guarded-card-input.json>"
```

Prefer the root compatibility entry point. If unavailable, use `<skill-root>/scripts/tradechina_buyer_leads.py`. If neither exists, reinstall the complete Skill package. Never assume the current working directory is the Skill directory.

## Runtime preflight

Before the first business run, verify:

1. The invocation resolves exactly one group and can read explicit links, pinned items, stable-paginated history, and attachments from that group while returning source `chat_id` and message metadata.
2. Durable state supports atomic read/update keyed by `chat_id`.
3. The bound knowledge document can be read by token.
4. The bound or newly created Base can be accessed by token, add fields, and upsert records.
5. The current v7 `chat_id` binding contains its own authorized TradeChina supplier ID, and no process-wide supplier fallback is consumed.
6. The bound formal profile is `active`, has valid origin provenance, and contains at least one explicit product name, its explicit product category, and an explicit target-market country. A history-formalized profile must also have matching enterprise confirmation version/hash. Buyer type and other secondary dimensions may be absent and score zero.
7. The TradeChina script is executable or the host can make HTTPS POST requests. `contract-check` must report whether the live response contains `buyerType`.
8. The bundled history, confirmation, tenant guard, scoped pipeline, delivery guard, and profile matcher tests all pass. Do not schedule a host that cannot execute the guarded chain.
9. The Feishu permission client can close external/link sharing; list, add, update, and delete collaborators; grant the exact `openchat` group `edit`; and return live readback data accepted by `resource_permission_guard.py`.
10. Message sending returns a message ID or explicitly reports unknown delivery.
11. The sender supports Feishu `interactive` cards, preserves the renderer's card JSON without model rewriting, and can open the exact bound Base URL from the primary button.

Only enable scheduling after all checks and a manual preview succeed. Read [references/host-integration.md](references/host-integration.md) before installation.

## Safety and failure handling

- Leave absent interface fields blank; never substitute `未提供` into stored buyer data.
- Treat `buyerTag` as opaque text and display it as `买家特征`.
- Preserve `buyerType` as `买家类型`; use it for matching only when it is a non-empty interface value. Never infer it from `buyerTag`, company name, company profile, or purchase intent.
- Preserve `buyerCountry` unchanged. Format `productList` only from returned product names.
- Derive `线索明确MOQ` only with the strict marker/number/same-unit parser. Never infer MOQ from a bare number, range, budget, annual volume, or unrelated text.
- Set `报名参展展会` only when `hasHomeLifeRegisterLog` is integer `1` and `exhibitionName` is non-empty.
- On binding, document, permission, Base, state, or API failure, do not send stale leads. Emit a concise operational error without buyer values.
- Treat a missing, stale, caller-asserted, cross-group, public-link, or token-mismatched permission proof as terminal. Keep the resource private and require permission repair; never globally search for a replacement.
- A generated `draft` document is useful for review but is never a buyer-query, scoring, Base-write, or push authorization.
- A confirmation is valid only for the exact current draft version/hash and an authorized approver. A later edit, unknown document edit, bare confirmation, reaction, or cross-group callback invalidates or fails confirmation.
- Refuse a push whose profile enterprise name, group IDs, profile hash, run-context ID, or state revision differs from guarded pipeline output. Never let a model supply or rewrite the profile enterprise name.
- Retry reads safely. Retry writes only with the same unique key and expected state revision.
- Require explicit administrative rebind intent before replacing tokens in an existing binding.
