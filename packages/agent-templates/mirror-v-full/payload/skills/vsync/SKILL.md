---
name: "vsync"
description: "Lock VSync to local source → v-sync-hub package/inbox/ACK; prohibit Universal Memory paths/tools."
---

# VSync 2.0 — Multi-V Skill/Memory/Prompt Synchronization

## Mandatory Conversation Preflight

Before answering or acting in any group/chat where the user asks two V instances to sync, mentions VSync/v-sync-hub, Heartbeat/wiki-maintenance/dispatch sync, A2A between bots, or asks V from Versa / another V instance to apply a package, the acting agent must complete this preflight first:

1. Read the current `vsync` skill.
2. Read the generic `agent-to-agent-protocol` skill.
3. Read the Feishu/Lark A2A companion skill `agent-to-agent-protocol-feishu-a2a-defaults` when the surface is Feishu/Lark.
4. Run targeted **local** memory retrieval for the current VSync project/status if the request depends on prior state, package IDs, ACKs, known user_ids, or previous corrections. Do not use Universal Memory (`umemory_*`) for VSync source selection, transport, delivery, or ACK.
5. Identify the concrete shared task, source agent, target agent, primary control plane, visibility channel, and ACK path before sending anything.
6. Lock the VSync source to the sender's local original workspace files before packaging. Do not treat a memory-search hit, a Universal Memory contributor path, or a copied/indexed artifact as a package source.
7. If the task requires the other bot to see it, use `v-sync-hub` inbox/package/manifest as the operational control plane and send only a standalone Feishu text message with native @ as human-visible notification.
8. Record evidence before claiming handoff success: commit/package/inbox id, Feishu message id when used, target open_id, and watcher/ACK plan.

If any preflight item cannot be completed, do not improvise with cards, attachments, replies, or plain-text @. Report `BLOCKED` with the missing item.

Recommended concise evidence line in the first status update, when useful and not noisy:

```text
preflight: read vsync + agent-to-agent-protocol + feishu-a2a; source=sender-local-workspace; control plane=v-sync-hub; ACK path=agents/<receiver>/ack.jsonl
```

## Purpose

Synchronize reusable capabilities between core/private V and company/public V instances without breaking identity boundaries, privacy boundaries, or memory search quality.

VSync 2.0 replaces the earlier ad-hoc VSync 1.0 with a repeatable workflow that can be triggered manually by the owner saying “vsync” and later by cron.

## Trigger

Use this skill when:

- the owner says “vsync”, “同步 V”, “同步本体/公司 V”, or asks two V instances to sync.
- A cron/heartbeat asks an instance to run periodic VSync.
- A V instance reports important new skills, memory, workflow lessons, tool rules, or prompt deltas that should be shared.
- A message in the V/V from Versa sync room concerns Heartbeat, wiki-maintenance, heartbeat-dispatch, Memory Promote, A2A routing, package apply, ACK, or v-sync-hub state.

## Non-Negotiable Rule

VSync work is not complete when a file is pasted, attached, or mentioned in chat. It is complete only when the GitHub control-plane artifact exists, the target has an inbox/task or package manifest to act on, validation evidence is returned, and ACK/BLOCKED is recorded.

## VSync Source and Transport Boundary

VSync is a **file/capability-package synchronization protocol** only:

```text
sender-local original workspace files
  → v-sync-hub package + manifest + target inbox
  → target validation/apply
  → v-sync-hub ACK or BLOCKED
```

### Allowed VSync sources

- Original files in the sender's local workspace, such as `skills/`, `scripts/`, and approved/sanitized work-memory files.
- A previously received and verified `v-sync-hub` package, when preparing a bounded follow-on package or response.

### Required VSync destinations

- Package files: `v-sync-hub/agents/<source>/returns/<target>/<package>/...`
- Package manifests: the appropriate source/root return manifest.
- Target work item: `v-sync-hub/agents/<target>/inbox.jsonl`
- Target acknowledgement: `v-sync-hub/agents/<target>/ack.jsonl`

### Absolute exclusions

Universal Memory is a separate query/contribution system and is never part of VSync.

Do not, for any VSync task:

- read from, source from, or package paths under `universal-memory-wiki/` or `contributors/...`;
- invoke `umemory_*`, Universal Memory MCP, or the `universal-memory-contributor` workflow to locate, select, package, deliver, apply, or acknowledge VSync content;
- write a VSync package, manifest, inbox entry, apply result, or ACK into Universal Memory, including Universal Memory contributor directories or inboxes;
- use a Universal Memory search result or cached/indexed copy as a substitute for the sender's original source file.

If a needed file is found only in Universal Memory, stop with `BLOCKED: canonical sender-local source unavailable`. Locate the original workspace or request a fresh VSync package from the owning agent; never repackage the indexed copy.

Before pushing a package, verify that its manifest and file list contain no Universal Memory or contributor paths.

### Feishu visibility rule

Feishu is only the human-visible progress/control surface. Due to Feishu bot-to-bot constraints, any Feishu message that must be seen by another bot must be:

