# Group message template

## Draft review notice

After the history fallback creates a draft, send one notice to the originating group:

```text
已根据本群历史消息生成企业画像草稿：{企业名称}｜企业画像草稿｜vN
草稿状态：{ready_for_confirmation 或 draft_incomplete}
历史范围：{from} 至 {to}（{message_count} 条，{complete/stop_reason}）
{待补充或冲突核心字段：...}

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

## Formalization notice

After valid confirmation, separate formal document creation, Base creation/validation, and atomic activation all succeed, send:

```text
企业画像已确认，正式企业知识库已生成并绑定。
确认草稿：vN
正式企业知识库：{formal Docx URL}
AI猎客商机池：{Base URL}
AI猎客线索将在本次确认触发的合规运行或下一次计划任务中，按正式知识库进行匹配推送。
```

Do not send this notice while formalization is pending or unknown. Never present the draft URL as the formal knowledge document.

## Buyer-lead interactive card

Never assemble a lead push in a free-form model response. Run `scripts/lead_card_renderer.py render` after the delivery gate and send only its returned card objects.

### Selection and grouping

- Remove leads with a confirmed prior push message ID and apply the deterministic order from `profile-and-matching.md`.
- Select at most five `匹配动作 = push` records per batch. Never card-render `pool_only` or `exclude`.
- Group selected records by the sanitized `买家国家`; emit one card per country while keeping the five-record batch maximum.
- Keep the sanitized country unchanged. Do not translate, append `国`, or push an empty country.
- Compute and persist the batch ID before rendering. All country cards belong to that batch.

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
📊 AI猎客商机池：
{Base URL}

💬 请在AI猎客商机池中标记每条线索的匹配结果（待确认/✅匹配/❌不匹配），系统将根据你的反馈优化后续推送。

[📊 打开AI猎客商机池]
```

The renderer must require HTTPS, an allowed Feishu/Lark host, and the exact `binding.base_app_token` inside the URL. Do not accept a model-generated or title-searched URL.

### Sending contract

- Send with `receive_id_type = chat_id`, exact guarded `receive_id`, and `msg_type = interactive`.
- When calling Feishu IM OpenAPI directly, compact-serialize the returned `card` object exactly once into `content`. Do not double encode it.
- Do not fall back to plain text when card rendering or sending fails.
- Before rendering and sending, require fresh live-validated `chat-isolation-v1` proofs for both Base and formal knowledge document. Links are usable by authorized members of the bound group but grant no access to recipients outside it.

## Delivery state

Persist the batch as `pending` before the first card send. Pass the batch ID as the sender idempotency key when supported. After each country card, persist its returned message ID immediately. Mark the batch `sent` only when every country card is confirmed.

If sending times out or returns no determinate status, mark the batch `unknown` and stop. Do not automatically resend it. If a later administrative reconciliation confirms delivery, attach the recovered message ID and mark it `sent`; otherwise require an explicit retry decision.

## Example title

`AI猎客｜来自巴西买家的采购机会`
