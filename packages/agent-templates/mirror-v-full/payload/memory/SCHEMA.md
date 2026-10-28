# Memory Wiki Schema

> 规则层（Karpathy LLM Wiki 的 schema）：定义 memory/ 怎么分层、页面长什么样、Librarian 怎么维护。沿用 V 的记忆规则（2026-09-27 起在 V 上运行）。改这份文档要先给主人看 diff。

> 当前运行方式与 V 2026-10-22 起的「原编译」一致：读日志 / reflection / 导入原料 → 合并主题页 → 保留历史 → 关联 → 滚动复核。V 上试过的「通用纠错」（语义对账、纠错卡片）已在 V 上暂停，这里也不启用；`librarian-reconcile.py` 等脚本随 payload 附带，启用前要主人同意。

## 一句话

Daily log 记录"发生了什么"，wiki 保存"现在什么是真的"。新信息进来时要**改写已有页面**，而不是新建一页。

## 三层

**Raw（只读，只追加）**：记录发生过的事，Librarian 不改写。
- `memory/YYYY-MM-DD.md` 每日日志（每件事一个 `## ` 小节）
- `memory/reflections/`、`memory/logs/`
- `memory/imports/`（主人导入的原始资料，例如 V001 示范）：**实体目录在工作区根的 `memory-archive/imports/`，`memory/imports` 只是软链接**（不参与 memory_search 索引）。`git mv` 必须写实体路径。
- **编译队列**：`scripts/librarian-daily-queue.py` 直接按 daily log 的 `## ` 段落出队列，进度记在 `librarian/daily-queue.json`。daily = 从 `since`（安装日）到昨天每份日志的每一段。

**Wiki（Librarian 维护）**：保存当前有效的综合结论。
- **memory/ 下的页都要进 git**：普通会话新建或改过的页常常只写不提交。21:00 编译第一步用 `scripts/librarian-adopt-untracked.py --stage` 收编：
  - 没进 git 的新文件（adoptable），以及别的会话改了但没提交的已有 .md 页（adoptable_modified，例如 ai-patterns.md、项目 main.md），只要超过 2 小时没改、新增内容没扫出 secret，就由 Librarian 先单独提交一次，再在这个基础上照常更新——不要绕开，也不要把本该写进去的内容挪去新子页。
  - 2 小时内还在改的页当晚不动，要写进这些页的日志段留在队列里，第二晚再编译。扫出 secret 的不提交，只把文件名和行号报给主人。json/log 这类状态文件和删除操作不收编。
- `projects/<slug>/main.md`：项目实体页，是主干。放项目状态、群 ID、关键决策、当前规则、未决事项。细节可以拆子页，但必须从 main.md 链过去。
- `people/<slug>.md`：人物卡。只写观察到的事实和来源，不推断性格/观点。
- `concepts/<slug>.md`：跨项目的规则、SOP、机制、教训。一个主题一页。
- `decisions/YYYY-MM-DD-<slug>.md`：有日期的决策。写明谁定的、推翻了哪条旧结论。
- `research/<slug>.md`：调研结论（不是调研过程）。
- **工程踩坑与教训**：统一放进 `concepts/<领域>-engineering-lessons.md`，或者对应 skill 的 `references/`。
- **已冻结的页面**不再追加新结论，新内容写到当前在用的页面，再从冻结页链过去。

**导航**
- `index.md`：目录。每页一行 `- [标题](路径) — 一句话`，按类别分组，目标 ≤300 行。不写正文。
- `log.md`：只追加的时间线，格式 `## [YYYY-MM-DD] <动作> | <标题>`，动作取值 compile / lint / import / archive / query / schema。
- `archive/`：退役页面。移入，不删除；已编译完的碎片放 `archive/fragments/`，每批附 manifest。**实体目录在工作区根的 `memory-archive/archive/`，`memory/archive` 只是软链接**（不参与 memory_search 索引）。`git mv` 必须写实体路径。

## 页面规范

