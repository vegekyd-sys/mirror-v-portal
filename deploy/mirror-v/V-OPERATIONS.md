# 给 V 的 Mirror V Portal 更新手册

这份手册的目标是让生产 V 能理解并接手 Portal 的代码和 Payload 更新。真相源是私有 GitHub 仓库 `vegekyd-sys/mirror-v-portal` 的 `dev` 分支；旧 DealClaw GitLab 只作为历史代码来源。先核对现场版本、实例和备份，再操作。

## 三个相互独立的 OpenClaw

| 位置 | 用途 | 2026-09-27 核验版本 | 更新边界 |
| --- | --- | --- | --- |
| `ssh v`，V ZKDA | Tianyi 的生产 V，运行带私有补丁的 db91 release | `2026.9.1` | 不因 Portal 更新而升级或重启 |
| Portal 主机 `43.134.135.143` 的旧 V001 Gateway | V001 知识来源与旧服务 | `2026.6.1` | 不作为扫码用户的运行时 |
| Portal 创建的 Vercel Sandbox | 每个扫码用户的 Mirror V Agent | 模板构建时固定 `2026.7.1` | 通过新快照和受控迁移升级 |

Portal 主机上的 `nexus-runtime-manager`、`nexus-central-gateway` 和 `nexus-credits-ledger` 是常驻控制面。扫码 Agent 的 Sandbox 按需唤醒，空闲后休眠；每轮成功响应都会把工作区和会话备份到 Portal 主机 `/opt/nexus/data/backups/<tenant>.tgz`，休眠时还保留实例快照。因此“有持久记忆”与“进程一直在线”是两件事。当前实现的是前者，不是所有 Agent 进程常驻。

## 7.1 Payload 是什么

Payload 是 `AGENTS.md`、`SOUL.md`、`MEMORY.md`、`memory/`、`skills/` 等工作区内容；OpenClaw `2026.7.1` 是解释和运行这些内容的程序。两者应分别记录版本，且每次发布要验证二者的组合。当前组合为：

- OpenClaw：`2026.7.1`，由 `packages/runtime-manager/scripts/build-snapshot.ts` 固定安装。
- Mirror V 知识种子：`mirror-v.v001-full.v2`，由 `prepare-mirror-v001-payload.py` 从旧 V001 的实时工作区生成私有文本包。当前这份种子包含 937 个文本文件，其中 923 个位于 `memory/`；构建流程排除旧会话、媒体、运行状态和已识别的凭据。
- GitHub 发布代码：以 `dev` 的提交 SHA 为准；Portal 生产 release 在 `/opt/nexus/current`。

私有源工作区在 Portal 主机 `/root/makaron-openclaw/.openclaw-local/workspace`，生成包保存在 `/opt/nexus/data/`，权限为 `0600`。GitHub 只保存构建脚本和可公开的 starter，不保存完整 V001 知识包。更新前需逐项审查将向所有新扫码实例分发的知识范围；正则凭据脱敏不等于完成隐私审查。

## V 将来更新 Payload 的流程

1. 在 `dev` 上修改生成脚本、身份边界或选定的知识来源。不要直接在运行中的 Sandbox 或原始旧 V001 工作区里编辑，把它当成发布的唯一记录。
2. 为有行为变化的 Payload 增加版本，运行 `python3 -m unittest packages/runtime-manager/scripts/test_prepare_mirror_v001_payload.py`，审查生成包的清单、脱敏统计和敏感内容。
3. 在 Portal 主机的私有路径生成 tar。以 `deploy/mirror-v/README.md` 的命令为准。生成文件和凭据不得进入 GitHub、飞书消息或共享记忆。
4. 以固定 OpenClaw 版本构建新 Vercel 快照。构建器会更新 `/opt/nexus/data/config.json` 中新扫码用户使用的模板指针；先备份原配置和快照 ID。
5. 创建**隔离测试实例**，至少验证记忆检索、普通私聊问候、追问、`NO_REPLY` 静默边界、实际渠道收发以及休眠后唤醒。不能只看 HTTP 健康检查或模型网页测试。
6. 测试通过后再把新模板作为默认入口。现有租户仍指向创建时的模板快照，不会因为模板指针改变而自动获得新的 Payload。为现有租户更新时，要先保存其工作区、会话和绑定，再决定做文件级合并或迁移；不能用新种子覆盖用户长期记忆。
7. GitHub `dev` CI 通过后按 `scripts/deploy-mirror-v.sh stage <sha>`、`activate <sha>` 发布控制面。该脚本在健康检查失败时恢复前一版 release；Payload 模板指针和租户数据需要单独保留回滚记录。

当前构建器创建的**模板快照有效期为 30 天**。现有持久租户另设不自动过期的实例快照，但新用户入口所指的模板仍需在到期前重建或建立续期机制。更新计划里必须检查这个期限，不能把模板指针长期放着不管。

## 将来从 7.1 升到 9.1

不要对 V 的 9.1 进程或现有 7.1 实例执行原地 `npm install`。V 当前的 9.1 含私有 db91 补丁，不能把官方 npm 9.1 误认为与生产 V 完全相同。先选定要验证的代码来源和固定版本，在独立分支上修改快照构建器，生成**新的运行时快照**，并给组合发布一个新版本。先用隔离实例验证 Gateway 启动、Responses 流式输出、`memory-core` 索引与检索、工具调用、微信和飞书收发、每轮备份、休眠恢复以及旧记忆格式。然后小流量灰度新用户，再逐个迁移已存在的租户；每个租户保留原工作区备份、原快照和可回退的渠道绑定。7.1 模板在 9.1 验收前继续可用。

版本号 `2026.9.1` 与 `2026.7.1` 是 OpenClaw 程序版本，不是 Payload 版本。即使 Payload 文本不变，升级运行时也可能改变插件、配置校验和回复行为，必须重新验收。当前模板目录只记录 Payload 版本和快照 ID，尚未把运行时版本作为独立元数据展示；在自动化升级前应补上这项发布记录。

## 若要“常运行”

可以单独设一个 7.1 常驻的核心 Mirror V 实例，继续用已验证的 Payload，并为它提供专门的资源、健康监控与备份。当前 2 GB Portal 主机还承载旧 V001 和控制面，不应直接把所有扫码实例改为本机常驻。多用户实例继续按需运行更合适。常驻核心实例和新用户扫码实例应有不同的状态与升级策略。

## 交接与权限现状

2026-09-27 已用生产 V 实际运行的 `openclaw` 身份核查：`gh auth status` 与私有仓库 `git ls-remote` 均通过，V 可以读取 `dev`。最初用 SSH 登录账号 `ubuntu` 检查失败，不能代表 V 的权限。**向 `dev` 写入及分支保护门禁尚未实测**；V 准备自行提交时须按仓库规则验证，并保留 CI、审查和生产发布边界。不要把 Portal 的生产 SSH 私钥、数据库 URL、模型密钥或 V001 私有 tar 复制到 V 主机。
