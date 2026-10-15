# Makaron 与 Portal 跨库工作收尾

2026-10-15，按用户要求结束混合两个仓库的线程，把接手入口和真实发布范围分清。本文件记录工作来源，不把历史实验、已上线控制面和未合入的应用源码混为同一状态。

## 两个仓库分别做什么

| 仓库 | 本线程承担的工作 | 后续接手入口 |
| --- | --- | --- |
| `vegekyd-sys/ai-image-editor`（Makaron） | 提取 prompts / Skills / capability tools；Agent Kit、原生 OpenClaw 插件、project facade；异步任务完成、源文件和项目归属；payload 版本与品牌头像 | `packages/makaron-agent-kit/`，`src/lib/harness-*`，`docs/ops/makaron-*` |
| `vegekyd-sys/mirror-v-portal`（本仓库） | 安装/构建版本化 payload、独立租户与账号绑定；飞书/微信图文入口和媒体投递；Portal 展示、扫码与管理；静态首页发布 | Gateway、Runtime Manager、agent-templates、`deploy/mirror-v/` |

OpenClaw 负责创作循环、会话与工具调用；Makaron 后端仍负责项目、供应商、永久媒体、渲染和计费。Portal 的 UI 改版不意味着 Makaron 网站更换了 Agent 架构，也不意味着其应用 `dev` 或生产 alias 已包含实验代码。

## Makaron 工作树与提交来源

以下为本机核对结果，路径是接手线索而不是生产依赖；临时 runner 可以不存在，分支/提交才是恢复来源。

| 阶段 | 历史或现存目录 | 分支 / 固定提交与状态 |
| --- | --- | --- |
| V2 payload 主开发 | `~/.codex/worktrees/makaron-mirror-payload/ai-image-editor` | 历史主工作树目录已不存在；分支 `codex/makaron-mirror-payload` 保留在 `5143b8aa`，含初次完整提取 `8c0ab710`、飞书 V2.0.1 `760c3ef1`、V2.0.2 `4ddc3250` |
| Harness 后端验收 runner | `~/ai-image-editor-makaron-harness-runner` | 现存干净 detached runner，`b89f838b`；用于 V2 初始 facade/证据，不是最新 payload |
| 去 MediaList / native-files | 历史 `~/.codex/worktrees/makaron-no-media-list/ai-image-editor` | 历史目录已不存在；分支 `codex/makaron-no-media-list-experiment` 保留，头为 `1181b36f`；实验开始 `63874053`，之后原生状态去重复媒体 `d69462f5`，V2.1.1 记录 `2fe21633` |
| native-files 固定后端 runner | `~/ai-image-editor-runner-no-media-list` | 现存干净 detached runner，固定 `63874053`；不能把它当作后来头像版的最新源码 |
| V2.1.2 头像源码验收 | `~/ai-image-editor-makaron-avatar-verify-20261012` | 现存干净 detached runner，`1181b36f7ddfb7860afaaf70920093929236f7c9`；公开 payload v2.1.2 的源码来源 |

收尾重新 fetch Makaron `origin/dev` 后，`5143b8aa` 和 `1181b36f` 均不是其祖先；两个历史 payload 分支也未找到同名远程分支。因此它们是**本地保留的独立源码分支**，不能声称已合入 Makaron 应用主线或可直接从 GitHub 同名分支恢复。下一次要产品化时，先审查与当前主线的差异、测试和资料敏感性，再选择合并/抽取与发布方式；本次不顺便推送或合并这些历史实验。

另外存在 `~/ai-image-editor-openclaw-harness-demo` / `codex/openclaw-harness-demo` 的旧 prototype，工作树有未提交修改。它不是上述 v2.1.2 归档的源码来源，本次没有清理、提交或覆盖它。Makaron 主目录当前也有其他任务的变更，保持原值。

## Portal 工作树与发布线

| 阶段 | 工作树 | 结果 |
| --- | --- | --- |
| Makaron 控制面接入 | `~/Nexus-makaron-payload`、`~/Mirror-V-makaron-deploy` | 模板、图文接入、原生媒体、异步/终态与头像注册；相应历史修复已沿 Portal 发布线保留 |
| 独立公开上架 | `~/Mirror-V-makaron-public-20261014`，`codex/makaron-public-portal` | PR #6/#7/#8；每个新用户绑定自己的 Makaron 账号，独立 `makaron.v2.1.2` 模板 |
| 首轮首页整理 | `~/Mirror-V-portal-elegant-home-20261014` | PR #9/#10；静态页面独立交付 |
| 视频、头像、玻璃与 H5 | `/tmp/mirror-v-video-avatars-20261014`（现目录已不存在，Git 仍保留历史注册） | `codex/portal-video-avatars-20261014`；PR #11，`4dc15d8955e0` |
| MacBook 和面板间距 | `/tmp/mirror-v-portal-laptop-20261015`（本次收尾复用） | PR #12/#13；UI 末版 `322f3ed1a68f`；收尾文档使用新分支 `codex/portal-thread-handoff-20261015` |
| 本机正式分支目录 | `~/Nexus-dev` | Portal 的 `dev` checkout；GitHub remote 为 `github`，旧 GitLab `origin` 不再是本产品发布目标 |

Portal 目录名中保留 Nexus 不表示代码还属于另一套 GitHub 仓库。应通过 remote URL 和提交判断归属，不靠目录名字推断。

本轮完整 UI 清单、各 PR、版本、响应式边界与验收见 [UI 发布记录](portal-ui-release-20261015.md)。2026-10-15 收尾现场已是 `88cc038a6610`，包含其他线程的运行时上下文修改及本轮 UI；本次只加文档，不把线上回退或重启。

## Agent 文件的区分

- 仓库根目录此前没有 `AGENTS.md`；本次补充给 Codex/Claude 等开发代理使用的代码入口、测试、UI 发布与跨库边界。
- `packages/agent-templates/*/payload/AGENTS.md` 是分发给用户 Agent 的行为文件。Makaron 原生插件和 OpenClaw 工作区同样有自己的启动规则。
- 本轮 UI 收尾不需要更改这些 payload 行为文件，也不重建 snapshot。特别保留其他任务刚更新的 Mirror V 运行时和工作区文档。

## 已证明和仍未完成

- 已完成：完整 craft 的 payload 打包、Portal 独立 Makaron 上架、用户确认的 Portal 外观、响应式及二维码/API 验证。
- 历史飞书四类成品有技术与原生交付证据；设计过程存在 overflow 与恢复，不是无错误的一次完成。v2.1.1 试用另有图文、连续改图、异步视频与原生交付记录。查 Makaron 源分支中的对应 ops 文档，不能用一个阶段覆盖另一个阶段的失败。
- 未证明：官方图片/视频 benchmark 成绩、创意优于其他 Harness、公开新用户在自己手机上的完整扫码和四类媒体连续使用。既有案例不等于总体结论。
- 微信原生媒体出站的历史缺口，不因 Portal UI 验收自动闭合；再次处理时先查当前渠道代码与现场再回归。
- Makaron 应用主线融合、公开 CLI/Plugin 后续演进与当前 payload 是独立工作。未来改工具、模型或 bundled Skill 时按 Makaron 的 CLI/npm 与 skill-sync 流程验证；本次纯文档不触发这些发布。

建议后续分别在 Makaron 与 Portal 项目开线程，引用本文件和固定 commit。保留历史分支、归档、快照与未提交工作；“结束当前线程”不等于获准删除工作树或迁移实例。
