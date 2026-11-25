---
name: "image-search-apify-first"
description: "找图片、产品照片、视觉参考；网页图片搜索，社媒案例转交社媒检索入口。"
alwaysActive: false
---

# 网页图片与视觉参考检索

## 1. 按来源分流
通用图片、产品照片、公开电商主图先搜索引擎；社媒图文案例、账号/关键词内容、小红书/TikTok/Instagram/B 站参考转交 [社媒检索入口](../social-search-apify-first/SKILL.md)，Actor/凭据/故障规则只在其 runtime 参考维护。
不要求用户说 Apify 或指定平台；口碑、真实使用场景、图文案例优先考虑社媒，官方产品参数用官方来源。纯生成且不缺参考不检索。
完成判据：所选来源回答的是用户需要的图片/案例，而不是工具名匹配。

## 2. 检索网页图片
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


## 3. 下载并检查
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


## 4. 交付与边界
下载后验证实际图片解码、内容和尺寸，识别 HTML/占位/截图；截图明确标注，不当作原图。给出公共来源页链接和检索范围；获取参考不等于已授权商业复用。
公开资料只读，不替用户发帖/评论。少量检索可同步；批量、长等待交给后台执行，报告失败和清理状态。
社媒媒体验证、签名 URL 处置、账号隔离和费用界限遵从社媒入口的 runtime，不在此复制规则。
