---
name: "feishu-doc-append-batch"
description: "追加新批次到已有飞书文档：末尾插入保留用户改动，回读计数核验。新素材/新一期文案要补进原文档时用。"
---

# 飞书文档追加批次（feishu-doc-append-batch）

> 一句话能力：同一主题来了新一批素材，把内容接到原文档末尾，不动用户已改的部分，并用回读计数证明接对了。

## 触发条件

- 用户说「增加到原来那份文档」「补进原文档」「别新建」。
- 同一客户/同一主题已有文案包、复盘、清单文档，这次来的是新一批素材。
- 需要在已有文档末尾续写一整段结构化内容（多条素材、多期数据）。

不触发：新建文档（走对应交付流程）；改文档中间某段（走定位替换，不是追加）。

## 核心原则

1. **追加，不重写**。已经存在的文档可能被用户手工改过，只做末尾插入，不整篇覆盖。
2. **挂在真实末块上**，不是靠"追加到文档"这种模糊语义——先取最后一个 block_id，插入它之后。
3. **写完必须回读计数**。工具返回 success 只说明请求成功，不说明内容落对位置、条数对。

## 步骤

### 1｜先定位末块

拉全文并定位最后一个块 id：

```bash
lark-cli docs +fetch --doc <doc_token> --as bot --format json
```

从 blocks 里取最后一个 block_id，同时记下当前标题数量、小节数量作为基线。

完成条件：手里有一个具体 block_id，和一份「改动前」的计数基线。

### 2｜把内容写成独立 md 文件

把本批次写成一份临时 markdown，标题层级与文档既有格式一致（如 `## 四、<批次名>` + `### 素材 N｜<视频名>`）。

一次一批，文件内只放这一批，不复制旧内容进去。

完成条件：文件里只含新增部分。

### 3｜末尾插入

```bash
lark-cli docs +update --as bot --doc <doc_token> \
  --command block_insert_after --block-id <last_block_id> \
  --doc-format markdown --content @tmp/<x>/append.md --format json
```

`--content @<相对 workspace 的路径>`；`--doc-format markdown` 让它按 md 解析标题与列表。

完成条件：返回 `ok: true` 且 `result: success`。

### 4｜回读计数核验

重新 fetch，按本批次的稳定标记计数，并与基线对比：

```bash
lark-cli docs +fetch --doc <doc_token> --as bot --format json | python3 -c "
import sys,json,re
c=json.load(sys.stdin)['data']['document']['content']
t=re.sub('<[^>]+>','',c)
print('LEN',len(c))
print('小节',len(re.findall(r'素材\s*\d+｜',t)))
print('字段',t.count('YouTube 标题'),t.count('Instagram 配文'))
"
```

判定：新增数量 = 本批条数；旧批次数量不变；正文长度增加合理。

完成条件：三个数都对得上，才回报完成。

### 5｜权限与标题（新建或首交付时）

追加本身不改权限。若本次同时新建了文档，仍按既有口径：`--as bot` 建、`public` 设 `anyone_readable`、给用户 open_id `full_access`（请求人也要单独加，别只加 the owner）。

Markdown 建档会丢标题：`docs +create --doc-format markdown` 返回 `missing_document_title`，文档标题落成 `Untitled`，正文第一个 `#` 只是 heading 不会补上。建完立刻改标题并回读确认：

```bash
lark-cli drive +update-title --type docx --token <doc_token> \
  --title "<客户｜文档名（版本）>" --as bot
lark-cli docs +fetch --doc <doc_token> --doc-format markdown --as bot | head -c 200
```

`+update-title` 用 `--token` + `--type docx`，没有 `--doc`；返回里的 `updated: true` 之后仍要 fetch 看 `<title>` 已变，再发链接。

完成条件：`<title>` 等于设定标题，正文首屏无 `Untitled`，请求人已是 full_access。

## 失败模式

- **写成功但位置错**：block_id 取错（用了旧缓存），表现为新内容插到中间。回读时看新章节是否在文末，不在则删掉重挂。
- **只信 success 就回报**：用户看到的是文档，不是工具返回。不计数就交付等于没验。
- **整篇覆盖**：把全文拉下来改完再写回，会冲掉用户手工编辑，也会丢文档里的图片/附件块。只做末尾插入；确需整篇重排时，覆盖后必须重新 `docs +media-insert` 插图、用 `block_move_after` 挪回原小节，再回读确认图片块仍在。
- **标题与正文粘连**：用脚本重建 markdown 再覆盖时，heading 与 body 必须用换行拼接；直接字符串相加会产出「## 四、素材盘点 项目：…」这种一个块里混排标题和正文的结果。
- **str_replace 匹配不到表行**：表格单元格是独立块，整行 `| a | b |` 不是可匹配文本；要改单元格文本，或 `block_replace` 整张表。
- **批次混写**：把旧批次内容抄进新文件，回读时计数会虚高（如 18 条写成 36）。

## 验证

1. 新增小节数 = 本批条数。
2. 旧批次小节数未变。
3. 新章节位于文档末尾，标题层级与既有格式一致。
4. 无代码块包裹正文（用户要直接复制的文案类内容按原文输出）。
