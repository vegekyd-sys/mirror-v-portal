---
name: "tiktok-publish-copy"
version: "0.2.0"
description: "为 TikTok 视频生成发布文案包（标题/简介/hashtags/videoDesc）并做文案 QC。任何人要求为 TikTok 写发布文案/打标签/出发布包时触发；产出可被发布执行器（如 GeeLark cloud-phone）直接消费。"
---

# TikTok 发布文案（tiktok-publish-copy）

> 一句话能力：把「实际成片 + 内容事实 + 目标市场语言」转成合规、吸引点击、能拿精准流量的 TikTok 发布文案包（标题 / 简介 / Hashtags / videoDesc），并产出可供发布环节消费的 QC 结论。

## 触发条件（通用）

- 任何人为一条 TikTok 视频要求：写发布文案 / 写标题 / 打 hashtag / 出发布包 / 生成 caption。
- 作为星擎/内容生产 workflow 的发布文案阶段被引用。
- 已有一条**实际成片**（或明确的视频内容描述），需要发布文案。

不触发：没有具体视频/内容对象的泛泛"教我写 TikTok 文案"（那是知识问答，不是本 skill 的任务）；策划案阶段（service-planning-doc）；成片生产阶段（ai-video-brief / remix-video-brief / makaron）。

## 核心原则

文案服务于两个目标：**吸引点击（流量）+ 精准触达（询盘）**。所有输出围绕这两个目标，同时守住事实边界与平台/市场合规。

## 输入（按优先级，缺什么停什么）

1. **成片 Brief / 已审核策划**（事实来源，最高优先）
2. **实际成片内容**（看视频实际讲了什么；文案不能写视频里没有的东西）
3. **客户事实白名单与 approved localized names**（只允许已授权品牌名/产品名/翻译形式）
4. **发布目标：国家/地区、语言、账号**（文案语言必须与目标市场一致）
5. **Apify TikTok 参考**（只做表达结构与标签类别证据，**不照搬**）

**缺失处理**：缺 1-4 任一 → 停止并列出缺失项，不猜不编。缺 5 → 可用自定义标签，标注"无 Apify 参考"。

## Hashtag 策略（双来源混合）

### 1. 流量策略热词（若有策划案）
策划案流量策略章节（行业洞察调研出的目标市场热词/hashtag）**直接采用**，作为流量底座。

### 2. 自定义标签（根据视频本身结构 + 文案内容追加）
- **(a) 大词（博流量）**：品类大词、泛流量词、热门话题词——扩大曝光池（如 #fabric #textile #factory）
- **(b) 细节词（拿精准流量）**：视频里的具体卖点、工艺、场景、测试细节——吸引精准买家（如 #waterproofFabric #pillingTest #fleece）

**结构比例**：2-3 品牌词 + 2-3 品类词 + 1-2 热门话题词，共 **4-8 个**。

## 输出形态（与 workflow 对齐）

产出**发布文案包 JSON**（工作流可直接消费）：

```json
{
  "version": 1,
  "contentItemId": "（视频任务ID，无则省略）",
  "title": "TikTok 标题",
  "description": "TikTok 简介",
  "hashtags": ["#品牌词", "#品类词", "#热门话题", "#细节词"],
  "videoDesc": "编译后的完整发布文案（标题/简介/hashtag 合成）",
  "language": "en-US",
  "qc": {
    "status": "passed|failed",
    "checks": [
      {"name": "标题hook式", "passed": true, "note": "..."},
      {"name": "hashtag结构", "passed": true, "note": "..."},
      {"name": "语言一致", "passed": true, "note": "..."}
    ],
    "issues": ["（failed 时列出）"]
  },
  "evidence": {
    "apifyQueries": ["query1", "query2"],
    "apifyReferenceUrls": ["https://tiktok.com/..."],
    "factSources": ["成片Brief/策划案文档ID/章节"]
  }
}
```

**QC 输出形态**（独立于文案包的质检结论）：
- `qc.status`: passed / failed
- `qc.checks[]`: 逐项质检（名称 + 通过与否 + 说明）
- `qc.issues[]`: failed 时的具体问题清单

## 文案 QC 自检（逐项）

1. **标题 hook 式**：吸引点击、有信息量；不是陈述式功能说明（如"XX产品功能介绍"）。
2. **描述有信息量**：视频最值得看的点在前 1-2 句。
3. **hashtag 数量与结构**：4-8 个；品牌+品类+热门混合；含大词与细节词。
4. **语言一致**：与目标市场语言一致，无中英混杂（除非 target 明确）。
5. **事实边界**：数字/声称来自成片 Brief 的 Product Truth；无虚构产能/认证/客户案例。
6. **合规红线**：无联系方式、无外链、无第三方品牌/IP/竞品词（除非白名单明确允许）。
7. **长度**：标题 ≤ 80 字符、简介 ≤ 320、videoDesc ≤ 500（按平台约束，发布执行器可再校验）。

QC 结论写入输出 JSON 的 `qc` 字段；任一红线项失败 = `qc.status: failed`，返回 issues 供修改，不交付。

## 边界与停止条件

- 成片未过机器 QC / 没有实际成片 → 停止，等成片。
- 缺客户事实白名单（不知道公司名/产品名授权形式）→ 停止，列出缺失项。
- 目标市场语言未知 → 停止，要求明确。
- 文案要求写视频里没有的声称（数据/认证/案例）→ 拒绝，标注事实边界。
- 外部发送/发布：本 skill 只产文案包，**不负责发布**；发布动作由 workflow/geelark-cloud-phone 执行并需发布授权。

## 失败模式

- Apify 无结果 → 换关键词重试一次，仍无则用自定义标签，标注"无参考"。
- 文案超长 → 压缩标题/简介，保 hook 与关键信息。
- 违禁词 → 删除换同义合规词。
- 事实无来源 → 删该声称，不硬写。
- 输出 JSON 校验失败 → 修正结构，保证 workflow 可消费。

## 验证（最小验证门禁）

生成后自检：
1. 输出为合法 JSON，含 title/description/hashtags/videoDesc/language/qc。
2. 长度合规（80/320/500）。
3. hashtag 4-8 个，含大词+细节词，无违禁词。
4. 语言与目标市场一致。
5. 每个声称可反查到成片 Brief/策划案。
6. qc.status 与 checks/issues 自洽。

未通过 → 返回修改，不交付。

## 版本记录

- **0.2.0**（2026-09-01）触发通用化（任何 TikTok 发布文案请求）；硬门禁移至 workflow 层，skill 只保留 QC 自检与输出形态；QC 结论结构化（status/checks/issues）；输出与 workflow 消费形态对齐。
- **0.1.0**（2026-09-01）初版：继承第一版 W12 文案规则；hashtag 双来源（策划案热词+自定义大词/细节词）。
