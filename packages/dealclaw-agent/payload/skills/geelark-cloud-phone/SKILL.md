---
name: "geelark-cloud-phone"
description: "Safe GeeLark cloud phone automation via official CLI. Covers TikTok login + warmup + publish end-to-end."
---

(仅更新以下部分)

## 操作前 QC（每次启动必须执行）

```
1. 云机检查：phone running? proxy bound? TK installed?
2. 版本检测：phone app list → 确认包名 (trill=Asia / musically=Global)
3. 命令选择：根据包名选对应命令组（见下方对照表）
4. 首次验证：新命令组合首次使用后，必须截图确认执行结果，不能只靠 task status
```

## TikTok 版本 ↔ 命令对照

| 地区 | 包名 | 版本 | 点赞 | 关注 | 评论 | 编辑资料 |
|------|------|------|------|------|------|------|
| 亚洲/日本 | `com.ss.android.ugc.trill` | 45.0.3 | `tiktok-star-asia` | `tiktok-follow-asia` | `tiktok-comment-asia` | `tiktok-edit-profile` |
| 全球/美国 | `com.zhiliaoapp.musically` | 45.0.3 | `tiktok-star` ✅ | `tiktok-follow` ⚠️ | `tiktok-comment` ? | `tiktok-edit-profile` ? |

⚠️ **Global 版 `tiktok-follow` 已知问题（2026-08-07）**：
- 提交成功（CLI 返回 taskId）但 RPA 脚本执行时找不到关注按钮元素 ID
- 日志中 `hi1`、`hui`、`i4t`、`iek` 四个 ID 全部 `No element found`
- 根因：CLI 内置 RPA 脚本的按钮 ID 基于 Asia 版 UI，未适配 Global 版
- 临时方案：`browse` + `star` 不变，关注用 Marketplace 模板或 `add-task` 替代 action

## Warmup Pipeline（命令示例已区分版本）

### Day 1-2：纯浏览（通用）

```bash
geelark-cli phone automation add-task --data \
  '{"taskType":2,"list":[{"scheduleAt":TS,"envId":"PHONE_ID","action":"browse video","duration":15}]}'
```

### Day 3：浏览 + 点赞（按版本选命令）

```bash
# Global 版（美国）
geelark-cli phone automation tiktok-star --id PHONE_ID --schedule-at TS2 --like-probability 10

# Asia 版（日本）
geelark-cli phone automation tiktok-star-asia --id PHONE_ID --schedule-at TS2 --like-probability 10
```

### Day 5+：关注（Global 版受限于元素 ID 问题，暂时用 Marketplace 模板）
