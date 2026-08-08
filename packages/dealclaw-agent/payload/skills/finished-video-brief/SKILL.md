---
name: "finished-video-brief"
description: "Require approved-planning whitelist for every visible brand, logo, trademark, or packaging mark"
---

# Finished Video Brief

## Purpose

Turn approved customer requirements, planning, scripts/shot lists, and verified assets into one production contract per video. Makaron, AutoFlow, and human editors consume the same creative meaning; adapters may change transport format but must not reinterpret the brief.

## Trigger

Use when asked to create, revise, validate, or hand off a 成片 Brief / finished-video brief / production requirement brief for a specific video. Do not use for early ideation, broad campaign planning, unapproved scripts, generic prompt writing, or direct video generation without an approved brief.

## Core Principle

A finished-video brief is an executor-neutral production contract. It must let an executor produce the intended video without reopening upstream sources while remaining traceable to them.

## Required Inputs and Gates

Prefer approved customer/product facts, human-approved planning direction, script/shot list, verified assets, output locale/specification, and delivery boundary. Stop before handoff when a required approval is missing, sources conflict, assets cannot support required beats, locale is unknown, proper-noun localization lacks authority, or visible-brand authorization is incomplete. Record the missing input rather than infer it.

## Base-Only Orchestration Gate

When a pipeline is Base-only, chat may explain intent but is not workflow state or authorization. Before handoff:

- re-read authoritative Base rows for exact brief id/version, review conclusion, quantity, executor/path, publication boundary, immutable asset references, and the approved visible-brand whitelist;
- require the approved brief version and conclusion to be persisted in Base;
- reject stale upstream state rather than letting local files or chat override Base;
- trigger production only from a qualifying Base transition or simulated Cron scan;
- persist production owner and executor task id before long polling.

### Human handoff semantics

Keep the human operation surface minimal and canonical:

- For a review/approval node whose instruction says completion advances the workflow, `处理状态=已完成` is the approval and handoff signal. The next step proceeds only after the Base consumer validates brief/version/assets/quantity/publication boundary and visible-brand whitelist.
- Do not require a second executor-specific permission when the reviewed node already names the executor and completion means “approve and continue”.
- Use a separate executor authorization only when it is itself the business decision of that node.
- Production authorization never implies publication authorization. Keep `是否允许发布` independent and default it to not allowed unless explicitly approved.
- Compatibility/system fields must not be editable canonical triggers.
- Human instructions should name exactly one action for the common approval path; system-only metadata stays hidden.

If Base state is incomplete or stale, stop before media submission. Do not backfill human approval from chat.

## Brief Contract

Create one brief per video with a stable id/version and these sections:

1. Source lineage — source ids/links, versions, approvals, immutable references.
2. Audience and objective — one audience, one objective, intended takeaway.
3. Direction and viewing mechanism — direction, hook, progression, payoff, CTA.
4. Required beats — ordered visible content, communicated information, purpose.
5. Product truth — allowed claims, observable descriptions, prohibited inference.
6. Visible-brand authority — exact allowlist of every brand, logo, trademark, product-line mark, slogan, packaging mark, and third-party identifier permitted to remain visible or be spoken/written; source each allowlist item to the human-approved planning.
7. Asset authority — allowed projects/assets/clips, ordering/matching constraints, preflight.
8. Localization authority — source/target locale and approved localized proper nouns.
9. Output contract — platform, duration, ratio, language, audio/subtitles/CTA, delivery/publication boundary.
10. Review gates — deterministic, semantic, runtime asset, rendered-output, and required human checks.

Keep the brief focused on the current video; do not dump unrelated approved material.

## Visible Brand Red Line

Treat every visible or audible brand indicator as denied by default.

