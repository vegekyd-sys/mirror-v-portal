---
name: "social-search-apify-first"
description: "Apify-first social search incl. 视频号账号名发现/下载"
---

# Social Search — Apify First

## Versioning

- **1.0.0 baseline**: TikTok/XHS/Google Trends Agent Skills discovery, plus verified Douyin and Bilibili search/download paths.
- **1.1.0**: adds WeChat Channels / 视频号 search, metadata collection, MP4 download validation, single `sph` link fallback download, and Feishu archive workflow.
- **1.2.0 proposal**: adds WeChat Channels account-name discovery: search by visible account name, convert `exportId` to account `v2Name`, crawl account video catalog, decrypt account CDN videos with `decode_key`, then run ASR/analysis. Verified on 2026-06-27 for 视频号「一叶知丝路」/ 叶敏捷.

## When to use this skill

Use this skill when the user asks to find, search, discover, benchmark, or collect public social-platform content or visual/video references from TikTok, 小红书/Xiaohongshu/XHS/Rednote, Douyin, Bilibili, Google Trends, or 视频号 / WeChat Channels. Trigger it for requests like 社媒内容雷达, 爆款/热门内容, 竞品灵感, viral references, short-video examples, TikTok references, TikTok 内容, TikTok 热门, 小红书内容, XHS 内容, 小红书笔记, 视频号搜索, 视频号下载, Agent Skill 热门视频, or requests for many links with creator/engagement metadata.

## Global rules

- Apify actor id format is `username~actor-name`, not `username/actor-name`.
- Never print or store real APIFY token values in commands, logs, prompts, proposals, or reports.
- For large or download-capable jobs: probe metadata first, inspect field quality/row count, download a small verified sample, validate with `ffprobe`, then scale.
- Signed CDN URLs are short-lived and may contain tokens. Do not keep raw actor outputs with signed media URLs longer than needed; keep safe manifests and downloaded media.
- Final success for downloads requires real MP4 validation, not just HTTP 200 or `content-type: video/mp4`.

## TikTok / XHS fast paths

- TikTok / TT: use `node scripts/apify-search.mjs tiktok "<query>" --limit <N> --json`; primary Actor `clockworks~tiktok-scraper`.
- 小红书 / Xiaohongshu / XHS / Rednote: use `node scripts/apify-search.mjs xhs "<query>" --limit <N> --json`; primary Actor `zen-studio~rednote-search-scraper`; Actor input must use `keywords` as an array.

For speed, accuracy, and quantity: run independent TikTok/XHS probes in parallel when safe, expand into 2–5 focused keywords, use high enough per-keyword limits, then merge, dedupe, and rank by engagement metrics.

## Live discovery workflow for hottest Agent Skills content

When the user asks for the hottest/most popular Agent Skills, AI Agent, Claude Code Skills, AI tools, or similar social content, do not stop at selecting an Actor. Run a controlled live probe first, then optimize the search plan from real result counts.

Default live-probe plan:

1. Run platform probes without downloading media first.
2. Start with exact intent keywords such as `agent skills`, `AI agent skills`, `Claude Code skills`, `AI Agent 教程`, `AI智能体`, and `Agent Skills`.
3. If a platform returns fewer than the requested amount, expand queries before declaring sparse results.
4. Use enough per-query limit to exceed the final target after dedupe, usually `--limit 20-30` per query for research tasks.
5. Merge all platform/query outputs, dedupe by stable video/item id, then rank by engagement score.
6. Report raw row count, deduped count, per-platform count, top results, query coverage, and sparse/failed queries.

Observed live behavior from the 2026-06-15 Agent Skills smoke: TikTok may return only one item per query from `clockworks~tiktok-scraper`, so TikTok needs broader query expansion. XHS/Rednote returned many high-engagement Agent Skills results, so prioritize XHS for quantity and use TikTok as a high-signal supplement unless the user specifically asks TikTok-first.

Example controlled probe commands:

```bash
node scripts/apify-search.mjs tiktok "agent skills" --limit 30 --json
node scripts/apify-search.mjs tiktok "Claude Code skills" --limit 30 --json
node scripts/apify-search.mjs xhs "Agent Skills" --limit 30 --json
node scripts/apify-search.mjs xhs "AI Agent 教程" --limit 30 --json
```

## WeChat Channels / 视频号 search + download — 1.1.0

### When to use

