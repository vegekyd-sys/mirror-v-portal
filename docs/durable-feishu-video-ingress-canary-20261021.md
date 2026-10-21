# 飞书视频入站修复：单实例验证与默认能力

2026-10-21，Asia/Shanghai。用户报告“飞书里面发视频无效”。本次修复属于 Portal 通道层，不是 Makaron 媒体模型或账号改动。

## 根因与行为

实际用户消息是带 `media` 元素的富文本 post。旧代码读取了其文字，但跳过视频元素，最终 run 的 attachments 为零；原生 media/file 视频也被消息类型过滤器直接忽略。之前的只读工具发现与出站文件传输验收没有覆盖这条真实入站路径。

新增行为由 `feishuInboundVideoTenantIds` 显式灰度，仅启用 **Makaron 0.2**：

- 支持原生 media、以文件发送的 MP4/MOV/M4V/WebM，以及富文本 post 中的 media 元素。按 file_key 下载真实文件，不把 image_key 封面当视频。
- 文件以 tenant/message/hash 作用域私有保存；核对类型、大小、路径、SHA-256、符号链接，再把相同字节写入该 VM 的 inbound 目录。
- 视频通过 files 元数据和真实本地路径进入 Agent，不作为 input_image，也不把视频 Base64 塞进模型请求。后续同会话文字可继承视频附件。
- 单条最多四项媒体，视频及总传输上限 64 MiB；图片既有单张 10 MiB/合计 12 MiB 限制保持。失败会清除本轮附件并禁止继承旧素材；去重消息不重复下载或执行。磁盘持久化失败不提前确认消息。

## 验证

- 31 个不依赖数据库环境的测试文件、233 项测试通过，包含新增 6 项视频测试；TypeScript build、diff 检查通过。完整尝试中 manager/scheduler 两个数据库集成文件因缺少本机私有测试配置而未运行，不计通过；未借用生产数据库运行这些测试。
- 使用飞书 API 读回该用户原始 post，经新 FeishuEdge.receive 实际下载、持久化和 owning VercelProvider 传入原 VM。该验证使用捕获 enqueue，不重提旧翻译任务，不外发消息。
- 真实原文件为 QuickTime/MOV，872,239 bytes；controller 与 VM SHA-256 完全一致。实际 DeepSeek Flash Agent 仅运行原生 exec/ffprobe，读出容器时长 5.225s、960×548、H.264/30fps、1 条 AAC 音轨。付费尝试计数 2→2，无新媒体生成。
- 用户重新发送后经在线事件通道的完整回归仍待本人确认；上述真实文件重放不能扩大为这一项已通过。

## 首次灰度现场与发布边界（历史记录）

实现 commit：`e2644c2aa18e`，本地分支 `codex/durable-feishu-video-ingress-20261021`，基于现场 Portal `c09046572131`。未推送、合并 dev 或发布 npm。

线上 Runtime Manager 运行本次组件灰度目录：`/opt/nexus/canaries/durable-video-e2644c2aa18e/packages/runtime-manager`。systemd 的 `60-durable-video-canary.conf` 只覆盖该服务的 WorkingDirectory。生产 `/opt/nexus/current` 指针仍为 `c09046572131`；公开模板、payload/snapshot 和所有租户模板 pin 不变，只有视频 allowlist 增加目标实例。Durable 核心仍为 candidate.7、Flash/high、固定后端 1.2.1。

启用前取得所有现有 tenant 的既有 advisory lock，并核对 queued/running 为零。Runtime Manager 重启会因 systemd Requires 依赖带动 Central Gateway 重启：首次切换原保护条件要求 Gateway PID 不变，触发回滚；已核对服务恢复，随后按实际依赖修正切换流程并启用。最终两服务正常、公开目录 HTTP 200，公开模板与租户 pin 校验不变。此处有入口进程重启，不声称所有进程未动或 pending 扫码会话完全无影响。

私有证据保存在服务器目标专属目录及 Makaron 工作树忽略目录 `output/capability-sync/portal-canary/`，包含首次回滚、最终 activation、原 post、真实入站与 ffprobe 结果、测试日志；不将凭据、私有媒体名或签名链接写入本文。

## 回滚与后续合入

暂停在安全空闲窗口；仅移除 `/etc/systemd/system/nexus-runtime-manager.service.d/60-durable-video-canary.conf`，恢复之前的视频 allowlist 字段，daemon-reload 后重启 Runtime Manager，并核验依赖 Gateway 恢复。保留候选 VM、原项目、原消息、已落盘视频、计数与账目。

这是临时组件 canary。下一次正式 Portal 发布须先处理该 drop-in，避免旧组件目录继续覆盖正式 release 的 WorkingDirectory；应将源改动 review/合入标准发布线后再移除覆盖。没有自动把视频功能开放给其他 Agent，也未把本次接入视为完整媒体 A/B 或正式晋升通过。

## 后续默认能力与新建实例验证

用户明确要求“在 payload 里修好，其他人扫码后也能发视频”。后续源改动移除了租户名单，所有实例默认使用同一 FeishuEdge 视频路径；每次 boot 将事实合同写入 payload 工作区 TOOLS.md、portal-environment.json 与 portal_environment。旧公开 snapshot 创建的新实例同样收到当前运行时，不修改其身份、账号、创作模型或模板 pin。源码与完整 CI 见 [PR #18](https://github.com/vegekyd-sys/mirror-v-portal/pull/18)。

已使用公开 `makaron.v2.1.2` snapshot 创建全新独立实例，只绑定已有测试账号的 MAKARON_API_KEY，没有 NODE_OPTIONS、DeepSeek 密钥或 candidate 覆盖目录，也没有视频名单。通过真实飞书资源 API 获取同一原始 MOV，经默认 receive 路径进入新 VM；Agent 原生 exec/ffprobe 得到同一 5.225s、960×548、1 条音轨。后续文字引用通过 exec 读得 872,239 bytes 和相同 SHA-256；最终已按 owning provider stop 保存休眠快照。未新建媒体或向飞书外发消息。此项验证新建公开 payload 的实际 Agent 调用，不等同于另一个人已完成扫码及手机验收。

正式切换必须使用合并后的 GitHub dev release，撤掉上述临时 systemd drop-in 并仅删除私有配置中的旧名单字段，保留其他配置与原 Makaron 0.2 candidate。切换前检查持久化任务空闲并持有现有租户 advisory lock，失败恢复指针、名单字段与精确 drop-in。不能只切换 /opt/nexus/current 而遗留 WorkingDirectory 覆盖。发布后的实际 release、服务健康与模板 pin 核验记录在 PR 发布回执；本节自身不是已部署声明。
