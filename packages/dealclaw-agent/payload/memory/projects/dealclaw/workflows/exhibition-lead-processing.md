# 展会现场线索处理流程

> DealClaw 场景 | 创建: 2026-07-02 | 验证: 光华士波兰展模拟
> 描述: 用户在展会现场收集名片和录音→每日上传→V 自动处理→生成展后邮件

---

## 流程总览

```
每日上传（名片照片 + 洽谈录音）
  → OCR 提取名片信息
    → ASR 转写录音
      → 自动匹配（公司名/人名 in 转写文本）
        → 未匹配标注，等用户手动关联
      → 意图分析（从对话提取：需求/痛点/交期/数量/决策权）
        → 展后24h邮件生成
```

---

## Step 1: 名片 OCR

输入: 名片照片
输出: 公司名 / 姓名 / 职位 / 邮箱 / 网址

模糊/反光的名片标 ⚠️ 待用户手动补全。

---

## Step 2: 录音 ASR

输入: 音频文件（火山引擎 ASR，支持中/英/德/日/韩/法等）
输出: 文本转写

嘈杂环境下的录音识别率会降，用户可手动修正。

---

## Step 3: 匹配名片 ↔ 录音

规则: OCR 提取的公司名或人名 → 在 ASR 转写文本中搜索

- 命中 → 自动匹配 ✅
- 未命中 → 标注，等待用户手动关联 ⚠️

用户在对话中可修正匹配结果。

---

## Step 4: 意图分析

从转写文本提取:

- 需求产品
- 当前供应商及痛点
- 预计采购量
- 时间计划
- 决策权（名片职位 + 对话内容）

根据对话内容个性化生成邮件，不做统一分级标签。

---

## Step 5: 展后邮件生成

展后24h内发送。邮件内容基于意图分析个性化：

| 对话内容示例 | 邮件策略 |
|-------------|---------|
| "主动找亚洲替代供应商，要报价" | 报价+样品照片+交期对比+公司背书 |
| "有兴趣但不急，先看看" | 产品目录+成功案例+MOQ |
| "只是逛展，暂无需求" | 简短感谢+公司简介，不做推销 |

邮件大纲见下方。

---

## 展后邮件大纲示例

### Müller Vakuum GmbH（要报价 + 抱怨交期长）

```
Subject: Following up from [Expo] — vacuum pump housing quote

Hi Thomas,

Great meeting you at [Expo]. As promised, I've prepared the following:

— Quote for stainless steel pump housing (300 pcs/quarter)
— Sample photos attached
— Our standard lead time: 4-6 weeks vs your current 12 weeks

We're IATF 16949 and PED certified. Existing clients include Siemens and Polaris.

If the quote looks promising, I can ship a sample within 2 weeks.

[Name] | NTC Technology
```

### Jansen Industrial B.V.（贸易商，想看产品）

```
Subject: NTC casting capabilities — following up from [Expo]

Hi Erik,

Good to connect at the show. As discussed, here's what we do:

— Investment casting, die casting, forging, CNC machining
— 1,000+ alloys, stainless steel specialty
— Small batch custom work available
— MOQ: flexible, no minimum for new partnerships

Attached our capability deck with typical parts and tolerances. Happy to quote on any specific drawing.

[Name] | NTC Technology
```

### TechVac（路过，暂无需求）

```
Subject: Nice meeting you at [Expo]

Hi Maria,

A pleasure meeting you at [Expo]. If vacuum pump precision castings ever come up on your radar, we'd be happy to help.

Attached our company overview for future reference.

[Name] | NTC Technology
```

---

## 用户交互设计

1. V 展示 OCR + ASR + 匹配结果摘要
2. 用户自然语言修正（改名字/补信息/重新匹配）
3. 用户确认后 V 生成展后邮件
4. 用户可微调邮件内容 → 确认 → 发送

不通过卡片编辑，全部对话驱动。

---

## Skill 前置约束（2026-07-02 补充）

### 1. 每一步必须用户确认

五步流程中，每一步都不能自动进入下一步：

| 步骤 | V 输出 | 用户动作 | 未确认时 |
|------|--------|----------|----------|
| OCR | 名片结构化结果 | 确认/修改/手动补全 | 不进入 ASR 匹配 |
| ASR | 录音转写文本 | 确认/修改 | 不进入匹配 |
| 匹配 | 名片 ↔ 录音匹配表 | 确认/改配对 | 不进入意图分析 |
| 意图分析 | 定量意图判断 + 数量提取 | 确认/修改 | 不生成邮件 |
| 邮件生成 | 邮件草稿 | 确认/修改 | 不发送/不导出 |

识别不清内容必须标记 `待补充`，并提示用户手动填写。

### 2. 意图识别必须定量化

禁止凭感觉判断热/温/冷，必须用规则表。

| 触发词/信号 | 意图结果 |
|------------|----------|
| 明确出现：budget / price / quote / buy / order / 下单 / 采购 / 报价 / 样品 / drawing / RFQ | 高意向 |
| 出现：supplier / alternative / lead time / MOQ / material / certification / quality / 供应商 / 交期 / 认证 | 中意向 |
| 仅出现：look around / just checking / learn more / 了解一下 / 看看 / 随便逛逛 | 低意向 |
| 无有效采购语义 | 待确认 |

输出必须包含命中的证据句，例如：

```text
意图: 高意向
证据: buyer said "Can you quote this pump housing?"
```

### 3. 数量估算必须区间化

ASR 中出现模糊数量时，不得写成确定数量。

| ASR 表达 | 输出 |
|---------|------|
| a few / several / 几个 | 预估区间 2-9，待确认 |
| dozens / 几十 | 预估区间 10-99，待确认 |
| hundreds / 几百 | 预估区间 100-999，待确认 |
| thousands / 几千 | 预估区间 1000-9999，待确认 |
| about 500 / around 500 / 大概500 | 约500，待确认 |
| exact number: 500 pcs | 500 pcs，已明确 |

### 4. 名片数据主权 / GDPR

欧美展会客户可能受 GDPR 约束。OCR 完成后的第一张卡片必须包含隐私声明与同意确认。

流程：

```text
OCR 完成 → 展示隐私声明 → 用户点击/回复“已获得同意” → 才能继续存储和后续邮件生成
```

若用户未明确确认：

- 不存储邮箱、电话、公司联系人信息
- 不生成营销邮件
- 不进入后续匹配和意图分析
- 只可提示用户补充授权或删除数据

### 5. 异步队列

展会批量处理可能包含多张名片和多段录音，必须异步执行，避免卡死聊天界面。

建议状态机：

```text
uploaded
  → waiting_privacy_consent
  → ocr_processing
  → ocr_review_required
  → asr_processing
  → asr_review_required
  → matching_processing
  → matching_review_required
  → intent_processing
  → intent_review_required
  → email_draft_processing
  → email_review_required
  → completed
```

用户界面：一张进度卡持续更新，完成每一步后等待用户确认再进入下一步。