- 常青页（项目/人物/概念/调研）文件名用稳定 slug，不带日期前缀。
- **main.md 开头一段（标题到第一个 `##` 之间）是给检索用的**，控制在 400 字以内，必须包含：一句话现状、群 ID（如有）、`关键词：` 一行（中英文名、简称、别名、相关人名和系统名）。memory_search 按约 400 字切块，这一段决定页面能不能被搜到。
- 每条关键结论后面用括号标日期，需要时加来源，例如 `（2026-06-16，memory/2026-06-16.md）`。
- **页面正文只放现在为真的内容**：新信息进来就原地改写对应段落，不在后面追加一段"更新"。
- 被推翻的结论先用 ~~删除线~~ 标出，写明被哪条取代、在哪一天。删除线在 main 里最多保留 30 天，之后连同推翻原因挪进 history.md。
- **三层分工：结论放 main，过程放 history，原文在日志。** `main.md` 只回答"现在是什么情况"；`history.md` 回答"怎么走到这一步的"（只追加不删）；daily log 永远不动。唯一允许真删的是逐字重复的内容。
- 可能随版本变化的内容（模型名、版本号）标明"以当下状态为准"。
- 重复段落、碎片堆出来的冗长「汇编」段落，要压缩成干净的结论：wiki 不能只加不删。
- **挪就是原文搬，不改写**：从 main 压掉的内容原样挪进 history.md，不翻译、不概括、不合并；搬过去的标题降一级，前面写「（已被 <现行版本或页面> 取代，YYYY-MM-DD）」。提交前 `scripts/librarian-move-check.py` 会检查：删掉的行里的路径、提交号、链接、ID 在整个 memory 里找不到就拦下，补回原文才能提交。（V 上两次因为复核时模型改写丢了单行事实。）
- **过期标记跟着内容走**：带「【已过期、不执行 · 日期】」的条目，搬移、合并、引用时标记必须原样带上。主人取消一条规则时，同时登记进 `memory/librarian/expired-rules.json`（规则摘要、现行口径页、识别用的关键词）；从 skill 或旧文档往 memory 抄规则前先查这张表。`librarian-move-check.py` 会拦下没带标记的过期规则。
- **规则源核验**：生产规则的源头常常是 `skills/`，主人可能直接改 skill 而不改 memory。每晚编译先跑 `python3 scripts/librarian-rule-sources.py diff` 看相对上次快照改了什么，按有来源的改动更新 memory（旧说法标过期、写现行口径、登记 expired-rules.json），处理完 `librarian-rule-sources.py commit` 更新快照。**第一次没有快照时只跑 `commit` 建基线，当晚不对账**，否则所有 skill 都会被当成新规则。
- 页面之间用相对路径互相链接。每页至少要被 index 或某个项目 main.md 链到。
- 不写 secrets。发现已有的明文 secret，报告主人，不要复制。

## 检索友好的首段规范

首段（标题到第一个 `##` 之间）是页面唯一的检索入口，八条硬规则：

1. **≤400 字。** memory_search 按约 400 字切块，超了就被切成两块，命中率反而下降。
2. **`关键词：` 永远是首段最后一行。**
3. **每个别名 ≥3 字符。** `librarian-relations.py` 直接丢弃更短的，两字简称要补全成「XX 科技」这种形式。
4. **不写「飞书 / 项目 / 报告 / 平台 / API / demo」这类词。** GENERIC 停用词表会过滤掉，白占字数。
5. **中英文名都写，英文写全拼。**
6. **工商注册名和品牌名都写。** 客户搜合同、搜发票用的是注册名，开口说话用的是品牌名。
7. **内部黑话单列 `concepts/glossary.md`。** 企业里六成提问用黑话，向量模型对自造词没有先验，只能靠 trigram 精确命中。
8. **每条结论带 `（日期，来源）`；写完必须真的跑一次 `memory_search` 验证能命中**，不能凭文件名、链接数或 `indexed` 字段推断可检索性。

**两个会让页面从监控里消失的结构陷阱：**

- `memory-graph.py` 只收 `projects/*.md` 和 `projects/*/*.md`。**项目子页必须平铺在 `projects/<slug>/` 下**，再嵌一层（`projects/<slug>/<sub>/x.md`）就在图谱和 reachability 里完全不存在——不是报错，是静默消失。
- `wiki-maintenance.py` 的自动 reindex 只认各 kind 目录的**顶层** `*.md`，所以 `projects/<slug>/main.md` 永远不会被自动挂进 index，**必须手挂**。

## 操作

