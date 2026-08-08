---
name: "tron-openmontage-kling-video"
description: "Tron OpenMontage + Kling 视频/图片制作 skill：通过 OpenMontage pipeline 调用 Kling API 做图和视频"
---

# Tron OpenMontage + Kling Direct API Video/Image Production Skill

> For Tron agent. Uses OpenMontage's pipeline-driven video production system with **direct Kling AI API** (Tron's own key) for image and video generation. Not fal.ai — direct Kling.

## Architecture

```
User: "做一个60s的产品介绍视频"
  → Tron (OpenClaw agent on Tron's machine)
    → OpenMontage workspace
      → Pipeline selection (pipeline_defs/*.yaml)
      → Stage directors (skills/pipelines/*)
      → Kling Direct API (api-singapore.klingai.com) ← Tron's own key
      → Remotion composition
    → Final video delivered as Feishu attachment/card
```

## ⚠️ Important: Machine Context

Tron runs on a **different machine** from V/Makaron. All commands below are instructions for Tron to execute on his own machine. Do NOT run them on V's machine.

---

# Part 1: Installation Guide (Tron Executes This)

## Step 1: Clone OpenMontage

```bash
# On Tron's machine:
cd ~
git clone https://github.com/calesthio/OpenMontage.git
cd OpenMontage
```

## Step 2: Install Dependencies

```bash
cd ~/OpenMontage

# Create Python virtual environment
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install piper-tts  # local free TTS

# Install Remotion composer deps
cd remotion-composer && npm install && cd ..

# Verify tool registry loads
.venv/bin/python -c "from tools.tool_registry import registry; registry.discover(); print('✅ OpenMontage ready')"
```

System requirements:
- Python 3.10+
- Node.js 18+
- FFmpeg (`sudo apt install ffmpeg` or `brew install ffmpeg`)

## Step 3: Configure Kling API Key

```bash
cd ~/OpenMontage

# Create .env
cp .env.example .env

# Add Kling credentials to .env:
cat >> .env << 'EOF'

# === Kling Direct API (Tron's own key) ===
KLING_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
KLING_API_BASE=https://api-singapore.klingai.com
EOF
```

Get Kling API key:
1. Go to https://kling.ai/dev/api-key
2. Create API Key (the new simple "API Key" mode, not the old AK+SK JWT mode)
3. Copy the key (shown only once)

For the old-style AccessKey+SecretKey, use JWT auth:
```python
# Python helper to generate JWT from AK+SK
import time, jwt
token = jwt.encode(
    {"iss": "YOUR_ACCESS_KEY", "exp": int(time.time()) + 1800},
    "YOUR_SECRET_KEY",
    algorithm="HS256"
)
# Use: Authorization: Bearer <token>
```

## Step 4: Test Kling API

```bash
# Test text-to-video with Tron's key
curl -X POST "https://api-singapore.klingai.com/v1/videos/text2video" \
  -H "Authorization: Bearer $KLING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "kling-v3",
    "prompt": "A gentle sunrise over a calm ocean, slow camera pan, cinematic",
    "duration": 5,
    "mode": "std",
    "aspect_ratio": "16:9"
  }'

# Response: {"code": 0, "data": {"task_id": "..."}}
# Then poll: GET .../v1/videos/text2video/{task_id}
```

## Step 5 (Optional): Configure Free Providers

For zero-cost path (stock footage + free TTS):

```bash
# In ~/OpenMontage/.env, add:
PEXELS_API_KEY=*** from pexels.com/api>
PIXABAY_API_KEY=*** from pixabay.com/api/>
# Piper TTS is already installed (Step 2) - totally free, no key needed
```

---

# Part 2: Using the Skill (Tron's Workflow)

## Kling Direct API Reference

### Text-to-Video

```bash
curl -X POST "https://api-singapore.klingai.com/v1/videos/text2video" \
  -H "Authorization: Bearer $KLING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "kling-v3",
    "prompt": "...cinematic description...",
    "negative_prompt": "",
    "duration": 5,
    "mode": "std",
    "aspect_ratio": "16:9",
    "sound": "off"
  }'
```

