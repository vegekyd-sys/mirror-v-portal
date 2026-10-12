---
name: "skill-gate"
description: "手动触发：Skill 验收门，仅当用户明确要求跑 skill-gate 时使用；写完 SKILL.md 不算完成，需 fresh agent 实跑通过"
---

# Skill Gate

## Core Principle

**写完 SKILL.md 不是完成。** 只有不继承作者会话上下文的独立 fresh agent 真实跑通一个代表性任务，Skill 才能标 READY。

## 触发方式：手动（默认不要进入）

本 Gate 是**手动触发器**，默认不启用。

- 只有用户明确要求时才进入，例如：「跑 skill-gate」「用 skill gate 验收这个 skill」「按验收门检查一下 X」「帮我做完整验收」。
- 普通任务（创建 / 修改 / 重构 / 沉淀 Skill）**不要**主动套上本 Gate，按常规做法直接完成即可。
- 用户没点名、但你认为值得验收时：先问一句「要不要走 skill-gate 验收」，得到同意再启动，不要先跑再报。
- 本 Gate 的 REVIEW / VALIDATE / ISOLATION TEST 只在被启用后执行。

## Inputs / Outputs

- 输入：被测 Skill 的 name（或路径）+ 一条代表性真实任务 + 该 Skill 声称覆盖的场景边界。
- 输出：统一报告（见文末模板）+ 状态 `READY` / `UNVERIFIED` / `FAILED`。
- 证据：每个 Gate 的实际命令输出、fresh agent 的 session key、产物路径。缺证据的 Gate 视为未执行。

## Capability Map（先复用现有能力，不要重造）

| Gate | 复用对象 | 缺失时 |
|---|---|---|
| DRAFT | `skill_workshop` 工具（create/update/patch/revise） | 手写 SKILL.md 文件，并在报告中说明原因 |
| REVIEW | `skills/skill-creation-coach/SKILL.md`（读全文后按其启发式审查） | 按本文件 Stage 2 的 7 项清单自审 |
| VALIDATE | `openclaw skills check --json`、`openclaw skills workshop inspect/evaluate <proposal-id>` | 记 NOT AVAILABLE |
| ISOLATION TEST | `sessions_spawn` 且 `context:"isolated"` | 记 NOT AVAILABLE，状态最高只能 UNVERIFIED |
| READY | 本文件统一报告模板 | — |

探测命令：`ls skills/<name>/SKILL.md`；`openclaw skills check --json`；`openclaw skills workshop list`；`agents_list`。

任一 Gate 的工具或命令在当前环境不存在，记录为 `NOT AVAILABLE`，**绝不假装执行**，继续跑其余可执行的 Gate。

## Stage 1 - DRAFT

产出或修改 Skill 本体。硬约束：

- `SKILL.md` ≤ 10,000 字符；长参考、示例、脚本移到 references/、examples/、scripts/。
- frontmatter 必须有 `name` 与 `description`；description 前 60 字符内写清触发场景，且 ≤160 字节。
- 必须写清：触发条件、产出物、必需输入、依赖工具与路径、失败处理、边界与停止条件。
- 不得依赖"当前对话里说过"的信息；一切必要背景必须写进 Skill 或 references。
- 注意：超过约 8,000 字节后，Workshop 的 patch 会被 read budget 拦下，只能整body重写；写长之前先考虑拆分。

**落盘语义（Workshop 环境）：**

- Workshop 创建的 Skill 可自动 apply；对 user-authored Skill 的更新会停在 `pending`，需要人工 apply 才生效。
- 运行中的 session 保持旧 Skill 快照；只有新 session 才加载新内容。
- 因此 Isolation Test 测的永远是**当前 live 内容**。若修改仍是 pending，必须在报告中写明"测的是旧版本 / 新版本未生效"，不得默认新版本已生效。
- 操作员手动生效命令：`openclaw skills workshop apply <proposal-id>`。

完成判据：文件存在且满足上述全部约束。

## Stage 2 - REVIEW

读 `skills/skill-creation-coach/SKILL.md`，按其启发式逐条审查。必查 7 项：

1. description / trigger 是否足够明确，是否写明"什么时候不该触发"。
2. instructions 是否完整、可独立执行。
3. 是否存在依赖当前对话的隐式上下文。
4. 是否存在模糊指代（"上面那个""之前说的"）。
5. inputs / outputs / dependencies / tools 是否明确。
6. failure handling 是否明确。
7. 是否存在只对当前 Agent 有效的假设（个人路径、私有凭据、临时状态）。

**发现问题必须修改 Skill，而不是只输出审查报告。** 完成判据：7 项均有明确结论，且修改已落盘。

## Stage 3 - VALIDATE

1. `openclaw skills check --json` → 目标 Skill 必须出现在 `eligible`，且不在 `blocked` / `missingRequirements`。
2. 若走 Workshop 流程：`openclaw skills workshop inspect <proposal-id>`；环境具备时再跑 `openclaw skills workshop evaluate <proposal-id>`。
3. 所有 blocking error 必须修完才能进入下一步。

某工具不存在 → 该项记 `NOT AVAILABLE`，其余照跑。完成判据：不存在未解释的 blocking error。

## Stage 4 - ISOLATION TEST（强制 Gate）

用 `sessions_spawn` 起一个 `context:"isolated"`、`mode:"run"` 的 fresh agent（不继承作者上下文），`visible:true` 便于事后查阅完整执行记录。