### Compile（每天 21:00）
对队列（`python3 scripts/librarian-daily-queue.py list --kind daily`）里的每一段：
1. **读原文全文**：按队列给的 `file` 和 `lines` 读完整段。
2. 判断：有持久价值的规则/事实/决策，还是纯事件记录？纯事件记录用 `librarian-daily-queue.py mark <id> --status skipped --note <原因>` 标掉。
3. 找目标页：优先已有的项目 main.md 或 concept 页，确实没有合适主题页时才新建。
4. **有来源的纠正优先，不是文件日期优先**：写入前先查同一主题有没有更晚的证据。比较的是来源的权威和决定时间，不是文件改动时间或出现次数；较新的转述沿用了旧错误，记为事故事实，不能据此恢复旧规则。`expired-rules.json` 里登记过的旧说法不许写回。
5. 改写合并：更新状态，标出被推翻的旧结论，补交叉链接。
6. 更新 index 的一句话摘要，在 log.md 记一条 `compile`，`mark <id> --status compiled --note <目标页路径>`。
每轮有处理上限，处理不完留到下一轮。

### Import Compile（导入原料，走 `kind=import` 队列）

Librarian 只整理记忆，不制造记忆。新租户没有日志、没有 reflection，冷启动时唯一的米是主人接进来的原料（官网、文档、别的 AI 助手里的记忆）。这些原料由 `scripts/onboard-collect.py` 落进 `memory-archive/imports/`，再由 `librarian-daily-queue.py` 的 **`kind=import`** 交给每晚 21:00 的编译。

- **两本账**：MANIFEST（`memory-archive/imports/MANIFEST.json`）记**文档**，`disposition`：`pending` → `compiled` | `skipped` | `duplicate`，每条都要有 `note`（compiled 写目标页路径，skipped / duplicate 写原因）。队列记**片**：大于 3500 字的文档按标题切成多片，id 为 `import#<sha8>#<n>`。**标完最后一片，MANIFEST 自动结账**，不要手改 MANIFEST。
- **每晚上限 20 片**，优先于 daily 和 reflection（冷启动期这两样本来就少）。`import_pending ÷ 20` 就是还要几个晚上，跟主人报进度用这个数。
- 编译：按 `file` + `lines` 读那一片原文 → 合并进已有的项目 main.md 或 concept 页，确实没有合适的主题页才新建 → 按「页面规范」和「检索友好的首段规范」写 → 结论后面的来源写 `memory-archive/imports/...` 的相对路径，让人能下钻到原文 → `mark`。
- 分流：`source=ai-memory` 的原料，主人的身份和偏好进 `USER.md`（只写主人自己说过的，一条一行，先查重），人进 `people/`，项目进 `projects/`。别人的电话、住址、证件号不进记忆。
- **原文不抄进 daily log，也不在真人轮里当场编译。** 抄进日志会被编译两遍；当场写会和夜间编译写出两套说法。唯一例外：主人在对话里亲口说的关于自己的事实，可以当场写进 `USER.md` 或项目页。
- `log.md` 记一条 `import`；`librarian/runs/` 记一条 `kind: import` 的 run。

### Reflection 编译
`memory/reflections/YYYY-MM-DD.jsonl` 是原始层，只读。进度记在 `librarian/reflections-cursor.json`：`{"new_since": "<ISO 时间>", "backlog": {}, "done_ids": [...]}`，每条 reflection 用 `文件名#行号` 作为 id。处理 `created_at`（或 `ts`）晚于 `new_since` 的条目，处理完把 `new_since` 推到最后一条的时间。每条分流到**一个**去处：
1. **跨场景的行为准则**（怎么沟通、怎么验证、怎么汇报）→ `ai-patterns.md`。先查重，已有的合并进原条目。
2. **工具、系统的踩坑和用法** → `concepts/*-engineering-lessons.md` 或对应 skill 的 `references/`。
3. **项目的事实、根因、决定、状态** → 对应项目的 main.md、子页或 history.md。
4. **对人的了解** → `people/<slug>.md`；主人的偏好 → `USER.md`。
5. **噪音** → 跳过：heartbeat 自动补的占位条目（context 以 "Heartbeat auto-captured" 开头）、过时的例行状态、一次性琐事、重复。

