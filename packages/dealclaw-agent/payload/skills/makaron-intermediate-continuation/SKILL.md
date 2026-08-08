---
name: "makaron-intermediate-continuation"
description: "Continuation mode for Makaron intermediate assets"
---

# Makaron Skill Upgrade Proposal — v1.5 Intermediate Asset Continuation

## Problem

Current Makaron Feishu/Lark workflow correctly forces the inbound parent session to exit after `visible-parent-flow.cjs` or `restart-task-worker.cjs` launches a detached worker. This prevents Feishu long-connection timeout/zombie-session incidents.

But sometimes Makaron output is not the final deliverable:

- generate an image, then insert it into another Feishu card/document/card layout;
- generate an image, then send it into a 3D model conversion pipeline;
- generate a video/image/music draft, then use it as one stage in a broader workflow.

If downstream orchestration remains in the original parent agent, the task is interrupted because the parent must exit by design. The fix must not keep the parent alive or reintroduce `watchEvents`/polling in the inbound session.

## Product Principle

Makaron tasks have two modes:

1. **terminal mode** — Makaron media is the user-facing deliverable. Current v1.4 behavior remains default.
2. **stage mode** — Makaron media is an intermediate asset. The detached worker must trigger a downstream continuation after the needed asset exists.

Parent exit guard remains non-negotiable in both modes.

## Backward Compatibility Guard — Must Not Break v1.4

This proposal is additive and must be implemented as opt-in behavior only.

Non-negotiable compatibility requirements:

1. Existing jobs with no `mode` field must behave exactly like current v1.4 terminal jobs.
2. `mode` defaults to `terminal` everywhere.
3. Continuation logic may run only when all are true:
   - `job.mode === "stage"`
   - `job.continuation.enabled === true`
   - required non-text assets have been produced or recovered
4. Existing terminal branch in `generic-task-worker-v14-staged.cjs` must still mark `sentAssets.length > 0` as delivered and update the card to `已发送，等待反馈`.
5. Existing v1.4 review-sidecar behavior must remain unchanged for terminal jobs.
6. `visible-parent-flow.cjs` default worker remains v1.4 staged worker; only new CLI flags add stage metadata.
7. `create-task-job.cjs` must preserve legacy fields (`mediaAssets`, `imagePaths`, `videoPaths`, `schemaVersion` compatibility) so current button reroll / restart paths still work.
8. No continuation code may run in the Feishu inbound parent session.
9. Before rollout, run no-regression terminal tests for normal image and video card tasks.

If any of these cannot be guaranteed, do not enable v1.5 in production.

## Skill Rule Additions

### 1. Classify terminal vs stage before launching Makaron

Before creating a Makaron card, decide whether the task is terminal or stage/intermediate.

Use **stage mode** when the user asks for Makaron output to be used by another process, e.g.:

- “做张图然后加入飞书卡片”
- “先出图，再转 3D / Meshy / 模型”
- “生成素材给后面的海报/白板/文档/卡片用”
- “先让 Makaron 做一版，再交给另一个流程继续”

Use terminal mode when the output itself is the requested deliverable.

### 2. Never let the inbound parent own downstream waiting

In stage mode, the parent still must:

1. download/acquire required user materials;
2. create the Makaron card immediately;
3. launch the detached worker;
4. return/exit immediately.

The parent must not wait for Makaron output, poll worker logs, call `responses watch`, or hold the downstream workflow in memory.

### 3. Pass a continuation contract into the job

Stage-mode parent helpers should pass continuation metadata into the Makaron job JSON.

Proposed job shape:

```json
{
  "kind": "makaron-task",
  "schemaVersion": "makaron-task-v1.5",
  "mode": "stage",
  "expectedAssets": ["image"],
  "continuation": {
    "enabled": true,
    "kind": "agent",
    "agentId": "makaron",
    "sessionKey": "agent:makaron-continuation-<cardId>",
    "prompt": "After Makaron produces the required image, use the completion JSON to continue the downstream task...",
    "completionFile": "<filled by worker>",
    "updateSameCard": true,
    "exposeIntermediateAssets": true
  }
}
```

Supported continuation kinds:

- `agent`: launch a detached OpenClaw agent/session with a prompt that includes the completion JSON path and downstream objective.
- `command`: launch a deterministic script with the completion JSON path, for flows like Feishu card assembly or 3D conversion where code is clearer than LLM planning.
- `none`: stage-mode classification was made, but no safe downstream handler is available; card should say it is waiting for a supported continuation handler instead of pretending the task is done.

### 4. Worker writes a completion JSON when required assets exist

When the Makaron worker obtains required non-text assets, it should write a machine-readable completion file before marking the card final.

Proposed completion JSON:

```json
{
  "version": "makaron-stage-completion-v1",
  "chatId": "oc_xxx",
  "cardId": "om_xxx",
  "projectId": "...",
  "projectUrl": "https://www.makaron.app/projects/...",
  "runIds": ["..."],
  "assets": [
    {
      "type": "image",
      "url": "https://...",
      "localPath": "/root/.../output/image.png",
      "id": "...",
      "source": "watch|recovery|project-media"
    }
  ],
  "makaronSay": "latest Makaron text",
  "createdAt": "ISO timestamp"
}
```

### 5. Worker triggers continuation, not the parent

After writing completion JSON:

- If `continuation.kind === "command"`, spawn the command detached and pass `--completion <completion.json>`.
- If `continuation.kind === "agent"`, spawn `openclaw agent` detached using the configured `agentId/sessionKey`, with the downstream prompt and completion JSON path.
- If continuation launch fails, update the same card as blocked with the concrete error and the completion JSON path; do not mark the full workflow complete.

The continuation must own the next stage and may update the same card or create a downstream card. It must not rely on the original inbound parent session.

### 6. Card UX for stage mode

Stage mode card wording should avoid implying final delivery too early.

Recommended states:

- `Makaron 正在生成中间素材`
- `中间素材已生成，已发送/已记录，继续下一步`
- `下一步处理中：飞书卡片/3D 模型/海报/文档...`
- `全流程完成` only after continuation succeeds.

Final action buttons should be context-aware:

- terminal mode: current `确认交付` + `重新生成` behavior.
- stage mode before downstream completion: do not show `确认交付`; show only wired controls such as `查看 Makaron 项目`, or downstream-specific retry if implemented.
- stage mode after downstream completion: final confirm/reroll can be shown for the whole workflow.

### 7. Intermediate asset delivery policy

Keep the current rule: non-text Makaron assets remain user-visible unless the downstream workflow explicitly marks them internal/private and the chat context supports that.

For stage workflows, the card should label them as intermediate assets, not final outputs.

## Implementation Targets

Recommended code changes:

1. `scripts/makaron-card-runner/create-task-job.cjs`
   - add `--mode terminal|stage`, default `terminal`;
   - add `--continuation-file <json>` or `--continuation-json <json>`;
   - write `schemaVersion: makaron-task-v1.5` only when stage/continuation fields are present, while preserving v1.3-compatible fields.

2. `scripts/makaron-card-runner/visible-parent-flow.cjs`
   - accept `--mode stage` and continuation args;
   - reflect stage mode in initial card status;
   - still launch worker and exit immediately;
   - default remains terminal v1.4 behavior.

3. `scripts/makaron-card-runner/restart-task-worker.cjs`
   - preserve continuation metadata on same-card restart when the active task is stage-mode;
   - do not downgrade to terminal unless explicitly requested;
   - default remains current v1.4 restart behavior.

4. `scripts/makaron-card-runner/workers/generic-task-worker-v14-staged.cjs`
   - collect delivered assets with local paths/URLs;
   - if `job.mode !== "stage"`, run the current v1.4 delivery branch unchanged;
   - only when `job.mode === "stage"`, write completion JSON and trigger continuation;
   - update same card to downstream-running state instead of final `已发送，等待反馈` only for stage jobs.

5. Add `scripts/makaron-card-runner/launch-continuation.cjs` to safely validate and spawn continuation commands/agents.

## Validation

Minimum validation before accepting v1.5:

1. **No-regression terminal image test**
   - normal image card still creates card, launches v1.4 worker, exits parent, delivers asset, shows final actions.

2. **No-regression terminal video test**
   - normal video card still creates card, launches v1.4 worker + review sidecar, exits parent, delivers video with cover, shows final actions.

3. **Existing restart/reroll test**
   - typed revision and `重新生成` still continue same card/project without stage continuation fields.

4. **Stage smoke test without Makaron spend**
   - synthetic completion JSON triggers a deterministic command continuation and updates the same card.

5. **Stage live test: image → downstream card**
   - Makaron generates one image;
   - worker writes completion JSON;
   - continuation creates/updates a Feishu card using the image;
   - original parent did not stay alive or poll.

6. **Stage live test: image → 3D conversion stub/real pipeline**
   - Makaron generates one image;
   - continuation starts conversion worker;
   - card shows `中间素材已生成，继续 3D`;
   - final card reflects conversion result or concrete blocker.

7. **Failure test**
   - if continuation launch fails, same card clearly shows `中间素材已生成，但下一步启动失败` with a non-sensitive error summary; no silent completion.

## Acceptance Criteria

- Parent/inbound Feishu session still exits immediately after handoff.
- Makaron intermediate assets do not require the original parent agent to remain alive.
- Downstream work is resumed by a detached continuation worker/agent with a durable completion JSON.
- Cards distinguish intermediate asset completion from whole-workflow completion.
- No `responses watch`, sleep, polling, or downstream waiting is added back to the parent session.
- Existing v1.4 terminal image/video/restart/reroll behavior is unchanged unless `--mode stage` / `job.mode === "stage"` is explicitly used.
