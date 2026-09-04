---
name: "dealclaw-onsite-touch"
description: "展中到场触达：对已到场买家（已邀约/现场推荐）发到展邀请邮件，走 Founder Direct。来源：田耕郡"
---

# 展中到场触达

## 定位

展会**展中**阶段，对「已经到场」的买家发一封「到展邀请邮件」，请他们到展位来聊。只发邮件 + 简单自我介绍，不做长跟进（长跟进归展后 exhibition-leads）。

## 触发（两部分买家）

| 类型 | 到场来源 | 邮件里是否提「邀约过」 |
|------|---------|---------------------|
| 已邀约 + 扫码到场 | `notice-list --msg-type 3`（买家到场通知） | 提「之前邀约过你」 |
| 现场推荐/搜索到场 | `buyer onsite`（现场买家） | 不提（新触达） |

## 流程

1. **拉一批到场买家** → 汇总成**一张卡片**推给用户（一批一张，不逐条刷）。
2. 用户确认后 → 逐个写邮件 → 走 **Founder Direct** 发送。
3. 不自动发，必须用户确认。
4. **验证**：逐个看 Founder Direct 返回（sent / rejected），失败的标记出来、不静默当作已发；一批发完给用户一个「成功 N / 失败 M」小结。批量发送时逐个失败不阻塞整体，失败的汇总后再单独重试或报告。

## 邮件要素（必记，随机写，5 句内）

每封邮件长度 ≤ 5 句，要素齐全即可，措辞**每次随机**不要套模板：

1. **展位号** + 展会名 + 日期（展位号从 `company win-contracts` 拿）
2. **一句自我介绍**（公司名 + 主营产品）
3. **邀约提醒**：已邀约的提「之前邀约过你」；现场推荐的不提
4. **1-2 个亮点**：能吸引买家来展位的（从企业画像 kb.json 的 usp / 产品 / 认证 / 规模拿，挑最硬的）
5. 一句「期待在展位见到你」收尾

> 亮点优先拿这些（有就用，没有就跳过）：认证（IATF/CE/PED 等）、大客户背书（Siemens 等）、产能/交期优势、定制能力、MOQ 灵活。**别编没有的亮点**（REDLINES 数据诚信）。

## 数据来源

- 展位号：`xiaoyuan company win-contracts --exhibition-id <展会ID>`（字段名待真实数据确认）
- 自我介绍 + 亮点：企业画像 `data/memory/<sid>/kb.json` 的 `profile`（name/product/usp/certifications/scale）
- 到场买家邮箱：`notice-list --msg-type 3`（已邀约到场）/ `buyer onsite`（现场推荐）返回
- 展会名/日期：`buyer exhibitions`（selectAllExhibition）对账

## 边界

- 用户确认后才发，不自动发。
- 一批到场买家 = 一张汇总卡片，不逐条刷屏。
- 邮箱缺失的买家跳过并标记，不硬发、不编邮箱。
- 展位号拿不到时，邮件里先不写展位号、只写展会名+日期，并向用户说明「展位号待补」。
- 只发邮件，不发 WhatsApp/短信（那走别的 skill）。
- **GDPR**：欧美展会买家受 GDPR 约束。到场触达默认基于「展前已邀约 / 已交换联系方式」的合法事由；纯现场新扫的买家（未建立联系）发邮件前，确认已获同意或走「展会场景合法利益」口径，不确定先问用户。
- **兄弟边界**：发邮件复用 `dealclaw-email-founder-direct` 的发送通道，不重造；到场数据来自 `monitor_buyer_onsite`（已邀约到场）和 `dc_onsite_recommend`（现场推荐），本 skill 只做「汇总卡片 + 写邀请邮件 + 发送」这一段编排。

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次完成触达发送后，后台异步记录一条计费事件（tenantId 从 scripts/billing-config.json 解析，解析不到自动 shadow）：

```bash
bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw-onsite-touch 1 &
```