### 关联
每个项目 main.md 在页面目录之后有一节 `## 相关`，每条一行：`- [名称](相对路径) — 关系类型：一句话说明`。关系类型：同一件事的另一版本/阶段、平台/上下游、共享客户/人/组件、由…拆出/合并进。双向写；只写有证据的关系。候选来自 `scripts/librarian-relations.py`。

关联的规则：
1. **双向写**：A 写了和 B 的关系，B 的 `## 相关` 里也要有对应一行（从 B 的视角写）。
2. **编译时顺手连**：往 A 写一条事实时提到另一个项目、客户或系统，就检查两边的 `## 相关`，缺了就补。
3. **只写有证据的关系**：关系说明要有来源（日期或原话）。只是在同一段日志里一起出现、没有实质关系的，不连。

### Lint（每天，跟在 compile 后面）
检查：页面之间的矛盾、main.md 落后于近期日志、重复主题页、孤儿页、index 死链、index 超长、明文 secret、提到了但没连上、单向关系、走不到的页（`scripts/librarian-reachability.py`，结果在 `librarian/unreachable.json`）。能修的直接修，改不了的写进运行记录的 issues。

### 滚动复核
每晚 Lint 之后，挑"最近复核"日期最早的页面重新核一遍：原地改写过时结论，把超过 30 天的删除线和过程性内容挪进 history.md。复核完在标题下写 `_最近复核：YYYY-MM-DD_`。

### Query 回写与当面纠正
回答跨多页的综合问题后，如果答案有复用价值，写回对应页面。主人在对话里指出记忆有错，**当场改**，用删除线标出旧结论并写纠正日期。

> **通用纠错（语义对账）**：V 在 2026-10-19 引入、2026-10-22 暂停。这里不执行 `librarian-reconcile.py prepare/apply/finish`，也不生成纠错卡片。仍然有效的是：既有过期标记、主人明确的决定、原文无损保留、秘密检查。所有 Librarian 提交统一用 `python3 scripts/librarian-corrections.py commit -m <说明>`（依次跑已知过期检查和 move-check，任一失败不提交）。

## 运行记录

- 每一轮写 `librarian/runs/YYYY-MM-DD.json`，同一天追加到 `runs[]`。每条 run：`id, kind(daily|reflection|lint|import), label, time, stats, outputs[{target,title,action(create|update),points[]}], changes[{target,title,kind(rewrite|strike|move|delete),before,after,reason}], sources[{source,action(merged|archived|skipped),note}], issues[], commit`。
- `outputs[].points` 就是「今天整理出来的记忆」，一句话一条，写结论本身。
- `changes[]`：这一轮对**已有内容**做的改写、划掉、挪走和删除，每处一项；move 表示挪进 history.md，delete 只用于逐字重复。before 和 after 各写一句概括，不贴大段原文。
- `sources[]` **每段日志、每片导入、每条 reflection 单独一项**，写清去向（note 写目标页或跳过原因）。不许用「其余 N 片」打包——打包会让去向和事实对不上，质检也抽不到。
- 不写 secrets、账号密码、联系方式。

## 护栏

- 自治范围：wiki 层、people 页、`USER.md`、`ai-patterns.md`、index / log 由 Librarian 直接改，每处写进运行记录，22:00 质检抽查。
- 写 `USER.md`、`ai-patterns.md` 时：只写有来源的事实或主人明确说过的话，一条一行，先查重，不写推断。
- 不直接改：`AGENTS.md`、`SOUL.md`、`REDLINES.md`、`MEMORY.md`。只把建议写进 issues。
- **每完成一批就提交一次 git**，只 stage 自己改过的路径。git 路径比对一律加 `-c core.quotepath=off`。导入脚本自己 `git add` + commit，**不依赖 Librarian 收编**——`librarian-adopt-untracked.py --min-age-hours` 默认 2，白天落盘的批次当晚收编不到。
- **导入只落纯文本。** 任何二进制（PDF / 图片 / 音视频）都不进 workspace：备份把整个 workspace 连 `.git` 一起打包，删文件不会让备份变小，一份 PDF 进去就永久计入之后每一轮的备份体积。
- **单批落盘前跑 `python3 scripts/onboard-budget.py`**，预计增量 >20 MB 就停下问主人，不要先落盘再算。
- 搜索必须带 `--include`。
- 单次定时任务最多运行约 9 分钟：做不完的留到下一晚，先提交已完成的部分。
