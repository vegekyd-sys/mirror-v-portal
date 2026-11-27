---
name: agent-to-agent-protocol
description: Use when coordinating with another AI agent, bot, subagent, session, coding agent, or Makaron-like response agent. Covers directional collaboration, handoff packets, bot-to-bot messaging, verification, disagreement, and stopping conditions.
---

# Agent-to-Agent Protocol

Agent-to-agent work is not polite parallel chatting. It is directional execution: one accountable lead turns context into a clear handoff, the other agent returns evidence, and the lead closes the loop with the user.

## Use This Skill When

- Delegating work to another agent, subagent, bot, coding agent, or session.
- Coordinating with another V / OpenClaw agent, a coding agent, or Makaron.
- Turning a Makaron `responses get` stream into an agent-to-agent workflow.
- A task needs separate tools, permissions, runtime, model, or local environment.

Do **not** use this when you can safely finish the task yourself in one flow.

## Core Principles

1. **One lead, one owner** — Decide who owns the user-facing outcome. Other agents are workers/advisors unless explicitly reassigned.
2. **Direction over agreement** — Do not ask another agent to “look at this” or merely agree. Give a concrete objective, constraints, and acceptance criteria.
3. **Who has the tools executes** — Route work to the agent with the right filesystem, browser, credentials, runtime, memory, or product surface.
4. **Evidence beats claims** — A handoff is not complete until the receiving agent returns proof: diff, test, log, screenshot, file path, message id, URL, or named blocker.
5. **Disagree productively** — If the requested plan is risky or wrong, the receiving agent should say so, propose a better path, and explain the tradeoff briefly.
6. **No infinite agent loops** — After 2–3 clarification rounds, stop and escalate with logs, current state, and the smallest next decision.

## Identity Boundary

Each agent keeps its own identity, owner and memory. What crosses between agents is
productized output only: skills, protocols, checklists, workflows and stable tool
instructions. Never copy or activate another agent's persona, private memory, internal
paths or experimental residues, and never overwrite an active local skill with a
same-name skill received from another agent — diff first and report the conflict.

## Handoff Packet

Send the receiving agent a packet with only the context needed to act:

```md
## Task
What must be done.

## Direction
The intended outcome and preferred strategy. Include what “good” looks like.

## Context
Why this matters, current state, relevant user intent.

## Verified Facts
Facts already checked. Prevent duplicate investigation.

## Inputs
Files, links, message_ids, run_ids, screenshots, local paths, commands already run.

## Constraints
Safety, privacy, permission, time, style, allowed files, forbidden actions.

## Ask
The exact 1–3 things the receiving agent should do.

## Acceptance Criteria
What evidence must come back before this counts as done.

## Stop Conditions
When to stop instead of pushing through.
```

Keep it shorter than a memo. If the receiver needs full context, attach files or point to exact paths.

## Receiver Return Format

Ask the receiving agent to return:

```md
## Done
What changed or was completed.

## Evidence
Tests, logs, screenshots, file paths, URLs, message ids, or direct inspection.

## Changed
Files, config, external state, messages sent, records updated.

## Blocked
None, or the exact missing input/permission/error.

## Recommendation
Next step, including any disagreement or risk.
```

## Bot-to-Bot Messaging Rules

For Feishu/Lark group bot collaboration:

- Use real Feishu/Lark native @ mentions to the target bot/agent. A plain text name like `@Bot Name` is not enough.
- For Feishu bot-to-bot group messages, both bot apps must have `im:message.group_at_msg.include_bot:readonly` granted, and the outbound message must be a `text` message with Feishu mention syntax such as `<at user_id="ou_xxx">Bot Name</at>`.
- Avoid card/interactive rendering for bot-to-bot wakeup tests unless you are certain the card markdown uses Feishu card mention syntax (`<at id=ou_xxx></at>`). In OpenClaw Feishu `renderMode: card`, hand-written text mention syntax may render as visible text instead of a native @.
- Include a smoke test in the first handoff, e.g. “Reply with ACK + your current role/model if you received this.”
- Do not let two agents both answer the human directly unless that is the intended product experience.

## Subagent / Session Delegation

When spawning or messaging an agent:

- Use isolated context unless the child truly needs the current transcript.
- Give the child the handoff packet, not vague instructions.
- Claim/record task ownership if there is a dispatch system.
- Do not poll aggressively. Wait for completion events or use one status check only when needed.
- On completion, verify the artifact before reporting success.

## Makaron as a Downstream Agent

Treat Makaron responses as an agent conversation, not just a polling API.

- `status`, `projectUrl`, `videoUrl`, and files are evidence/state.
- Makaron text is the downstream agent’s reasoning/output. Read it and decide.
- If Makaron writes a script and pauses, that is a confirmation gate, not failure.
- Your job is to brief, interpret, approve, redirect, QC, and deliver — not blindly forward raw output.
- User-facing progress should be coherent: one owner, one visible workflow, clear next step.

## Escalation / Stop Conditions

Stop and escalate when:

- The same error repeats twice.
- The agents disagree on facts and cannot verify within one more action.
- Required permissions, files, credentials, or user decisions are missing.
- The conversation becomes meta-discussion instead of moving toward the artifact.
- A safety/privacy boundary is involved.

When escalating, summarize: current owner, completed work, evidence, blocker, and the one decision needed.

## Good vs Bad

Bad:

> “Can you check this?”

Good:

> “Goal: fix Feishu group mentions not triggering V. I verified dedup has the message ids and the session received them, but V output NO_REPLY. Please inspect `openclaw-lark/src/messaging/inbound/dispatch-builders.js`, confirm whether bot mentions are stripped before BodyForAgent, and propose the smallest patch. Return file/line evidence and a test plan. Stop if this requires gateway restart.”

Bad:

> “Makaron returned text but no video, failed.”

Good:

> “Makaron returned a script but no video URL. Treat this as a confirmation gate. Read the script, decide whether it matches the brief, then send a follow-up approval or correction. Evidence: project URL + run id + Makaron text excerpt.”