Models: `kling-v3`, `kling-v2-6`, `kling-v2-5-turbo`, `kling-v2-1-master`, `kling-v2-master`
Duration: 5 or 10 seconds
Resolution: `mode=std` (720p) or `mode=pro` (1080p)
Aspect: `16:9`, `9:16`, `1:1`

### Image-to-Video

```bash
curl -X POST "https://api-singapore.klingai.com/v1/videos/image2video" \
  -H "Authorization: Bearer $KLING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "kling-v3",
    "image": "https://example.com/start_frame.jpg",
    "prompt": "The person slowly turns to camera, gentle smile",
    "duration": 5,
    "mode": "std"
  }'
```

Supported image formats: URL or Base64. Optional `image_tail` for end frame.

### Text-to-Image

```bash
curl -X POST "https://api-singapore.klingai.com/v1/images/text2image" \
  -H "Authorization: Bearer $KLING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model_name": "kling-image-v2-1",
    "prompt": "Product photography of wireless earbuds on dark marble, dramatic lighting, 8K quality",
    "negative_prompt": "",
    "n": 1,
    "aspect_ratio": "16:9"
  }'
```

Models: `kling-image-v2-1`, `kling-image-v2`
Aspect: `16:9`, `9:16`, `1:1`, `4:3`, `3:2`
Count: `n` (number of images)

### Status Polling

```bash
# All tasks return a task_id. Poll for results:
curl -s "https://api-singapore.klingai.com/v1/videos/text2video/$TASK_ID" \
  -H "Authorization: Bearer $KLING_API_KEY"

# Response when done:
# {"code": 0, "data": {"task_status": "succeed", "task_result": {"videos": [{"url": "https://...", "duration": "5"}]}}}
```

Status values: `submitted` → `processing` → `succeed` / `failed`
Poll interval: 3-5 seconds. Videos typically take 2-5 minutes.

### Python Helper Module for Tron

Tron should create a helper at `~/kling-helper.py`:

```python
#!/usr/bin/env python3
"""Kling API helper for Tron."""
import os, time, json, requests

API_KEY = os.environ.get("KLING_API_KEY", "")
API_BASE = os.environ.get("KLING_API_BASE", "https://api-singapore.klingai.com")
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

def text2video(prompt, duration=5, model="kling-v3", mode="std", aspect="16:9"):
    """Submit text-to-video task. Returns task_id."""
    r = requests.post(f"{API_BASE}/v1/videos/text2video", json={
        "model_name": model, "prompt": prompt, "duration": duration,
        "mode": mode, "aspect_ratio": aspect, "sound": "off"
    }, headers=HEADERS)
    d = r.json()
    if d.get("code") != 0:
        raise Exception(f"Kling API error: {d}")
    return d["data"]["task_id"]

def image2video(image_url, prompt, duration=5, model="kling-v3", mode="std"):
    """Submit image-to-video task."""
    r = requests.post(f"{API_BASE}/v1/videos/image2video", json={
        "model_name": model, "image": image_url, "prompt": prompt,
        "duration": duration, "mode": mode
    }, headers=HEADERS)
    return r.json()["data"]["task_id"]

def text2image(prompt, n=1, model="kling-image-v2-1", aspect="16:9"):
    """Submit text-to-image task."""
    r = requests.post(f"{API_BASE}/v1/images/text2image", json={
        "model_name": model, "prompt": prompt, "n": n,
        "aspect_ratio": aspect
    }, headers=HEADERS)
    return r.json()["data"]["task_id"]

def poll(task_id, endpoint="videos/text2video", interval=5, timeout=600):
    """Poll until task completes. Returns result dict."""
    deadline = time.time() + timeout
    url = f"{API_BASE}/v1/{endpoint}/{task_id}"
    while time.time() < deadline:
        r = requests.get(url, headers=HEADERS)
        d = r.json()
        status = d["data"]["task_status"]
        if status == "succeed":
            return d["data"]["task_result"]
        if status == "failed":
            raise Exception(f"Task failed: {d}")
        time.sleep(interval)
    raise TimeoutError("Poll timeout")

# CLI: python3 kling-helper.py t2v "prompt" > t2i "prompt"
if __name__ == "__main__":
    import sys
    cmd = sys.argv[1]
    if cmd == "t2v":
        tid = text2video(sys.argv[2])
        print(f"task_id={tid}")
        result = poll(tid)
        print(json.dumps(result, indent=2))
    elif cmd == "t2i":
        tid = text2image(sys.argv[2])
        print(f"task_id={tid}")
        result = poll(tid, endpoint="images/text2image")
        print(json.dumps(result, indent=2))
```

