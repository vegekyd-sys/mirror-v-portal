# TikTok 视频下载并发到飞书（竞品/爆款调研）

来源：memory/2026-07-31.md、2026-08-06.md、2026-08-07.md（Librarian 2026-09-28 编译）。命令细节以当下脚本为准。

## 稳定流程（2026-08-07 版）

1. `web_search` 先确认企业主营产品和品类关键词。
2. Apify 搜索：`node scripts/apify-search.mjs tiktok "<keyword>" --limit 20 --json`，8–12 个关键词并行覆盖（当时单关键词常只回 1 条）。
3. 下载走 tikwm.com API：检查 `code==0`，优先取 `data.hdplay`，其次 `data.play`。tikwm 限速约 1 req/s；它的视频列表接口被 Cloudflare 拦，不可用。
4. `ffprobe` 验证同时有 video 和 audio stream：图片帖（`/photo/`）下下来是纯音频，要剔除或标注。
5. 分批发飞书：`message` 工具发附件，每批 3–4 个，文件名带点赞量；单个 >15MB 常被拦，压缩或逐个发。

## 已知坑

- yt-dlp 下载 TikTok 在 2026-08-04 大面积 rehydration error，成功率约 30–40%；`--extractor-args "tiktok:api_hostname=us.tiktok.com"` 偶尔有用但不可靠，已被上面的 tikwm 路径取代。yt-dlp 仍可用来列账号视频（`--print-to-file`）。
- 下载 200 不算成功，必须 ffprobe 过。

## 调研输出格式（2026-07-31）

- 按 B2B 工厂线 / C 端种草线分类，逐条拆内容公式；每个视频配一条分析消息，最后一条发品类获客总结。
