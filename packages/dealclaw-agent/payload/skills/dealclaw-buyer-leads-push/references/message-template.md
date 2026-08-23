# Group message template

## Intent profile follow-up

When `intent_profile_builder.py assess` returns `needs_input`, send its `question` verbatim to the originating group exactly once:

```text
为了给您精准推荐买家，请回复补充：{缺失槽位，如 主营产品及所属类目、目标国家/市场}。例如「主营绗缝被（床上用品），目标巴西」。
```

When it returns `needs_confirmation` (core slots inferred from group history or public material rather than stated by the user), post the profile summary plus its `question`:

```text
以上画像信息来自群历史/公开资料推断，请确认是否准确；回复「没问题/继续」即按此方向推荐买家。
```

Send each question at most once per pending assessment; never re-ask on a schedule. A recognized approval signal activates the profile; a rejection signal restarts slot collection; an unrelated message changes nothing.

## Draft review notice

After the history fallback creates a draft, send one notice to the originating group:

```text
已根据本群历史消息生成企业画像草稿：{企业名称}｜企业画像草稿｜vN
草稿状态：{ready_for_confirmation 或 draft_incomplete}
历史范围：{from} 至 {to}（{message_count} 条，{complete/stop_reason}）
{待补充或冲突核心字段：...}

✅ 确认企业画像后，AI猎客将立即为您持续匹配并推送优质的海外买家采购商机，助您高效开拓市场、精准触达客户。

请由本群企业画像确认人回复：
确认企业画像 vN
或
修改企业画像 vN：<具体字段和新值>

企业确认前不会生成正式知识库，也不会查询或推送买家线索。
```

Include only the draft Feishu document URL. Do not include full `chat_id`, document/Base tokens, message IDs, author IDs, or history excerpts in the notice. A `draft_incomplete` notice must say that confirmation is unavailable until the listed core fields are supplied. Sending this notice is separate from buyer-lead batch idempotency.

Before sending the URL, require a current `onboarding.draft_permission_proof` produced from live permission readback for this exact `chat_id`. State that the link is available only to authorized members of the current bound group. Do not send a URL for an unverified resource.

## Revision notice

After an authorized modification, send the new draft URL/version, changed field names, current readiness, and remaining missing/conflicted core fields. State that all earlier confirmations are invalid and require `确认企业画像 vN+1`.

## Deleted knowledge-document rebind notice

After `binding_resource_guard.py evaluate` proves `deleted` or `not_found` and the `rebind_required` state patch commits, send only its exact reminder to the originating group:

```text
当前群绑定的企业知识库已被删除或无法通过原 token 找到，AI猎客已暂停。
请由本群管理员发送新的企业知识库飞书文档链接并回复“重新绑定企业知识库”；如果群内没有现成文档，系统将只根据本群历史消息重新生成企业画像草稿，待确认后完成绑定。
原企业线索池和本群历史反馈将保留；重新绑定完成前不会查询或推送买家线索。
```

Persist the returned message ID through `binding_resource_guard.py complete-reminder`. Do not include the deleted token, supplier ID, buyer values, another group's resources, or a globally searched replacement. After `reminder_status = sent`, scheduled runs must not repeat the reminder. Permission denial, type mismatch, and transient read failure use their own operational error messages and must not use this deletion notice.

## Formalization and immediate-matching notice

After valid confirmation, separate formal document creation, Base creation/validation, and atomic activation all succeed, run `post_confirmation_flow.py start` and send its exact progress message:

```text
企业画像已确认，{企业名称}的正式企业知识库已生成并绑定。
正式企业知识库：{formal Docx URL}
企业线索池：{Base URL}
正在根据正式企业画像重新匹配合适的买家采购需求，完成后将在本群推送结果。
```

Do not send this notice while formalization is pending or unknown. Never present the draft URL as the formal knowledge document. Persist the notice message ID before interface retrieval. Do not say “下一次计划任务”; this run starts immediately after the notice is confirmed sent.

## Immediate-matching result notice

