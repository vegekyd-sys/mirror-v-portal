---
name: "dealclaw-exhibition-dossier"
description: "展会目录·一客一案：记住展位号/展会信息，把已跟进买家整理成可查目录（一览+每客档案），可发飞书文档。"
author: ""
---

# 展会目录 · 一客一案

> 展会场景下，把**已跟进的买家**整理成「一目了然可查」的目录。
> 数据**全部复用 memory**（线索池 + 沟通明细 + 邀约 + 知识库），不新建买家表。

## 触发

| 用户说 | 动作 |
|--------|------|
| 「我们展位是 A-123」/ 报展位号 | **必须记住** → 写入 meta.json |
| 报/问展会信息（名称/时间/地点） | 记录，或从 CDP 查 |
| 「展会目录」/「买家一览」/「一客一案」/「跟进情况」 | 生成/查看展会目录 |

## 动作

### 1. 记录展位号（说了就要记住）

```bash
python3 work/mio-api/dc_exhibition_meta.py set-booth <company_id> <booth>
```

- 用户提供的展位号**优先级最高**：后续接口（win-contracts）查到也**不会覆盖**用户值，冲突会标注。
- 记完回一句「展位号 <booth> 已记住」，不重复追问。

### 2. 记录 / 刷新展会信息

```bash
# 从 CDP 查（查了就存进 meta.json）
python3 work/mio-api/dc_exhibition_meta.py sync-info <company_id>

# 或用户直接给
python3 work/mio-api/dc_exhibition_meta.py upsert <company_id> <exhibition_id> \
  --name "Mexico Expo 2026" --city "墨西哥城" --country "MX" --start 2026-09-05 --end 2026-09-08
```

### 3. 生成 / 查看展会目录

```bash
python3 work/mio-api/dc_exhibition_index.py --company-id <cid>            # 直接看（打印）
python3 work/mio-api/dc_exhibition_index.py --company-id <cid> --write    # 写 index.md
python3 work/mio-api/dc_exhibition_index.py --company-id <cid> --publish  # 发飞书文档
```

目录内容：① 展商参展信息 ② 展会信息 ③ 买家总览（复用线索池）④ 买家档案（一客一案）
⑤ 进度概览 ⑥ 数据完整度。

## 边界

- 只读 memory（线索池 / 沟通明细 / 邀约 / 知识库），**不新建买家表**。
- 展会目录是**可再生阅读层**，随时可重算，不手改。
- 展位号：**用户值优先**，接口值不覆盖用户值。
- 「没有数据」不要写成 0，用「待补 / unavailable」。
- 发飞书文档前确认目标（哪个群/用户）。

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

```bash
bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw-exhibition-dossier 1 &
```

后台异步，不阻塞回复；失败静默。
