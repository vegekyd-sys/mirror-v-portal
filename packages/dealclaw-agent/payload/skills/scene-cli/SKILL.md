---
name: "scene-cli"
description: "CLI-first Scene retrieval: Search exact shots, Agent builds full footage packs, then export MP4s for editing."
---

# Scene CLI — Customer Footage Retrieval

## Core Principle

**Scene finds the right customer footage; downstream editors turn it into a video.**

Scene is a standalone product with a GUI and a local `scene` CLI. For normal agent work, use the CLI—not the GUI or browser—to access indexed customer libraries. Open the GUI only when the user explicitly asks to inspect it, or when the CLI is unavailable and the user approves a fallback.

Scene is the eventual successor to DAM for customer-footage understanding, semantic retrieval, and clipping. It is not an immediate replacement for every existing DAM workflow: DAM and its skills remain in use during migration.

## Trigger Conditions

Use this skill when the user asks to:

- find a specific visual, action, shot, person, product state, or source clip from a customer/project library;
- locate source ranges for an edit, storyboard, script, or creative brief;
- find a complete set of materials for a production process, story, campaign, or multi-beat video;
- export Scene-selected footage as playable MP4 clips for Makaron or another editor;
- inspect Scene projects, structured Search results, or an Agent material plan.

Do not use this skill for:

- direct video creation, styling, captioning, rendering, or timeline editing; hand verified Scene exports to Makaron or another editor;
- ordinary DAM work that the user has not asked to move to Scene;
- browser-based manual selection when the CLI is available;
- non-READY / unindexed projects.

## Check Readiness

```bash
scene --version
scene projects list --json
```

- Use `scene`, not `scene-cli`.
- Confirm the target project is `READY` before claiming its assets are searchable.
- Scene may read `DAM_API_TOKEN`; never print credentials or signed URL query parameters.

## Choose Search vs Agent

### Search — a specific retrieval need

Use `scene search` for a clear visual/action request, a small candidate list, or direct source ranges.

```bash
DAM_API_TIMEOUT_SECONDS=120 scene search '工人手持喷枪向拍框持续喷漆，漆雾清晰可见' \
  --project PROJECT_ID --limit 5 --json
```

Pass the user's request as natural language. A complete-process request should start as one complete natural-language query, not a sequence of browser searches.

Read these as the retrieval contract:

- `project_id`, `asset_id`, `file_name`, `relative_path`: source identity;
- `start_sec`, `end_sec`: authoritative source range;
- `summary`, `evidence`, `match_sources`, `boundary_confidence`: match rationale;
- `coverage_group`, `coverage_order`: stage/order where returned.

If a top result plainly misses the requested action, say so and make one precise semantic retry. Do not silently swap in a browser-picked clip.

### Agent — a complete material pack

Use `scene agent` when the user wants a complete set of footage: a process, several narrative beats, a multi-shot short-video pack, or simply says “帮我把素材找全”.

```bash
scene agent '从这个客户项目找完整的生产流程素材：打磨、喷漆、穿线、包柄；按工序顺序给我可剪的片段。' \
  --project PROJECT_ID --json
```

The user does not need to state a duration. Agent may infer a reasonable duration and coverage range from the creative scope and Project Profile; this is useful planning behavior.

Interpret `partial` correctly:

- It means Scene found a usable, relevant footage plan and transparently identified an unmet coverage, duration, or other constraint.
- Deliver the usable material first; present the gap as an optional improvement path.
- Escalate only when an unmet constraint is explicitly hard (for example, a mandatory stage or strict duration floor). Do not discard an otherwise valid plan merely because it is `partial`.

## Export Playable MP4s

If a downstream editor needs actual clips, use `--export-dir`.

```bash
scene agent '从这个客户项目找完整的生产流程素材，供后续剪辑使用。' \
  --project PROJECT_ID \
  --export-dir ./scene-exports/process-pack \
  --json
```

`--export-dir` materializes each selected authoritative range as an MP4 and writes a manifest. Keep `source_url + start_sec + end_sec` as the source of truth; use local MP4s for editing handoff.

Verify every exported file before claiming it is playable:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries format=duration,size:stream=codec_name,width,height \
  -of json /absolute/path/to/clip.mp4
```

If export fails, retain the source identity/range, retry once, and report the actual state. Never claim a playable handoff without a decodable MP4.

## Handoff to Editing

For a user-approved edit, hand the ordered verified bundle to the downstream editor. For Makaron, attach every selected clip as ordered repeated `--video` inputs and state that Scene footage must remain the main material.

```text
Scene Search / Agent → verified MP4 bundle → Makaron CR → final video
```

Scene owns retrieval and MP4 materialization. Makaron owns edit decisions, pacing, captions, audio, and render QC. Do not conflate a good retrieval plan with a finished-video pass.

## Boundaries and Recovery

- Authorization: check token availability without exposing it.
- Missing project/index conflict: rerun `scene projects list --json` and select a READY project.
- Timeout: confirm project readiness, set `DAM_API_TIMEOUT_SECONDS=120`, then retry once.
- Weak/mismatched result: make one targeted semantic retry and report uncertainty.
- Do not use Scene GUI/browser as a normal fallback.
- Do not publish, send externally, or start paid generation unless the user asks. Exporting clips for a requested edit is allowed.

## Output Contract

- Retrieval only: report project, source file/path, exact range, match rationale, and any gap.
- Agent: report the ordered material plan even if `partial`, separating usable materials from optional improvement paths.
- Export handoff: report the number of verified MP4s and downstream destination. Do not claim final-video success until the editor has rendered and passed its own QC.