After fresh retrieval, scoring, Base write, card rendering, and determinate card sends finish, call `post_confirmation_flow.py complete` and send its exact result message. It reports fresh records evaluated, records entering the current group's opportunity pool, and newly pushed leads. Send a completion notice even when the pushed count is zero.

If the post-confirmation run fails after the progress notice, call `post_confirmation_flow.py fail` and send its exact sanitized failure message. It must state that the formal profile exists, identify only the operational stage/error code, and say that old leads were not substituted. Never include raw buyer values, tokens, supplier IDs, or exception text.

## Buyer-lead interactive card

Never assemble a lead push in a free-form model response. Run `scripts/lead_card_renderer.py render` after the delivery gate and send only its returned card objects.

### Selection and grouping

- Remove leads with a confirmed prior push message ID and apply the deterministic order from `profile-and-matching.md`.
- Select at most five `匹配动作 = push` records per batch. Never card-render `pool_only` or `exclude`.
- Group selected records by the sanitized `买家国家`; emit one card per country while keeping the five-record batch maximum.
- Keep the sanitized country unchanged. Do not translate, append `国`, or push an empty country.
- Let the renderer compute the batch ID after the final selected lead set is fixed. Persist that exact returned ID as `pending` before sending; all country cards carry the same ID.

### Card title

```text
AI猎客｜来自{买家国家}买家的采购机会
```

Use the blue header template and wide-screen mode.

### Buyer block

Render each selected lead in deterministic rank order:

```text
🥇 买家公司：{买家公司名称}    ⭐ 匹配分数：{AI匹配分}/100

需求意向：{需求意向}

关注产品：{关注产品}

买家特征：{买家特征}

报名参展：{报名参展展会}

💡 推荐理由：{根据评分明细确定性生成的理由}
```

Requirements:

- Require non-empty `买家公司名称`, numeric authoritative `AI匹配分` from 0 to 100, exactly nine authoritative `评分明细` dimensions, and non-empty `买家国家`.
- Show `需求意向`, `关注产品`, and `买家特征` only when the sanitized interface value is non-empty. Do not display placeholders or invent missing facts.
- Show `报名参展` only when sanitized `报名参展展会` is non-empty. That field may exist only when `hasHomeLifeRegisterLog` was integer `1` and the interface returned a non-empty `exhibitionName`; never infer registration from buyer text.
- Generate the displayed recommendation reason deterministically from authoritative nine-dimension `评分明细`: core product name, product category, and target-market country first; then buyer type and other non-zero bonuses or feedback deductions. Never accept a model-written reason and never change the score or gate.
- Escape buyer-controlled Markdown, mentions, and links. Truncate display text only at the renderer's fixed limits; retain full sanitized values in the bound Base.
- Separate multiple buyer blocks with a divider.

### Footer and action

End every card with a divider, the exact raw bound Base URL, this fixed guidance, and one primary URL button:

```text
📊 企业线索池：
{Base URL}

💬 请在企业线索池中标记每条线索的匹配结果（待确认/✅匹配/❌不匹配），系统将根据你的反馈优化后续推送。

🔓 需要买家联系方式？在企业线索池把该线索的「是否解锁」改为「已解锁」，或在本群回复「解锁线索 线索ID」，系统会把该买家的联系方式推送到本群。

[📊 打开企业线索池]
```

The renderer must require HTTPS, an allowed Feishu/Lark host, no credential/fragment/nonstandard port, and a decoded path exactly equal to `/base/<binding.base_app_token>`. The token appearing only in a query string, fragment, hostname, or larger path is invalid. Do not accept a model-generated or title-searched URL.

### Sending contract

- Send with `receive_id_type = chat_id`, exact guarded `receive_id`, and `msg_type = interactive`.
- When calling Feishu IM OpenAPI directly, compact-serialize the returned `card` object exactly once into `content`. Do not double encode it.
- Do not fall back to plain text when card rendering or sending fails.
- Before rendering and sending, require distinct live-validated `chat-isolation-v3` proofs for both Base and formal knowledge document, proving group edit plus DealClaw management, bound to the current run and no older than 60 seconds.

## Buyer contact unlock card

