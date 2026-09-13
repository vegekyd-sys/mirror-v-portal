---
name: "dealclaw-knowledge-base"
description: "三层知识库：首页+主题页(docx)+资料层(bitable)。V自主写入+用户上传双路径。来源：田耕郡@格格"
author: ""
---

# 企业知识库

> 三层飞书文档，analyze-company 纠偏完成后创建。

## 触发

| 场景 | 行为 |
|------|------|
| analyze-company 纠偏完成、公司关键信息基本齐全后 | 建三层知识库 → 气泡「公司档案整理好了——产品介绍、资质物料、报价工具都在里面，后续开发信报价展会直接调，不用重复准备。要看看吗？」 |
| 用户说「看」「打开」 | 发链接，不加说明 |
| 用户说「更新知识库」 | 重新发布三层文档 |
| 用户发送文件（PDF/照片/证书） | V 分析后写入引擎 + 同步文档，不通知 |
| 用户说「知识库还有什么缺的」 | 列出缺失清单 |
| 下游 Skill 需要缺失素材 | 阻断提醒，补全后继续 |

**建库前置条件：** 公司的关键信息（主营产品、工厂规模、认证资质、出口市场）至少 3/4 确认后再建。不允许建一个满篇「待确认」「❌」的空壳——用户打开一看全是缺口，反而降低信任。

## 三层架构

```
🏠 首页（docx） — 一屏看懂：V的判断 + 业务就绪度 + 机会 + 知识地图
📚 主题页（docx） — 深度内容：产品线 + 竞品 + 买家画像 + 物料清单
📋 资料层（bitable） — 结构化索引：类型/文件名称/状态/营销用途
```

首页和主题页合并为一个 docx，资料层为独立 bitable。

## 物料上传双路径

**路径一：V 自主分析（用户发文件：PDF / 产品图片 / PPT / Office / 视频）**

```bash
# ① 本地归档 + KB 物料库（必须；否则解析完就丢）
python3 work/mio-api/dc_material_ingest.py \
  --file "<原文件>" --type <catalog|price|spec|certificate|sample|case_study|video> \
  --text-file "<解析文本>" --description "<一句话用途>"
# ② 写资料层 / 物料表（建记录 + 传附件），复用既有工具
python3 skills/dealclaw-knowledge-base/scripts/fill_material_index.py create \
  --base-token <资料层 app_token> --table-id <资料层 table_id> --records records.json
python3 skills/dealclaw-knowledge-base/scripts/fill_material_index.py attach \
  --base-token <app_token> --table-id <table_id> --field-id <附件列 field_id> \
  --mapping name_to_rid.json --manifest manifest.json
python3 skills/dealclaw-knowledge-base/scripts/fill_material_index.py sync \
  --enterprise <企业> --status status.json
```

- `dc_material_ingest.py` 也支持一次带 `--bitable-app-token/--table-id/--field-id`，内部复用 `fill_material_index` 建记录+传附件。
- 粒度铁律：**一条记录 = 一个可独立调用的物料单元**（主图 1 张/条；参数表 N 页挂 1 条；证书 1 张/条）。
- 校验：`get_material_links()` 必须能取到该条目；**取不到即视为失败，如实报告，不得声称"已入库"**；缺资料层坐标时明确报 `skipped`（不假装已写文档）。

**路径二：用户在文档上传** — 打开 docx 或 bitable 直接拖入文件。V 定期同步回引擎。

两条路径都落文档，引擎和文档双向同步。

## 创建与权限

- `--as bot` 创建 docx + bitable
- 创建后自动 `--as bot` 设公开可读 + Tianyi 编辑权限
- 详见 `memory/projects/mio/dealclaw/channel-rules/feishu-doc.md`

## 资料层自动推理

从企业画像字段自动推断资料层条目：认证 → 资质条目 / 产品 → 手册条目 / 客户 → 案例条目 / 定制能力 → 定制说明。工厂型企业预设产线照片、质检设备照、英文简介、参展海报。

## 下游调用

写开发信、报价、展会准备、客户验厂等场景自动从知识库取素材。只取状态为 ✅ 的条目。

关键素材缺失时阻断发送，气泡通知用户补全。补全后恢复发送。

## 边界

- 知识库创建后不主动发链接，用户说看才发
- 用户不回复不追问，不重复提醒
- 用户上传文件后静默写入，不通知
- 补全通知每 24h 最多一次，不刷屏
