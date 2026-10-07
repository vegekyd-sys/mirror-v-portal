# Memory Wiki Schema

> 规则层（Karpathy LLM Wiki 的 schema）：定义 memory/ 怎么分层、页面长什么样、Librarian 怎么维护。沿用 V 的记忆规则（2026-09-27 起在 V 上运行）。改这份文档要先给主人看 diff。

## 一句话

Daily log 记录"发生了什么"，wiki 保存"现在什么是真的"。新信息进来时要**改写已有页面**，而不是新建一页。

## 三层

**Raw（只读，只追加）**：记录发生过的事，Librarian 不改写。
- `memory/YYYY-MM-DD.md` 每日日志（每件事一个 `## ` 小节）
- `memory/reflections/`、`memory/logs/`、`memory/imports/`（主人导入的原始资料，例如 V001 示范）
- **编译队列**：`scripts/librarian-daily-queue.py` 直接按 daily log 的 `## ` 段落出队列，进度记在 `librarian/daily-queue.json`。daily = 从 `since`（安装日）到昨天每份日志的每一段。

**Wiki（Librarian 维护）**：保存当前有效的综合结论。
- **memory/ 下的页都要进 git**：普通会话新建的页常常只写不提交。21:00 编译第一步用 `scripts/librarian-adopt-untracked.py` 收编：未跟踪、超过 2 小时没改、没扫出 secret 的新文件由 Librarian 提交；扫出 secret 的不提交，报给主人。别人改了没提交的已跟踪文件不碰。
- `projects/<slug>/main.md`：项目实体页，是主干。放项目状态、群 ID、关键决策、当前规则、未决事项。细节可以拆子页，但必须从 main.md 链过去。
- `people/<slug>.md`：人物卡。只写观察到的事实和来源，不推断性格/观点。
- `concepts/<slug>.md`：跨项目的规则、SOP、机制、教训。一个主题一页。
- `decisions/YYYY-MM-DD-<slug>.md`：有日期的决策。写明谁定的、推翻了哪条旧结论。
- `research/<slug>.md`：调研结论（不是调研过程）。
- **工程踩坑与教训**：统一放进 `concepts/<领域>-engineering-lessons.md`，或者对应 skill 的 `references/`。
- **已冻结的页面**不再追加新结论，新内容写到当前在用的页面，再从冻结页链过去。

**导航**
- `index.md`：目录。每页一行 `- [标题](路径) — 一句话`，按类别分组，目标 ≤300 行。不写正文。
- `log.md`：只追加的时间线，格式 `## [YYYY-MM-DD] <动作> | <标题>`，动作取值 compile / lint / archive / query / schema。
- `archive/`：退役页面。移入，不删除；已编译完的碎片放 `archive/fragments/`，每批附 manifest。**实体目录在工作区根的 `memory-archive/archive/`，`memory/archive` 只是软链接**（不参与 memory_search 索引）。`git mv` 必须写实体路径。

## 页面规范

- 常青页（项目/人物/概念/调研）文件名用稳定 slug，不带日期前缀。
- **main.md 开头一段（标题到第一个 `##` 之间）是给检索用的**，控制在 400 字以内，必须包含：一句话现状、群 ID（如有）、`关键词：` 一行（中英文名、简称、别名、相关人名和系统名）。memory_search 按约 400 字切块，这一段决定页面能不能被搜到。
- 每条关键结论后面用括号标日期，需要时加来源，例如 `（2026-06-16，memory/2026-06-16.md）`。
- **页面正文只放现在为真的内容**：新信息进来就原地改写对应段落，不在后面追加一段"更新"。
- 被推翻的结论先用 ~~删除线~~ 标出，写明被哪条取代、在哪一天。删除线在 main 里最多保留 30 天，之后连同推翻原因挪进 history.md。
- **三层分工：结论放 main，过程放 history，原文在日志。** `main.md` 只回答"现在是什么情况"；`history.md` 回答"怎么走到这一步的"（只追加不删）；daily log 永远不动。唯一允许真删的是逐字重复的内容。
- 可能随版本变化的内容（模型名、版本号）标明"以当下状态为准"。
- 页面之间用相对路径互相链接。每页至少要被 index 或某个项目 main.md 链到。
- 不写 secrets。发现已有的明文 secret，报告主人，不要复制。

## 操作

