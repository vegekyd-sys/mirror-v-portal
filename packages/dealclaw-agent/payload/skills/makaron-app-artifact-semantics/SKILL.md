---
name: "makaron-app-artifact-semantics"
description: "Makaron.app产物终态判断与sidecar语义规则"
package: makaron-app
kind: product-spec
aliases:
  - makaron-artifact-semantics
---

# Makaron App Artifact Semantics

This is a Makaron.app runner/sidecar product spec, not an ordinary user-facing skill. Use it when changing or reviewing Makaron card/worker behavior around whether an artifact is final, intermediate, a patch, or input to a next step.

## Core Diagnosis

The failure pattern is treating artifact type as artifact meaning:

```text
video URL appeared = result is done
```

A video can be final output, local patch, preview, temporary segment, or input to the next composition step. Hardcoding many artifact categories is brittle. Makaron.app should use agent judgment at decision points.

## Product Principle

**Worker executes and collects facts. Sidecar V decides artifact meaning.**

When an artifact appears, especially a video, the worker should create a decision point for sidecar V with evidence.

Sidecar V decides one of:

- `final_deliver` — artifact satisfies original user intent;
- `continue_action` — run a completion action or natural next step;
- `revise` — artifact is close but needs another prompt;
- `ask_human` — user judgment is required;
- `stop_failed` — cannot satisfy request;
- `record_intermediate` — show intermediate but do not mark final complete.

## Required Runner Logic Change

Remove brittle auto-finalization:

```text
if video.url:
  deliver video
  mark card done
```

Use:

```text
on artifact/video URL:
  deliver or queue attachment as appropriate
  collect evidence:
    - original user request / expected outcome
    - current prompt
    - Makaron text
    - artifact metadata: type, duration, URL, ids
    - completion_actions if any
    - project media snapshot
    - recent card/run history
  ask sidecar V: is this final or intermediate?
  execute sidecar decision
```

Final card state is not allowed until sidecar V judges the original user intent is satisfied.

## Completion Actions Rule

`completion_actions` are evidence, not automatic commands and not automatic finality.

Sidecar V checks:

- Does the action complete the original request?
- Is it safe and non-destructive?
- Did the user already authorize the final target?
- Does `policy: confirm` require human confirmation, or is V authorized because the intent is clear?

Example: user requested a 15s final video; Makaron produced a 9s patch; `completion_actions` says stitch to full video. Correct decision: `continue_action`, not final delivery.

## Project Media Verification

When images/screenshots/reference assets need to be reusable later:

1. Add images to the same project.
2. Run `project media <projectId> --json`.
3. Verify new `<<<media_N>>>` refs exist.
4. Use those refs for future prompts.

For add-media-only, tell Makaron to only add assets and not generate new media. If future CLI adds `project add-media`, prefer that.

## Screenshot Video-Fix Contract

For screenshot-based local video repair:

- use same Makaron project;
- include problem-frame screenshot;
- include relevant reference assets;
- instruct Makaron to preserve good parts and repair the local issue;
- timecode is optional evidence, not required from the user.

## Card UX Requirements

Card state must reflect sidecar judgment:

- intermediate: `已生成局部修复片段，V 正在继续合成完整视频`;
- continue action: `V 正在执行 Makaron 的下一步：拼回完整视频`;
- final: `最终视频已发送`.

Show final action buttons only after final judgment.

## Validation Scenario

Reproduce Mirror V case:

1. Full 15s video exists.
2. Screenshot-fix generates 9s patch with `completion_actions` to stitch.
3. Worker records patch but does not final-complete.
4. Sidecar decides `continue_action`.
5. Worker stitches in same project/card.
6. Final 15s video is delivered and card completes only then.

## Non-goal

Do not create a huge hardcoded artifact-role taxonomy. The goal is a Makaron.app loop where sidecar V judges artifact meaning from context.

## Package Note

This belongs to the future `makaron-app` package, likely under product-spec/runner-spec rather than normal user-triggered skills.
