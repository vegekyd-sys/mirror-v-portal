# Mirror V ↔ v-sync-hub：VSync 中转（broker）

2026-11-27 CST。Tianyi 的决定：「私有仓库给镜像 V 可以传可以收就好，不要太大权限。」客户独立部署版也要带 VSync。

## 为什么不直接发 GitHub 凭据

`v-sync-hub`（GitHub 私有仓库，约 3 GB）里有各个 V 的完整快照和发给不同实例的包，含客户上下文。GitHub 能给出的最小权限都是**整库**：

| 做法 | 粒度 | 结论 |
|---|---|---|
| 部署密钥 | 整库读或整库读写 | 能读所有人的包，不行 |
| GitHub App / fine-grained token | 按仓库，不能按目录 | 同上；创建 App 还要在网页上操作 |
| 每个租户一个仓库 | 按仓库 | 能隔离，但 V 的 vsync 流程要改成往 N 个仓库推，每开一个号都要建仓库 |
| 经 V 中转 | — | 要在 V 上开公网入口，V 是只读对照对象，不动 |
| **Portal 中转**（采用） | 按 agent、按路径 | 唯一一把可写部署密钥只在 Portal 服务器；Mirror 只拿自己的令牌，V 的流程和 hub 目录结构都不变 |

## 权限

每个 Mirror V 有一个 agent id：

- 沙盒租户：`mirror-<租户 id 前 8 位>`（非 uuid 的合成租户用整个 id），或 `config.vsync.tenantAgents` 里固定的（0.4 = `mirror-v-004`，沿用 hub 里已有的目录）。
- 客户独立部署：运维起名，写进 `config.vsync.deployments`。

令牌 = HMAC(Portal 的 encryptionKey, `vsync:<agent id>`)，不存储，吊销靠 `config.vsync.revoked`。只认这三类 agent，`counterparts`（默认 `private-v`）本身不能用令牌登录。

| 能做的 | hub 里的路径 |
|---|---|
| 读自己的收件箱、ACK 和自己发出的东西 | `agents/<自己>/**` |
| 读别人发给自己的包 | `agents/*/returns/<自己>/**` |
| 看发送方的 manifest | 只返回 `to == 自己` 的行 |
| 看对端对自己的回执 | 对端 `ack.jsonl` 里 `to == 自己` 的行 |
| 写 ACK | 追加 `agents/<自己>/ack.jsonl`，`from` 强制为自己 |
| 发包 / 发消息给对端 | `agents/<自己>/returns/<对端>/<包>/`、自己的 `return-manifest.jsonl`、对端 `inbox.jsonl` 追加一行（`from` 强制为自己）；同名包不覆盖；单次不超过约 700 KB（Nginx / Gateway 的 1 MB 上限，base64 占三分之一） |

读别人的包、别人的 manifest、`..` 等路径逃逸、发给不在 `counterparts` 里的对象，都会被拒。

## 组成

| 位置 | 作用 |
|---|---|
| `packages/runtime-manager/src/vsync-hub.ts` | 权限、令牌、hub 读写：depth 1 + `blob:none` 的部分克隆（212 KB），读文件时按需取 blob；写入用临时索引 + `commit-tree` 提交，别人先推送就重新 fetch 再提交，最多 5 次 |
| `src/vsync-routes.ts` | Manager 的 `/v1/vsync/*`（只听 127.0.0.1，挂在 64 KB 的 JSON 解析之前） |
| `central-gateway` `/onboard/vsync/v1/{whoami,inbox,acks,replies,packages,file,ack,send}` | 公网入口，带着 `x-vsync-agent` / `x-vsync-token` 转给 Manager |
| `provider.ts` | 给 `mirror-v-full` 租户沙盒注入 `NEXUS_VSYNC_URL` / `_AGENT` / `_TOKEN`（下次启动 Gateway 时生效） |
| `scripts/vsync-token.ts` | 给客户独立部署签身份：写 `/opt/nexus/data/vsync-hub/issued/<agent>.env`（600），不打印 |
| payload `scripts/mirror-vsync.py` | Agent 用的命令：`whoami / inbox / packages / fetch <包> <目录>`（按 manifest / inbox 校验 sha256，不符退出码 4）`/ get / ack / send / replies`；没身份退出码 3，hub 不通退出码 2 |
| payload `skills/vsync` 的「On Mirror V」 | 先走中转；没身份或不通才退回飞书群文件 + sha256 |

## 服务器上的东西（不进 git）

