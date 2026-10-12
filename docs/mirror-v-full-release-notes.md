# Mirror V 全功能 · 发布说明

发布日期：2026-10-12（Asia/Shanghai）
入口：Mirror V Portal 选择页第四个选项「Mirror V 全功能」（`/onboard?template=mirror-v-full`），飞书扫码创建，飞书里的机器人名为「Mirror V」。

## 这是什么

和线上 V 同一套运行时、同一套工作方式的个人 AI 伙伴，但**记忆从零开始**，第一次对话时认主人、起名字。每个人一台独立的云端小电脑（Vercel Sandbox），不用时自动休眠、有消息自动唤醒。

| 能力 | 说明 |
|---|---|
| 运行时 | OpenClaw 2026.9.1 + V 的全部补丁，多 Worker 并行 |
| 对话 | DeepSeek Flash（思考模式），飞书流式卡片，调工具前先说一句在做什么 |
| 第二大脑 | `/model vds` 切到 Codex harness（DeepSeek），`/model deepseek` 切回 |
| 工具 | 命令执行、网页搜索、读网页、Makaron 生图/视频/音乐、子 agent 并行 |
| 记忆 | 记忆文件 + 实时索引（Gemini 向量 + 中文全文检索），跨会话可检索；可导入 V001 示范记忆做参考 |
| 自我进化 | 每晚 21:00 Librarian 编译记忆、22:00 质检、每天 8:30/20:30 Heartbeat 反思、午夜报告、每周日 Skill 复盘 |
| 电脑 | 自带桌面和 Chrome：computer use 截图点击；需要你登录时发「接管链接」，手机上接管、交还后它接着做 |
| 你的浏览器 | V Browser 扩展配对后，它可以操作你自己电脑上的 Chrome |
| 语音 | 通过专属链接和它打电话（Grok Voice），沉睡时也能拨通 |
| 定时任务 | 让它「每天几点提醒我」即可，由 Portal 按时唤醒执行 |

## 本次版本相对首个验收版（10/08）的改进

- **首字与流式**：思考模式下文字边写边出，热实例首字约 3 秒；调工具前先在卡片里说明要做什么。
- **回复完立刻结束**：每轮状态备份不再带可重建的记忆索引和缓存，备份从最多 294 MB / 83 秒降到约 8 MB / 3–4 秒，下一条消息不用排队。
- **不会再被锁死**：模型超时、回合中途崩溃、休眠失败都不再锁住实例；之前一次休眠超时让实例停用了 3 天，定时任务也全停。
- **能正常休眠**：闲置约 10 分钟自动休眠；修了闲置实例拿不到新脚本、唤醒后常驻服务没起来两个问题。
- **子 agent**：并行子 agent 的结果在同一轮内汇总返回，不再丢失。
- **运维**：Portal 每 10 分钟巡检所有实例（锁死、睡不下、失败、定时任务没跑、Librarian 空跑、备份变大、首字变慢、飞书断线）。

## 验收与回归

按 `docs/mirror-v-full-eval.md` 的三层标准：
- L1 发布门禁（测试实例 `mvfull-accept-04`）：对话、工具、多 harness、记忆、桌面/浏览器、睡醒循环、崩溃恢复、官方定时任务（Librarian 等）全部通过后才发布。
- L0 生产巡检：Portal 上 `nexus-eval-health.timer` 每 10 分钟运行。
- 真人试用：Tianyi 10/12 试用约半小时。

## 已知限制

- **对话中途插话（steer）还不支持**：运行中发的新消息会排队，等当前这条做完再处理。
- `/vcc`、`/vcodex` 需要用户自己接入账号，默认不可用。
- 语音只开放 Grok Voice（豆包的 key 无效）。
- V Browser 扩展暂时需要开发者模式安装。
- 群聊里所有人都按主人对待（单主人模式），建议私聊使用。
- 「记进长期记忆」这类请求有时会默默跑一两分钟才回复（模型在等提交和索引），待优化。
- DeepSeek 超时没有备用模型，超时的那一轮会失败（下一条正常）。
- 巡检告警暂时只记在 Portal 上，还没推送到飞书。

## 运维要点

- 发版：从 mirror-v-portal `dev` 的提交打包，`/opt/nexus/current` 指向新 release，重启 runtime-manager 与 central-gateway；重启前确认没有正在运行的回合。
- 回滚：`/opt/nexus/current` 指回上一个 release 目录并重启两个服务。
- 模板配置在 `/opt/nexus/data/config.json` 的 `templates["mirror-v-full"]`（`listed`、`name`、`appName`、`description`），改动前先备份。
- 巡检结果：`/opt/nexus/data/eval/health.jsonl`；门禁结果：`/opt/nexus/data/eval/gate.jsonl`。
