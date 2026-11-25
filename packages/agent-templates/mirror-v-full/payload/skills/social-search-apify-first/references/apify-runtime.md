# Apify 共享执行规则

## 凭据与账号
默认账号按名字顺序 APIFY_TOKEN → APIFY_API_KEY；每个名字先看进程环境，再看本机 ~/.openclaw/.env。不修改 token 值，不强制两个别名相等。
**只有默认账号一个作用域**：按名字顺序 APIFY_TOKEN → APIFY_API_KEY，不按账号切换、不传 `--account`（原 `haoyuan` 作用域 2026-10-12 停用，夜班策划案同样走默认 key）。账号失败不自动切换。
使用 scripts/apify-client.mjs；脚本内部读取凭据，通过 Authorization 请求头认证，不放在 URL、命令参数、日志或输出。新凭据只用 host-owned masked entry 和受保护配置；不向聊天收集凭据。

## API 合约与边界
REST Actor ID 用 username~actor-name。开始前获取 acts/<id>/builds/default 的 inputSchema，核对实际字段与 required。
共享 runActor：提交一次 → 保存 runId/datasetId → 查询 actor-runs/<runId> → 只在 SUCCEEDED 时读取 dataset。默认每 run $0.50 / 240 秒；服务端超时也传入提交请求。--max-charge / --timeout 显式改界限；大批量前与用户对齐范围。
--state 记录请求指纹与 run ID。再次执行相同命令/状态路径是恢复/读取已有 run，不是另开任务。SUBMITTING 无 run ID 是提交结果不明，先在 Apify 核对，不自动 retry；FAILED/ABORTED/TIMED-OUT、401/403、限额中断如实报告。恢复成功 run 是快照；需要新检索明确使用新任务状态路径。
完整性检查同时看数量、目标匹配、错误行和字段；少于目标不冒充已满足数量。空数据不自动开 fallback。需要备选 Actor 时明确选择并核对其 schema，不假设同名 Actor 输入相同。

## 常用 Actor 和当前输入要点
| 分支 | Actor | 关键字段 |
|---|---|---|
| TikTok 搜索 | clockworks~tiktok-scraper | searchQueries 数组、resultsPerPage、searchSection="/video"；关闭媒体下载 |
| TikTok 备选 | clockworks~free-tiktok-scraper | 先核对该 build schema，再选 |
| 小红书搜索 | zen-studio~rednote-search-scraper | keywords 数组、maxResults、sortType="general"；旧 limit/sortBy 无效 |
| 抖音搜索 | zen-studio~douyin-search-scraper | keywords、maxResultsPerQuery、sort、publishTime |
| 视频号关键词与账号 | sian.agency~wechat-channels-scraper | operation="searchVideo"、keyword、maxResults |
| 视频号旧关键词备选 | ethereal_wool~wechat-channels-scraper | searchKeywords、maxItems；先确认有相关结果，不作默认 |
| 视频号账号链路 | sian.agency~wechat-channels-scraper | operation=searchVideo/convertExportId/accountVideos；keyword/exportId/v2Name/maxResults |
| B 站旧下载入口 | ahmed_jasarevic~bilibili-video-downloader | links 数组；先 probe，错误行不可用 |
| B 站旧备选 | easyapi~bilibili-video-downloader | links；检查 result.error / result.status，非空行不等于媒体成功 |
| Google Trends | emastra~google-trends-scraper | searchTerms、timeRange、geo、maxItems；旧 mode/dailyTrends 不支持；--daily 兼容入口走官方 RSS，地区显式标注 |
| IG reels/posts | apify~instagram-reel-scraper / apify~instagram-post-scraper | username 数组、resultsLimit |
| IG hashtag/profile | apify~instagram-hashtag-scraper / apify~instagram-profile-scraper | hashtags 或 usernames 数组 |

## 产物和验证
元数据 probe → 必要时一个媒体样本 → QC → 扩量。持久化公共内容页、作者/标题、稳定 ID、指标、run 证据；签名 CDN URL、decode_key 只在下载需要期间留于内存，不入聊天、长期 manifest 或日志。
视频必须 ffprobe 检出正时长、有效视频流和尺寸；B 站分流可只在合适 compute node 上合并/处理。图片检查 MIME、真实解码/画面；截图不是“原图下载”。
社媒事实交叉验证；保持点赞/播放等指标原义，缺失用 null。Actor 存在/有 schema ≠ 当前检索成功 ≠ 媒体已下载，分别报告。

## Trends 实时热门兜底
当前 Actor 不支持旧 dailyTrends schema。`node scripts/apify-search.mjs trends --daily --geo US --limit 3 --json` 读取 Google 官方公开 RSS，默认 US，不代表全球/历史每日榜；按用户受众选择明确 geo，空/失败如实报告，不换成关键词兴趣曲线。