- A brand, logo, trademark, product-line name, slogan, packaging mark, watermark, storefront sign, UI brand, or third-party identifier may appear in the final artifact only when the human-approved planning explicitly names and allows that exact mark.
- Customer-owned, supplier-owned, product-native, embedded-in-footage, or uploaded-by-customer does not mean authorized. Asset provenance is not brand permission.
- An instruction such as “avoid LEGO” is a prohibition, not an allowlist for every other visible mark.
- “No third-party brands” is insufficient when ownership is unverified. Unknown ownership remains denied until explicitly approved.
- The allowlist must cover spelling, logo/form, placement/context, and locale when relevant. Do not infer aliases, translations, sub-brands, product-line labels, or packaging slogans.
- If the approved planning contains no visible-brand allowlist, the executable default is `none allowed`; crop, mask, blur, replace the shot with another approved asset, or stop for human confirmation. Do not silently weaken the creative direction.
- The brief builder, executor adapter, and final QC must all consume the same allowlist. Free-text prompts must not be the sole enforcement mechanism.

## CTA Rule

A CTA proposed in the human-approved planning may be used and adapted as normal short-video structure unless the planning or customer explicitly prohibits it. The executor may improve wording while preserving intent and factual boundaries. A CTA does not require separate sentence-level customer confirmation merely because it was introduced during approved planning.

## Localization Rules

Generate each locale directly from the authorized source. Localize proper nouns only through approved localized forms. Otherwise omit them or preserve verified original text only when unavoidable. Review locales independently for fact equivalence, proper-noun and brand authority, claims, hook/CTA meaning, and beat alignment.

## Runtime Judgment

The executor may rewrite narration, subtitles, CTA wording, pacing, transitions, and audiovisual expression when permitted. It must not delete required beats, change direction, invent facts, substitute unsupported assets, change locale/format, or introduce/unmask any non-allowlisted brand indicator. If technical adaptation cannot preserve semantics and the brand allowlist, stop and report incompatibility.

## Executor and Asset Routing

- Real-footage edit: pass original videos and immutable references only after a preflight scan identifies every visible mark and proves each one is allowlisted or removable.
- Generation: only when generated visuals are explicitly authorized; prompts and references must prohibit non-allowlisted brand generation.
- Hybrid: only when generated gap-filling is expressly permitted; generated material cannot evidence product, packaging, process, certification, commercial claims, or unauthorized brands.

Missing/unreadable required clips are a hard stop. Do not replace them without approval.

## Background Production Handoff

Brief creation and deterministic validation are synchronous. Media generation/render/export/download/upload/polling run in a bounded background worker. Persist project/task ids immediately; resume rather than duplicate after timeout. Production authorization does not imply publication authorization.

## Validation

A brief passes only when source lineage/approvals resolve; audience/objective/direction/hook/CTA/beats exist; claims are authorized or observable; assets support the beats; locale permissions are complete; and the visible-brand allowlist is explicit and traceable to human-approved planning.

Apply three brand gates:

1. Preflight: inventory all visible/audible marks in every candidate asset and compare exact matches against the allowlist.
2. Handoff: pass the allowlist and denied-by-default rule as structured production constraints.
3. Rendered QC: inspect the complete artifact across the full timeline, including packaging, transient frames, reflections, background signage, subtitles, audio, end cards, watermarks, and generated overlays. Any non-allowlisted or uncertain mark is a hard fail.

Before declaring handoff or pipeline acceptance successful, inspect a rendered artifact for duration/ratio/playability, beat coverage, language/text, claim safety, lineage, audio/subtitles, publication state, and full-timeline brand compliance.

## Failure Handling

- Missing/conflicting source or brand authority: stop and identify exact human confirmation needed.
- Unauthorized/unknown mark: crop, mask, blur, use another approved asset, or fail; never assume ownership/authorization.
- Unsupported asset: stop or replace only with approved equivalent.
- Executor drift: fail QC and rerun from the same brief without weakening gates.
- Worker stall: preserve ids/checkpoints and resume/query.
- Partial artifact: label partial; do not mark complete.
- Publication ambiguity: default to no publication.

## Sibling Scope

- `makaron` owns Makaron media execution and visible task workflow; it must enforce this brief’s brand allowlist in submission and final QC.
- `autoflow-pipeline` owns AutoFlow/DAM execution details; it must not treat DAM/customer-upload provenance as brand authorization.
- This skill owns the shared semantic brief and validation gates; it must not duplicate backend credentials or commands.
