# Mirror V 吃可安装 V 的发行包（C 线第二步）

2026-11-27 CST 起草。**状态：`mirror-v-full.v22` 已进 `dev`（`d1413e43`），发布记录见文末。** 运行时取 A 的包 `2026.11.27-db91-lifecycle-proof.3`（`e584b69c`），工作区取 B 的 `59bf9d55`；A、B 两条线的 PR（vegekyd-sys/v-openclaw-platform#661、#660）还没合并，包按提交号固定。

沙盒版 Mirror V 和客户单独部署版用同一个发行包：A 线产运行时和安装器（`distro/`，契约 `distro/CONTRACT.md`），
B 线产工作区（`distro/workspace/`）。Mirror 这边只补「沙盒 / Portal」才有的部分。

## 来源

| 部分 | 来源 | Mirror 这边做什么 |
|---|---|---|
| 运行时字节（core / worker / codex / 记忆索引器 / 工具版本） | v-distro 包的 `runtime/` | `scripts/package-v-release.sh <platform> <v-distro.tgz> <out>`：按包清单逐文件核对后取用；codex 整包换算成对 npm 的覆盖层；V 主机专属的胶水按哈希换掉（`core-mirror.mjs`）；`@openclaw/ai` 覆盖层包里没有时用 `deploy/v-release/ai-<release>` |
| `openclaw.json` | 仍是 `runtime/v-config.mjs`（不读包里的生成器；两边是两份代码，改一边要同步另一边，靠下面的测试兜住） | `src/v-config-distro.test.ts` 逐路径比对包里 `config/openclaw-config.mjs` 的 sandbox profile：每一处不同都写明原因，多一处少一处都失败。打包时核对 vendored 的生成器和包里的逐字节相同 |
| 工作区（payload） | `distro/workspace/payload`（B 线） | `packages/agent-templates/mirror-v-full/distro/import-workspace.mjs`：渲染占位符 → 去掉 `sandbox-skip.txt` → 补 `sandbox-files/`（VSync 的 `scripts/mirror-vsync.py`）→ 打 `sandbox-patches/` → 写进 `payload/`，来源记在 `DISTRO_WORKSPACE.json` |
| 定时任务 | payload 的 `schedules.json`（9 条） | `gen-manifest.mjs` 经 `distro/schedules.mjs` 映射成 Portal 系统任务（cron / heartbeat，`enabled:false` 照样登记成关闭） |

直接从 V 同步的 `sync-from-v.sh` 一套在这个分支上退役：V → v-core → `distro/workspace`（B 的 `sync.mjs` 和审阅门）→ Mirror。

## 一次更新怎么做

运行时和工作区都从同一个 v-distro 包来（A 线 `distro/build/build.mjs`，只读 git 对象，几秒；包里的 `workspace/` 是 B 的 `payload/**`，占位符原样保留）：

```bash
git -C ~/v-openclaw-platform fetch origin
node <A 的 distro/build/build.mjs> --release <rel> --version <ver> --repo ~/v-openclaw-platform \
  --source origin/<A 的分支或 dev> --captured-ref origin/captured-store --workspace-ref origin/<B 的分支或 dev> --out <dir>
tar -xzf <dir>/v-distro-<ver>.tgz -C <tmp>
# 工作区（来源写进 DISTRO_WORKSPACE.json：包版本、A 的提交、B 的提交和 payload 树）
node packages/agent-templates/mirror-v-full/distro/import-workspace.mjs --dir <tmp>/v-distro-<ver>/workspace
git diff -- packages/agent-templates/mirror-v-full/payload      # 逐个审 B 的改动
node packages/agent-templates/mirror-v-full/gen-manifest.mjs mirror-v-full.v<N>
# 运行时
VBROWSER_REPO=~/v-browser scripts/package-v-release.sh ~/v-openclaw-platform <dir>/v-distro-<ver>.tgz <out-full.tgz>
```