**Fresh agent 只能获得：**
- 工作区正常提供给普通 agent 的基础 instructions；
- 工作区正常可见的 Skill 目录（含被测 Skill）；
- Skill 声明需要的正常工具与资源；
- 一条代表性真实用户任务（自然语气，**不要点名被测 Skill**）。

**禁止额外提供（泄露即测试作废）：**
- 创建 Skill 时的原始对话；
- 作者对任务的解释、思路、背景补充；
- 没有写入 Skill / references / 正式 workspace context 的背景知识；
- 为了让测试通过而临时补充的提示。

**任务设计要求：** 真实、可验证、能产出实体产物；难度与被测 Skill 声称覆盖的场景一致；优先取自真实历史请求，不要为通过而临时编一个简单任务；避免触发外部发送、删除、付费等不可逆副作用。

**副作用降级：** 若某个通过条件必须依赖不可逆外部动作，改用只读或小代价等价方式验证，并把该条件记为"部分验证"，写进 Remaining risks；不得直接判 PASS 或整个测试作废。

**Fresh agent 必须真的去做**，交回简短自述：用了哪个 Skill、读了什么、关键步骤、产物位置、卡住的地方。完成判据：有产物且过程可核对，而不是"读完 Skill 后评价看起来可以"。

**必须先证明 Skill 真的被用上，否则测试无效（2026-09-11 实测回补）：**

- 证据 A（可见性）：确认 fresh agent 的 `<available_skills>` 里确实列有被测 Skill。若没有列出（清单截断 / 未注入），记 `notInCatalog`——这是**环境问题，不是 Skill 问题**，不得据此判该 Skill FAIL。
- 证据 B（实际调用）：从 fresh agent 的轨迹确认它真的读过 `skills/<name>/SKILL.md`。
- 只有 A 成立、B 不成立时，才归因 `incorrect trigger`，且要指向可发现性问题（name、description 前 60 字符的触发信号），而不是笼统说模型不听话。
- **产物合格但 Skill 从未被调用 ≠ PASS**：那只证明"基础 agent 自己也能做"，说明该 Skill 对这类请求是惰性的。按 `incorrect trigger` 记录为 FAIL，不要因为产物好看就给 READY。
- 若修复只能以 pending 提案存在（user-authored Skill 不会自动 apply），Isolation Test 测到的仍是旧内容。此时**禁止重测后假装通过**：状态记 UNVERIFIED，写明"修复未生效"，由操作员 apply 后再重测。

**通过条件（全部满足才算 PASS）：**
- 判断出该不该用这个 Skill，并找到正确的 Skill；
- 理解任务目标；
- 获取或识别出 required inputs；
- 找到 required tools / resources；
- 按正确流程执行；
- 缺少输入时按 Skill 定义正确处理；
- 产出符合要求的 output。

**失败归因（写进 failure report，禁止含糊）：**
`missing context` / `ambiguous instruction` / `missing dependency` / `unknown path` / `unknown tool` / `undefined input` / `undefined output` / `incorrect trigger` / `notInCatalog` / `execution failure`

失败 → 把 failure report 交回作者 → 修改 Skill → **新建 fresh agent 重测**（不要复用上一个 child）。最多自动修复并重测 **3 轮**。

## Stage 5 - READY

只有同时满足以下条件才允许报告 READY：

- Review passed；
- 可用的 Validator passed；
- Isolation Test passed；
- Fresh agent 实际完成至少一个代表性任务（有产物）。

无法进行 Isolation Test → 状态只能是 **UNVERIFIED**，不得标记 READY。
3 轮后仍未通过 → **FAILED**，附完整 failure report 与剩余风险。

## 统一报告模板

```
Skill: <name>
Status: READY / UNVERIFIED / FAILED
Review: PASS / FAIL
Validator: PASS / FAIL / NOT AVAILABLE
Isolation Test: PASS / FAIL / NOT AVAILABLE
Test task: <实际使用的测试任务>
Failures found: <发现了什么问题>
Fixes applied: <实际修改了什么>
Remaining risks: <仍然未验证的风险>
```

报告必须带实测记录（命令输出、child session key、产物路径）。不要把"已建立""已写完"当作结论。

## Anti-Patterns

- **Auto-Entry**：用户没要求就自动套上本 Gate。
- **Review Theater**：只打分不改 Skill。
- **Fake Gate**：工具不存在却写 PASS；应写 NOT AVAILABLE。
- **Context Leak**：给 fresh agent 塞作者解释、原始对话或通关提示。
- **Self-Grading**：作者自己跑隔离测试并自称通过；结论必须来自 fresh agent 的实际产物。
- **Read-Only Test**：fresh agent 只读 Skill 就评价，没有真正执行。
- **Artifact-Only Pass**：看到合格产物就判 PASS，不核对 Skill 是否真的被调用。
- **Snapshot Trap**：修改 Skill 后复用旧 child 重测，或把 pending 提案当作已生效内容来测。

## Boundaries

- 本 Gate 只管 Skill 生命周期，不替代核心文档（AGENTS/SOUL/REDLINES/MEMORY）的 diff + 确认规则，也不替代外部发送、删除等确认门。
- 测试任务避免不可逆副作用；不修改未授权的外部系统。
- 不因赶时间跳过 Isolation Test 后仍标 READY。
