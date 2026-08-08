---
name: "makaron-app-workflow-contract"
description: "Makaron.app模板到增长/广告闭环工作流"
package: makaron-app
aliases:
  - workflow-contract-v01
  - skill-to-ad-growth-contract
---

# Makaron App Workflow Contract

Use this internal orchestration skill when a Makaron.app template/skill should become a repeatable growth workflow, not just a one-off creative asset.

This is the canonical `makaron-app-*` replacement for `workflow-contract-v01` and the older rejected `skill-to-ad-growth-contract`.

## Trigger

Use when:

- a Makaron.app template/skill has launched or is close to launch;
- the team asks whether a template should become a growth/ads workflow;
- a launched template needs FB/Meta ad packaging;
- a weekly review asks which launched templates deserve paid-ad follow-up;
- the task involves Workflow Contract v0.1, FB Ad Creator, Football Captain, World Cup MVP, Broadcast Candid, K-Pop Stage, or similar template-to-growth examples.

Do not use for ordinary one-off image/video generation unless growth-loop packaging, launch, or ad follow-up is explicitly requested.

## Contract Overview

Main chain:

1. Production
2. QC
3. Failure library
4. Reroll / correction
5. Launch
6. FB Ad Creator packaging
7. Paid-ad deliverable
8. Metrics feedback
9. Template / prompt / QC update

Minimum external ad deliverable: `ad_9x16_main_15s.mp4`.

Optional/internal materials: cover frame, caption/headline/CTA, VO text, subtitles/ASS, QC report, failure log, hook variants, metrics feedback placeholder.

## Required Inputs

Gather or infer:

- template/skill name;
- launch status: draft, testing, launched, already advertised;
- representative output sample(s);
- QC result or known failure modes;
- first-second clarity for paid ads;
- available FB Ad Creator inputs: effect video, English app recording, selfie/before image, logo CTA/end card;
- target market/language;
- existing ad data if available.

If an asset is missing, mark it as a blocker instead of inventing it.

## Workflow

1. **Classify template:** primary v0.1 case, historical paid-ad baseline, control case, or new candidate.
2. **Build contract record:** template, owner, stage, sample, QC verdict, failure modes, reroll notes, launch status, ad readiness, next action.
3. **QC before packaging:** do not package weak output. Check first-second clarity, transformation, artifacts, crop, watermark, text, face/body distortion, IP/logo risk, and match to template promise.
4. **Package with FB Ad Creator:** 12–15s 9:16 ad: hook → selfie/before → app/tutorial → effect showcase → logo CTA.
5. **Define deliverables:** at minimum `ad_9x16_main_15s.mp4`; ideally include cover/copy/VO/subtitles/QC/failure log/hook variants.
6. **Close loop:** feed spend, impressions, CTR, CPC/CPA, retention, winning hooks, and QC changes back into prompts/templates.

## Weekly Operating Rule

For newly launched Makaron.app templates:

- post launch internally when appropriate;
- every Friday, review launched templates;
- decide which templates deserve FB Ad Creator packaging;
- list blockers and next paid-ad candidates.

## Output Format

```markdown
结论：适合 / 暂不适合 / 需要补素材
模板：...
阶段：...
QC：pass / reroll / blocked / unknown
广告包装：ready / missing assets / not recommended yet
最小投放物：ad_9x16_main_15s.mp4
下一步：...
阻塞：...
```

## Safety

- Do not claim launch/ad/performance state without evidence.
- Do not fabricate metrics, links, screenshots, or ad results.
- Do not send external-facing ads, post publicly, or launch campaigns without explicit approval.
- Internal reversible analysis and proposal drafting are allowed.
- For customer/user materials in group chats, confirm materials are complete before heavy processing.

## Package Note

This skill belongs to the future `makaron-app` skill package with `makaron-app-fb-launch-content`, `makaron-app-artifact-semantics`, and `makaron-app-daily-evidence-collector`.
