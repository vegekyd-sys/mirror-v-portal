---
name: "feishu-sheet-to-doc"
description: "飞书表格做成同结构文档：workbook-info 取 sheet、csv-get 读数、docs +create 建表文档、开编辑权限并回读核对。"
---

# 飞书表格 → 同结构文档

## 何时用

用户给一张飞书表格链接，说「做成文档」「和某个结算单一样的结构」「给我开放编辑权限」。典型：月度拍摄结算单、企宣片结算单、对账单、清单类文档。

## 步骤

1. **定位并读表**：`lark-cli sheets +workbook-info --spreadsheet-token <tok> --as bot` 拿标题和 `sheet_id`；再 `lark-cli sheets +csv-get --spreadsheet-token <tok> --sheet-id <id> --range A1:H60 --as bot` 读数，输出带 `[row=N]` 前缀，便于区分空行与合计行。完成标准：拿到表头、全部有值行、合计行。
2. **对齐参照文档**：用户说「和某文档一样」时，先 `lark-cli docs +fetch --doc <tok> --doc-format markdown --as bot` 看它的骨架，保持「标题 + 一句口径说明 + 表格 + 合计行」一致；列名按新数据调整，不硬套旧列。完成标准：列出新旧列映射。
3. **建文档**：`lark-cli docs +create --title "<标题>" --content @/tmp/x.xml --doc-format xml --as bot`。正文 XML：`<p>说明</p><table><colgroup>…</colgroup><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr></tbody></table>`，合计行放 tbody 末尾。完成标准：返回 document_id 与 url。
4. **开权限**：先 `lark-cli drive permission.public patch --type docx --token <doc> --data '{"link_share_entity":"tenant_editable"}' --yes`。**该命令属 high-risk，漏 `--yes` 会返回 `confirmation_required`，这不是权限失败，补 `--yes` 重跑即可，不要换路径。** 再把操作人加成可管理：`lark-cli drive permission.members create --type docx --token <doc> --data '{"member_type":"openid","member_id":"<ou>","perm":"full_access"}' --yes`。完成标准：`permission.public get` 回读为 `tenant_editable`。
5. **回读核对**：`docs +fetch --doc-format markdown` 逐行比对标题、每行数据、合计金额；空列（附件、下载链接）在回复里显式说明待补。完成标准：行数与合计都能对上源表。

## 口径

- 「组织内可编辑」= `tenant_editable`；「拿到链接谁都能改」= `anyone_editable`。用户只说「开放编辑」时，默认给 `tenant_editable` + 本人 `full_access`，并在回复里说明可切换。
- 金额、时长按源表原样搬，不自己重算。但若能从数据反推出计价规则（如按半小时向上取整），主动指出并问是否写进文档说明，避免对方对账时再问。
- 文档建在 bot 名下时，务必第 4 步把用户加成 `full_access`，否则对方只有链接权限、改不动。

## 已有结算单增删行（不要用 block_insert_after 插 `<tr>`）

1. **先别插行**：`docs +update --command block_insert_after --content '<tr>…</tr>'` 不会新增一行，而是把 7 个 `<td>` 里的段落塞进目标单元格（实测塞进表头最后一格），行数不变、表头被污染。要改行就整表重建。
2. **备份再重建**：`docs +fetch --doc <tok> --doc-format xml --detail with-ids`，把 `<table …>…</table>` 整段存到 `/tmp/tbl_backup.xml`，同时记下 `<table id>`、`<colgroup>`、每行 `<th>/<td>` 文本与行内 `<figure>…</figure>`。
3. **脚本拼新表**：按原列数生成 `<table><colgroup>…</colgroup><thead>…</thead><tbody>…</tbody></table>`，插入或删除目标行，合计行按新数据重算（场数、金额一起改）。
4. **附件靠 token 搬运**：每个单元格里的 `<figure view-type="Card"><source name="…" token="…"/></figure>` 原样复制到新表同一行，不要重新上传；重建后 `<source` 数量必须与重建前一致。
5. **替换+校验**：`docs +update --command block_replace --block-id <table_id> --content @/tmp/tbl_new.xml --doc-format xml`；再 `docs +fetch --doc-format markdown` 核对：行数 = 1 表头 + N 数据 + 1 合计、附件数不变、合计与数据行算术一致、新行按日期落在正确位置（表按日期倒序）。对不上就回滚备份。
