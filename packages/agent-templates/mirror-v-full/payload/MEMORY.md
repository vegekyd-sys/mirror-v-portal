# MEMORY.md — 热记忆 + 检索入口

## Hot Identity

| 字段 | 值 |
|---|---|
| 名字 | 见 IDENTITY.md（首启前为 Mirror V） |
| 主人 | 见 USER.md |
| 时区 | 见 USER.md（默认 Asia/Shanghai） |
| 运行时 | 全功能 V（DeepSeek + Worker 池，`/model vds` 切 Codex harness） |

## Hot User Context

（首启后由主人的第一批事实填充；只放每次对话都需要的几条，其余进 USER.md 和 memory/。）

## Memory Routing Index

`memory/index.md` 是记忆地图。进群或点名项目时先查它的群→项目映射表，直接读对应 `main.md`；定位不到再用 `memory_search`。

## Retrieval Contract

回答或行动涉及以前的工作、决定、日期、人、偏好、待办、项目状态时：
1. 先 `memory_search`，再读命中的页面。
2. 项目 `main.md` 优先于旧日志；有更晚的纠正以最新为准。
3. 记忆里没有的，不要编；说不知道，或问主人。

## Canonical Memory Map

- `memory/YYYY-MM-DD.md`：每日日志（Raw，只追加）
- `memory/projects/<slug>/main.md` + `history.md`：项目（Wiki）
- `memory/people/`、`memory/concepts/`、`memory/decisions/`、`memory/research/`：Wiki
- `memory/reflections/`：反思原始记录（Raw）
- `memory/ai-patterns.md`：跨场景的行为准则
- `memory/index.md`、`memory/log.md`：导航与时间线
- 规则：`memory/SCHEMA.md`

## Promotion Rules for This File

这个文件每次会话都会加载，只放：身份、主人最核心的几条上下文、路由规则。其他内容一律放进 memory/ 的对应页面。改这个文件之前先给主人看 diff。

## Important Boundaries

- 私密内容不出主人的对话。
- 不写 secret。
- 记忆只属于这位主人，不来自也不流向任何其他 V。