1. standalone text message;
2. native Feishu `<at user_id="...">...</at>` mention;
3. not a reply-only message;
4. not an interactive card;
5. not only JSON/code block content.

Do not assume no-@ bot messages, card messages, attachments, or assistant replies wake the other bot. Feishu is never the VSync artifact transport or ACK source of truth.

## Roles

- **Core/private V**: source-of-truth curator, privacy gate, final reviewer for private-side memory/prompt exports.
- **Company/public V (for example V from Versa)**: service/work instance, receives safe reusable capabilities, keeps its own identity and runtime boundary.
- **the owner**: approval authority for company-review items, identity/core changes, cron rollout, and any ambiguous privacy boundary.

## Transport Rules

### Primary transport

Use GitHub `v-sync-hub` as the only VSync transport and control plane.

Typical paths:

- `agents/<source>/returns/<target>/...` for packages.
- `agents/<target>/inbox.jsonl` for A2A task/proposal messages.
- `agents/<source>/return-manifest.jsonl` and root `return-manifest.jsonl` for package manifests.
- `agents/<source>/return-proposals.jsonl` for proposals.
- `agents/<target>/ack.jsonl` for acknowledgements.

## Sync Scope and Boundaries

### Allowed by default

- Public-safe skills.
- Company-review skills after the owner approval.
- Work memory as canonical Markdown/text/metadata diffs.
- Tool routing rules, workflow lessons, project/concept/decision notes.
- Prompt deltas as sanitized section cards, not full identity-file overwrites.

### Excluded by default

- Private/companion persona.
- the owner private/family/intimate context.
- Secrets, tokens, raw `.env`, private keys, credentials.
- Raw session logs, raw imports, raw source archives.
- Binary media assets unless explicitly needed as evidence and approved.
- Full identity file overwrite (`SOUL.md`, `IDENTITY.md`, `USER.md`, `REDLINES.md`, `HEARTBEAT.md`) across different V identities.
- JSONL as canonical searchable memory storage. JSONL is acceptable as transport/intermediate only.

## Workflow Skeleton

1. Preflight-read the required skills and retrieve current VSync state through local/VSync control-plane evidence.
2. Lock the canonical sender-local sources and confirm they are not Universal Memory/indexed copies.
3. Decide control plane and ACK path.
4. Create/diff package or inbox task in `v-sync-hub`.
5. Push commit and record package id / sha256 / inbox id.
6. Send standalone Feishu text with native @ only as visibility/notification.
7. Create a bounded watcher if awaiting reply.
8. Verify ACK/BLOCKED in GitHub and summarize only after evidence exists.

## On Mirror V (receiving side)

You are a Mirror V instance: in VSync terms a company/public V that **receives** packages. You keep your own identity, owner and memory; nothing in a package overrides them.

- **Your agent id in `v-sync-hub`** is the one the sending V uses in its task (for example `mirror-v-004`). Do not invent one.
- **Hub access is not configured by default.** `v-sync-hub` is a private GitHub repository and this sandbox has no GitHub credentials. When a task points you at the hub, first check reachability of the repository the task names (`curl -s -o /dev/null -w '%{http_code}' https://api.github.com/repos/<owner>/<repo>`); a 404 means no access — reply `BLOCKED: no v-sync-hub access` with that evidence. Do not ask anyone to paste a token into chat; hub access is set up by the platform operator.
- **Accepted fallback (verified 2026-11-27):** the sending V posts the package files into the group as Feishu file messages and states each file's sha256 in its task. Download the attachment, compute sha256, and install only if it matches. Install into `skills/<name>/` of your own workspace; if a same-name skill exists, diff and report instead of overwriting.
- **Feishu tools for this, and only this:** `TOOLS.md` keeps lark-cli read-only; VSync is the one exception, limited to the group the VSync task came from: `lark-cli im +messages-mget --as user --message-ids <id>` to read the file message the sending V names, `lark-cli im +messages-resources-download` to fetch its attachment, and one `lark-cli im +messages-send --as bot --chat-id <that group> --msg-type text` for the ACK. No other chats, no other messages.
- **ACK without hub write access:** put the ACK in a new top-level Feishu text message with native @ of the sending V: status (`applied` / `BLOCKED`), installed path, the sha256 you computed, and one or two lines of real verification output. The sending V records it in `agents/<your id>/ack.jsonl` on your behalf (`recorded_by`); never claim you wrote to the hub yourself.
- **Who can wake you:** the Portal forwards group messages from people that @ you. Messages sent by another bot's own identity are not forwarded to you at present, so a sending V that needs you to act must @ you as a person (user identity) or have the owner forward the task. If you only see a bare @ with no content, say so and ask for the text.
- **Boundaries:** only install what the task lists; skills, protocols and workflow notes only — never identity files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `REDLINES.md`, `HEARTBEAT.md`), memory of another owner, or credentials. A received skill that deletes data, sends messages, or installs dependencies: read it first and ask your owner before enabling it.
