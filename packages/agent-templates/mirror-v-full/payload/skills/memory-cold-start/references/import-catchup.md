# 导入补编（凌晨 3 点那一轮，以及它的接力）

规则以 `memory/SCHEMA.md` 为准，所有命令在工作区根目录执行。时间预算 7 分钟，到点就收尾。

1. `python3 scripts/librarian-daily-queue.py stats`。`import_pending` 为 0：只回复 HEARTBEAT_OK，结束。
2. `python3 scripts/librarian-daily-queue.py list --kind import --limit 30`，最多 30 片。每片读原文，合并进已有的 `projects/<slug>/main.md` 或 concept 页（没有合适的才新建，首段按检索友好规范，每条结论带日期和来源），然后 `mark '<id>' --status compiled --note '<目标页路径>'`；没有持久价值的标 `skipped` 并写原因。
   - 标题带「更新版」的是主人改过的文档：按新版改写对应页面，旧说法原样挪进 `history.md`。
   - 会议纪要：只留结论、决定、负责人和截止时间，写进对应项目页，不为每次会议新建一页。
   - 写入前查 `memory/librarian/expired-rules.json`，登记过的旧说法不许写回。
3. `memory/log.md` 追加一条 compile；`git add -- <具体文件>` 后用 `python3 scripts/librarian-corrections.py commit -m "chore(librarian): <日期> 补编 N 片"` 提交；再跑 `python3 scripts/memory-graph.py`。
4. 接力：`import_pending` 还大于 0，而且现在是 00:00–08:00（Asia/Shanghai），就用 `portal_schedule` 加一条：
   `{"action":"add","kind":"heartbeat","name":"导入补编 · 接力","schedule":{"kind":"at","at":"<现在+1 分钟，带 +08:00>"},"prompt":"【导入补编 · 接力】按 skills/memory-cold-start/references/import-catchup.md 做一轮。"}`
   白天不接力，免得主人说话要排队。
5. 最终回复只写 HEARTBEAT_OK（进度由 21:00 的整理汇报）。失败就如实写一句原因。

不跑 reconcile、lint、关联，不 sessions_yield，不等子任务。
