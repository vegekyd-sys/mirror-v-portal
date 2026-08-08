---
name: "tiktok-account-report"
description: "TikTok账号深度洞察：TK主页URL → 数据采集 → 下载Top视频 → vision+ASR → 8维度飞书文档报告。需完整TK主页地址。"
---

# TikTok 账号深度洞察 (TikTok Account Report)

> 独立的 TikTok 账号分析 skill。入参一个 TK 账号主页 URL，输出 8 维度飞书文档洞察报告。
>
> 底座能力：
> - 数据采集：利用 `social-search` skill 的 Apify + tikwm.com API 工具链
> - 视频分析：利用 `video-review-analysis` skill 的大模型 vision+ASR 能力
> - 文档输出：`lark-cli docs +create --as bot` + 权限设置

## 触发条件（Trigger）

当用户要求对 TikTok 账号做深度分析或洞察时触发。典型触发语：

- "TikTok 账号深度洞察"
- "TikTok 账号分析"
- "分析这个 TikTok 账号"
- "看看这个 TK 账号"
- "分析 {账号名} 的 TikTok"
- "TikTok account report / deep dive"
- "TK 账号洞察"

**Do NOT trigger on：**
- 热品/品类搜索（走 `xingqing-hot-product-insights` 或 `social-search`）
- 单个视频分析（走 `video-review-analysis` 或 `video-analyze`）
- 客户画像报告（走 `xingqing-ai-customer-profile-report`）
- 策划案/复盘报告（走 `aochuang-review-report` 或各类 planning-doc skill）
- 没有 TK 账号 URL 的泛泛讨论
- 明显是私人/个人 TikTok 账号（非商业/B2B）→ 提示用户确认意图后再继续

## 输入要求（Input Gate）

**必须提供：完整的 TikTok 账号主页 URL**，例如：
- `https://www.tiktok.com/@bilusiautoparts_can`
- `https://www.tiktok.com/@username`

**如果用户没有提供 URL：**
> ❌ 不猜测、不搜索、不自己补全。
> ⚡ 反问："请提供完整的 TikTok 账号主页链接（例如 https://www.tiktok.com/@username），没有这个我没法开始分析。"

**如果用户仅提供用户名（如 @"handle_name"）：**
- 先尝试用 tikwm.com API 搜索确认账号存在
- 如果找不到，反问用户确认正确的 URL

## 核心原则

1. **先抓数据，再分析** — 不要凭空想象账号内容
2. **数据驱动，标注来源** — 每条结论要有数据支撑（播放量/互动率/发布时间等）
3. **客观诊断 + 可执行建议** — 不只说"表现好/不好"，要说为什么、怎么改进
4. **账号分析 ≠ 热品洞察** — 重点是「这个账号做得怎么样」，不是「这个品类什么好卖」
5. **文档面向运营/销售** — 报告中不出现任何技术术语、API 名称、工具名称、报错信息
6. **数据拿不到就直说** — 视频下载失败不推断、不编造，直接告知用户当前无法完成完整分析

## 执行流程

### Phase 1：数据采集（Data Fetch）

#### 1.1 账号基础信息

**首选路径：tikwm.com API**（快速、无验证码、已验证可靠）

```bash
# 从 URL 提取 username
# https://www.tiktok.com/@bilusiautoparts_can → unique_id=bilusiautoparts_can

curl -s "https://www.tikwm.com/api/user/info?unique_id={username}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d['code'] == 0:
    u = d['data']['user']
    print(f'Name: {u[\"uniqueId\"]}')
    print(f'Nickname: {u[\"nickname\"]}')
    print(f'Bio: {u[\"signature\"]}')
    print(f'Following: {u[\"followingCount\"]}')
    print(f'Followers: {u[\"followerCount\"]}')
    print(f'Likes: {u[\"heartCount\"]}')
    print(f'Videos: {u[\"videoCount\"]}')
    print(f'Verified: {u[\"verified\"]}')
else:
    print(json.dumps(d))
"
```

**备选：Apify TikTok Scraper**（如 tikwm.com 不可用）

```bash
curl -s -X POST "https://api.apify.com/v2/acts/clockworks~tiktok-scraper/runs?token=***" \
  -H "Content-Type: application/json" \
  -d '{"profileUrls":["https://www.tiktok.com/@username"],"maxResults":1,"shouldDownloadVideos":false}'
```

APIFY_API_KEY 在 `~/.openclaw/.env`。

#### 1.2 视频列表（含翻页）

tikwm.com 每次返回最多 30 条。如果视频数 >30，需要翻页。

