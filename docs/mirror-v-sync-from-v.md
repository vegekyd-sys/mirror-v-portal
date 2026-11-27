# V → Mirror V 同步（mirror-v-full）

V 一直在进化（Librarian、heartbeat、skills），Mirror V 的 `mirror-v-full` 模板把其中通用的部分带给每个新租户。这份文档是**每次同步都照着走一遍**的 runbook，以及每次同步的记录。

范围（2026-11-26 与 Tianyi 约定）：

- **单向、人工发起**：Tianyi 说「同步」才跑。不定时、不反向（Mirror 的改动不回推 V）、不自动推给已开号的老租户。
- **只读 V 的 git HEAD**：`ssh v`，工作区 `/home/openclaw/makaron-openclaw/.openclaw-local/workspace`。V 没提交的改动不算。
- **Mirror 自己的东西不被 V 覆盖**：身份文档、BOOTSTRAP / onboarding、记忆骨架、`feishu-docs.py`、`onboard-*.py`、`memory-cold-start`、`librarian-ask.py` 等从不参与同步；V 拥有、但 Mirror 改过的文件（`memory-graph.*`、`librarian-daily-queue.py`、`wiki-maintenance.py`、`memory/SCHEMA.md`…）走三方合并，Mirror 的改动保留。

## 机制

| 文件 | 作用 |
|---|---|
| `packages/agent-templates/mirror-v-full/sync-from-v.sh` | 三方合并：base = `V_WORKSPACE_COMMIT` 记录的 V 提交，theirs = V 的 HEAD，ours = payload。base 和 theirs 先做同样的脱敏（沙盒路径、agent id、主人名、V 的飞书文档链接） |
| `v-sync-paths.txt` | **同步清单**：哪些 V 路径进 payload。加一行就是一个产品决定 |
| `v-sync-skip.txt` | **不带清单**：V 改了但 Mirror 不要的 skill / 脚本 / 单个文件，每条带原因 |
| `V_WORKSPACE_COMMIT` | 上一次同步到的 V 提交（下一次的 base） |
| `.v-sync-pending` | 合并有冲突时留下（不进 git），冲突解决完 `--resolved` 才把 V 的提交记进 `V_WORKSPACE_COMMIT` |
| `gen-manifest.mjs` | 生成 `payload/payload-manifest.json`（版本号、文件清单、`vWorkspaceCommit`、系统定时任务）。同步没收尾或文件里还有冲突标记时直接报错 |
| `system-schedules.json` | 7 个系统定时任务的提示词，**只影响新租户**（`ensureSystemSchedules` 按名字插入，不改已有的） |

**审阅门**：V 自上次同步以来改过的每个 `skills/<名字>`、`scripts/<条目>`，必须出现在同步清单或不带清单里，否则脚本列出 `UNREVIEWED`。V 新长出来的 skill 不会被悄悄带上，也不会被悄悄漏掉。

## 步骤（一次同步）

前提：在一个基于最新 GitHub `dev` 的 worktree 里（`git fetch github dev && git checkout -B <分支> github/dev`）。别的会话也可能在改 `payload/scripts/`，提交前再 rebase 一次。

```bash
cd packages/agent-templates/mirror-v-full
bash sync-from-v.sh --dry-run          # 约 2 分钟（V 仓库大）；看 added / updated / merged / CONFLICTS / UNREVIEWED
```