## OpenMontage Pipeline Integration

Tron can use OpenMontage's pipeline system + stage director skills for full production:

1. **Read AGENT_GUIDE.md**: `~/OpenMontage/AGENT_GUIDE.md`
2. **Read pipeline index**: `~/OpenMontage/skills/pipelines/INDEX.md`
3. **Run tool discovery**: `cd ~/OpenMontage && .venv/bin/python -c "from tools.tool_registry import registry; import json; registry.discover(); print(json.dumps(registry.support_envelope(), indent=2))"`
4. **Select pipeline** from `~/OpenMontage/pipeline_defs/`:
   - `animated-explainer.yaml` — 产品介绍/教育
   - `cinematic.yaml` — 电影感预告
   - `animation.yaml` — Ghibli/动漫
   - `hybrid.yaml` — 实拍+动画混合
   - `talking-head.yaml` — AI口播
5. **Read stage director** from `~/OpenMontage/skills/pipelines/<name>/`
6. **Execute stage by stage**, calling Kling API via the helper script for video/image generation

For production stages that need Kling video/images, Tron calls his own Kling helper instead of OpenMontage's fal.ai tools.

## Pipeline Selection Guide

| User Request | Pipeline | Video Source | Image Source | Cost Estimate |
|---|---|---|---|---|
| "做个产品介绍视频" | animated-explainer | Kling B-roll clips | Kling images | ~$2-5 |
| "电影感短片" | cinematic | Kling video | Kling images | ~$2-8 |
| "动漫风格短片" | animation | Kling video | Kling images | ~$2-5 |
| "口播视频" | talking-head | Kling image-to-video | Kling images | ~$1-3 |
| "实拍混剪+AI素材" | hybrid | Kling + stock | Kling + stock | ~$1-3 |

## Feishu Card UX

When serving video requests in Feishu group chats, Tron should:

1. Create a single task card immediately (not multiple text bubbles)
2. Show pipeline selection + cost estimate in the card
3. Update the SAME card during production: "脚本编写" → "素材生成" → "Kling 渲染中" → "合成中"
4. Attach intermediate images as they're generated
5. Deliver final video as video attachment to chat
6. Show "确认交付" + "重新生成" buttons when done

Tron can implement this via Feishu message.edit or use V's card runner primitives from `scripts/makaron-card-runner/run.cjs` (streamCard pattern).

## Kling Cost Reference

Kling pricing (approximate, from Chinese developer console):
- Text-to-video 720p std: ~0.8 points/sec → ~4 points for 5s video
- Text-to-video 1080p pro: ~1.0 points/sec → ~5 points for 5s video
- Text-to-image: ~0.1-0.2 points/image
- Image-to-video std: ~0.8 points/sec
- Image-to-video pro: ~1.0 points/sec

Points are prepaid; check https://kling.ai/dev/pricing for Tron's account rates.

## Zero-Cost Path (No Kling Credits Needed)

```
Pipeline: animation (stills-only)
Tools: Kling images (free tier or cheap) + Piper TTS (local, free) + 
       Pexels/Pixabay music (free) + Remotion (free)
Output: image slideshow with Ken Burns, narration, subtitles
Cost: $0.00 (if using free stock images) or ~$0.02-0.20 (Kling images)
```

## NEVER DO THIS

- Call Kling API without showing cost estimate first
- Skip pipeline selection and go straight to raw API calls
- Use fal.ai instead of Tron's own Kling API key
- Send multiple text-bubble progress messages instead of updating one card
- Expose API keys in chat messages
- Run OpenMontage commands on V's machine — Tron must run them on his own

## Maintenance

```bash
# Tron updates OpenMontage:
cd ~/OpenMontage && git pull && .venv/bin/pip install -r requirements.txt

# Update Kling helper:
cd ~ && curl -O https://...kling-helper.py  # or manually edit
```