```bash
# 翻页拉取全量视频列表
cursor=0; count=0
while true; do
  resp=$(curl -s "https://www.tikwm.com/api/user/posts?unique_id={username}&count=30&cursor=$cursor")
  echo "$resp" | python3 -c "
import json, sys
d = json.load(sys.stdin)
videos = d['data']['videos']
for i, v in enumerate(videos):
    print(f'[{i+1}] Views:{v[\"playCount\"]} ❤️:{v[\"diggCount\"]} 💬:{v[\"commentCount\"]} 🔄:{v[\"shareCount\"]} ⏱:{v[\"duration\"]}s')
    print(f'    Title: {v[\"title\"][:100]}')
    print(f'    Music: {v[\"musicInfo\"][\"title\"]}')
    print()
"
  hasMore=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('hasMore',False))")
  cursor=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('cursor',0))")
  [ "$hasMore" != "True" ] && break
done
```

#### 1.3 数据整理

需要整理以下数据用于分析：

| 维度 | 数据来源 | 用途 |
|------|---------|------|
| 粉丝数、视频数、创建时间 | API | 账号概览 |
| Bio、链接 | API | 转化路径分析 |
| 每条视频的播放/点赞/评论/分享 | API | 内容效果分析 |
| 视频标题、hashtags | API | 选题/标签策略 |
| 发布时间 | API | 发布节奏 |
| 音乐/音效 | API | 内容风格 |

### Phase 2：视频分析（Video Insight）

对播放量 **Top 3-5** 的视频做深度分析。

#### 2.1 筛选视频

按播放量取 Top 3-5 条，同时尽量包含：
- 最高播放（找出爆款规律）
- 最新发布（判断当前策略）
- 播放量覆盖高/中/低档（全面诊断）

#### 2.2 下载视频

```bash
mkdir -p work/tiktok-insight/{account_name} && cd work/tiktok-insight/{account_name}
yt-dlp --no-playlist -q -o "%(uploader)s_%(id)s.%(ext)s" <video_url>
```

⚠️ 只下载 Top 3-5 条。视频太大（>100MB）跳过并标记。

**🚫 下载失败处理（重要）：**

如果 Top 3-5 条中任何一条下载失败，**不推断、不编造、不降级分析**。直接：
1. 记录哪些视频下载成功、哪些失败
2. 对下载成功的视频正常分析
3. 在群内回复中**仅用业务语言**告知：「有 X 条视频暂时无法获取，本次分析基于已有的 Y 条视频完成」

**绝对不在报告或群内回复中出现：**
- ❌ API 报错、HTTP 状态码、yt-dlp 错误信息
- ❌ "视频未下载"（技术语言）→ 应说 "暂时无法获取该条视频数据"
- ❌ "推断"、"降级分析" → 直接说"本条基于文字信息分析"
- ❌ 任何工具名（tikwm、Apify、makaron-cli、yt-dlp 等）

#### 2.3 Vision + ASR 分析（含 fallback）

**首选路径：makaron-cli analyze**

```bash
npx makaron-cli analyze --video <video_path> "请分析这条TikTok视频，输出：
1）一句话概括视频内容
2）前3秒钩子手法（怎么抓住观众的）
3）视频结构拆解（开头-发展-高潮-结尾）
4）画面信息：场景、人物/无人出镜、产品展示方式、文字/字幕内容
5）B2B信任建设元素（工厂/设备/质检/认证/团队/客户案例/产能）
6）CTA（号召行动）：有/无，类型（DM/WhatsApp/评论区/主页链接）
7）可复用的内容公式
8）改进建议
不要泛泛总结，给出具体可执行的判断。"
```

**Fallback（makaron-cli 不可用时）：**

直接用大模型 `image` 工具对视频关键帧做 vision 分析：
- 取开头、中间、结尾各一帧
- 结合视频标题、音乐名做综合判断
- 标注"基于关键帧分析"

对无声/纯音乐视频，重点做 vision 分析。

### Phase 3：生成报告（Report Generation）

#### 3.1 文档结构（8维度框架）

按以下结构生成飞书文档（XML 或 Markdown 格式）：

