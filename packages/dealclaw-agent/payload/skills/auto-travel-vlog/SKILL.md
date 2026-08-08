---
name: "auto-travel-vlog"
description: "ZIP旅行视频→自动剪辑成片：解包→抽帧理解→AI选段→ffmpeg合成竖版vlog，带BGM+标题字幕，无TTS"
---

# Auto Travel Vlog

Transform a ZIP of travel video clips into a ready-to-share vertical (9:16) short-form vlog — with BGM, clean title subtitles, and no TTS.

## Trigger

User uploads a ZIP containing phone-recorded travel video clips (MP4/MOV) and says something like "剪一条旅行vlog" / "自动成片" / "travel vlog".

## Output

- **Format**: 720×1280 vertical MP4 (9:16)
- **Duration**: 30–45 seconds (default target ~36s)
- **BGM**: yes — user-provided or built-in ambient track
- **Title subtitles**: yes — per-segment short labels (top-left), opening title card (centered), ending card
- **TTS / voiceover**: no
- **Color**: slight contrast/saturation lift + vignette for cinematic feel
- **Transitions**: short fade-in/fade-out between clips

## Pipeline

### Step 1 — Receive & unpack ZIP
- Accept the uploaded ZIP
- Unpack to a working directory: `extracted/{subdir}/{video}.mp4`
- Index videos by filename, collect basic ffprobe metadata

### Step 2 — Extract keyframes & analyze
- For each video, extract ONE representative frame (first frame or middle frame) to `frames/v{idx}.jpg`
- Use AI vision model (Gemini / GPT-4o) to analyze each frame and describe: scene type, mood, visual quality, what's happening
- Produce `video-summary.json`:
```json
[
  { "idx": 1, "path": "extracted/...", "duration": 28.5, "width": 1080, "height": 1920, "rotation": 0, "frame": "frames/v01.jpg", "scene": "underwater coral reef", "mood": "calm, immersive" },
  ...
]
```

### Step 3 — Auto-select segments
Based on AI analysis, build an editing plan:

- **Selection rules**:
  - Prefer clips with clear subjects, good lighting, motion
  - Avoid shakiness, blur, dark clips unless intentionally atmospheric
  - 1.2–2.5 seconds per segment for fast-paced montage feel
  - Arrange in a narrative arc: opening (establishing shot) → adventure (action) → peak (highlight moment) → closing (sunset / goodbye)
- **Speed**: normal clips @ 1.0×; action clips @ 1.08–1.20× for energy
- **Labels**: short English or Chinese captions per segment, one opening title card, one ending card

### Step 4 — ffmpeg compose clips
For each selected segment:
- Trim with ffmpeg `-ss` / `-t`
- Scale + crop to 720×1280 centered
- Color grade: `eq=contrast=1.08:saturation=1.18:brightness=0.015` + `unsharp`
- Fade in/out: 0.10s / 0.12s
- Text overlay: segment label (top-left, white, shadow, underline accent) or title card (centered, dark overlay, subtitle line)
- Output to `clips_v{xx}.mp4`

### Step 5 — Concat + BGM
- Concat all clips with `ffmpeg concat demuxer`
- Add BGM: loop user-provided music, trim to video duration, fade out last 1.5s
- Volume: BGM at ~0.52–0.62×, adjusted per clip
- If original clip audio is useful (waves, splashes), mix at low volume (0.28–0.58×) alongside BGM
- Encode final: `libx264`, `crf 21–23`, `aac 160k`, `faststart`

### Step 6 — End card
- Append a 1.2s end card: dark background, main title + subtitle line
- Or bake into the last clip of the concat

## Version Variants

The skill supports three output modes:

| Mode | BGM | Original Sound | Style |
|------|-----|---------------|-------|
| **v1 (ambient)** | Synthetic ambient sine chords | No | Minimal, peaceful |
| **v2 (upbeat)** | User/music track, full | No | Energetic montage, fast cuts |
| **v3 (SFX mix)** | Music track, 52% vol | Clip audio mixed in at 28–58% | Immersive, with natural sound |

Default: **v2 (upbeat)** — the version confirmed as preferred output.

## Edge Cases & Fallbacks

- **Video too short**: skip clips < 2 seconds
- **Landscape video → vertical**: center-crop with `crop=720:1280` after scaling
- **No BGM provided**: generate synthetic ambient track via `lavfi sine` mix
- **Font missing**: fallback to DejaVu Sans
- **ZIP with nested folders**: flatten to flat video list after extraction
- **Corrupt / unreadable video**: skip and note in summary

## Dependencies

- `ffmpeg` + `ffprobe` (with libx264, aac, drawtext, lavfi)
- `unzip`
- Noto Sans CJK font (or DejaVu Sans fallback)
- AI vision model (Gemini / GPT-4o) for frame analysis
- BGM track (user-provided or built-in ambient fallback)

## Quality Gate

Before delivering the final video:
1. Check duration is in range (30–45s)
2. Verify all segment labels are readable (not clipped by crop)
3. Confirm BGM plays throughout, fades out cleanly
4. Spot-check 2–3 transitions are smooth (no black frames, no audio pop)
5. If QC fails, re-render with adjustments and report the fix
