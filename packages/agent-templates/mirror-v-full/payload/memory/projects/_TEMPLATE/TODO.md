# TODO — <项目名>

> 格式：`- [ ] 任务描述 (status: ready|in_progress|blocked|waiting_input) (priority: hot|high|medium|low)`
>
> status：
> - `ready` — heartbeat 可以领
> - `in_progress` — 已经派出去了，不要动
> - `blocked` / `waiting_input` — 要等主人决定
>
> priority：`hot` 先领，`high` 其次，`medium` 空闲时，`low` 有空再说。
>
> heartbeat 按优先级扫描这个文件里 ready 的任务。新建项目时把本目录的 main.md 和这个文件一起复制过去，
> main.md 的「页面目录」里已经链好 TODO.md：没有这条链接，夜间 Librarian 的可达性检查会把 TODO.md 报成走不到的页。

## Backlog

- [ ] 示例任务 (status: ready) (priority: medium)
- [ ] 等主人决定的示例 (status: waiting_input) (priority: high)

## Done
<!-- 完成的任务挪到这里 -->