Use this section when the user asks to search 视频号 / 微信视频号, download 视频号 videos, or collect 视频号 content into a Feishu doc. Example: “搜索最近比较火的 10 个 Agent Skill，视频号上，再把这 10 个视频全部下载下来，结合简介放到一个飞书里”。

### Primary actor

- Actor: `ethereal_wool~wechat-channels-scraper`
- Good at: keyword search, metadata, creator/title/engagement fields, and search-result `videoUrl` retrieval.
- Important caveat: direct URL-shaped inputs may be ignored by this actor and can return its default sample/search result. Do not trust a result until title/author/exportId match the intended target.

### Keyword search input

Run one focused keyword per actor run for easier debugging and ranking:

```json
{
  "searchKeywords": ["Agent Skill"],
  "maxItems": 20
}
```

Recommended Agent Skill / AI Agent 视频号 keywords:

```text
Agent Skill
AI Agent Skill
Claude Skill
Claude Code Skill
Agent 技能
AI Agent 技能
智能体 技能
智能体 Skill
MCP Agent
OpenAI Agent
```

### Ranking and dedupe

1. Merge all actor outputs.
2. Dedupe by `exportId`, then `id` / `docId`, then title.
3. Prefer relevant titles/descriptions containing terms like `agent`, `skill`, `智能体`, `技能`, `claude`, `code`, `mcp`, `openai`, `cursor`, `codex`, `工作流`, `workflow`.
4. Rank by relevance first, then engagement. A practical score:

```text
relevance_terms * 100000 + exact_agent_skill_match * 50000 + likeCount*3 + favCount*4 + forwardCount*5 + commentCount*2
```

5. For “最近比较火”, include recent-but-relevant candidates even if raw likes are lower. Report both relevance and engagement tradeoffs.

### Account-name discovery and account catalog crawl — 1.2.0

Use this path when the user only provides a 视频号 account display name, screenshot, or person/company name, and asks to collect that account's videos. Example: “自己 Apify 探索下怎么用账号名找到内容”, “把叶敏捷/一叶知丝路的视频号内容都下载下来”.

Primary actor for this flow:

- Actor: `sian.agency~wechat-channels-scraper`
- Good at: account/video operations including `searchVideo`, `convertExportId`, and `accountVideos`.
- Verified case: 2026-06-27, account display name `一叶知丝路`, person `叶敏捷`; pulled 50 account videos, decrypted Top15, ran ASR, and created report `https://versa-ai.feishu.cn/docx/OisIdY4rXoGlJ9xperrczuBonch`.

Workflow:

1. **Search videos by account/person keywords**. Prefer display-name keywords first, then person/company variants.

```json
{
  "operation": "searchVideo",
  "keyword": "一叶知丝路",
  "maxResults": 20
}
```

2. **Identify a matching result** by checking title/author/description. Do not assume the first result is correct if the account name is ambiguous.
3. **Convert the result `exportId` to account `v2Name`**:

```json
{
  "operation": "convertExportId",
  "exportId": "export/UzFf..."
}
```

4. **Crawl the account video catalog** with `accountVideos`:

```json
{
  "operation": "accountVideos",
  "v2Name": "v2_...@finder",
  "maxResults": 50
}
```

5. **Rank videos**. If play count is unavailable, use interaction-weighted ranking. Practical default:

```text
forward_count * 3 + fav_count * 2 + comment_count * 2 + like_count
```

6. **Download/decrypt account catalog videos**. Account catalog `download_url` may be encrypted (`X-encflag=1`) and `ffmpeg`/`curl` alone can produce an unusable stream. If the item has `decode_key`, decrypt first using `wxipad-video`, then validate with `ffprobe`:

```bash
python3 -m venv work/wechat-account/venv
work/wechat-account/venv/bin/pip install -q wxipad-video requests
```

```python
import wxipad_video
mp4_bytes = wxipad_video.decrypt_video(item["download_url"], int(item["decode_key"]), timeout=180)
open("video.mp4", "wb").write(mp4_bytes)
```

7. **Extract audio and run ASR**. For long analysis tasks, save `summary.json`, per-video `.txt` transcripts, and a merged `topN_transcripts.md`. Keep raw signed URLs out of durable docs.
8. **Report evidence**: number of catalog videos found, ranking proxy used, number successfully decrypted/downloaded, ASR completion count, and final artifact link.

Caveats:

- `searchAccount` may return zero even when `searchVideo` can find the account. Do not stop after `searchAccount` fails; use video search → exportId → v2Name.
- Search-result `videoUrl` and account-catalog `download_url` behave differently. Search-result URLs may be directly playable; account-catalog URLs may require `decode_key` decryption.
- Signed CDN URLs expire. Download/decrypt promptly, and keep only safe manifests/transcripts in durable memory.
- If a user asks for “播放量最高”, but play count is not exposed, explicitly state the proxy used (e.g. interaction score) rather than pretending true play counts were available.

### Download search-result videos

For search-result items, the actor usually provides a usable `videoUrl`. Download immediately because signed URLs expire.

Recommended pattern:

```bash
# pseudocode: stream item.videoUrl to local mp4, then validate
ffprobe -v error \
  -show_entries format=duration,size,bit_rate \
  -show_entries stream=codec_name,width,height,r_frame_rate \
  -of json "work/weixin-agent-skill/videos/01_title.mp4"
```

Success criteria:

- `ffprobe` returns duration > 0.
- video stream has a codec such as h264/hevc and width/height.
- Do not report success merely because HTTP status is 200.

Known behavior from 2026-06-16: Apify search-result `videoUrl`s for the top 10 Agent Skill candidates downloaded and validated successfully.

### Direct `sph` link download

For a single link like `https://weixin.qq.com/sph/AiLfqUUATr`, prefer the local fallback downloader as the primary practical path:

```bash
python3 scripts/weixin-sph-download.py 'https://weixin.qq.com/sph/AiLfqUUATr' --out work/weixin-sph
```

This script uses the verified 视频号 parsing fallback and saves a playable MP4 plus token-free metadata. It should not persist full parser responses containing signed URLs unless explicit debug mode is needed.

If using Apify for direct `sph` detail lookup, first convert the short URI to `dynamicExportId` via the public feed info endpoint, then call the actor with explicit empty search keywords:

```json
{
  "searchKeywords": [],
  "videoIds": ["export/UzFf..."],
  "maxItems": 1
}
```

Critical caveats:

- Passing `url`, `urls`, `startUrls`, or `shareUrls` may be ignored and return the actor’s default food sample. Always verify target title/author/exportId.
- In the 2026-06-16 direct-link test, Apify returned correct metadata but its direct detail `videoUrl` downloaded as a non-playable/encrypted-looking stream (`ffprobe` failed with `moov atom not found`). For direct single-link download, prefer `scripts/weixin-sph-download.py`.

### Feishu archive workflow for 视频号 collections

When the user asks to “放到一个飞书里”:

1. Create a working directory, e.g. `work/weixin-agent-skill-0616/`.
2. Save safe candidate metadata to `candidates.safe.json` and final selection to `top10_manifest.safe.json`.
3. Remove raw actor output files containing signed media URLs after downloads are verified.
4. Create a Feishu doc with:
   - search keywords and selection criteria;
   - table of rank, title/intro, author, date, duration, engagement, local file path, source keyword;
   - initial observations / content patterns;
   - local download directory.
5. Upload validated MP4s as document file attachments using `lark-cli docs +media-insert --as user --doc <doc_id> --file <file> --type file`.
6. Do not pass `--api-version` to `docs +media-insert`; that shortcut does not accept it.
7. Fetch/read the document after creation/upload to verify title/content and file mentions before reporting completion.

Example Feishu media insert:

```bash
lark-cli docs +media-insert --as user --doc "$DOC_ID" --file "work/weixin-agent-skill/videos/01.mp4" --type file --json
```

### 2026-06-16 verified 视频号 run

- Query set: Agent Skill / AI Agent Skill / Claude Skill / Claude Code Skill / Agent 技能 / AI Agent 技能 / 智能体 技能 / 智能体 Skill / MCP Agent / OpenAI Agent.
- Actor: `ethereal_wool~wechat-channels-scraper`.
- Output: selected 10 Agent Skill-related 视频号 videos.
- Download: all 10 Apify search-result `videoUrl`s saved locally and passed `ffprobe`.
- Feishu doc: `https://versa-ai.feishu.cn/docx/Cs5edUB4loZVRixaPExcvFFwnIc`.
- Work dir: `work/weixin-agent-skill-0616/`.

## Do not change existing working paths

Keep these old paths unchanged unless Tianyi explicitly asks for a separate refactor:

- TikTok / TT: keep `scripts/apify-search.mjs tiktok ...` and its current Actor/input behavior.
- Xiaohongshu / Rednote / XHS: keep `zen-studio~rednote-search-scraper`.
- Google Trends: keep `emastra~google-trends-scraper` and local script behavior.
- Existing report generation / Feishu doc behavior: keep unchanged.

## Credential compatibility

The local environment should expose both names for compatibility:

- `APIFY_TOKEN`
- `APIFY_API_KEY`

Both should point to the same token value. The token is managed in `work/mio-api/.env`
(hot-reloaded from the admin console; legacy fallback `~/.openclaw/.env`).
Never print or store the actual token in reports, skills, or chat.

## Douyin search + video download

Primary path, verified 2026-06-13:

- Actor: `zen-studio~douyin-search-scraper`
- Local wrapper: `scripts/apify-douyin-search.py`

Use this when the user asks to search Douyin videos and retrieve links, metadata, and/or MP4 files.

Recommended command:

```bash
python3 scripts/apify-douyin-search.py "AI生成视频" "AI视频" AIGC --limit 10 --download --download-covers --out work/douyin-ai
```

Useful options:

- `--limit N`: max results per keyword.
- `--download`: download MP4s to Apify KV and local `out/videos`.
- `--download-covers`: download cover images.
- `--sort general|most_liked|latest`: default `most_liked` for popular-video research.
- `--publish unlimited|one_day|one_week|half_year`: default `half_year`.
- `--duration unlimited|under_1m|one_to_five|over_5m`.

Verified output fields:

- `url` / `shareUrl`: Douyin links.
- `authorMeta.name`, `authorMeta.followersCount`: creator data.
- `statistics.diggCount`, `commentCount`, `shareCount`, `collectCount`, `playCount`: engagement data.
- `videoMeta.duration`, `width`, `height`, `downloadUrl`: video metadata/CDN source.
- `videoFile.kvUrl`, `videoFile.sizeBytes`, `videoFile.mimeType`: downloaded MP4 when `--download` is enabled.
- `coverFile.kvUrl`: downloaded cover when `--download-covers` is enabled.

Recommended validation:

```bash
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_type,codec_name,width,height -of compact work/douyin-ai/videos/*.mp4
```

### Douyin workflow pattern

1. Run a metadata probe first without `--download` if the keyword/actor is untrusted or the target scale is large.
2. Inspect `raw_items.json` / `results.csv` for quality and field shape.
3. Run a small `--download` sample, especially before downloading many long videos.
4. Verify local MP4s with `ffprobe` before reporting success or uploading to Feishu.
5. Only then scale to more keywords/results.

### Known bad / weaker Douyin path

Avoid `natanielsantos~douyin-scraper` as the default Douyin search path. In the 2026-06-13 repair run, it returned “No more results for the search term 'AI生成视频'” and then stayed running until manually aborted. It may still be useful for specific post/profile URLs, but it is not the default keyword-search path.

If `zen-studio~douyin-search-scraper` fails, fallback order:

1. Retry with broader/native keywords (`AI视频`, `AIGC`, `AI创作浪潮计划`) and no download.
2. Try `sian.agency~douyin-scraper` for specific operation modes such as video detail/user videos/comments/search videos.
3. Browser/manual extraction only if Apify actors fail and the user still needs the data.

## Bilibili downloader

Primary Actor, verified 2026-06-12:

- `ahmed_jasarevic~bilibili-video-downloader`

Input:

```json
{
  "links": ["https://www.bilibili.com/video/BV..."]
}
```

Useful output fields:

- `result.title`
- `result.duration`
- `result.best.video`
- `result.best.audio`
- `result.best.mergeHint`
- `result.streams.video[]`
- `result.streams.audio[]`

Recommended chain:

```text
Bilibili URL → Apify Actor → best.video/best.audio → ffmpeg -c copy → video analysis/Makaron analyze
```

Example merge:

```bash
ffmpeg -y -i "$VIDEO_URL" -i "$AUDIO_URL" -c copy output.mp4
```

If the Actor returns `result.best.mergeHint`, prefer that command structure.

## Fallback order for Bilibili only

1. `ahmed_jasarevic~bilibili-video-downloader`.
2. `easyapi~bilibili-video-downloader` if the primary Actor fails or lacks needed quality/options.
3. Browser `window.__playinfo__` extraction with Bilibili Referer + browser UA.

Do **not** use `yt-dlp` for Bilibili. It is a known-bad path in this environment and wastes time.