1. **UNREVIEWED**：逐个看 V 的那个 skill / 脚本（`ssh v` 读 `git show HEAD:skills/<名字>/SKILL.md`）。通用、不依赖 V 私有东西（主人姓名和个人事务、V 的主机和账号、客户项目、V 的公开站点）的加进 `v-sync-paths.txt`；否则写进 `v-sync-skip.txt` 并写原因。依赖可脱敏的，同步后在 payload 里改（之后的三方合并会保留这个改动）。
2. 正式合并：`bash sync-from-v.sh`。有冲突时逐个解决（**不要整文件覆盖**：保留 Mirror 的改动，只取 V 的通用改进），然后 `bash sync-from-v.sh --resolved`。
3. **逐个审 V 的 diff**（`git diff -- payload/`），即使是「updated (Mirror unchanged)」也要看：
   - 新依赖的脚本 / 文件在 payload 里存在吗？（例：v19 里 V 让两个 Librarian 脚本去调 V 私有的 `retired-footage-rule.py`，原样带过来新租户每晚 Librarian 第一步就崩）
   - 有没有把 V 专属的输出带进来？（例：v19 的记忆页模板带进了 V 的 Universal Memory、wiki.tianyi.live 证书、「Living V 手册」三块）
   - 脚本末尾的私有内容检查有输出就必须处理。
4. 测试：
   ```bash
   (cd payload && for t in scripts/tests/test_*.py; do /usr/bin/python3 -m unittest "$t" || exit 1; done)
   ```
   改到记忆页时，把 payload 拷到临时目录 `git init`，写几份 `memory/librarian/runs/<日期>.json`，跑 `python3 scripts/memory-graph.py`，用 `python3 -m http.server` 打开 `artifacts/memory-graph/index.html` 看：第一天视图、按天切换（含懒加载的旧日期）、图谱。
5. 版本号：`node gen-manifest.mjs mirror-v-full.v<N>`（主版本号 +1；同一次同步的后续修补用 `v<N>.1`）。
6. 提交，推 GitHub：`git push github HEAD:dev`（同时推自己的分支；不要推旧 GitLab `origin`），等 CI（`.github/workflows/dev-ci.yml`）绿。
7. 部署（payload-only 的提交会复用当前 release 的构建，约 1 分钟）：
   ```bash
   scripts/deploy-mirror-v.sh stage <sha>
   ```
   在 staged release 里构建快照（**快照失败就停，不 activate**）：
   ```bash
   ssh ... root@43.134.135.143 "export PATH=/root/.nvm/versions/node/v22.22.1/bin:\$PATH; cd /opt/nexus/releases/<sha12>/packages/runtime-manager && NEXUS_CONFIG_PATH=/opt/nexus/data/config.json ./node_modules/.bin/tsx scripts/build-snapshot.ts --template mirror-v-full --v-release /opt/nexus/data/v-release/v2026.9.1-db91.6-firsttext-r4-20261007-full.tgz --seed-archive /opt/nexus/data/mirror-v-v001-payload-v2.tar"
   ```
   然后 `scripts/deploy-mirror-v.sh activate <sha12>`（会等没有进行中的回合，并跑头像门禁和健康检查，失败自动回滚）。
   V 的运行时（openclaw release tgz）升级是另一层风险，**先和 Tianyi 确认**再动。
8. 核对：`https://mirror-v-portal.vercel.app/onboard/templates?template=mirror-v-full` 的版本号、`config.json` 里 `templates["mirror-v-full"]` 的 `version` / `snapshotId`、`/healthz`。
9. 验收（下一节），把记录追加到本文末尾，提交。

## 验收清单

用合成租户（不设 `app_id`，不开飞书长连接），工具 `/opt/nexus/data/onb-accept.mjs`：

```bash
ssh -i ~/.ssh/nexus-mirror-v-deploy-20260925 -o IdentitiesOnly=yes -o BatchMode=yes root@43.134.135.143 \
  "export PATH=/root/.nvm/versions/node/v22.22.1/bin:\$PATH; NEXUS_CONFIG_PATH=/opt/nexus/data/config.json node /opt/nexus/data/onb-accept.mjs <create|say|runs|schedules|exec|fire> ..."
```

**不要在真实租户上做验收，也不要给它们发消息**（例如 Tianyi 的测试号 0.3 `f0c772ef…`、0.4 `99591967…`）。

