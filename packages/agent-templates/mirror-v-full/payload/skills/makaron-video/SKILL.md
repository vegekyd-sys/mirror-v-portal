---
name: makaron-video
description: "Generate video scripts and create videos via Makaron CLI. Use when the user wants to: (1) make a video from photos/images, (2) generate a short video clip, (3) create a story or montage video, (4) animate a photo, (5) produce a cinematic short. After writing the script, ALWAYS call `makaron video create` to render — never stop at script-only unless the user explicitly asks to review first."
---

# Makaron Video

## ⚠️ Before Writing Any Script

**MUST** read [references/prompt-rules.md](references/prompt-rules.md) in full. Every word in that document matters — it is the canonical prompt that Makaron Agent uses for video. Treat it as verbatim specification, not summary.

## CLI Reference

```bash
makaron video create --script "..." --image <url_or_file> [--image <url2>] \
  [--duration 5|10] [--aspect 9:16|16:9|1:1] [--model kling|seedance] \
  [--video-ref <url>] [--video-ref-type feature|base] \
  [--motion-control] [--keep-original-sound] \
  [--character-orientation image|video] [--out result.mp4]

makaron video status <taskId>
```

## Mode Decision (quick reference)

| Mode | CLI flags | Prompt rules |
|------|-----------|-------------|
| **Reference** (default) | `--image` × N + `--aspect` | Full script with `<<<image_N>>>` |
| **Video Reference** (`feature`) | `--video-ref` + `--video-ref-type feature` | SHORT prompt <200 chars |
| **Video Edit** (`base`) | `--video-ref` + `--video-ref-type base` + `--keep-original-sound` | Kling only |
| **Motion Control** | `--motion-control` + `--video-ref` + `--keep-original-sound` + `--character-orientation` | No detailed prompt — title only |

## Workflow

1. Read [references/prompt-rules.md](references/prompt-rules.md) — the full Makaron Agent video prompt
2. Analyze provided images, select 3-7 best shots, reorder for story
3. If the user provided a reference/viral video, use `video-analyze` first and convert its timecoded storyboard into the Makaron script beats. Do not use ASR as the analysis source unless exact subtitles are explicitly required.
4. Write script following the prompt rules exactly
5. Call `makaron video create` with the script and images
6. Poll `makaron video status <taskId>` until complete