### Compile（每天 21:00）
对队列（`python3 scripts/librarian-daily-queue.py list --kind daily`）里的每一段：
1. **读原文全文**：按队列给的 `file` 和 `lines` 读完整段。
2. 判断：有持久价值的规则/事实/决策，还是纯事件记录？纯事件记录用 `librarian-daily-queue.py mark <id> --status skipped --note <原因>` 标掉。
3. 找目标页：优先已有的项目 main.md 或 concept 页，确实没有合适主题页时才新建。
4. **新证据优先**：写入前先查同一主题有没有更晚的证据。有更晚的纠正，以最新为准，旧说法用删除线标出。
5. 改写合并：更新状态，标出被推翻的旧结论，补交叉链接。
6. 更新 index 的一句话摘要，在 log.md 记一条 `compile`，`mark <id> --status compiled --note <目标页路径>`。
每轮有处理上限，处理不完留到下一轮。

### Reflection 编译
`memory/reflections/YYYY-MM-DD.jsonl` 是原始层，只读。进度记在 `librarian/reflections-cursor.json`：`{"new_since": "<ISO 时间>", "backlog": {}, "done_ids": [...]}`，每条 reflection 用 `文件名#行号` 作为 id。处理 `created_at`（或 `ts`）晚于 `new_since` 的条目，处理完把 `new_since` 推到最后一条的时间。每条分流到**一个**去处：
1. **跨场景的行为准则**（怎么沟通、怎么验证、怎么汇报）→ `ai-patterns.md`。先查重，已有的合并进原条目。
2. **工具、系统的踩坑和用法** → `concepts/*-engineering-lessons.md` 或对应 skill 的 `references/`。
3. **项目的事实、根因、决定、状态** → 对应项目的 main.md、子页或 history.md。
4. **对人的了解** → `people/<slug>.md`；主人的偏好 → `USER.md`。
5. **噪音** → 跳过：heartbeat 自动补的占位条目（context 以 "Heartbeat auto-captured" 开头）、过时的例行状态、一次性琐事、重复。

### 关联
每个项目 main.md 在页面目录之后有一节 `## 相关`，每条一行：`- [名称](相对路径) — 关系类型：一句话说明`。关系类型：同一件事的另一版本/阶段、平台/上下游、共享客户/人/组件、由…拆出/合并进。双向写；只写有证据的关系。候选来自 `scripts/librarian-relations.py`。

### Lint（每天，跟在 compile 后面）
检查：页面之间的矛盾、main.md 落后于近期日志、重复主题页、孤儿页、index 死链、index 超长、明文 secret、提到了但没连上、单向关系、走不到的页（`scripts/librarian-reachability.py`，结果在 `librarian/unreachable.json`）。能修的直接修，改不了的写进运行记录的 issues。

### 滚动复核
每晚 Lint 之后，挑"最近复核"日期最早的页面重新核一遍：原地改写过时结论，把超过 30 天的删除线和过程性内容挪进 history.md。复核完在标题下写 `_最近复核：YYYY-MM-DD_`。

### Query 回写与当面纠正
回答跨多页的综合问题后，如果答案有复用价值，写回对应页面。主人在对话里指出记忆有错，**当场改**，用删除线标出旧结论并写纠正日期。

## 运行记录

- 每一轮写 `librarian/runs/YYYY-MM-DD.json`，同一天追加到 `runs[]`。每条 run：`id, kind(daily|reflection|lint), label, time, stats, outputs[{target,title,action(create|update),points[]}], changes[{target,title,kind(rewrite|strike|move|delete),before,after,reason}], sources[{source,action(merged|archived|skipped),note}], issues[], commit`。
- `sources[]` 每段日志、每条 reflection 单独一项。
- 不写 secrets、账号密码、联系方式。

## 护栏

- 自治范围：wiki 层、people 页、`USER.md`、`ai-patterns.md`、index / log 由 Librarian 直接改，每处写进运行记录，22:00 质检抽查。
- 写 `USER.md`、`ai-patterns.md` 时：只写有来源的事实或主人明确说过的话，一条一行，先查重，不写推断。
- 不直接改：`AGENTS.md`、`SOUL.md`、`REDLINES.md`、`MEMORY.md`。只把建议写进 issues。
- **每完成一批就提交一次 git**，只 stage 自己改过的路径。git 路径比对一律加 `-c core.quotepath=off`。
- 搜索必须带 `--include`。
- 单次定时任务最多运行约 9 分钟：做不完的留到下一晚，先提交已完成的部分。