1. 新租户是新版本：`create` 输出的 `template` 等于新 payload 版本，`snapshot` 等于新快照。
2. 扫码开场：一条消息里有开场白 + 授权链接。
3. 7 个系统定时任务都在（`schedules`）。
4. 这次同步进来的能力各跑一遍。默认模型和 V 一致：`exec <id> "python3 -c 'import json;print(json.load(open(\"/vercel/sandbox/agent-data/openclaw.json\"))[\"agents\"][\"defaults\"][\"model\"])'"` 与 V 的 `~/.openclaw/openclaw.json` 同为 `deepseek/vds-deepseek-flash`（Codex harness）。
5. heartbeat 和 21:00 Librarian 各手动触发一次（`fire`），能跑完并提交（`exec <id> "cd /vercel/sandbox/agent-data/workspace && git log --oneline -5"`）。
6. 记忆页：Librarian 之后能生成，第一天就有内容；从 Portal 的签名链接打开（`/onboard/memory/<租户>/<签名>/index.html`），图谱和旧日期能加载。
7. 没有 V 的私有内容：在新租户的工作区 grep 主人名字、V 的路径、V 的飞书 id 与文档链接（同 `sync-from-v.sh` 末尾的规则）。
8. 合成租户验收完删除或停用，别占沙盒。

## 回滚

- 控制面：`/opt/nexus/previous` 指向上一个 release，`scripts/deploy-mirror-v.sh activate <上一个 release 的 sha12>`。
- payload / 快照：`config.json` 每次构建前会备份为 `config.json.before-mirror-v-full-*`，里面有上一版的 `snapshotId` 和 `version`；把 `templates["mirror-v-full"]` 恢复成它并重启 `nexus-runtime-manager`，新租户就回到上一版快照（快照 30 天过期，过期就得用上一版提交重新构建）。已开号的租户不受影响。
- V 同步本身：`git revert` 那次同步的提交，`V_WORKSPACE_COMMIT` 随之回到上一次的值。

## 老租户（下一步，现在不做）

已开号的租户停在开号时的 payload 和定时任务提示词，发布新版不会改变它们：

- 新脚本 / skill：现在靠**手工上传补丁**（`onb-accept.mjs exec` 或沙盒写文件），先读租户当前文件再三方合并——租户自己的 agent 改过平台脚本（11-12 核对：两台改过 `heartbeat.py`，一台改过 AGENTS/TOOLS/REDLINES），直接替换会抹掉它们的改动。
- 定时任务提示词：`ensureSystemSchedules` 只按名字插入，改过的提示词要手工更新 `elastic_schedules.prompt`（先比对是否被租户改过）。
- 要做成机制，需要「Mirror V 平台 → 老租户」的分发：按租户的 payload 版本算 diff、在租户工作区做三方合并、冲突交给租户自己的 agent 或人工、失败回滚到每轮的备份。等 Tianyi 说开始再做。

---

## 同步记录

### 2026-11-26 · payload `mirror-v-full.v19`

| 项 | 值 |
|---|---|
| V 提交 | `5ccf8618`（10-28，v15 实际同步到的点）→ `185eb6e6`（11-25 21:21），298 个提交 |
| payload | `mirror-v-full.v18.4` → `mirror-v-full.v19` |
| 源码提交 / release | `335647ea`（v19）→ `d818860b`（v19.1，只改 payload 的 `.gitignore`） |
| 快照 | v19 `snap_J7FtrtZlntprhlsH5vReedG3PHJU` → v19.1 `snap_Sq4PpGFEO8TrRQvbFwkAGF9cTOSa`（30 天后 2026-12-26 过期） |
| 回滚依据 | 到 v19：release `335647ea4775`、快照 `snap_J7Ftrt…`（`config.json.before-mirror-v-full-2026-11-26T09-08-49-797Z`）；到 v18.4：release `ec85f78e0f1d`、快照 `snap_gH0qcjALgiGUoG4GaL4CIsag57bu`（`config.json.before-mirror-v-full-2026-11-25T17-47-48-109Z`） |

**修了同步机制本身**

