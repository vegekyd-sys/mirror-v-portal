---
name: "11"
description: "从飞书妙记或转写文本抽取挖需11问，生成需求调研文档并写回多维表。"
user-invocable: true
metadata:
  openclaw:
    requires:
      bins:
        - lark-cli
    envHints:
      - DEMAND_11Q_APP_TOKEN
      - DEMAND_11Q_TABLE_ID
      - DEMAND_11Q_DOC_FOLDER_TOKEN
---

# 挖需 11 问（星擎 Skills）

## 定位

把销售初访的飞书妙记 / transcript / 手动转写文本，整理成固定的「挖需 11 问」需求调研文档，并在可用时写回飞书多维表。

这个 skill 属于 **星擎 skills**：用于外贸 / 销售团队把客户拜访录音沉淀为可复用的需求资料。

## 触发场景

用户表达以下任一意图时使用：

- "给这条拜访妙记做 11 问"
- "从这个会议 / 妙记里提取挖需问题"
- "把调研表这条记录生成 11 问文档"
- "需求访谈整理一下"

## 输入

优先级从高到低：

1. 调研表 `record_id`：从记录里读取客户名、妙记 URL、写回字段。
2. 公司名 + 飞书妙记 URL / minute token。
3. 公司名 + 用户提供的 transcript / txt 文本。

可选配置：

- `DEMAND_11Q_APP_TOKEN`：调研表 app token。
- `DEMAND_11Q_TABLE_ID`：调研表 table id。
- `DEMAND_11Q_DOC_FOLDER_TOKEN`：输出文档父文件夹。

如果环境变量缺失，但用户已提供明确 app/table/folder，可直接使用用户提供值；不要向用户索要明文凭证。

## 输出

1. 飞书云文档：标题建议 `挖需 11 问 - {客户名}`。
2. 可选：写回多维表「挖需 11 问文档」字段。
3. 当前对话回复：只给文档链接 + 一句话总结，不 dump transcript 或内部日志。

## 11 问标准（固定，不要改）

1. 公司名字
2. 公司官网 / 线上平台（阿里国际站等）
3. 是否有自己品牌 / 有没有想发展自己的品牌
4. 公司外贸规模（人数）
5. 主营产品关键词
6. 主推国家市场
7. 主要客户群体
8. 产品优势 / 相比同行的不同
9. 为什么选择做这款产品
10. 公司是否有过往视频素材
11. 今年想在海外市场做到多少营业额

## 推荐工作流

```text
[0] 识别输入类型
    ├── record_id
    ├── 妙记 URL / minute token
    └── transcript 文本
    ↓
[1] 获取客户名 + transcript
    ├── record_id → 读多维表记录 → 拿客户名和妙记字段
    ├── minute token → 拉飞书妙记 transcript
    └── 文本输入 → 直接进入抽取
    ↓
[2] 抽取 11 问
    ├── 区分客户原话 vs 销售方案例
    ├── 明确答案 / 推断答案 / 未提及 分层
    └── 额外提炼痛点、顾虑、决策点
    ↓
[3] 生成 markdown 报告
    ↓
[4] 用 feishu_create_doc 创建云文档
    ↓
[5] 可选：用 feishu_bitable_app_table_record 写回记录字段
    ↓
[6] 回复用户文档链接
```

## 飞书妙记读取

优先使用 OpenClaw 已提供的飞书工具；如果当前 runtime 没有妙记 transcript 专用工具，可用 `lark-cli` 走 OpenAPI 兜底。

已验证的 CLI 路径：

```bash
lark-cli api GET "/open-apis/minutes/v1/minutes/{minute_token}/transcript" --as user
```

可选校验：

```bash
lark-cli minutes +search --query "<客户名>" --as user
```

需要的飞书权限：

| Scope | 用途 |
|---|---|
| `minutes:minutes.basic:read` | 妙记基础信息 |
| `minutes:minutes.transcript:export` | 导出 transcript 全文 |
| `minutes:minutes.search:read` | 按客户名搜索妙记 |
| `base:record:read` | 读取调研表记录 |
| `base:record:update` | 写回文档 URL |
| `docx:document:create` | 创建云文档 |

如果缺权限：不要猜测；说明缺哪个能力，并降级为"用户粘贴 transcript 后继续抽取"。

## 抽取规则

- 不做关键词硬匹配。客户说"10 来号人"就是 Q4 外贸规模线索。
- 严格区分当前客户回答和销售方讲的案例。
- 未覆盖的问题统一写 `未提及`，不要写"无法判断""没找到"。
- 可推断但不确定的答案标注 `推断：...`，并说明依据。
- 痛点、顾虑、决策点单独成节；这些常比 11 问本身更有销售价值。
- 不把工具失败、权限报错、CLI 命令、token、内部路径写进最终文档。

## 报告结构

```markdown
# 挖需 11 问 - {客户名}

## 1. 基本信息
- 客户名：
- 妙记 / 访谈时间：
- 信息来源：飞书妙记 / transcript / 手动文本

## 2. 11 问答案
| 问题 | 答案 | 依据 |

## 3. 客户痛点与顾虑
- 痛点：
- 顾虑：
- 决策阻力：

## 4. 销售跟进建议
- 下一步应确认的问题
- 适合推荐的星擎能力
- 风险提醒

## 5. 数据局限
- 哪些问题未提及
- 哪些答案是推断
```

## 写回多维表

如果输入来自调研表 record，并且有写权限：

- 创建文档后，把 URL 写回「挖需 11 问文档」字段。
- 字段名不确定时，先读取表字段；不要硬写错字段。
- 写回失败时，仍交付文档链接，并在当前对话说明"文档已生成，表格写回失败/缺权限"。

## 降级策略

| 阻塞 | 降级 |
|---|---|
| 没有 `lark-cli` | 如果有 transcript 文本，直接抽取；否则提示需要授权/安装或让用户粘贴 transcript |
| 缺妙记 transcript scope | 让用户授权，或粘贴 transcript |
| 多维表读失败 | 让用户提供公司名 + 妙记 URL |
| 文档创建失败 | 输出本地 markdown 内容给用户，待权限恢复后再建 doc |
| 写回多维表失败 | 交付 doc 链接，不阻塞主交付 |

## 验收标准

- 11 个问题全部出现，未提及项明确标注。
- 每个非空答案有依据，不编造。
- 客户痛点 / 顾虑 / 决策点单独提炼。
- 飞书文档标题不带内部版本号或实现方式词。
- 最终回复只包含文档链接和一句业务总结。

## 实战记录

2026-06-24 已用"义乌市睿秋贸易"妙记验证：

- 妙记时长：1 小时 53 分 28 秒
- transcript：约 1763 行
- 11 问命中：约 7.5/11
- 识别出关键顾虑：被骗怕了 / 账号归属权 / 付款风险

这类记录只作内部校准，不要原样写进客户文档。
