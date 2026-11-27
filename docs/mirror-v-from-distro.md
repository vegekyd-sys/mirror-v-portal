# Mirror V 吃可安装 V 的发行包（C 线第二步）

2026-11-27 CST 起草。**状态：候选（`mirror-v-full.v22-rc2`，B 的工作区 `59bf9d55`），在分支 `claude/sandbox-latest-v-44e8eb`，没进 `dev`、没上线。**
上线前要协调会话确认，并等 A、B 两条线的 PR（vegekyd-sys/v-openclaw-platform#661、#660）合并。

沙盒版 Mirror V 和客户单独部署版用同一个发行包：A 线产运行时和安装器（`distro/`，契约 `distro/CONTRACT.md`），
B 线产工作区（`distro/workspace/`）。Mirror 这边只补「沙盒 / Portal」才有的部分。

## 来源

| 部分 | 来源 | Mirror 这边做什么 |
|---|---|---|
| 运行时字节（core / worker / codex / 记忆索引器 / 工具版本） | v-distro 包的 `runtime/` | `scripts/package-v-release.sh <platform> <v-distro.tgz> <out>`：按包清单逐文件核对后取用；codex 整包换算成对 npm 的覆盖层；V 主机专属的胶水按哈希换掉（`core-mirror.mjs`）；`@openclaw/ai` 覆盖层包里没有时用 `deploy/v-release/ai-<release>` |
| `openclaw.json` | 仍是 `runtime/v-config.mjs` | `src/v-config-distro.test.ts` 逐路径比对包里 `config/openclaw-config.mjs` 的 sandbox profile：每一处不同都写明原因，多一处少一处都失败。打包时核对 vendored 的生成器和包里的逐字节相同 |
| 工作区（payload） | `distro/workspace/payload`（B 线） | `packages/agent-templates/mirror-v-full/distro/import-workspace.mjs`：渲染占位符 → 去掉 `sandbox-skip.txt` → 补 `sandbox-files/`（现在为空）→ 打 `sandbox-patches/` → 写进 `payload/`，来源记在 `DISTRO_WORKSPACE.json` |
| 定时任务 | payload 的 `schedules.json`（9 条） | `gen-manifest.mjs` 经 `distro/schedules.mjs` 映射成 Portal 系统任务（cron / heartbeat，`enabled:false` 照样登记成关闭） |

直接从 V 同步的 `sync-from-v.sh` 一套在这个分支上退役：V → v-core → `distro/workspace`（B 的 `sync.mjs` 和审阅门）→ Mirror。

## 一次更新怎么做

```bash
git -C ~/v-openclaw-platform fetch origin
# 工作区
node packages/agent-templates/mirror-v-full/distro/import-workspace.mjs --repo ~/v-openclaw-platform --ref origin/<B 的分支或 dev> --dry-run
node packages/agent-templates/mirror-v-full/distro/import-workspace.mjs --repo ~/v-openclaw-platform --ref origin/<…>
git diff -- packages/agent-templates/mirror-v-full/payload      # 逐个审 B 的改动
node packages/agent-templates/mirror-v-full/gen-manifest.mjs mirror-v-full.v<N>
# 运行时：在平台仓库用 A 的 build.mjs 出包（只读 git 对象，几秒），再打 Mirror 的运行时包
VBROWSER_REPO=~/v-browser scripts/package-v-release.sh ~/v-openclaw-platform <v-distro.tgz> <out-full.tgz>
```

补丁打不上（`PATCH_DOES_NOT_APPLY`）说明 B 改了沙盒也改过的那几行：看 B 的改动，再在 `import` 出来的树上重做沙盒的改法，
`git diff` 重新生成补丁。不要放宽成「打不上就跳过」。

## 沙盒层改了 B 的什么

**不带**（`sandbox-skip.txt`）：替主人写飞书的 skill（多维表、表格、文档、权限、发图）、飞书原生卡片、`v-schedule.py`、
长视频任务卡 skill。

**补回**：现在不需要。rc1 补过记忆图谱库；B 在 `59bf9d55` 把它纳入了 git（平台仓库根 `.gitignore` 忽略 `artifacts/` 导致的），字节相同。

**补丁**（`sandbox-patches/01-portal-sandbox.patch`）：

- 运行环境说明：`TOOLS.md`、`onboarding/GUIDE.md`、`skills/memory-cold-start/{SKILL.md,references/feishu-lark-cli.md}`、
  `scripts/feishu-docs.py`、`onboarding/templates/data-sovereignty.md` 用 Mirror 的沙盒版本（休眠沙盒、Portal 通道、`MEDIA:` 附件、
  `portal_schedule`、飞书只读、扫码绑定的应用、数据在境外）。
- `AGENTS.md`：留下 B 带来的 V 规则（主动推进、调工具前先说一句、搜索要过滤、推到最后一厘米再交人、高消耗先对齐、素材齐了再开工、
  跨会话协作的验收），把 Portal 的部分改回来（平台的上手提示、`portal_schedule`、记忆页链接、子 agent 本轮内等结果）；
  去掉 `ask_user`、飞书卡片、表情回应、`message` 发结果、异步 `sessions_send`。
- 名字：IDENTITY / SOUL / MEMORY / knight / 记忆页标题仍叫 Mirror V；REDLINES 回到「只读主人的文档」和沙盒说法。
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

## 上线前要定的

1. **主动推进默认开**（每 6 小时，结果发给主人）。之前差距盘点里这是「待定」：B 按 V 的行为默认开。要关就在 `distro/schedules.mjs` 映射时加 `enabled:false`。
2. **飞书仍只读**：B 给客户版加了写权限（文档、日程、任务、多维表……）和十个写飞书的 skill，沙盒都没带。要放开需要 Portal 扫码建应用时申请写权限、老租户补权限。
3. **名字**：沙盒继续叫 Mirror V（B 改成了 V）。
4. **调度变化**：「Heartbeat 反思 8:30/20:30」→「Heartbeat 维护 8:00/20:00」，导入补编从「3 点起循环到 8 点」变成「3/5/7 点各一轮」，名字变了，老租户不受影响（按名字插入）。

## 给 A、B 的

- A：包的 `workspace/` 打进了 B 的整个 `distro/workspace/`（含 tests），触发自己的密钥扫描；B 的说法是只放 `payload/**`。
- A：sandbox profile 缺 `gateway.reload.mode: off`（V 2026-09-20 热重载把 Worker 池关死）、缺禁用 `message`；V 的 4 个 `@openclaw/ai` 改动文件不在 captured-store。
- B：图谱库、项目 `TODO.md` 两处已在 `59bf9d55` 修。rc2 的沙盒补丁用三方合并带上了 B 在上手引导里加的 `_TEMPLATE` 那一行。