Never assemble a contact release in a free-form model response. Run `scripts/contact_unlock_guard.py authorize` first, then `scripts/tradechina_buyer_leads.py buyer-detail` with the returned `--unlock-id`, then `scripts/contact_card_renderer.py render` with both outputs, and send only its returned card object.

### Trigger sources

1. **Base field** — a member of the bound group sets the lead record's `是否解锁` to `已解锁` in the main table (`线索池`, or legacy `买家线索`). Delivery uses the two mechanisms in [host-integration.md](host-integration.md) "Contact unlock delivery (Options A + B)": the Base automation posts `解锁线索 {线索ID}` to the bound group in real time, and the scheduled sweep reconciles anything missed. For both, the host reads the live record and passes it as `base_record`; the guard requires `飞书群ID == chat_id`, exact `线索ID` equality, and an empty prior unlock for that lead. An automation/bot-authored `解锁线索` message (`sender_type = app`) is never an actor source — it only tells the host to re-read the record; the actor is the record's last modifier.
2. **Group command** — a human member (`sender_type = user`) of the bound group replies `解锁线索 <线索ID>` in the originating group. The host must verify the author is a member of that same group and pass their open ID as `actor_open_id`.

A model decision, a schedule by itself, a push batch, an automation/bot-authored message, or a cross-group request is never an unlock trigger.

### Card title

```text
AI猎客｜买家联系方式已解锁
```

Use the green header template and wide-screen mode, with `enable_forward = false`.

### Card body

```text
🔓 买家公司：{买家公司名称}
线索ID：{线索ID}

👤 联系人：{联系人姓名}
💼 职位：{职位}
📧 邮箱：{邮箱}（已验证/未验证）
📱 电话：{电话}（已验证/未验证）
💬 WhatsApp：{WhatsApp}（已验证/未验证）
🌐 公司官网：{公司官网}

联系方式来自 TradeChina 买家详情，仅发送至本群，不会写入企业线索池。请合规使用，勿二次分发。
```

- Show each contact row only when the interface value is non-empty. Append the validation badge only from `emailValid`/`mobileValid`/`whatsappValid` integer `1` (已验证) or `0` (未验证); omit the badge when the flag is absent.
- The renderer refuses to render when every contact value is empty; send the no-contact notice instead.
- Escape buyer-controlled Markdown. Contact values are display-only and must not be written to the Base, durable state, or logs.

### No-contact notice

When the detail response carries no contact values, send this group text instead of a card:

```text
线索 {线索ID} 已解锁，但买家暂未提供联系方式。
```

### Duplicate unlock notice

When the guard rejects an unlock because the lead was already released, send:

```text
线索 {线索ID} 的联系方式已于 {上次解锁日期} 推送到本群，请查看历史消息，无需重复解锁。
```

### Contact delivery state

Persist `state.unlocks[线索ID] = pending_push` before the contact-card send, keyed by the guard's `unlock_id` as the sender idempotency key. Persist the returned message ID immediately via `contact_unlock_guard.py complete` (`status = contact_pushed`); on an indeterminate send persist `status = unknown` and stop without automatic resend. Never store contact values inside `unlocks`.

Only after `contact_pushed`, write the lead's Base record back to the converged state: `是否解锁 = 已解锁`, `解锁人`, `解锁时间`, `解锁方式` (`线索池下拉` or `群内指令`), and `解锁推送消息ID`. This applies to both trigger paths; a `群内指令` unlock must therefore leave the record visibly `已解锁` in the 企业线索池. An `unknown` or failed send leaves `是否解锁` untouched.

## Delivery state

Persist the batch as `pending` before the first card send. Pass the batch ID as the sender idempotency key when supported. After each country card, persist its returned message ID immediately. Mark the batch `sent` only when every country card is confirmed.

If sending times out or returns no determinate status, mark the batch `unknown` and stop. Do not automatically resend it. If a later administrative reconciliation confirms delivery, attach the recovered message ID and mark it `sent`; otherwise require an explicit retry decision.

## Example title

`AI猎客｜来自巴西买家的采购机会`
