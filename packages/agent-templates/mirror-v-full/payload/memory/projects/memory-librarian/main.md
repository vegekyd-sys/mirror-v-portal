# Memory Librarian（记忆整理）

现状：每晚 21:00 把当天日志和 reflection 编译进 wiki，22:00 独立质检。规则在 [SCHEMA.md](../../SCHEMA.md)。关键词：Librarian / 记忆整理 / LLM Wiki / 编译 / lint / 质检

## 页面目录

（随运行补充。）

## 当前规则

- 编译队列：`python3 scripts/librarian-daily-queue.py list --kind daily`，进度在 `memory/librarian/daily-queue.json`。
- reflection 进度：`memory/librarian/reflections-cursor.json`。
- 运行记录：`memory/librarian/runs/YYYY-MM-DD.json`；时间线：`memory/log.md`。
- 每完成一批就提交一次 git，只 stage 自己改过的路径。

## 指标记录

| 日期 | 已编译页 | 孤儿页 | index 行数 | 死链 | 备注 |
|---|---|---|---|---|---|

## 相关