- v15（10-28）同步时实际取的是 V 的 `5ccf8618`，但有冲突时脚本退出，手工解决后没有回写 `V_WORKSPACE_COMMIT`，它一直停在 `67d00d25`。以旧 base 去合并会把已经同步过的改动当成冲突（dry-run 报 6 个冲突，正确 base 下只有 1 个）。现在冲突时留 `.v-sync-pending`，`--resolved` 才记录；`gen-manifest.mjs` 在同步没收尾或有冲突标记时拒绝生成；加了 `--base` 用于修正记录。
- skill / 脚本清单从脚本里的数组改成可审阅的 `v-sync-paths.txt` / `v-sync-skip.txt`，加审阅门（UNREVIEWED）；不带清单也能排除同步目录里的单个文件。
- 脱敏加了 V 内部飞书文档链接；私有内容检查加了主人名、wiki.tianyi.live、agentmail、versa-ai、飞书文档链接。
- 对 V 的 ssh 复用一条连接。

**带过来的（V 的通用改进）**

- `heartbeat-dispatch.py`：汇报可以由执行任务的 agent 自己写一段给主人的话（`--user-message-file`，可决定不打扰），同一结果不重复发；发送加锁。没有这份文件时行为不变。
- 记忆页 `memory-graph.py` / 模板：`index.html` 只内联统计和最近两天，图谱数据（`graph.json`）、图谱库（`graph-lib.js`）和更早的日期（`days/<日期>.json`）打开时再取——V 11-18 因为国内宽带打开慢做的改动，Mirror 的主人同样在国内。Portal 记忆页路由早已允许这些文件。Mirror 的「第一天视图」改成先取 `graph.json` 再列页面。
- `librarian-move-check.py`：每日日志里写回已登记的过期说法也会被拦（之前日志路径豁免）。
- skills：`makaron`（官方 CLI 1.28.16：Kling 4、GPT Image 2.6、音乐时长、V 写 brief 不越俎代庖的边界）、`social-search-apify-first`（拆成 runtime / 平台工作流两份参考）、`image-search-apify-first`、`technical-project-research`（GitHub 仓库取证、业务 API 试用、经由别的平台接入服务商）、`tiktok-publish-copy`（agent 按视频内容生成文案、账号级去重）。

**没带的及原因**

- `librarian-adopt-untracked.py` / `librarian-daily-queue.py` 对 `scripts/retired-footage-rule.py` 的调用：那是 V 的客户素材下架规则，Mirror 没有这个文件，带过来每晚 Librarian 收编和编译第一步就会崩。保留 Mirror 原版本。
- 记忆页模板里的 Universal Memory 维修回执、wiki.tianyi.live 发布证书回执、「Living V 手册」维护段：都是 V 自己的服务，后者写死了 V 的飞书文档链接，并对 10-28 之后的每一天显示「未记录，待核」。
- `tiktok-publish-copy/references/cases.md`：客户（圣山染整）真实发布的文案与 TikTok 账号；SKILL.md 在案例库为空时照常工作。
- `makaron/SKILL.md` 里指向 `xingqing-ad-social-v2` 夜班工作流的一行（客户工作流，引用的参考文件也不在 payload）。
- `social-search-apify-first` 参考里的客户人名 / 视频号账号例子换成占位，V 的飞书报告链接脱敏。
- V 这段时间新增或改动的其它 skill / 脚本：客户项目（星擎、米奥、奥创、dealclaw、geelark、fcloud…）、主人个人事务（`computer-use` 含收货地址与付款规则、外卖、打车、家里设备）、V 自身运维（`v-self-update`、发布 wiki、Universal Memory）、依赖 V 运行时补丁或账号的（`feishu-channel-cards`、`browser-fast-run`、`scene-cli`、`video-review-analysis`）。逐条原因在 `v-sync-skip.txt`。`feishu-channel-cards` 的「回复本身是卡片」对 Mirror 有价值，但依赖 V 运行时的回复卡片补丁，需要先确认 Mirror 的运行时是否支持，另行评估。

**已知、本次没修的缺口**（同步前就存在）

