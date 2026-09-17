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

**顺手沉淀企业事实（2026-09-17 起，别漏）**：
- 用户上传的 PDF/证书/公司资料里常含**企业事实**（产品线、认证、目标市场、规模、产能）。分析完除入物料表外，把这些事实写进 `work/mio-api/data/memory/<企业>/pending_facts.json`（`kind: company_fact`），6 小时心跳会自动落 `memory/company/<企业>/facts.md` + 投影 `kb.json profile`。
- 不写这一步的后果：物料表有资料、**画像层永远空**（搜索/邮件/展中匹配都缺基准）——2026-09-17 实测过的坑。
- 需要立即生效就用 `dc_session_distill.py route ... --apply`。

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
# ① 入站附件先落本地（用户发的是消息资源，物料表上传需要本地路径）
#    有 message_id + file_key（img_xxx/file_xxx）时自动下载；已有本地路径则跳过
python3 work/mio-api/dc_material_ingest.py \
  --from-message "<om_xxx>" --file-key "<img_xxx|file_xxx>" --resource-type <image|file> \
  --type <catalog|price|spec|certificate|sample|case_study|video> \
  --text-file "<解析文本>" --description "<一句话用途>"
#    也可以直接给本地文件：--file "<本地路径>"（两者取其一）
#    下载失败必须如实报错并终止，不得跳过入库还宣称已处理
# ② 写资料层 / 物料表（建记录 + 传附件）
#    坐标**自动解析**（缓存 → 发现 → 兜底创建），不需要向用户/运维要 token：
#    dc_material_ingest 已内置；单独跑时：
python3 work/mio-api/dc_material_target.py --company-name "<企业名>"   # 输出/创建 物料表 坐标
python3 skills/dealclaw-knowledge-base/scripts/fill_material_index.py create \
  --base-token <上一步的 base_token> --table-id <table_id> --records records.json
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

## 视图与源的分工（2026-09-17 田耕郡确认，硬约束）

三层知识库 + 物料表是**给人看的展示层（视图）**；企业事实的**源**在 `memory/company/<企业>/facts.md`（+ 投影 `kb.json profile`）。四条铁律：

1. **单一事实源**：新事实只往 canonical 走（`pending_facts.json` → 6h 心跳 → `facts.md`）。三层文档与物料表是**生成物**，不得当事实来源。
2. **单向**：canonical →（生成/重发布）→ 三层文档与物料表。禁止以文档为准反向改记忆；用户在文档里的改动要么回填 `pending_facts`，要么只作展示。
3. **字段映射固定**：文档/表格字段按固定映射取 canonical 字段，缺失留空，不编、不臆测。
4. **更新触发**：事实变化 → 重发布三层文档（「更新知识库」触发路径不变）。

违反后果就是 2026-09-17 踩过的坑：两边各存一份真相 → 漂移（物料表有资料、画像层空；文档改了记忆没改）。

## 边界

- 知识库创建后不主动发链接，用户说看才发
- 用户不回复不追问，不重复提醒
- 用户上传文件后静默写入，不通知
- 补全通知每 24h 最多一次，不刷屏

## 素材来源优先级（2026-09-13 田耕郡确认）

1. **用户上传**（飞书附件 / 图文）—— 最稳，走「路径一」；
2. **官网可抓**（普通企业站/自建站）—— 用 `work/mio-api/dc_site_assets.py`（`--render` 走 puppeteer）；
3. **反爬站点（如阿里国际站）** —— 实测有风控（slider/captcha/punish/baxia 等标记）：
   **不做额外开发**（不上登录态浏览器等），改为**提醒用户直接发素材**，说明"站点有反爬、拿不到，麻烦把图/参数/证书发我"。

## 去重（跨渠道同一张图只入一次）

`dc_material_dedup.py` 两级指纹：`sha256`（字节一致）+ `dHash` 感知哈希（缩放/重压/改扩展名仍判重复，阈值默认 6）。
入库前自动查重：**重复 → 跳过写入**（不重复建记录/附件/文档），并回报"重复于哪个文件 + 匹配类型 + 距离"。
需要保留重复件时显式传 `--allow-duplicate`。
