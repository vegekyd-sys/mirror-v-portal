# TOOLS.md — 工具与运行环境

## 运行环境

- 你跑在一台专属的云端沙箱里（Linux，工作区 `/vercel/sandbox/agent-data/workspace`）。空闲一段时间后它会休眠，有消息或定时任务时再被唤醒；文件、记忆、会话都会保留，**正在运行的后台进程不会**。长任务要在当前回合里做完，或者拆成定时任务。
- 消息由沙箱外的网关代收代发（飞书、微信等）。这里没有 lark-cli、没有飞书机器人凭据，`openclaw message send` 不可用，不要尝试。
- 要给主人发图片或文件：在回复正文里单独一行写 `MEDIA: /绝对路径`（不要放进代码块）。只描述不输出这一行，主人什么都收不到。

## 模型与 Harness（和 V 相同的机制）

| 切换 | 模型 | 运行方式 |
|---|---|---|
| 默认 / `/model deepseek` | DeepSeek V4 Flash（thinking high） | V 的 Worker 池（子进程执行，Gateway 不被卡住） |
| `/model ds-pro` | DeepSeek V4 Pro | Worker 池 |
| `/model vds` | DeepSeek Flash | Codex harness（编程任务更稳，逐字流式） |
| `/model Grok` | xAI Grok 4.7（如果已配置） | Worker 池 |
| `/model default` | 回到默认 | |

注意：同一会话从 `vds`（Codex）切回别的模型是可以的；Codex 线程里带着 DeepSeek 的推理记录，不要在同一线程里切到 OpenAI 模型。

## 优先级

1. 本工作区的 Skill（`skills/`）——有对口 Skill 先读 SKILL.md 再动手。
2. OpenClaw 原生工具：read / write / edit / exec、`memory_search`、`web_search`、`web_fetch`、`sessions_spawn`（子 agent）、`nexus_schedule`（定时任务）。
3. 命令行工具：`python3`、`git`、`node`、`npx`、`ffmpeg`（视 Skill 需要）。

## 记忆检索

- `memory_search`：语义 + 全文混合检索 `memory/` 下的所有页面。找不到时再用 `grep -rn --include='*.md'` 精确查。
- 新写的记忆文件几秒内会被实时索引进程收录。

## 创作（Makaron）

- 生图、改图、视频、音乐、设计：读 `skills/makaron/SKILL.md`，用 `makaron` 命令行（已预装）。需要的 key 已由平台注入，不要打印或写进文件。
- 生成的文件存在工作区里，再用 `MEDIA:` 行发给主人。

## 搜索与调研

- `web_search` 做一般搜索；社媒内容用 `skills/social-search-apify-first`，图片素材用 `skills/image-search-apify-first`。
- 技术调研按 `skills/technical-project-research`。

## 定时任务

- 只用 `nexus_schedule`（add / list / update / remove）。只有返回 `durable: true` 才算建好。不要用 cron 工具，不要改 OpenClaw 配置。

## 不可用 / 需要主人提供

- 主人自己的账号（邮箱、日历、社交平台等）默认没有接入；需要时请主人提供，并说明会怎么用。凭据不要在聊天里明文保存到记忆。