- `/opt/nexus/data/vsync-hub/`（700）：`deploy_key`（600，ed25519，公钥已登记为 v-sync-hub 的可写部署密钥「mirror-v-portal vsync broker (2026-11-27)」）、`known_hosts`、`repo/`（部分克隆）、`issued/`（签发给独立部署的 env 文件）。
- `config.json` 的 `vsync` 段：`enabled`、`repo`、`branch`、`dir`、`sshKeyPath`、`counterparts`、`templates`、`tenantAgents`、`deployments`、`revoked`。改前备份为 `config.json.before-vsync-*`；改完重启 runtime manager 才生效。

## 客户独立部署

1. 在 Portal 主机把 agent id 加进 `vsync.deployments`，重启 manager。
2. `cd /opt/nexus/current/packages/runtime-manager && NEXUS_CONFIG_PATH=/opt/nexus/data/config.json ./node_modules/.bin/tsx scripts/vsync-token.ts <agent id>`。
3. 人工带外把 `issued/<agent id>.env` 交给安装的人；A 线安装器 `--vsync-env <文件>` 装成 `/etc/v/vsync.env`（0600，只收这三个键），Gateway 的 systemd 单元用它做 EnvironmentFile。
4. 部署机只需能用 HTTPS 访问 `mirror-v-portal.vercel.app`，不需要访问 GitHub。
5. 验收：`python3 scripts/mirror-vsync.py whoami` 返回自己的 agent id 和 `["private-v"]`。

已签发：`mirror-distro-test`（A 线测试机，2026-11-27）。

## 回滚 / 关闭

- 关掉整个中转：`config.vsync.enabled=false`，重启 manager（Mirror 侧会退回飞书群文件）。
- 吊销单个：agent id 加进 `vsync.revoked`，重启 manager。
- 撤销部署密钥：GitHub 仓库 Settings → Deploy keys 删掉「mirror-v-portal vsync broker」，或 `gh api -X DELETE repos/<owner>/v-sync-hub/keys/<id>`。

## 验证记录

- 单测：`runtime-manager/src/vsync-hub.test.ts`（本地裸仓库当 hub：越权读、错误令牌、吊销、ACK `from` 冒充、发给非对端、路径逃逸、别人先推送时重试且两边写入都保留），`central-gateway/src/__tests__/vsync-proxy.test.ts`。
- 2026-11-27 上线前对**真实 hub** 实测（Portal 主机上用 staged release `6168eb0aad91` 的代码临时起一个只听 127.0.0.1 的中转，测试身份 `mirror-vsync-hosttest`，对端只允许测试用的 `mirror-test-sink`，不碰 `private-v` 的收件箱）：`mirror-vsync.py` 收到包、sha256 一致、ACK 提交 `96d71348`、回发提交 `86eeed70`；读 `private-v → mirror-v-004` 的包 403、读 `private-v` 的 manifest 403、路径逃逸 400、发给 `private-v` 403、错误令牌 401、没身份退出码 3。测试数据已在 `bcc83ef` 删除。
- v22 上线后（release `d1413e434522`、快照 `snap_4IxJ…`），合成租户 `mvfull-vsync-03`（agent `mirror-mvfull-vsync-03`）：
  - 沙盒 Gateway 环境里有 `NEXUS_VSYNC_*`；`whoami` 经公网全链路（Vercel → Nginx → Gateway → Manager → hub）返回自己的 id 和 `["private-v"]`。
  - 在测试命名空间放一个发给它的包后，只说「收件箱里有一条，按 vsync 流程处理」：72 秒内 Agent 自己 `inbox` → `packages` → `fetch`（sha256 一致）→ 装到 `skills/delivery-precheck/` → `ack` 写进 hub（`ack_20261127T231629_…`）；回发给 `mirror-test-sink` 被 broker 以 `RECIPIENT_FORBIDDEN` 拒绝（符合配置），Agent 另写了一条 partial ACK 说明。
  - **发现的问题**：Agent 查用法时跑了 `send --help`，脚本把 `--help` 当主题，经中转往 `private-v` 收件箱写了一条空消息。两分钟内已撤回（`6be8b66`），只读核对 V 的已读记录（最后更新 10-09）和定时任务，V 没读到。`db4d5479` 修复：脚本见到任何 help 参数只打印用法，主题以 `-` 开头或少于 3 个字符拒绝；broker 也拒绝这样的主题（v22.1，待发布）。
  - 测试数据已删（`1b3ad88`），hub 的 `agents/` 恢复原样；租户没有注册定时任务。

## 还没做的

- V 侧：V 的 vsync 技能按原有目录结构工作，Mirror 发回的包在 `agents/<mirror>/returns/private-v/` 和 `agents/private-v/inbox.jsonl`。V 的 `vsync-a2a-check.py` 会在它的收件箱里看到这些行；第一次真实往来要按 VSync 群里的验收流程走。
- Portal 接收机器人发来的飞书消息：C 线在改 `feishu.ts`。