```
# {账号名} TikTok账号深度洞察

> 分析时间：{Asia/Shanghai 时间}
> 数据范围：{最早视频日期} — {最新视频日期}

---

## 一、账号概览

| 指标 | 数值 |
|------|------|
| 账号 | @{username} |
| 粉丝 | {followerCount} |
| 视频数 | {videoCount} |
| 获赞 | {heartCount} |
| 运营时间 | {从创建至今} |

**简介：** {signature}

---

## 二、定位分析

- 账号宣称什么（简介 + 昵称 + 账号名传递的信息）
- 定位是否清晰、独特
- 目标受众推断
- 定位与内容的匹配度

---

## 三、品类分析

- 覆盖的产品/服务线
- 品类宽度 vs 深度
- 是否有品类聚焦策略
- 产品展示方式

---

## 四、内容选题分析

- 选题方向汇总（归类统计）
- 选题多样性（高度同质化 vs 丰富多元）
- 爆款选题特征
- 低效选题特征
- 选题与目标受众的匹配度

---

## 五、视频结构与节奏

- 典型视频时长分布
- 开头钩子策略
- 视频结构模式（如：产品展示→工厂→CTA）
- 有无真人出镜 / IP 化程度

---

## 六、发布节奏

- 发布频率（条/天）
- 发布间隔规律
- 近期发布趋势（加速/减速/停更）

---

## 七、标签与流量策略

- 常用话题标签分析
- 音乐/音效策略
- 爆款视频的流量来源推断
- 关键词覆盖情况

---

## 八、受众画像与互动

- 粉丝画像推断（地区/行业/角色）
- 互动表现（点赞率/评论率/分享率）
- 评论区洞察（买家询盘/同行交流）
- 粉丝增长趋势

---

## 九、转化路径

- 简介中的联系元素（WhatsApp/邮箱/链接/电话）
- 视频中的引导行动使用情况
- 转化链路完整性评估
- 缺失的转化环节

---

## 十、核心发现与建议

### 🔍 核心发现

1. {发现1}（数据支撑）
2. {发现2}
3. {发现3}

### 📌 机会与建议

1. {可执行建议1}
2. {可执行建议2}
3. {可执行建议3}

---

*本报告基于 TikTok 公开数据生成，分析结果仅供参考。*
```

**🚫 报告语言规则：**
- 报告中不出现任何技术词汇（API、脚本、下载、报错、失败等）
- 不确定的结论明确标注"基于现有信息推断"或"建议进一步验证"
- 数据缺失时直接说"该数据暂未获取"，不解释技术原因

#### 3.2 创建飞书文档

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 lark-cli docs +create --as bot \
  --content @report.xml --doc-format xml
```

#### 3.3 设置权限

```bash
# 公开可读
lark-cli drive permission.public patch --as bot \
  --params '{"token":"{完整DOC_ID}","type":"docx"}' \
  --data '{"external_access":true,"link_share_entity":"anyone_readable"}' --yes

# 给需求方可编辑权限
lark-cli drive permission.members create --as bot \
  --params '{"token":"{完整DOC_ID}","type":"docx"}' \
  --data '{"member_type":"openid","member_id":"{requester_openid}","perm":"edit","type":"user"}' --yes
```

⚠️ drive permission 操作必须使用完整 token，缩写 token 不可靠。

#### 3.4 群内回复格式

```markdown
✅ {账号名} TikTok账号洞察完成

📄 文档：{飞书链接}
（公开可读 + 已给你开阅读权限）

实际账号是 @{handle}（{粉丝数}粉 / {视频数}视频）

━━ 核心发现 ━━

🔹 内容：{一句话内容分析}
🔹 策略：{一句话策略分析}
🔹 人群：{一句话受众分析}

📌 最大机会：{一句话核心建议}
```

#### 3.5 视频下载失败时的回复

如果部分视频下载失败，回复中仅用业务语言告知：

```markdown
✅ {账号名} TikTok账号洞察完成

📄 文档：{飞书链接}
（公开可读 + 已给你开阅读权限）

实际账号是 @{handle}（{粉丝数}粉 / {视频数}视频）

⚠️ 有 {N} 条视频暂时无法获取，本次分析基于已获取的 {M} 条视频完成。

━━ 核心发现 ━━
...
```

### Phase 4：记录与入库

更新项目记录 `memory/projects/xingqing/hot-product-insight-group.md`：

```
| {日期} | {账号名}（{行业}） | {飞书文档链接} |
```

## Background Task Execution Policy

This skill has background-worthy branches: API data collection, video downloading, and vision+ASR analysis.

When invoked from an IM/group/chat surface:

1. **Parent session**: validate the TK URL, acknowledge the request, submit background task.
2. **Do not run full workflow in the parent session.**
3. **Use `sessions_spawn` with `mode="run"`** for heavy work.
4. Default to isolated child context.

### 子 Agent Task Brief 模板

```
You are a TikTok Account Report background worker.

Objective: Generate a TikTok account deep insight report.

Inputs:
- Account URL: <TikTok URL>
- Requester open_id: <open_id>
- Analysis dimensions: 8-dimension full analysis

Output contract:
- Final status: completed/failed/blocked
- Feishu doc URL (if completed)
- Account summary (follower count, video count, key metrics)
- Top 3-5 video analysis results
- Any videos that couldn't be downloaded (count + business-level reason only)
- Blocker and next step if failed

