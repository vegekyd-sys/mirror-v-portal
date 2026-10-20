# Memory Wiki Index

> LLM 维护的结构化 wiki 层。每日日志记录发生了什么，这些页面保存现在什么是真的。规则见 [SCHEMA.md](SCHEMA.md)。
> 每页一行 `- [标题](路径) — 一句话`，按类别分组，目标 ≤300 行；不在这里写正文。

## Group Index（群 → 项目映射）

进群第一条：查此表定位项目页。群名 / ID 是固定 key，不要靠关键词搜。

| 群 ID（chat_id） | 群名 | 项目页 |
|---|---|---|

## Projects

- [Memory Librarian](projects/memory-librarian/main.md) — 记忆的夜间整理：规则、运行方式与指标

## People

## Concepts

（自动 reindex 插进来的新条目会落在这一行和第一个分组之间，编译时顺手归进下面四组。）

### 公司与产品

### 销售

### 交付

### 合规

## Decisions

## Research

## Imports

（**薄索引在这里**：每批一行「什么资料、哪天导入、编译进了哪几页」。**原文在工作区根的 `memory-archive/imports/`**，`memory/imports` 只是指向它的软链接——只读、不参与检索索引。要看原文，照这里记的相对路径 grep 下钻。）
