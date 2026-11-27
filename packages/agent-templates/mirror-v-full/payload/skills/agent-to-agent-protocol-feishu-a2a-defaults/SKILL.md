---
name: "agent-to-agent-protocol-feishu-a2a-defaults"
description: "Feishu A2A: shared task + clear communication route, not rigid form."
---

# Feishu/Lark A2A Defaults for Agent-to-Agent Protocol

This skill is the Feishu/Lark group companion to `agent-to-agent-protocol`. Use it whenever an agent needs to contact, wake, delegate to, verify with, teach, or hand off work to another agent/bot in a Feishu/Lark group.

## Core Purpose

A2A onboarding is not about making agents follow a rigid message format. It is about making two agents able to **jointly complete a real task** through a **reliable communication route**.

The desired outcome is:

1. V can reliably reach the other agent.
2. The other agent can reliably reach V.
3. Both sides understand the shared task, owner, next action, and stopping conditions.
4. The collaboration continues after no-reply or reply until the task is done, blocked, or escalated.

Use labels like `[目的] / [上下文] / [输出] / [边界]` only when they help clarity. They are optional scaffolding, not the protocol itself.

## Core Model: A2A Onboarding Is a Loop, Not One Message

A2A onboarding has two agents that both need to learn the route:

1. **V / sender must @ the target correctly.**
2. **The target agent must learn how to @ V / sender correctly.**
3. **Both agents must use the route to move a shared task forward.**
4. **The loop must continue after no-reply or reply.**

Do not treat the first successful outbound message as completion. Onboarding is complete only when the target either:

- replies in a new top-level group body message with native @ back to V/sender and helps move the shared task forward; or
- returns `BLOCKED` with a concrete reason; or
- the owner escalates after bounded retries with evidence.

## Acceptance Rule

A Feishu/Lark A2A attempt counts as valid only if all are true:

1. the outbound message is a **new top-level group body message**, not a reply/thread/topic response;
2. the outbound message is a **plain text/post message**, not an interactive card;
3. it contains a **real native @ mention** of the target agent, not just visible text like `@Bot` or literal `<at ...>`;
4. it contains a **clear task body**: what shared task we are trying to complete, what the receiver should do next, and how it should answer;
5. it is sent through a **verified sender path** that preserves native mentions and sends top-level;
6. the sender records evidence: message id, target agent open_id/name, and whether ACK/evidence came back.

A2A onboarding has additional acceptance rules:

7. the receiving agent is taught how to **native-@ the sender back**, including the sender's open_id or exact mention target, required sender path, and a return ACK/action test in a top-level group body message;
8. a **follow-up watcher** is created after the first outbound contact if the workflow depends on a reply;
9. every continuation/follow-up is also sent as a **new top-level group body + native @**, never as a reply/thread;
10. the exchange is tied to a concrete task or capability handoff, not just empty ACK ping-pong.

If any item is missing, report `Blocked` instead of claiming onboarding or A2A contact is complete.

## What to Include in the Body

The body should answer four practical questions, in whatever wording is shortest and clearest:

- **Shared task:** What are we trying to complete together?
- **Current state:** What has already happened or why is this message being sent?
- **Next action:** What should the receiving agent do now?
- **Return route:** How should it answer so the sender can see it and continue?

Optional structured version:

```text
<real native @ target agent>
[任务] The shared task we are completing.
[当前] Relevant state or reason for this handoff.
[下一步] What the target should do now.
[回法] Reply as a new top-level group message with native @ back to V/sender; include ACK/evidence/BLOCKED.
```

Compact natural-language version is usually better:

```text
<real native @ target agent> 我们在做 Jerry 的图片/视频协作 onboarding。请用新的群正文消息 native @ V 回复 ACK，并说明你能否安装 makaron-cli；V 的 open_id 是 ou_SENDER_V。不要用 reply/thread，也不要先开任务。
```

## Hard Red Lines

### 1. Do Not Use Final Reply for A2A Wakeup

For Feishu bot-to-bot A2A, do **not** rely on the assistant's normal final reply to create a target-agent @ mention.

Even if the final reply text contains:

```text
<at user_id="ou_xxx">Target Bot</at>
```

that may render as visible text or be delivered without a platform `mentions` array. It may look correct to humans but fail to wake the target agent.

### 2. Do Not Use Reply/Thread/Topic Response for A2A Wakeup or Continuation