Rules:
- Do not message the chat directly
- Do not include technical errors in report — use business language only
- If video download fails, report count but do not fabricate analysis
- Write durable artifacts to work/tiktok-insight/<account_name>/
```

The parent session receives completion and delivers the result.

## Sibling Skill Coverage

| Sibling Skill | 关系 | 说明 |
|---|---|---|
| `social-search` | 底座 | 共享 Apify + 下载 + 飞书文档工具链 |
| `video-review-analysis` | 底座 | 共享 vision+ASR 分析能力 |
| `xingqing-hot-product-insights` | 同级 | 热品洞察（产品视角），本 skill 是账号洞察（账号视角） |
| `xingqing-ai-customer-profile-report` | 同级 | 客户画像报告（企业维度），本 skill 是单一账号维度 |

## 边界与停止条件

- ❌ **用户未提供 TK 账号 URL** → 反问，不猜测不搜索
- ❌ **URL 不是 TikTok 域名** → 提示只支持 TikTok
- ❌ **账号不存在/被封/私密** → 告知用户并建议确认
- ❌ **API 全部不可用** → 告知当前无法获取数据，建议稍后重试
- ❌ **视频下载全部失败** → 仅基于标题和互动数据完成分析，在回复中说明「视频内容暂未获取」
- ❌ **明显是个人/非商业账号** → 提示用户确认意图后再继续
- ❌ **不自行决定分析哪些账号** → 等用户指定
- ❌ **不对分析结果做商业承诺** → 标注推断和不确定性

## 失败模式与处理

| 情境 | 处理方式 |
|------|---------|
| tikwm.com API 不可用 | 降级到 Apify TikTok Scraper |
| Apify 也无响应 | 告知用户当前无法获取数据，建议稍后重试 |
| 视频下载失败 | 在群内回复中用业务语言告知有 N 条视频暂未获取；分析基于已有数据完成 |
| 全部视频下载失败 | 基于标题+互动数据完成分析，回复中说明「视频内容暂未获取，本次分析基于文字信息完成」 |
| 飞书文档创建失败 | 告知用户文档创建未成功，建议稍后重试 |
| 权限设置失败 | 告知用户文档已创建，附文档链接，提示可手动调整查看权限 |
| vision 分析超时 | 跳过该视频，在文档中标注该条视频内容暂未分析 |

## 质量检查 (QC)

生成报告后，检查：

1. ✅ 账号 URL 是否正确引用
2. ✅ 所有数据是否有来源标注
3. ✅ 各维度是否有实质内容（不能空泛）
4. ✅ 每个发现是否有数据支撑
5. ✅ 建议是否可执行（不能说"建议做得更好"）
6. ✅ 不确定的结论是否标注了推断
7. ✅ 飞书文档是否公开可读 + 需求方已开权限
8. ✅ 报告中无任何技术术语/工具名/报错信息
9. ✅ 报告文字运营/销售能看懂
10. ✅ 群内回复摘要覆盖内容/策略/人群/机会

## 示例

### 触发示例

**用户：** TikTok账号深度洞察 https://www.tiktok.com/@bilusiautoparts_can

**回复：**
```
收到，分析 @bilusiautoparts_can TikTok账号，马上出洞察报告 ⚡
```

→ 后台任务 → 完成推送报告

### 输出示例

```
✅ BILUSIAutoParts_Japan TikTok账号洞察完成

📄 文档：https://versa-ai.feishu.cn/docx/WwkDdfqgYo0k1oxVjWocOm9WnAg
（公开可读 + 已给你开阅读权限）

实际账号是 @bilusiautoparts_can（10.3K粉 / 89视频）

━━ 核心发现 ━━

🔹 内容：极度聚焦，89条视频反复讲同一件事——「日系认证品牌 + 中国唯一制造商 + 工厂直供无中间商」。
🔹 策略：三角定位很聪明（借日本品质信用 + 制造独占性 + 价格优势），但内容高度同质化，发布频率偏低（≈0.3条/天），缺少真人IP。
🔹 人群：海外日系车配件进口商/批发商/代理商，受众精准但信任建设不足。

📌 最大机会：让简介中提到的"Ben"真人出镜做IP化内容，参考Jianye Textile的IP化路径。
```

### 反例 — 无 URL 时

**用户：** 分析一下 BILUSIAutoParts_Japan 这个账号

**回复：**
```
请提供完整的 TikTok 账号主页链接（例如 https://www.tiktok.com/@bilusiautoparts_can），没有这个我没法开始分析。
```

### 反例 — 视频部分下载失败时的回复

```
✅ BILUSIAutoParts_Japan TikTok账号洞察完成

📄 文档：https://versa-ai.feishu.cn/docx/xxxxx
（公开可读 + 已给你开阅读权限）

⚠️ 有 2 条视频暂时无法获取，本次分析基于已获取的 3 条视频完成。

实际账号是 @bilusiautoparts_can（10.3K粉 / 89视频）

━━ 核心发现 ━━
...
```
