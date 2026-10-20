# TOOLS.md — 工具与运行环境

## 运行环境

- 你跑在一台专属的云端沙箱里（Linux，工作区 `/vercel/sandbox/agent-data/workspace`）。空闲一段时间后它会休眠，有消息或定时任务时再被唤醒；文件、记忆、会话都会保留，**正在运行的后台进程不会**。长任务要在当前回合里做完，或者拆成定时任务。
- 执行权限来自沙盒的实际配置。全局 npm 目录为 `/vercel/sandbox/agent-data/npm`，bin 位于 PATH；沙盒文件系统有休眠快照，agent-data 有额外备份。
- 当前对话的消息由沙箱外的 Portal 网关代收代发（飞书、微信等）。当前回复的附件协议为独立的 `MEDIA: <绝对路径>` 行；其他 CLI 与外部账号连接独立于这条投递通道。
- 要给主人发图片或文件：在回复正文里单独一行写 `MEDIA: /绝对路径`（不要放进代码块）。只描述不输出这一行，主人什么都收不到。

## 模型与 Harness（和 V 相同的机制）

| 切换 | 模型 | 运行方式 |
|---|---|---|
| 默认 / `/model deepseek` | DeepSeek V4 Flash（thinking high） | V 的 Worker 池（子进程执行，Gateway 不被卡住） |
| `/model ds-pro` | DeepSeek V4 Pro | Worker 池 |
| `/model vds` | DeepSeek Flash | Codex harness（编程任务更稳，逐字流式） |
| `/model default` | 回到默认 | |

注意：同一会话从 `vds`（Codex）切回别的模型是可以的；Codex 线程里带着 DeepSeek 的推理记录，不要在同一线程里切到 OpenAI 模型。

## 优先级

1. 本工作区的 Skill（`skills/`）——有对口 Skill 先读 SKILL.md 再动手。
2. OpenClaw 原生工具：read / write / edit / exec、`memory_search`、`web_search`、`web_fetch`、`sessions_spawn`（子 agent）、`portal_schedule`（定时任务）。
3. 命令行工具：`python3`、`git`、`node`、`npx`、`ffmpeg`（视 Skill 需要）。

## 记忆检索

- `memory_search`：语义 + 全文混合检索 `memory/` 下的所有页面。找不到时再用 `grep -rn --include='*.md'` 精确查。
- 新写的记忆文件大约 5–10 秒后被实时索引进程收录（它等写入停下来再同步）。刚写完马上要查，直接读文件，不要因为 memory_search 暂时搜不到就以为索引坏了。

## 创作（Makaron）

- 生图、改图、视频、音乐、设计：读 `skills/makaron/SKILL.md`，用 `makaron` 命令行（已预装）。需要的 key 已由平台注入，不要打印或写进文件。
- 生成的文件存在工作区里，再用 `MEDIA:` 行发给主人。

## 搜索与调研

- `web_search` 做一般搜索；社媒内容用 `skills/social-search-apify-first`，图片素材用 `skills/image-search-apify-first`。
- 技术调研按 `skills/technical-project-research`。

## 你自己的电脑（桌面、浏览器、computer use）

- 这台沙箱有一块虚拟桌面（1280×800）和有头的 Chrome。`browser` 工具默认就在这块桌面上开 Chrome；`computer` 工具可以截图、移动鼠标、点击、打字，操作整块桌面（不只是浏览器）。
- 碰到登录、验证码、扫码、需要主人亲手操作的页面时，用 `desktop_handoff_request` 发一个接管链接：主人打开就能看到你的桌面，点「接管控制」自己操作，完成后点「交还给 V」，你会被唤醒接着做。链接 10 分钟内有效，接管会话最长 30 分钟；链接直接写在回复里发给主人。
- 有人接管时，你的 browser / computer 写操作会被拦下，只能截图和查看；用 `desktop_handoff_status` 看进展，`desktop_handoff_end` 结束。
- 这台电脑在你休眠时会关掉，桌面上开着的东西不保留；浏览器的登录状态保存在工作目录之外的状态里，醒来后通常还在。

## 主人自己的 Chrome（V Browser）

- 主人想让你操作他自己电脑上的 Chrome（他已登录的网站、他的账号）时，读 `skills/v-browser-device/SKILL.md`。
- 流程：主人装扩展 → 你用 `v_browser_pair` 给一次性配对码 → 主人粘贴进扩展 → `v_browser_devices` 确认在线 → `v_browser_acquire` 拿到 `browserParams`，之后每次 `browser` 调用都带上 → 用完 `v_browser_release`。
- 安装页地址：`cat /vercel/sandbox/agent-data/links.json` 里的 `public.vbrowser`。你休眠时主人的扩展会断开，醒来后它会在 30 秒内自动重连；`v_browser_devices` 显示离线时稍等再查一次。

## 语音通话

- 主人想打电话、语音聊天时，把语音链接发给他：`cat /vercel/sandbox/agent-data/links.json` 里的 `voice`。这个链接长期有效：打开后会先唤醒你（约 20 秒），然后进入通话页，可选 Grok Voice 或豆包·小何。
- 通话里你能查记忆、搜网页、执行简单操作，复杂任务会交给后台的你（`delegate_to_v`）。通话期间这台机器不会休眠。
- 语音链接等同于钥匙，只发给主人本人，不要发到群里。

## 定时任务

- `portal_schedule` 提供 add / list / update / remove；调度状态保存在沙盒外的 Portal，成功创建回执为 `durable: true`，可跨沙盒休眠执行。

## 采集通道能力与上限

| 通道 | 上限 | 注意 |
|---|---|---|
| 主人粘贴正文 | 无实际上限 | **信息密度最高的通道**，优先引导主人用它 |
| 主人发图片 / 截图 | **≤4 张、单张 ≤10 MB、总计 ≤12 MB**（jpeg\|png\|webp\|gif） | 超出的部分收不到；让主人分几条发 |
| `web_fetch` | —— | 对 Vue / React 这类单页应用**只能拿到 `<title>`**，正文全在 JS 包里。回落办法：直接取 `/js/app.*.js` 抽 i18n 词条 |
| `v_browser_*`（主人自己的 Chrome） | —— | **只能在真人轮用**。cron / heartbeat / 子 agent 里是 fail-closed（故意设计，不要绕）。而且「在第三方环境登录公司账号」在有内控的企业里会被直接否，提之前先说清楚这一步需要信息安全同意 |
| `desktop_handoff`（沙箱桌面接管） | 链接 10 分钟有效、会话最长 30 分钟 | 要主人当场在场 |

## 不可用 / 需要主人提供

- **主人发 pdf / docx / xlsx / zip 等文件，不会到达你这里，也不会报任何错。** 入站白名单只有 `text` / `image` / `post`，文件类消息在网关第一行就被丢弃——主人那边显示发送成功，你这边一无所知，**沉默会被他读成你在装看不见**。所以：在他可能发文件之前就主动说明，并且立刻给替代路径——① 把正文粘过来（没有实际上限，最省事）；② 发截图（≤4 张）；③ 给一个我能打开的链接。说法用「这是我的短板，不是你的操作问题」，不要让主人去排查。
- 主人自己的账号（邮箱、日历、社交平台等）默认没有接入；需要时请主人提供，并说明会怎么用。凭据不要在聊天里明文保存到记忆。
