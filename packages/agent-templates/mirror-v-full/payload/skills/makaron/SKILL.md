---
name: "makaron"
description: "Create or edit images, video, music and motion via Makaron CLI; Feishu task cards, scoped accounts, revisions and delivery."
---

# Makaron — Official CLI + V Feishu Service

This is the effective Makaron Skill loaded by OpenClaw. It is composed from two independently maintained parts so an official CLI update cannot overwrite V's Feishu behavior.

## Load the right parts

1. Read [the bundled official CLI Skill](parts/official/SKILL.md) for current commands, flags, models, and response schemas.
2. For every Feishu/Lark request that creates, edits, continues, or delivers Makaron media, also read [V's Feishu service part](parts/feishu/SKILL.md) before acting.
3. Outside Feishu/Lark, the official part is sufficient unless the request explicitly needs V's service-card behavior.

The official part owns CLI syntax. The Feishu part owns cards, detached execution, account routing, progress, exact reply anchoring, same-card continuation, and delivery. Both parts are required for a Feishu Makaron task.

## V brief / Makaron production boundary

V conveys the user goal, audience, verified facts, available media, deliverable specifications and explicitly required content or dialogue. Write the desired result, not a construction recipe: Makaron chooses the production route as well as scripts, shot design, pacing, music and composition. Leave integrated picture, speech, lip sync, music, ambience and subtitle generation available; do not prescribe per-shot generation, silent video followed by TTS/music/captions, or another implementation sequence by default. Pass a method constraint only when the user explicitly requires it or a verified technical obstacle in this task necessitates it, and state that source. Preserve explicit customer/planner content requirements without turning V's preferred implementation into a hard constraint. A complete 30-second submission does not imply a continuous take; multiple shots do not imply separate generation submissions; accurate subtitles do not imply post-generated speech. Before submission, check each added production step against those exceptions and remove unsupported method constraints; assess the final result against the requested outcomes rather than V's imagined workflow. Preserve the selected specialist Skill's essential template mechanism and technical contracts; its example timings and camera choices remain adaptable defaults unless the user explicitly requires exact replication. Trace each hard requirement to user intent, selected template core or actual tool constraints, and label V-added creative suggestions as optional. Discover available Makaron Skills server-side and use --skill when supported; a local Skill path does not mean the remote Agent has read it. For local-only specialists, pass the necessary core rather than expanding all historical instructions into the brief. Review unmet user outcomes, factual accuracy and required template fidelity; do not overwrite Makaron's design solely because V imagined another approach. For replication, use Makaron's dedicated replication Skill rather than the retired local makaron-viral-replicate procedure.

## Delivery specification at brief preparation

During Default Feishu flow step 3, include one delivery-specification block in the actual Makaron brief: duration (and any stated tolerance), aspect/orientation, resolution, audio, and subtitles/language. Carry forward explicit user requirements and applicable selected-template contracts with their source. For unspecified fields write “Makaron decides” or a clearly labelled adjustable default; do not impose 1080×1920, 9:16, 15s, music or subtitles on every request, and do not ask the user merely to fill optional fields. Keep the card summary and submitted prompt consistent with this same block, including on revisions; the latest user instruction supersedes the earlier value. Check the final asset against the explicit result requirements before claiming compliance; distinguish delivered from specification-verified and disclose unsupported/unverified requirements without silently changing them.

Treat V's proposed “5–6 shots × 2.5–3.0s” or similar shot plans as adjustable suggestions unless the user or selected template explicitly requires them. The manifest is available material, not a mandatory shot list: do not equate shot count with asset count, force every asset into the edit, or divide time equally by N. Makaron chooses shots, timing, transitions and pacing. Check only whether genuine hard constraints can be jointly satisfied; relax V-added suggestions before asking to change the user's requirements. Text-to-image and text-to-video remain valid without reference media.

## Feishu execution invariant

In a Feishu/Lark DM or group, the inbound turn is only the control plane. Before any Makaron CLI action, read both bundled parts. Treat the current inbound request as fresh unless the user explicitly asks to retry, continue, reroll, revise, or replies to an existing media item. A fresh media task must enter through `visible-parent-flow.cjs`; after resolving only the required inbound media and canonical local reference, invoke it immediately instead of inspecting Runner source code, old handoff files, old cards, project history, or Memory. For V's own visual identity, the canonical local reference is `assets/v-avatar.jpg`. Pass the trusted inbound destination as `--chat`: the `oc_...` chat id for a group, or the `ou_...` user open id for a direct chat. Pass the trusted inbound `message_id` as `--request-id`. The helper is a single-use write operation: one successful invocation is authoritative and must never be rerun merely to inspect, grep, or confirm its output. After the successful handoff, return one concise visible acknowledgement such as `收到，任务已进入卡片后台执行。`; do not return `NO_REPLY`, because the separately sent card is not counted as the Gateway turn reply. A retry, continuation, or revision must use `restart-task-worker.cjs` when a recoverable card exists, otherwise create a new visible task card. For media-only requests, end the inbound turn after detached handoff. For composite requests where media feeds another deliverable, follow the bundled Feishu part’s composite-task branch: retain current-session ownership, collect child results, and verify the downstream deliverable before finalizing. Never run `makaron-cli chat`, `responses get --wait`, polling, or rendering supervision directly in the inbound Feishu turn.

## Night Shift isolated-card branch

In a Night Shift isolated Workboard card (no trusted inbound chat/message_id), do NOT use the Feishu card helpers. Read the official CLI part and run the CLI directly, e.g. `makaron-cli chat --project auto --media-manifest …` then `responses get --wait`. Never invoke `visible-parent-flow.cjs` / `restart-task-worker.cjs` — they require a trusted `--chat oc_…`/`ou_…` and `--request-id` that an isolated card does not have.

If a request first requires Scene retrieval, use the effective `scene-cli` Skill. Scene remains the owner until it has produced verified source ranges or image URLs and handed a non-empty manifest to Makaron.
