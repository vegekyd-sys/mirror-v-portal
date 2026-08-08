---
name: "image-search-apify-first"
description: "Apify-first social visual discovery; DDG remains first for general image search."
alwaysActive: false
---

# Image Search — Apify First Overlay

Use when the user asks for image search, reference images, product photos, social visual references, TikTok/Instagram/XHS visual discovery, or downloading public images/videos for analysis.

## Routing priority

1. General image search → DDG images first (`ddgs.images`) because it is fastest and not a platform crawler.
2. Network crawling / social-platform discovery / TikTok / Instagram / XHS / Bilibili / video references → Apify first when a suitable Actor exists.
3. Browser/Playwright/direct scraping/yt-dlp are fallbacks only after Apify fails, lacks coverage, or login/private content is explicitly required.
4. Apify actor id format is `username~actor-name`, not `username/actor-name`.
5. Load credentials from `APIFY_TOKEN` first, then `APIFY_API_KEY`; token is in `~/.openclaw/.env`. Never expose it.

## Quick Reference

| Need | First choice | Fallback |
|---|---|---|
| General web images | `ddgs.images()` | browser screenshot/download |
| General video search | `ddgs.videos()` | platform Apify Actor |
| TikTok/TT visual/video refs | `clockworks~tiktok-scraper` or script | yt-dlp / browser |
| Instagram/Reels refs | `apify~instagram-reel-scraper`, `apify~instagram-post-scraper` | `easyapi~instagram-reels-downloader`, browser |
| Xiaohongshu/XHS refs | `zen-studio~rednote-search-scraper` | existing XHS scripts/browser |
| Bilibili video refs | `ahmed_jasarevic~bilibili-video-downloader` | browser `__playinfo__`, yt-dlp |
| Product CDN images | search engine → public CDN URL | browser if blocked |

## General Image Search (DDG)

```python
from ddgs import DDGS

ddgs = DDGS()
results = list(ddgs.images('search query', max_results=10))
for r in results:
    print(f"{r['title']}\n{r['image']}\n")
```

Returns title, image URL, source, thumbnail, width, height.

Rate limit: DDG may 403 if called too fast; add a short delay between calls.

## General Video Search (DDG)

```python
from ddgs import DDGS

ddgs = DDGS()
results = list(ddgs.videos('search query', max_results=10))
for r in results:
    print(f"{r['title']}\n{r['content']}\n{r.get('duration')} | {r.get('statistics',{}).get('viewCount')} views\n")
```

Returns mostly YouTube URLs with view counts, durations, thumbnails.

## Apify social visual discovery

### TikTok / TT

Primary Actor:

- `clockworks~tiktok-scraper`

Preferred script:

```bash
node scripts/apify-search.mjs tiktok "query" --limit 20 --json
```

Use returned thumbnails/video URLs/media metadata as references. For music sourcing, aggregate `musicMeta`.

### Instagram / IG / Reels

Primary Actors:

- `apify~instagram-reel-scraper` — reels by profile/reel URL, can scrape/download reels and metadata.
- `apify~instagram-post-scraper` — posts/reels by URLs or usernames.
- `apify~instagram-hashtag-scraper` — hashtag discovery.
- `apify~instagram-profile-scraper` — profile metadata.

Downloader fallback:

- `easyapi~instagram-reels-downloader`

### Xiaohongshu / Rednote / XHS

Primary Actor:

- `zen-studio~rednote-search-scraper`

Input shape:

```json
{"keywords":["AI绘画"],"sortBy":"general","limit":15}
```

`keywords` must be an array. Use returned `images[]`, title/desc, author, and engagement fields.

### Bilibili

Primary Actor:

- `ahmed_jasarevic~bilibili-video-downloader`

Input:

```json
{"links":["https://www.bilibili.com/video/BV..."]}
```

Use `result.best.video`, `result.best.audio`, and `mergeHint` to download/merge references.

## Download Images

### Direct hotlink

```bash
curl -sL -o /tmp/img.jpg "URL"
```

Check file size; if tiny or HTML, fallback.

### Browser/Playwright fallback for anti-hotlink domains

```python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(image_url)
    page.screenshot(path='/tmp/img.jpg', full_page=False)
    browser.close()
```

## Product image search

When product video/image generation lacks materials, use search engine results to find public ecommerce CDN image URLs instead of crawling dynamic detail pages.

```bash
curl -sL -o product.jpg "https://img11.360buyimg.com/n1/...jpg"
```

Rules:

- Search ≠ crawl: prefer search result snippets/CDN URLs over fighting dynamic pages.
- JD/Tmall CDN image URLs are usually directly accessible.
- Analyze downloaded images before using them as generation constraints.

## Important rules

1. General images: DDG first.
2. Social/platform crawling: Apify first.
3. Check downloaded file size and MIME before trusting assets.
4. Present source URLs alongside images when useful.
5. Respect copyright and platform terms; use references appropriately.
6. 管理员's platform cookies are read-only; do not post/comment/write.
7. If Apify returns expired media URLs, rerun Actor instead of reusing stale links.
