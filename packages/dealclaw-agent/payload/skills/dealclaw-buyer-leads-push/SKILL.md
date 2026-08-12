---
name: "dealclaw-buyer-leads-push"
description: Read the company knowledge document in a Feishu group, query TradeChina buyer leads, create or update a per-company Feishu Base lead pool, apply strict field whitelisting and contact-data removal, rank and deduplicate leads, and prepare or send the daily group recommendation. Use for manual previews, daily 10:00 Asia/Shanghai buyer-lead runs, company profile refreshes, lead-pool maintenance, or match-feedback processing in one-company-per-group Feishu workflows.
---

# Buyer Leads Feishu Push

Run a one-company-per-group buyer-lead workflow without inventing buyer facts. Treat the company knowledge document as the profile source and the company Base as the lead system of record.

## Fixed rules

- Use the document title pattern `企业名称｜企业知识库`.
- Use the Base title pattern `企业名称｜AI猎客商机池`.
- **Group isolation**: Each Feishu group has exactly one knowledge document and one Base. The company name extracted from the knowledge doc title is the isolation key. Never write leads from one group's knowledge doc into another group's Base. Never search globally for Bases without `chat_id` scoping.
- **Base table**: Only the `买家线索` table should exist. Delete any auto-created default tables immediately after Base creation.
- Run daily at `10:00` in `Asia/Shanghai` when invoked by a host scheduler.
- Query the most recent 7 days by default and set `supplierId` to the string `"1234"`.
- Push at most 5 new leads per group and use 80 as the default push threshold.
- Never invent, enrich, infer, translate, or complete buyer facts.
- Never expose or persist email, phone, WhatsApp, WeChat, social account, or other direct contact data.
- Keep interface facts separate from AI match score and match reason.

## Required host capabilities

This Skill runs inside the DealClaw/OpenClaw Agent runtime. The following tools are already available and must be used:

- **`lark-cli`** — 搜索群内飞书文档、读取 Docx 内容。优先用 `--as bot`，创建资源时用 `--as user`。
- **`feishu-bitable` Skill** — 查找、创建、读写多维表格（Base/Bitable）。创建表、添加字段、upsert 记录均通过此 Skill。
- **`message.send`** — 向当前群发送推送消息。
- **`scripts/tradechina_buyer_leads.py`** — 调用 TradeChina API 获取买家线索。

The Skill does not create its own scheduler. Use the host cron/heartbeat mechanism for daily 10:00 Asia/Shanghai execution.

## Workflow

1. Obtain the originating group `chat_id`. Stop if the run is not bound to exactly one group.
2. Search documents visible in that group for `企业知识库`. Select exactly one title matching `^.+｜企业知识库$`. Stop and report a configuration error when zero or multiple documents match.
3. Extract the company name from the title prefix and retain the returned document token. Read table-aware document blocks, not screenshots or OCR, and parse the current company profile and market sections.
4. Compare a hash of the normalized profile with the previous hash when state is available. Refresh the cached profile when changed. Continue the buyer query even when unchanged.
5. Find the exact Base title `企业名称｜AI猎客商机池` using `feishu-bitable` Skill.
6. Read feedback records changed since the previous run. Read `是否匹配`, `不匹配原因`, and `反馈说明`. Use feedback to adjust matching preferences: if ≥3 leads with the same product/country/buyer-type are marked `❌ 不匹配`, reduce new leads matching that pattern by 20 points. Never rewrite interface-returned buyer fields or automatically edit the company knowledge document.
7. Read [references/api-contract.md](references/api-contract.md). Resolve each target country through the country endpoint and query each target-country/product combination. First resolve the installed Skill directory and run the script by absolute path. Prefer `<skill-root>/tradechina_buyer_leads.py`; the implementation remains under `<skill-root>/scripts/tradechina_buyer_leads.py`. Never assume the current working directory is the Skill directory. If the host does not expose bundled files or Python, use its generic HTTPS request capability to call the endpoints directly according to the API contract. Do not make up a country ID when exact Chinese or English matching fails.
8. Use only the sanitized output of the bundled script. Never pass the raw buyer response into a model, log, group message, or Base write.
9. Read [references/profile-and-matching.md](references/profile-and-matching.md). Score the sanitized records against explicit company profile facts, deduplicate on `chat_id + 线索ID`, and keep AI conclusions only in the AI fields.
10. Upsert eligible records into the lead pool. Write scores 65–79 without notifying the group; write and notify scores at least 80. Do not add records below 65 to the normal lead-pool view.
11. Push results to the group as a Feishu card (see [references/message-template.md](references/message-template.md)).

## Interface commands

Resolve `<skill-root>` from the installed Skill/package location before running a command. Do not use a path relative to the conversation workspace. Use the root compatibility entry point without adding buyer fields:

```text
python "<skill-root>/tradechina_buyer_leads.py" resolve-country --name "巴西"
python "<skill-root>/tradechina_buyer_leads.py" buyers --country-id "<id>" --product-keyword "绗缝被"
python "<skill-root>/tradechina_buyer_leads.py" contract-check
python "<skill-root>/tradechina_buyer_leads.py" self-test
```

If the root entry point is unavailable but bundled resources are visible, use `<skill-root>/scripts/tradechina_buyer_leads.py`. If neither path exists, the installer imported only the instruction file rather than the complete Skill package. Reinstall from the complete repository or ZIP. If the host supports generic HTTPS requests, use the direct-request fallback in `references/api-contract.md`; otherwise stop and report the missing HTTP/tool capability instead of claiming that the TradeChina API returned an error.

## Runtime preflight

Before the first business run, verify all three capabilities:

1. The enterprise knowledge document can be searched and read.
2. A Feishu Base tool or connector is connected and can create a Base, add fields, and upsert records; document access alone is insufficient.
3. Either the bundled Python script is executable by absolute path, or the host can make HTTPS POST requests to the two TradeChina endpoints.

Only configure the daily 10:00 `Asia/Shanghai` schedule after all three checks pass. A Skill supplies the workflow but does not grant Feishu permissions, install connectors, or create the host scheduler.

## Safety and failure handling

- Leave absent interface fields blank; do not substitute `未提供` into stored buyer data.
- Treat `buyerTag` as opaque text. Do not split or reinterpret it.
- Display `buyerTag` as "买家特征" (Buyer Characteristics) in Base fields and push messages, not "买家标签".
- Use `buyerCountry` unchanged in the message title. Do not translate it, append `国`, or replace it with an inferred country.
- Format `productList` only from returned `productName` and `productNameEn` values.
- Set `报名参展展会` only when `hasHomeLifeRegisterLog` is the integer `1` and `exhibitionName` is non-empty.
- On document, permission, Base, or API failure, do not send stale leads. Emit a concise operational error without buyer values.
- Retry reads safely. Retry writes only with the same unique key so Base records and group messages do not duplicate.
- Read [references/host-integration.md](references/host-integration.md) before installing or scheduling the Skill in a new host.