- `social-search-apify-first` 依赖 `scripts/apify-search.mjs` / `apify-client.mjs`：在 V 上没进 git，payload 里没有，Mirror 也没有 Apify 凭据——这个 skill 在 Mirror 上跑不起来。
- `makaron/SKILL.md` 要求飞书里先读 `parts/feishu/SKILL.md` 并用 `visible-parent-flow.cjs`，这两样是 V 私有的、payload 里没有；Mirror 上实际走官方 CLI 部分。
- 记忆页分类标签里有 V 的 `versa-business`（只是一个分类名）。

**验收（2026-11-26，合成租户 `mvfull-sync19-01`，v19 快照，不设 `app_id`）**

| 项 | 结果 |
|---|---|
| 上线核对 | release `335647ea4775`，`config.json` 里 `mirror-v-full` = `v19` / `snap_J7Ftrt…`，公开目录 `?template=mirror-v-full` 返回 `mirror-v-full.v19`，`/healthz` 200，activate 的头像门禁通过 |
| 新租户版本 | `create` → `mirror-v-full.v19`、`snap_J7Ftrt…` |
| 扫码开场 | 平台开场提示（`GREETING_PROMPT`）→ 52 秒一条消息（冷启动，首字 46 秒）：开场白 + 说明接不上飞书、改要官网。没有授权链接是因为合成租户第一轮前没有沙盒、绑不了应用；随后 `bindapp`（只把 0.3 的应用配置读进合成沙盒，不碰 0.3 本身、不开长连接）后 `feishu-docs.py connect` 能生成设备码授权链接。这一段本次同步没改 |
| 主人自述 → 初稿 | 写了 USER.md 和项目页，`memory: 上手初稿（主人自述）` 提交，回复里给了记忆页链接 |
| 7 个系统定时任务 | 都在（Librarian 21:00、质检 22:00、Heartbeat 8:30/20:30、午夜报告、Skill 周复盘、飞书同步 20:30、导入补编 03:00）。注意：系统任务只在**带飞书会话**的轮次后注册，`say` 默认会话不会触发，要用 `say <id> '=<id>:oc_<任意>' …` |
| Heartbeat（手动触发） | 23 秒，`HEARTBEAT_OK`；`heartbeat.py` 跑了（写了 `heartbeat-dispatch.json`、`heartbeat-analyzer-candidates.json`） |
| 21:00 Librarian（手动触发两次） | 第一次 48 秒：队列空，做 lint + 滚动复核 + 规则源建基线（53 个来源），提交 `chore(librarian): … lint + 滚动复核`。把 `since` 拨回一天后第二次：读到当天日志那一段，判断事实已在初稿里、标 skipped 并提交（走 `librarian-corrections.py commit`） |
| 记忆页（Portal 签名链接） | 第一天视图有内容（从 `graph.json` 取页面）；Librarian 后按天显示运行记录；图谱：`graph.json`、`graph-lib.js` 经签名路由 200，canvas 出图；没有 V 专属的 UM / 证书 / Living 手册段 |
| heartbeat-dispatch 新路径 | Mirror 默认关闭汇报（`knight.config.json`），行为不变；打开配置（dry-run）验证：agent 写的话原样作为汇报、`should_notify:false` 不发、要求 agent 写而没写时不发机械兜底 |
| technical-project-research | 问 force-graph 维护情况：26 秒，GitHub API 取星数、最近提交、issue 状态与作者活动，每条带出处 |
| tiktok-publish-copy | 葡语文案：按画面写、标签 5 个单独一行并注明自生成、不编造认证产能、提醒同账号去重 |
| makaron | 沙盒里 `npx makaron-cli --version` = 0.17.30（新于 skill 文档的 0.17.16）。没有实际生成（花额度），未验 |
| 私有内容 | 租户工作区 grep 主人名、V 路径、V 的飞书 id 与文档链接、客户名：命中的只有 Mirror 自己的身份声明（「不是 Tianyi 的 V」）、飞书 URL 模板、memory-cold-start 里以前就有的 versa-ai 采集示例；没有来自这次同步的 |

**验收中发现的问题**

