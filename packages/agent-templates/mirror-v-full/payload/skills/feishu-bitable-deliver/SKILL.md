---
name: "feishu-bitable-deliver"
description: "交付清单到飞书多维表格：建表、批量写入、回链接。附件是扫描件读不到文字时，先判定再要文本版，不凭空生成。"
---

# 飞书多维表格交付

把一份清单交付成飞书多维表格，或判断附件为何读不出内容时使用。

## 1. 先确认落点

- 复用已有 Base：需要 app_token（形如 `YAfWb...`）。用 `lark-cli base +table-list --base-token <token> --as user` 看现有表，避免建重复表。
- 新建独立 Base：一条命令建好 Base、首表和字段：`lark-cli base +base-create --as user --name "表名" --table-name "表名" --time-zone Asia/Shanghai --fields '[{"name":"企业名称","type":"text"}]'`。它会自动删掉默认空表；不要再走「先建 app 再建表」，多两次调用。
- 建完把编辑权限直接给到要交付的人：`lark-cli drive +member-add --as user --token <base_token> --type bitable --member-type openid --member-id ou_xxx --perm edit --need-notification --yes`；回链接时明确说已开编辑。

## 2. 建表：用 --name + --fields，不要用 --json

```bash
lark-cli base +table-create \
  --base-token <app_token> --as user \
  --name "表名" \
  --fields '[{"name":"客户名称","type":"text"},{"name":"金额","type":"number"}]'
```

`--json` 是「输出格式」开关，不是 schema 入参；误用会报字段缺失。字段对象只需 `name` 与 `type`（`text` / `number` / `select`+`options`）。

## 3. 写入：分批 50 条

```bash
lark-cli base +record-batch-create \
  --base-token <app_token> --table-id <tbl...> --as user \
  --json '{"records":[{"fields":{...}},{"fields":{...}}]}'
```

- 单批 ≤50 条；按批累加成功计数，失败批次单独打印响应前 200 字，便于定位是哪一批。
- 返回体含 `"ok": true` 才算成功；不要只看退出码。

## 4. 回链接

`https://<tenant>.feishu.cn/base/<app_token>?table=<table_id>`

写完后用 `+table-list` 核对 `records_count` 是否等于写入条数，再把这个链接发出去。

## 5. 附件读不到文字时

判定顺序：

1. 看 `media/inbound/` 下最新 staged 目录里到底落了什么文件；文件名与用户描述不符时，先按内容判断，不要按文件名下结论。
2. 若是 PDF，先 `pdftotext -f 1 -l 2 file.pdf -`。输出只有 `\x0c`（换页符）或空白，说明是扫描件、没有文字层。
3. 若需按原文精确核对（合同条款、报价单），直接说明：扫描件无法逐字提取，要么给带文字层的版本（导出型 PDF / Word / Excel），要么做 OCR 但准确率不保证。
4. 用 `lark-cli im +messages-resources-download` 补下载时：`--as user` 可能报 `message invisible to the operator`，`--as bot` 可能报 HTTP 500；两者都失败就停止重试，转人工要文件。

## 6. 交付时的诚实边界

用系统数据（如 Base 权益数量 + 主档金额）拼出的清单，必须在回复里写明「数据来源不是合同正文」，并列出缺口字段（如服务月数缺失导致全期无法折算）。不要把系统推算说成合同原文。

## 7. 读大表做汇总统计（分析，不是写入）

7.1 全表导出用 `--format ndjson --output <file>`；单次上限 2000 条，超过用 `--offset 2000` 继续拉，累加行数等于 `+table-list` 的 `records_count` 才算拿全。

7.2 先用 `+field-list` 看列，但不要假设企业名在哪一列。明细行常是层级表：`父记录` 指向批次行、批次行再指向上级。沿 `父记录` 走到最高层，取第一个非空的 `多行文本` 作为企业归属；直接读明细行的公司列会大量为空。

7.3 日期列常是自由文本，同一列混着 `10.01`、`10/01/18:30`、`1002/2:00`、`1014/`、`11.01` 等写法：按「M.D / M/D / MMDD」取月份和日期；文本里没有日期时，用 `发布日期`（datetime）补。不能只按一种分隔符解析，否则会漏掉整批 `1002/` 形式的记录。

7.4 看起来重复的行不要按内容去重：同一天同一公司的多行通常是不同账号或语种，逐行累加才对。只按 `record_id` 去重。

7.5 条数来自文本列时（如「发布情况」），用正则取 `已发布N条` / `N条成功` 的 N，再与 `发布数量` 列交叉核对；差异要点名到企业，并在回复里写清口径（时间范围、条数取自哪列、差异多少）。