Do **not** put A2A onboarding, wakeup, handoff, correction, or continuation content inside a reply/thread/topic response to the other agent's message.

Even if the reply contains a native @, many agent runtimes watch only top-level group message bodies or treat replies differently. The target agent may not see or process the reply.

A2A wakeup/onboarding/continuation must be sent as a **new top-level group body message**:

```text
<real native @ target agent> shared task + next action + return route
```

If the current UI/session is in reply mode, do not send the A2A handoff as final chat text. Use a verified sender path to send a separate top-level message to the group. If you already sent a visible result via `message.send`, return `NO_REPLY` in that originating session to avoid duplicate/threaded replies.

### 3. Do Not Let No-Reply End the Onboarding Loop

If the target agent does not reply, the onboarding loop is not complete and must not silently end.

After the first outbound A2A onboarding message, create a bounded follow-up mechanism, for example:

- a one-shot cron/reminder in 5–15 minutes to check the group/session history;
- a durable inbox/task record if the workflow has a non-Feishu control plane;
- a visible owner note only if continued automation is impossible.

The watcher should check whether the target returned a top-level native-@ ACK/action result or BLOCKED reason. If not, send one shorter top-level native-@ follow-up, then at most one final reduced prompt before escalating with evidence. Do not spam.

## Verified Sender Path

When the goal is to wake/contact another agent, use a verified Feishu sender path such as:

- `message(action="send", channel="feishu", target="chat:<oc_xxx>", message="<at user_id=\"ou_xxx\">Target</at> ...")` if verified in this runtime to preserve mentions and send a top-level message;
- `lark-cli im +messages-send --chat-id <oc_xxx> --content '{"text":"<at user_id=\"ou_xxx\">Target</at> ..."}'` when available and previously verified;
- another platform/API path that can be checked by message id and, ideally, `mentions` metadata.

After using a sender path, verify with the smallest available evidence: message id, Feishu message metadata/mentions array when accessible, and target response. If the path cannot be verified, say so and ask for permission/tooling rather than pretending the @ worked.

## A2A Onboarding: Two-Way Mention Teaching

A2A onboarding is not complete when V can @ the other agent. It is complete only when both directions are taught and tested through a task:

1. **V → target:** V sends a new top-level plain text/post group message using native @ to the target agent.
2. **Target → V:** V teaches the target exactly how to native-@ V back in a new top-level group body message.
3. **Shared task:** the target uses that return route to advance the task or report a blocker.
4. **Watcher:** V creates a bounded follow-up check so no-reply does not silently end the loop.
5. **Continuation:** if the target replies, V does not answer in reply/thread; V sends a new top-level native-@ continuation.

The sending V's open_id (`ou_SENDER_V` below) is the one given in the VSync task or visible in its message's mentions. Feishu open_ids differ per app, so never reuse an id seen elsewhere or guess one:

```text
ou_SENDER_V
```

When onboarding another Feishu agent, include a return-path block like:

```text
以后要找 V，不能只写“@V”或普通文本名字，也不能只在 reply/thread 里回复；必须发一条新的群正文消息，用你那边的 Feishu/native mention 发送路径，生成真实 @。
V 的 open_id 是：ou_SENDER_V。
如果你有 OpenClaw/message sender，正文应包含类似：
<at user_id="ou_SENDER_V">V</at> 我们在共同完成 <shared task>。我现在完成了/卡住了 <state>，下一步需要 V <ask>。
如果你做不到 native @ 或不能发 top-level 消息，请回：BLOCKED + 原因。
```

Do not mark onboarding complete until the target agent either:

- replies with a real native @ to V in a new top-level group message and advances the task; or
- returns `BLOCKED` with a concrete reason such as missing open_id support, missing bot-message permission, no verified sender path, or only being able to reply/thread.

## No-Reply Follow-Up Pattern

After sending the first onboarding message, schedule a check:

```text
At T+5~15 min: check whether <target agent> replied in <chat id> with top-level native @ to V/sender and useful task state.
If yes: continue only by new top-level native-@ message if more teaching is needed.
If no: send one shorter top-level native-@ prompt asking it to either advance the task or return BLOCKED.
At next check: if still no reply, send one final minimal prompt or escalate with evidence.
```

Example shorter follow-up:

```text
<target native @> 我们还在做 <shared task> 的 A2A onboarding。请用新的群正文消息 native @ V 回复：能否继续、当前 blocker、下一步。做不到就回 BLOCKED + 原因。
```