- 本次同步引起、已修（v19.1）：记忆页拆成多个文件后，`.gitignore` 只忽略了 `index.html`，其余在租户工作区是未跟踪文件，随手全量提交会进 git 历史和备份。改为忽略整个 `artifacts/memory-graph/`（保留 `vendor/`）。备份不看 `.gitignore`，记忆页照样能提供。
- 以前就有，**已在 v19.2 修复**（见文末）：沙盒时区是 UTC，Agent 在上海 0–8 点写的日志文件名是前一天（例：上海 11-26 01:51 写成 `memory/2026-11-25.md`），而 daily 队列的 `since` 按上海日期，凌晨开号的租户第一天日志永远进不了编译队列（这次因为初稿已写了同样的事实，没丢东西）。
- 以前就有：Librarian 处理了队列段（标 skipped）时仍回复「今晚没有需要整理的新记忆」，汇报措辞不准。
- 以前就有：运行记录里的时间是 agent 写的 UTC 字符串（`…T08:47:00Z`），页头时间已是上海时间。

**没验到的**

- 真实飞书里的呈现（开场一条消息、卡片、二维码图片）：合成租户不经飞书。
- 真人扫码授权后读文档、写初稿的全流程：这段没改，沿用 v16–v18.4 的验收。
- Makaron 实际出图 / 出视频、social-search（Mirror 没有 Apify 脚本和凭据，见上）。
- 22:00 质检、午夜报告、Skill 周复盘、20:30 飞书同步、03:00 导入补编：本次同步没改它们的提示词和脚本，未单独触发。
- 老租户：不随发布升级（见「老租户」一节），本次没有动任何真实租户。

**v19.1 复验（合成租户 `mvfull-sync19-02`）**

- 上线核对：release `d818860b2cad`，`config.json` = `v19.1` / `snap_Sq4PpGFE…`，公开目录返回 `mirror-v-full.v19.1`，`/healthz` 200，头像门禁通过。
- v19.1 快照第一次构建在 `v-release-converge`（构建沙盒里启动运行时、装插件）失败，按规矩没有 activate，线上保持 v19；原样重跑一次成功。与本次改动无关，看起来是偶发，下次再遇到先重跑。
- 新租户 `v19.1`；开场一条消息（这次冷启动首字 128 秒，上一个租户 46 秒）；7 个定时任务；跑 `memory-graph.py` 后 `artifacts/memory-graph/` 不再出现在 `git status`，`vendor/force-graph.min.js` 仍被跟踪。
- 两个合成租户的定时任务已全部关掉（`enabled=false`），租户保留在休眠状态，与之前的 `mvfull-accept-*`、`mvfull-onb-*` 一致。
- 验收工具 `/opt/nexus/data/onb-accept.mjs` 新增 `fire <id> <任务名片段>`（只对没有 `app_id` 的合成租户），`say` 的会话名以 `=` 开头时按原样使用（`=<id>:oc_<任意>` 是带飞书会话的轮次，才会注册系统定时任务）。改前备份在 `onb-accept.mjs.bak-20261126`。注意远端 shell 是 zsh，`=` 开头的参数要加引号。

### 2026-11-27 · payload `mirror-v-full.v19.2`（时区）

| 项 | 值 |
|---|---|
| 源码提交 / release | `79de4083` / `79de40833f21`（CI 通过） |
| 快照 | `snap_pB5cmOJyD9wCUSabUgTPsqgcwBav`（2026-12-26 过期）；回滚到 v19.1：release `d818860b2cad`、快照 `snap_Sq4PpGFE…`（`config.json.before-mirror-v-full-2026-11-26T16-09-17-015Z`） |

