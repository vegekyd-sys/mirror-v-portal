---
name: "background-worker-contract"
description: "Parent/child contract for long worker tasks"
---

# Background Worker Contract

## Purpose

Keep interactive chat lanes responsive while long, polling-heavy, resourceful, or failure-prone work runs in isolated workers with structured artifacts and clear parent delivery.

This skill does not replace domain skills. It is a cross-cutting contract to apply when a domain skill has background-worthy branches.

## Trigger Conditions

Use this skill when a task or skill branch involves any of:

- long or unpredictable runtime
- repeated polling/waiting for external systems
- media generation/editing/render/export/download/upload
- build/deploy/browser automation
- cloud phones, device runtimes, GPUs, or other scarce/paid resources
- batch crawling/searching/downloading
- multi-step external API workflows that may time out
- cleanup obligations that must run even on failure
- a need to keep Feishu/OpenClaw parent lane responsive

Do not use this skill for quick lookups, short file reads, simple explanations, or one-shot validations unless they are attached to a larger long-running workflow.

## Core Principle

The parent session is the control plane. The child worker is the execution plane.

- Parent: understand request, validate safety, queue work, keep user informed, deliver final answer.
- Child: execute bounded work, preserve evidence, clean up resources, return structured results.

## Routing Decision

### Run synchronously when

- expected runtime is short and predictable
- no polling loop is needed
- no scarce/paid external runtime is started
- no cleanup obligation exists
- validation can finish in the current turn

### Use background worker when

- expected runtime exceeds about 60 seconds
- external worker/provider completion must be polled
- render/export/download/upload/deploy/browser/device work is involved
- the task can time out or outlive the chat turn
- user experience benefits from quick acknowledgement
- failure evidence/artifacts matter

Mixed skills should encode both paths rather than marking every invocation heavy.

## Parent Session Responsibilities

Before spawning:

- Confirm the task is safe to execute.
- Ask only for the one missing decision that blocks safe progress.
- Validate external/destructive/privacy-sensitive actions have permission.
- Determine whether child needs isolated or forked context; prefer isolated.
- Define objective, inputs, write scope, safety boundaries, validation gate, timeout, and output schema.

After spawning:

- Send a concise accepted/queued message when user-visible delay is expected.
- Do not busy-poll child status from the parent.
- Continue only when a completion event, wake, or explicit check is needed.
- Inspect child result before user delivery.
- Deliver final user-facing result from parent session.
- If child delivery/announce failed, fetch result/artifact when possible and report manually.

The parent should not rely on child workers to send final group messages unless explicitly delegated.

## Child Worker Responsibilities

The child worker must:

- read the relevant domain skill(s) before execution
- execute only within declared write scope
- avoid direct user-visible messaging unless explicitly delegated
- avoid leaking credentials, cookies, tokens, private messages, or raw sensitive data
- save artifacts in the declared artifact directory
- run the smallest meaningful validation gate
- perform cleanup in a finally-style pattern when resources were started
- return structured result, not a long chat transcript

## Standard Child Prompt Contract

A parent spawning a worker should include:

```text
Objective:
Inputs:
Relevant skills to read:
Write scope / artifact directory:
Safety boundaries:
External actions permitted / forbidden:
Execution steps or decision criteria:
Validation gate:
Cleanup obligations:
Timeout / no-infinite-polling rule:
Final output schema:
Do not send user-visible chat messages directly unless explicitly told.
```

## Standard Result Schema

Use JSON when possible:

```json
{
  "status": "completed|failed|blocked|partial|cancelled",
  "summary": "short human-readable result",
  "artifacts": ["path-or-url"],
  "validation": {
    "ran": true,
    "evidence": "command/tool/output/url/status/screenshot",
    "passed": true
  },
  "cleanup": {
    "required": true,
    "completed": true,
    "evidence": "status or path"
  },
  "errors": [],
  "blockers": [],
  "delivery": {
    "child_sent_user_message": false,
    "recommended_parent_message": ""
  },
  "next_actions": []
}
```

If JSON is too restrictive for the domain, still include these fields in a clear structure.

## Artifact Rules

Use a deterministic directory under workspace, for example:

```text
work/<domain>/<YYYYMMDD-HHMM>-<slug>/
```

Save:

- input/request summary with sensitive fields redacted
- raw or summarized tool outputs needed for verification
- final generated files or links
- screenshots/QC evidence when visual/browser/device work occurred
- logs needed for recovery, bounded and sanitized
- `REPORT.md` for human review when the task is complex

Do not save secrets or credentials in artifacts.

## Progress Updates

For user-facing chat surfaces:

- acknowledge start when work will take more than ~10 seconds
- report submitted/queued when external worker is launched
- report long waits only at meaningful milestones or 60–90 second intervals
- avoid spam
- final report should include result, evidence, artifact/link, and blockers

If a message tool is used to proactively send final results, the assistant’s visible final reply should avoid duplicate delivery according to channel rules.

## Timeout and Failure Policy

No infinite polling.

Before execution, define:

- per-step timeout
- global timeout
- retry/backoff limit
- what partial state to preserve
- whether duplicate execution is safe

On timeout:

- preserve task IDs / process IDs / remote status
- save latest logs/status
- mark result `partial` or `blocked`
- state whether remote work may still be running
- give recovery command or next inspection step

On delivery failure:

- distinguish task failure from delivery failure
- preserve artifact/result
- parent should attempt manual retrieval or report where the result was saved

## Cleanup Policy

For resourceful jobs, cleanup is a validation requirement, not an optional courtesy.

Examples:

- stop cloud phones
- close browser tabs/sessions
- terminate background local processes when no longer needed
- release device handles
- avoid leaving paid workers running

If cleanup cannot be completed, report it as a blocker or risk with evidence.

## Validation Gates

Before claiming success, verify behavior, not just intent.

Examples:

- build/test/lint passed
- curl/link returned expected status
- screenshot/QC inspected
- media export list contains expected files
- background task status completed
- cloud phone status stopped
- artifact files exist and contain expected content

If no validation can run, state why and mark risk explicitly.

## Sibling Coverage

When adding or changing background behavior in a domain skill, check sibling skills that share:

- backend/API/provider
- user trigger phrase
- resource type
- delivery surface
- artifact format

Report siblings as:

- updated now
- separate proposal needed
- intentionally out of scope
- not found / blocked

## Anti-Patterns

Avoid:

- child worker sending final group messages while parent also replies
- parent busy-polling child status
- unbounded `while true` polling
- “task succeeded” with no artifact or validation evidence
- “file created” as the only success proof when rendered behavior matters
- backgrounding every tiny check
- leaving cloud phones/browsers/processes running
- storing tokens/cookies/passwords in logs or reports
- silently treating delivery failure as execution failure
- fixing one sibling skill while leaving another with contradictory behavior

## Example Parent Spawn Brief

```text
You are the background worker for <domain>.
Objective: <concrete deliverable>.
Read skills: <paths>.
Inputs: <sanitized inputs>.
Write artifacts under work/<domain>/<timestamp>-<slug>/.
Safety: do not send user-visible messages; do not expose credentials; do not perform destructive/external actions beyond <scope>.
Validation: <minimal gate>.
Cleanup: <required cleanup>.
Timeout: no infinite polling; stop after <limit>, save partial state.
Return JSON: {status, summary, artifacts, validation, cleanup, errors, blockers, recommended_parent_message}.
```

## Example Final Parent Message

```text
跑完了 ✅
结果：<short result>
验证：<evidence>
产物：<link/path>
风险/阻塞：<none or concise blocker>
```
