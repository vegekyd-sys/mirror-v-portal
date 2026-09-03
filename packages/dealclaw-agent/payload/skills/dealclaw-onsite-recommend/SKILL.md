---
name: "dealclaw-onsite-recommend"
description: "展会现场搜买家/推荐未邀约的匹配买家。定时推荐由 cron 自动跑，本 skill 处理用户现场主动喊「搜现场买家」的即时触发。"
---

# 展会现场搜买家 / 推荐

## 触发

用户现场说：「搜现场买家」「现场推荐」「现场有哪些没邀约的买家」「再推荐一下现场买家」「现场还有哪些能聊的」等。

**不触发**：通用「找买家」走 `dealclaw-find-buyers`（画像评分 + 落线索池）；展前邀约走 `dealclaw-exhibition-invitation`。本 skill 只认「展会现场 + 即时搜未邀约买家」这一个场景，别跟 find-buyers 抢。

## 动作

调脚本（脚本内部会直接推简讯卡到群）：

```bash
python3 work/mio-api/dc_onsite_recommend.py run
```

脚本已负责：确定当前开展展会 → 拉现场买家（buyer onsite + 产品词）→ 剔除已邀约 → 主推/跟进分层 → 简讯卡推群。

**Agent 只做结果判断，不重复推卡**。读脚本 stdout 的 JSON：
- `status == "no_exhibition"`（或输出 NO_RUN）→ 告诉用户「当前没有正在开展的展会」。
- `results` 里 candidates 全 0 → 告诉用户「现场暂时没有未邀约的匹配买家」。
- 有 candidates → 简讯卡已由脚本推到群，Agent 简短回一句「已推 N 家，见群卡片」即可，不重复发。

## 边界

- 未注册展会（orderRecords state=3 空）或当前无开展展会 → 脚本 NO_RUN，如实告知，不硬编。
- 推荐粗粒度（产品对路 + 买家类型/规模），宽进分层，不筛太狠；现场「聊上」比「精准」重要。
- 结果用简讯卡（公司名 + 国家 + 一句理由），不带 ✅❌ 按钮，也不落线索池（现场临时推荐，不是正式线索）。
- 定时推荐不归本 skill 管（cron 已注册当地时间 10/14/16 点），本 skill 只负责用户主动要求时的即时触发。

## 失败与验证

- 脚本报错 / 返回非 JSON → 如实告诉用户「查询失败」，贴关键报错，不编造推荐结果。
- 验证 gate：脚本 stdout 必须是含 `action == "onsite_recommend"` 的 JSON；以 `results[].candidates` 数量作为「有没有可推」的唯一依据，不以「脚本没报错」当成「有结果」。