- 原因：沙盒系统时区 UTC，Agent 按本地日期给 `memory/YYYY-MM-DD.md` 命名，夜间队列按上海日期算 `since`。上海 0–8 点开号时第一份日志落在 UTC 前一天，永远进不了编译队列。
- `runtime/boot.mjs`：V 运行时的 Gateway 默认 `TZ=Asia/Shanghai`（模板 `runtimeEnv` 可覆盖）。属于控制面，老租户下次启动也生效；切换当天日志按上海日期继续，不跳日。
- `librarian-daily-queue.py`：没有日志时 `since` 取上海与 UTC 日期中较早的一天，兜底。
- 验收（合成租户 `mvfull-tz-01`，上海 11-27 00:09 开号，此时 UTC 仍是 11-26）：新租户 `v19.2` / `snap_pB5c…`；Gateway 进程 `TZ=Asia/Shanghai`；Agent 的 `date` 返回上海时间；日志写成 `memory/2026-11-27.md`，队列 `since` 同为 `2026-11-27`。之后定时任务已关闭。0.3、0.4 都是白天开号，第一天日志没有漏（只读核对）。

### 2026-11-27 · 分场景验收与 V 对照，payload `mirror-v-full.v19.3`

| 项 | 值 |
|---|---|
| 源码提交 / release | `d05c7396` / `d05c7396dece`（CI 通过） |
| 快照 | `snap_RZBNbLcuFSkY0hiOR4WqVUCAEX60`（2026-12-27 过期）；回滚到 v19.2：release `79de40833f21`、快照 `snap_pB5c…`（`config.json.before-mirror-v-full-2026-11-26T18-30-59-097Z`） |
| 合成租户 | `mvfull-scn-01`（新用户，v19.2）、`mvfull-tz-01`（已有身份「阿青 / 杭州茶叶电商」），验完定时任务已关 |

对照 V 只读 V 的配置和真实记录（`/home/openclaw/makaron-openclaw/.openclaw-local/openclaw.json`、`~/.openclaw/agents/makaron` 的转录），不给 V 发测试消息。

| 场景 | Mirror 表现 | 与 V 对照 | 结论 |
|---|---|---|---|
| 扫码开场 | 首字 26 秒、一条消息 | — | 通过（v19.1 那次 128 秒是冷启动个例） |
| 自述 → 更正 → 追问 | 22 秒写进 USER.md；更正后旧值划线带日期；追问答「只做独立站、12 人」 | 同 V 的划线纠正规则 | 通过 |
| Heartbeat | 19 秒 `HEARTBEAT_OK`，不发给主人 | V 开着 `dispatch_report`，发到主人群；Mirror 默认关 | 差异，待 Tianyi 定 |
| 21:00 Librarian | 40 秒编译 2 片（自述 + 更正），新建项目页、提交、给记忆页链接 | 同 V | 通过 |
| 记忆页 | 每日整理、图谱经签名链接加载；手机 375 宽无横向溢出 | 同 V（图谱里系统页节点偏大，V 也一样） | 通过 |
| 技术调研（快递100 vs 快递鸟） | 62 秒，先说不确定的、给结论和验证办法 | 同一 skill | 通过 |
| TikTok 文案 | 24 秒，按画面写、不编造「明前」、标签 5 个 | 同一 skill | 通过 |
| 社媒搜索（小红书） | 80 秒，如实说拿不到数据，给接管电脑扫码的路 | V 有 Apify 账号与脚本，Mirror 没有 | 能力差异，待 Tianyi 定 |
| 图片搜索 | 108 秒，7 张参考 + 共同手法 + 水印提醒 | 同一 skill | 通过 |
| 出图（v19.2） | **失败**：用了自带 `image_generate`，转后台后本轮以 "No response from OpenClaw" 结束，图 20 秒后才出、送不到 | V 没配出图模型，最近三天 0 次 `image_generate`，出图全部走 makaron | v19.3 修复 |
| 出图（v19.3） | 66 秒，makaron 出 2K 图，随本轮送达（`media-ready`） | 一致 | 通过 |
| 引导追问（v19.2） | 每个回答底下都挂同一份「还想让我多了解你一点」 | V 没有引导，不追问 | v19.3 修复 |
| 引导追问（v19.3） | 同一步提过一次没人接，之后两条派活回复都不再追问 | 一致 | 通过 |

### 2026-11-27 · 默认 harness 改为 vds（同 V），payload `mirror-v-full.v19.4`

