---
name: "feishu-sheet-deliver"
description: "要飞书电子表格、xlsx 型表格、表格链接时用：一次建表写入、开权限、回链核对。"
---

# 飞书电子表格交付

用户说「要 xlsx 那种」「要个表格」「给我表格链接」时，交付的必须是一张真正的电子表格（`/sheets/<token>`），不是 docx 文档、不是聊天里的列表、不是消息卡片。

## 1. 一次建成并写满数据

把数据准备成二维数组文件 `/tmp/rows.json`（首行表头），然后：

```bash
lark-cli sheets +workbook-create --title "表名" --values @/tmp/rows.json --as user --format json
```

返回 `data.spreadsheet.url` 与 `spreadsheet_token`，`data.sheets[0].range` 如 `A1:E14` 即写入范围。

不要走「先建空表、再 `+cells-set` 填」：

- `--as bot` 建表/写入会报 `app_scope_not_applied`（缺 `sheets:spreadsheet:write_only`），表建出来了但一格没写进。
- 换成 `--as user` 对 bot 建的表仍报 `code=601124003 ... action: Edit ... DENY`，因为属主是 bot。
- 所以建表那一步就用 `--as user`，一次调用完成建表+写入，两步并一步。

若确需往已有表补写：`lark-cli sheets +cells-set --spreadsheet-token <tok> --sheet-name "Sheet1" --range A1:E14 --cells @/tmp/cells.json --as user`，其中 cells 是 `[[{"value":"…"},…],…]`。

完成标准：返回 `"ok": true`，且 `data.sheets[0].data_rows` 等于数据行数。

## 2. 开权限给要交付的人

```bash
lark-cli drive permission.members create --token <spreadsheet_token> --type sheet \
  --data '{"member_id":"ou_xxx","member_type":"openid","perm":"full_access","type":"user"}' \
  --yes --as user
lark-cli drive permission.public patch --token <spreadsheet_token> --type sheet \
  --data '{"link_share_entity":"anyone_readable"}' --yes --as user
```

`permission.members create` 只接受 `--token`；误加 `--target` 会报 `unknown flag "--target"`。

完成标准：成员接口回 `"perm":"full_access"`，公共接口回 `"link_share_entity":"anyone_readable"`。

## 3. 回读再回链

```bash
lark-cli sheets +cells-get --spreadsheet-token <tok> --sheet-name "Sheet1" --range A1:C4 --as user
```

抽读左上几行，确认表头和值真的在表里，再把 `https://<tenant>.feishu.cn/sheets/<token>` 发出去，并说明对方已有编辑权限。

## 4. 清理旧交付物

用户说「文档不要，都删掉」时，按类型删：

- docx：`lark-cli drive +delete --file-token <doc> --type docx --yes --as user`
- bot 建的空表：`--as user` 会回 `drive task failed`，改用 `--as bot` 才删得掉

完成标准：删除接口回 `"ok": true`；回复里说明删了哪几份、留了哪一份。

## 口径

- 表结构直接照用户给的优先级/分组顺序排，不要自作主张合并行或改列名。
- 排期类表格里，未定日期的模块写成「资料到位起 T+N」，不要编造具体周次。
- 只在回复里给链接和一句变更说明，不复述整张表。
