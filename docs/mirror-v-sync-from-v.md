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
4. 这次同步进来的能力各跑一遍。
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
| 源码提交 / release | 见下方验收段 |
| 快照 | 见下方验收段 |

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
