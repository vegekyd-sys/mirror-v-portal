---
name: makaron
description: Use Makaron CLI for creative image, video, music, and motion work. In Feishu/Lark, the same Skill also owns V's visible task card, detached Worker, scoped account, progress, revision, and delivery lifecycle.
---

# Makaron — Official CLI + V Feishu Service

This is the effective Makaron Skill loaded by OpenClaw. It is composed from two independently maintained parts so an official CLI update cannot overwrite V's Feishu behavior.

## Load the right parts

1. Read [the bundled official CLI Skill](parts/official/SKILL.md) for current commands, flags, models, and response schemas.
2. For every Feishu/Lark request that creates, edits, continues, or delivers Makaron media, also read [V's Feishu service part](parts/feishu/SKILL.md) before acting.
3. Outside Feishu/Lark, the official part is sufficient unless the request explicitly needs V's service-card behavior.

The official part owns CLI syntax. The Feishu part owns cards, detached execution, account routing, progress, exact reply anchoring, same-card continuation, and delivery. Both parts are required for a Feishu Makaron task.

## Feishu execution invariant

In a Feishu/Lark DM or group, the inbound turn is only the control plane. Before any Makaron CLI action, read both bundled parts. Treat the current inbound request as fresh unless the user explicitly asks to retry, continue, reroll, revise, or replies to an existing media item. A fresh media task must enter through `visible-parent-flow.cjs`; after resolving only the required inbound media and canonical local reference, invoke it immediately instead of inspecting Runner source code, old handoff files, old cards, project history, or Memory. For V's own visual identity, the canonical local reference is `assets/v-avatar.jpg`. Pass the trusted inbound destination as `--chat`: the `oc_...` chat id for a group, or the `ou_...` user open id for a direct chat. Pass the trusted inbound `message_id` as `--request-id`. The helper is a single-use write operation: one successful invocation is authoritative and must never be rerun merely to inspect, grep, or confirm its output. After the successful handoff, return one concise visible acknowledgement such as `收到，任务已进入卡片后台执行。`; do not return `NO_REPLY`, because the separately sent card is not counted as the Gateway turn reply. A retry, continuation, or revision must use `restart-task-worker.cjs` when a recoverable card exists, otherwise create a new visible task card. For media-only requests, end the inbound turn after detached handoff. For composite requests where media feeds another deliverable, follow the bundled Feishu part’s composite-task branch: retain current-session ownership, collect child results, and verify the downstream deliverable before finalizing. Never run `makaron-cli chat`, `responses get --wait`, polling, or rendering supervision directly in the inbound Feishu turn.

## Night Shift isolated-card branch

In a Night Shift isolated Workboard card (no trusted inbound chat/message_id), do NOT use the Feishu card helpers. Read the official CLI part and run the CLI directly, e.g. `makaron-cli chat --project auto --media-manifest …` then `responses get --wait`. Never invoke `visible-parent-flow.cjs` / `restart-task-worker.cjs` — they require a trusted `--chat oc_…`/`ou_…` and `--request-id` that an isolated card does not have.

If a request first requires Scene retrieval, use the effective `scene-cli` Skill. Scene remains the owner until it has produced verified source ranges or image URLs and handed a non-empty manifest to Makaron.