也可以 `import-workspace.mjs --repo ~/v-openclaw-platform --ref origin/<B 的分支>` 直接从 B 的 git 取（结果相同，`.3` 包核对过）。

补丁打不上（`PATCH_DOES_NOT_APPLY`）说明 B 改了沙盒也改过的那几行：看 B 的改动，再在 `import` 出来的树上重做沙盒的改法，
`git diff` 重新生成补丁。不要放宽成「打不上就跳过」。

## 沙盒层改了 B 的什么

**不带**（`sandbox-skip.txt`）：飞书原生卡片（`feishu-channel-cards`，走被禁的 `message` 工具，Portal 每轮只渲染一张 markdown 卡片）、
`scripts/v-schedule.py`（往沙盒自己的 Gateway 登记 `openclaw cron`，会和 Portal 的系统任务重复）、长视频任务卡 skill。
写飞书的 9 个 skill 从 v22 起照 V 带上（Tianyi 2026-11-27：「要能写不能只是读」）。

**补回**（`sandbox-files/`）：`scripts/mirror-vsync.py`（VSync 中转客户端，B 的工作区没有）。

**补丁**（`sandbox-patches/01-portal-sandbox.patch`）：

- 运行环境说明：`TOOLS.md`、`onboarding/GUIDE.md`、`skills/memory-cold-start/{SKILL.md,references/feishu-lark-cli.md}`、
  `scripts/feishu-docs.py`、`onboarding/templates/data-sovereignty.md` 用沙盒的说法（休眠沙盒、Portal 通道、`MEDIA:` 附件、
  `portal_schedule`、扫码绑定的应用、数据在境外）。飞书读写口径和 B 一致（`feishu-docs.py` 的 `WRITE_SCOPES` 保留），
  `TOOLS.md` 加「飞书（读和写都和 V 一样）」和「飞书里收到的东西」（文件、语音转写、引用、合并转发、群里别的机器人 @）。
- `AGENTS.md`：留下 B 带来的 V 规则（主动推进、调工具前先说一句、搜索要过滤、推到最后一厘米再交人、高消耗先对齐、素材齐了再开工、
  跨会话协作的验收），把 Portal 的部分改回来（平台的上手提示、`portal_schedule`、记忆页链接、子 agent 本轮内等结果）；
  去掉 `ask_user`、飞书卡片、表情回应、`message` 发结果、异步 `sessions_send`。
- 名字：IDENTITY / SOUL / MEMORY / knight / 记忆页标题仍叫 Mirror V；REDLINES 只改「数据放在哪」的沙盒说法，凭据一条用 B 的（读写主人的文档、日程、任务、多维表；对别人做事先确认）。
- `skills/vsync`：「On Mirror V」用 VSync 会话的版本（经 Portal 中转收发），「谁能唤醒你」改成 Portal 会转发别的机器人 @ 你的消息。
- 小处：主动推进只发纯文本；TikTok 素材分批用 `MEDIA:` 行；V Browser 的链接文件路径；`onboard-collect.py` 的 openclaw 路径。

B 的去身份化（客户名、versa-ai 换成示例，不再出现主人名字）都保留了。

## 候选验收（合成租户 `mvfull-d22-01`，v21 快照里换上 v22-rc1 的 payload 重新种工作区，定时任务按候选清单手工登记）

| 场景 | 结果 |
|---|---|
| 扫码开场 | 20 秒，开场白 + 接不上飞书时的替代路径，同 v21 |
| 自述 → 更正 | 40 / 10 秒；初稿带 Portal 签名记忆页链接；按 B 的新规则建了项目 `TODO.md`（下周三的报价） |
| **主动推进**（新） | 61 秒一条消息：从 TODO 里挑了 5 天后的德国报价，查了欧盟森林法规对木制猫爬架的影响，问两件具体的事，给了报价单骨架 |
| Heartbeat 维护 | 26 秒，`NO_REPLY`（静默） |
| 21:00 Librarian | 43 秒，队列空、规则源基线、提交；lint 报 `TODO.md` 没从项目页链过去（rc1；B 已用 `_TEMPLATE` 修，rc2 带上了） |
| 导入补编 | 12 秒，`NO_REPLY` |
| 出图 | 64 秒，`MEDIA:` 送达（`media-ready`） |