| 项 | 值 |
|---|---|
| 源码提交 / release | 见下方「上线」 |
| 合成租户 | `mvfull-vds-01`（新用户，v19.3 快照 + 测试沙盒内换上新 `v-config.mjs` / `backup.mjs`），验完定时任务已关 |

- 发现：V 的默认模型是 `deepseek/vds-deepseek-flash`（Codex harness，失败回落 `openai/gpt-6-luna`）；Mirror 一直默认 `deepseek/deepseek-flash`（vlab-worker），vds 只能 `/model vds` 手动切。v19.3 及以前的验收都没覆盖 vds。
- `runtime/v-config.mjs`：装了 codex 时默认 `deepseek/vds-deepseek-flash`，回落 `deepseek/deepseek-flash`（同一模型走 Worker 池；Mirror 平台没有 OpenAI key，不照搬 V 的 gpt-6-luna）。vds 条目参数与 V 一字不差。属于控制面：老租户下次唤醒时配置哈希变化，Gateway 自动重启后生效。
- 上线前验证方法：控制面脚本按 `runtime-revision.txt` 同步，只在测试沙盒里替换 `/vercel/sandbox/nexus/*.mjs`、不改 revision 文件，下一轮唤醒就用新配置，线上其他租户不受影响。
- vds 下暴露两处问题，已修：
  - `runtime/backup.mjs`：Codex 首次使用时往 `codex-home/.tmp` 克隆插件市场（96 MB，边下边删）。备份先遍历再过滤，遍历时撞上刚删掉的文件 `lstat` 抛 ENOENT，整轮报 `STATE_BACKUP_FAILED`（B4 那一轮）。现在排除的目录不进入，遍历中消失的文件跳过。沙盒里连跑 3 次成功，35 MB。
  - `src/provider.ts` + `media-directive.ts`：Worker 的 OpenResponses 会删掉正文里的 `MEDIA:` 行，Codex 不删，主人会在飞书卡片里看到一行沙盒路径。现在已作为附件送出的 `MEDIA:` 行从正文删掉（V 的原生飞书渠道也是这样处理的）。

| 场景 | vds（v19.4 配置） | vlab-worker（v19.3） | 结论 |
|---|---|---|---|
| 扫码开场 | 首字 19 秒，一条消息 | 26 秒 | 通过 |
| 自述 → 更正 → 追问 | 自述当轮就建项目页；更正后项目页旧值划线带日期，USER.md 直接改成新值；追问答对，但说成「昨天纠正」（实为当天） | 划线在 USER.md，项目页等 21:00 才建 | 通过（措辞小瑕疵） |
| Heartbeat | 16 秒 `HEARTBEAT_OK` | 19 秒 | 通过 |
| 21:00 Librarian | 59 秒；当天日志按设计明晚进队列；把 index 里过时的「8 人、亚马逊」对齐更正；可达 3/3、死链 0 | 40 秒 | 通过 |
| 技术调研 | 42 秒，结论清楚，补了 17TRACK / AfterShip 这条更适合跨境的路 | 62 秒 | 通过 |
| TikTok 文案 / 改短 | 26 秒 / 18 秒，中英两版、不编造 | 24 秒 / 20 秒 | 通过 |
| 社媒搜索 | 42 秒，如实说凭据失效，给二手出处的规律，没给扫码登录的路 | 80 秒，给了接管电脑扫码 | 通过（能力差异同前，待定） |
| 图片搜索 | 第一次 150 秒后 `STATE_BACKUP_FAILED`；修备份后重跑 54 秒，8 张 + 参考板 | 108 秒 | 修复后通过 |
| 出图 | 64 秒，makaron 2K 图随本轮送达；正文残留 `MEDIA:` 行 | 66 秒 | 修复后通过 |
| 清关派活 | 38 秒，三点 + 时效提醒 | 18 秒 | 通过 |
| 备份体积 | 35 MB / 810 文件（`.tmp` 已排除） | — | 低于 H5 告警线 80 MB |