## Reply-Received Continuation Pattern

When the target agent replies:

- Treat the inbound reply as evidence/state only.
- Do **not** click/reply under that message for A2A continuation.
- If more instruction is needed, send a fresh top-level group message via verified sender path and native @ the target.
- If you already used `message.send` for the visible continuation, final reply in that session should be `NO_REPLY` to avoid duplicating in a reply/thread.

## Required Behavior

- **Top-level group body is required.** A2A wakeup/onboarding/continuation must not be sent as reply/thread/topic response.
- **Native @ is required for bot wakeup.** Plain text names do not count.
- **Body must serve the task.** It must make the shared task, current state, next action, and return route clear. Do not force labels when natural language is clearer.
- **Reciprocal @ teaching is required for onboarding.** Teach the other agent the sender's open_id/mention target and require it to respond with native @ in a new top-level group message.
- **Watcher is required when waiting for another agent.** If no reply would otherwise end the workflow, schedule a bounded check or use a durable inbox/control plane.
- **Use plain text/post for wakeup.** Do not use interactive cards for first-contact A2A wakeup unless card native mention behavior has already been verified for that exact receiver.
- **Use verified sender path.** Normal assistant final replies are not accepted for target-agent wakeup unless this exact route has been verified to create native mention metadata and top-level delivery.
- **Mention every target with a role.** If multiple agents are involved, write separate sections or separate messages: `@A implement`, `@B verify`, `@C observe only`.
- **Do not @ broad bot lists for visibility.** Only mention agents with a concrete ask or explicit observer role.
- **If native @ is unavailable, say so.** Do not pretend a text `@name` will wake the target. Use a durable control plane or ask for target open_id/tooling.
- **A2A does not override group silence.** Agents still respond only to direct mention, clear assignment, owned-task milestone/blocker, or safety/factual correction.
- **A2A does not override privacy.** Share only context the receiver is allowed to see. V-private persona, the owner private memory, secrets, raw logs, and customer-sensitive data require sanitization or explicit permission.

## Validation Checklist

Before treating a Feishu/Lark A2A route as working:

1. Identify the shared task.
2. Identify target chat id and target agent open_id/name.
3. Identify V/sender open_id or exact return mention target.
4. Choose a verified sender path that creates native mention metadata and sends a top-level group body message.
5. Send a top-level plain text/post message with real native @, shared task, next action, and return route.
6. Include reciprocal return-path teaching: how the target should native-@ V/sender back in a top-level group message.
7. Create a bounded watcher/check if waiting for a target reply.
8. Record message id and, when possible, verify platform `mentions` metadata for the target bot.
9. Confirm receiver returns task state/evidence in the expected group or durable inbox.
10. Confirm receiver's response includes a real native @ back to V/sender in a new top-level group message, or a concrete `BLOCKED` reason.
11. If no response, check in order: sender path created native mention; message was top-level not reply/thread; receiving bot app has bot-message/at-message permissions; receiving runtime allows bot senders; target knows V/sender open_id; shared task/next action was clear; group silence rules did not suppress response.
12. If target replies but more coaching is needed, send continuation as a new top-level native-@ message, not as a reply/thread.
13. Record tested group, target open_id/app, V/sender open_id, message ids, watcher/check result, and outcome in memory/project notes or the owning protocol doc.

## Good vs Bad

Bad:

> normal final reply or reply/thread: `<at user_id="ou_xxx">Target Bot</at> 看一下`

Good:

> verified Feishu sender path sends a new top-level group message: `<at user_id="ou_xxx">Target Bot</at> 我们在做 Jerry 图片/视频协作 onboarding。请用新的群正文消息 native @ V 回复你是否能安装 makaron-cli；V 的 open_id 是 ou_SENDER_V。不要用 reply/thread，也不要先开任务。`

Bad:

> target replies correctly, then V clicks reply and continues coaching under that message.

Good:

> target replies correctly; V records the reply as evidence, then sends a fresh top-level message: `<target native @> 收到，你已经能 @ 回 V。下一步请用 Makaron CLI 检查命令可用性，回传版本号或 BLOCKED 原因。`

Bad:

> no target reply, V's turn ends and no one follows up.

Good:

> no target reply; V's first outbound created a T+5~15 min watcher. The watcher checks latest history and sends one shorter top-level native-@ follow-up or escalates with evidence.