没验到的：用真实快照（要先建快照）、Portal 按新清单自动登记（`ensureSystemSchedules` 读的是快照对应的清单）、飞书里的呈现、每日复盘（默认关）。

## Tianyi 的决定（2026-11-27）

1. 主动推进默认开（每 6 小时，`heartbeat-proactive`），`src/mirror-v-full-distro.test.ts` 固定。每日复盘按 B 的默认关。
2. 飞书可写，和 V 一样（见上）。新应用扫码时一次申请全套权限：`packages/central-gateway/src/services/feishu-scopes.ts`，
   来自 V - Makaron 应用的导出（应用身份 168 / 用户身份 255），去掉薪酬、人事、审批、邮箱、OKR、考勤、会议机器人、Spark、
   应用自管理和 V 的斜杠命令（应用 151 / 用户 208，再加 `feishu-docs.py` 要的 `bitable:app`、`sheets:spreadsheet`），事件按 V 订阅 7 个。
   飞书文档说确认页会忽略不认识的名字，不限数量；但全套链接约 2,500 字符，二维码放不下（版本 37），所以二维码改放 Portal 短链接
   `/onboard/feishu/go/<id>`，302 到同一个创建页（其他模板链接短，仍直接放）。**真机扫码还没验**（要 Tianyi）。老租户的权限不变。
3. 名字保持 Mirror V。
4. 语音转写和 V 一样走火山（BigASR 极速版，V 的 `openclaw-inbound-volcano-asr.sh` 同一接口），key 只在 Portal 私有配置 `volcengineAsr`。
5. Portal 不再丢别的机器人的消息：群里只处理 @ 本机器人（或 @所有人）的消息；别的机器人 @ 我们时交给 Agent 并标明不是主人；
   丢弃自己发的；同一群同一机器人每分钟最多 20 条（OpenClaw 的 bot 防循环默认值）。代码 `runtime-manager/src/feishu-senders.ts`。
6. 调度变化（Heartbeat 维护 8:00/20:00、导入补编 3/5/7 点）照 B；老租户按名字插入，不受影响。

## 给 A、B 的

- A：已在 `ed8f1093` / `e584b69c`（包 `2026.11.27-db91-lifecycle-proof.3`）修：workspace/ 只放 payload、sandbox profile 加了 `reload: off` 和禁 `message`、`@openclaw/ai` 覆盖层进包（`runtime/core-ai`，和 Mirror 仓库里那份逐字节相同，打包现在优先用包里的）。
- B：图谱库、项目 `TODO.md` 两处已在 `59bf9d55` 修。rc2 的沙盒补丁用三方合并带上了 B 在上手引导里加的 `_TEMPLATE` 那一行。
- A、B：B 的 `TOOLS.md` 说写飞书先读全局的 `lark-doc`、`lark-calendar`、`lark-task` 等 skill，和 `skills/lark-user-routing`。V 上这些在 `~/.agents/skills/lark-*`（larksuite 官方），A 的安装器和包里都没有，`lark-user-routing` 在 V 上也没找到。沙盒的 `TOOLS.md` 暂时改成 B 的 9 个写飞书 skill 加 `lark-cli <域> --help`；客户版要么由安装器装上这套 skill，要么 B 改掉这句。


## 发布记录

### 2026-11-27 23:03 CST · `mirror-v-full.v22`（运行时和工作区都来自 v-distro `.3`）

