---
name: "feishu-standalone-deliver-link-guidance"
description: "Route non-Makaron final links through deliver-link"
---

# Feishu Standalone Link Delivery Guidance

## Purpose

Improve the chance that important standalone links in Feishu/Lark are delivered as a native card with an `open_url` button by using the existing helper:

```bash
node scripts/deliver-link.mjs --target "$FEISHU_TARGET_OR_CHAT_ID" --title "..." --url "https://..."
```

This is an agent/workflow-level rule, not a runtime patch, not a Feishu Open Platform Link Preview integration, and not a global streaming hook.

## Hard exclusions

Do **not** apply this to:

- Makaron project links
- Makaron video/image task links
- Links already present in Makaron task/project cards
- Links already present as buttons in an active realtime/interactive card
- Casual inline links in ordinary chat

Rationale: Makaron already has its own card/project-button delivery path, and duplicating it creates noise.

## Target skill update 1 — `report-web`

Add under `## Feishu delivery bridge` after the paragraph about realtime Channel SDK cards:

```md
### Standalone Feishu link delivery

When the final report URL is delivered in Feishu/Lark and it is **not already included as a button in an existing realtime/report card**, send it with `scripts/deliver-link.mjs` so the user gets a native `open_url` button card plus URL fallback.

Use this especially for:
- `https://dealclaw-report.example.com/report/<slug>` report pages
- the `/report` collection URL when explicitly delivering the report archive

Do **not** duplicate delivery if the active Feishu Channel SDK card already contains the final report URL/button.
Do **not** apply this rule to Makaron project links; Makaron has its own task/project cards.

Example from workspace root, using the current Feishu group/user target when available:

```bash
node scripts/deliver-link.mjs \
  --target "$FEISHU_TARGET_OR_CHAT_ID" \
  --title "报告已准备好" \
  --subtitle "Report Web" \
  --url "https://dealclaw-report.example.com/report/YYYY-MM-DD-topic"
```

If `deliver-link.mjs` fails, fall back to one concise plain-text HTTPS URL and mention the card delivery failed.
```

## Target skill update 2 — `lark-doc`

Add before `## 不在本 Skill 范围`:

```md
## Feishu link delivery for created/updated documents

When this skill creates a new Docx/Wiki document or produces a final document URL in Feishu/Lark, prefer delivering that URL with `scripts/deliver-link.mjs` so the user receives a native card with an `open_url` button. This is a narrow link-delivery behavior rule, not a runtime patch.

Use `deliver-link.mjs` when all are true:
- the output is an important standalone document/wiki link (`docx`, `wiki`, or equivalent final document URL);
- the link is being delivered in Feishu/Lark chat;
- the link is not already inside an existing interactive/realtime card with an open button.

Do **not** use this for Makaron project links; Makaron task/project delivery already has its own card buttons.
Do **not** use it for ordinary inline reference links inside a longer explanation.

Example from workspace root, using the current Feishu group/user target when available:

```bash
node scripts/deliver-link.mjs \
  --target "$FEISHU_TARGET_OR_CHAT_ID" \
  --title "飞书云文档" \
  --subtitle "文档已准备好" \
  --url "https://example.feishu.cn/docx/..."
```

If card delivery fails, send a concise plain-text HTTPS URL fallback and state that the card failed.
```

## Target skill update 3 — `feishu-channel-cards`

Add before `## Required behavior`:

```md
## Standalone link delivery policy

For important standalone links in Feishu/Lark, prefer a native `open_url` button card rather than a bare or mixed prose URL. Use `scripts/deliver-link.mjs` for **standalone** final links when there is no active realtime/interactive card already carrying the link.

Good standalone targets:
- Report Web URLs: `https://dealclaw-report.example.com/report/...`
- Feishu/Lark document or wiki URLs created as final deliverables
- OpenClaw/Dashboard/internal artifact viewer links
- one-off external preview/download links that are important deliverables

Do not duplicate links:
- If the current realtime Channel SDK card already has a final artifact button, update that card instead of sending a second `deliver-link` card.
- Do **not** apply this to Makaron project links or Makaron video/image task links; those are already represented by Makaron task/project cards.
- Do not use it for casual inline links in ordinary chat.

Operationally, this is an agent/workflow rule, not a global runtime patch and not a Feishu Open Platform Link Preview integration. Keep it narrow to avoid slowing streaming or altering normal replies.
```

## Validation checklist

- The rule mentions `scripts/deliver-link.mjs` explicitly.
- Makaron project/video/image links are explicitly excluded.
- Existing realtime/interactive cards should be updated instead of duplicated.
- Plain HTTPS fallback remains available if card delivery fails.
- No OpenClaw runtime files, Feishu Open Platform event mode, or plugin hooks are modified.