| 项 | 内容 |
|---|---|
| 源码 | `dev` `d1413e43`（#22 `71e7e8dd`、VSync `6168eb0a` / `439acc0c`、#21 一并带上；CI 绿） |
| release | `d1413e434522`（完整控制面发布：Gateway 与 Manager 都有代码改动，manager 重启过） |
| 运行时 | `/opt/nexus/data/v-release/db91-lifecycle-proof-20261127-distro3-full.tgz`（sha256 `c9b65872…`；由 v-distro `2026.11.27-db91-lifecycle-proof.3` / A `e584b69c` 经 `package-v-release.sh` 打出，`features.json` 记包版本） |
| payload | `mirror-v-full.v22`，151 个文件、9 条系统定时任务；B `59bf9d55`，payload 树 `c70b7eef…` |
| 快照 | `snap_4IxJNIRuQlhlMOhwgdPYpaqpq5hx`（构建一次成功，`v-release-installed` 修改 188 / 新增 45，`@openclaw/ai` 4 个，`NEXUS_RUNTIME_READY`） |
| 私有配置 | 新增 `volcengineAsr`（和 V 同一把火山 key，只在 `/opt/nexus/data/config.json`）；VSync 会话加的 `vsync` 段随重启生效 |
| 上线核对 | 公开目录 `?template=mirror-v-full` 返回 `mirror-v-full.v22`；activate 的头像门禁四个模板通过、健康检查通过；`/onboard/feishu/go/<未知 id>` 返回 410 |
| 回滚 | `scripts/deploy-mirror-v.sh activate e19672bba63d`（v21 的 release，`/opt/nexus/previous`），再把 `templates["mirror-v-full"]` 恢复成 `config.json.before-mirror-v-full-2026-11-27T15-03-14-728Z`（v21 / `snap_6xmL…`）并重启 manager；`volcengineAsr`、`vsync` 两段留着无害。v22 开的租户回滚后仍用 v22 快照 |

**合成租户验收（`mvfull-v22-01`，v22 快照开号，没有飞书 app）**

| 场景 | 结果 |
|---|---|
| 开场 | 30 秒，叫 Mirror V，接不上飞书时给替代路径 |
| 系统定时任务 | 第一轮对话后 Portal 按快照清单自动登记 9 条：主动推进每 6 小时开、每日复盘关，其余开（rc 时没验到的这一项通过） |
| 自述 | 32 秒，写进档案，把下周三的报价排成待办并问三件具体的事 |
| 主动推进 | 33 秒，`NO_REPLY`：23:06 在静默时段，先把报价工作表整理进项目页，留到 08:30 后再说（rc 白天试跑 61 秒发出过一条） |
| 出图 | 54 秒，`media-ready` |
| Heartbeat 维护 / Librarian | 39 秒静默 / 45 秒，队列空 |
| 工作区 | 写飞书的 skill 在、无 `feishu-channel-cards`、无 `v-schedule.py`；REDLINES / TOOLS 是可写口径；Gateway 环境里有 `NEXUS_VSYNC_*`，`lark-cli` 在 PATH |

之后 VSync 会话在 23:30 发了 `v22.1`（release `064d04b4b792`、快照 `snap_FnjIdvPl…`，只修 `mirror-vsync.py --help` 误发，记录见 `docs/mirror-v-vsync-broker.md`），回滚基准就是上面的 v22。

定时任务验收完已全部关闭。

**老租户（只读看，没发消息）**：0.3（`f0c772ef…`）、0.4（`99591967…`）在 23:03 manager 重启后重连了飞书长连接；00:00 午夜报告是 v22 之后第一次唤醒，两边都完整走完 waking → ready → 生成 → `feishu-delivered` → state-saved → sleeping，没有错误事件。

没验到的（要真人）：真机扫码（新权限清单、短链接跳转、飞书确认页）、真实飞书里的文件 / 语音 / 引用 / 合并转发、群里和 V 互相 @、写文档日程任务多维表。
