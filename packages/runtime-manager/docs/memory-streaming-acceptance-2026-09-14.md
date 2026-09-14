# 流式展示与记忆隔离验收

## 流式补丁

只读取得 V 的 `source/scripts/patch-feishu-latest-snapshot-streaming.mjs`，位于 `/opt/openclaw-experiments/db91-release-v2026.9.1-db91.1`。将其 latest-snapshot 合并原则移植到 Nexus 的独立 Feishu adapter：API 请求期间只保留最新累计正文，不逐条重放过时帧；首次立即发送，后续最短间隔 150ms（之前 800ms）。采用官方 SDK 使用的 `print_strategy: fast`；最终全文通过非流式整卡更新展示，不等待旧帧逐字排空。没有修改 V/VLab。

验证：原 12 项测试通过，新增慢 API + 100 次增量 + 最终全文测试通过；TypeScript build 通过。用户已在真实飞书客户端确认：“是，能直接追上并完整展示”。API 时刻仍不等价于客户端渲染计时。

真实 Bot 验证：run `c30afeb7-e374-468e-8617-0b4b3835e4c8`，succeeded/sent，卡片 `om_x100b654e83b828a4b3971aea5c84de0`。API 接收累计正文 2 → 317 → 367 → 424 字，后续间隔 244/273/274ms；无流式 API 错误。16:14:13.619 收首 delta，16:14:14.691 首卡确认，16:14:18.669 最终送达。这些是服务端/API 时刻，非客户端渲染时间。IM GET 对 CardKit2.0 的兼容占位不能用来核对正文；本次无需旧版验收标记，旧脚本输出的 marker=false 不代表发送失败。

## 两个独立 Agent 的真实 Vercel 验收

时间：2026-09-14 16:11 开始。使用与试用 Bot 相同的 VercelProvider、OpenClaw、原版 DealClaw payload 和官方 DeepSeek；两个独立测试租户，不污染用户 Bot 的业务记忆。

| 检查 | Agent A | Agent B |
|---|---|---|
| 租户 | memory-1789373460811-a | memory-1789373460811-b |
| 独立 Sandbox 名称 | nexus-elastic-20260914-memory-1789373460811-a | nexus-elastic-20260914-memory-1789373460811-b |
| 首次 VM session | sbx_8rEWePES0yj4lbHAM4l2L4THsye3 | sbx_r1ivegCnDGGX7Yea5fwL0uEBsrte |
| 恢复后 VM session | sbx_qXdGdQZiw3J7XByxYMZA6hG4iONv | sbx_oc6djbjjL1XRtZPgI5IxMpGzKdHy |
| 模型调用工具写业务记忆 | 通过 | 通过 |
| stop 后云端状态 stopped | 通过 | 通过 |
| 新 Provider、新 VM、新聊天读取原记忆 | 通过 | 通过 |
| 整个 agent-data 不含另一 Agent 随机值 | 通过 | 通过 |
| 测试完成再次 stop | 通过 | 通过 |

测试没有在召回问题中提供答案；明确要求读取业务笔记路径。因此证明文件持久化、重新连接、显式记忆检索和租户隔离，不代表任意自然语言问题都能自动检索所有记忆。没有加载向量 memorySearch。

物理 VM session 会变化；稳定的是每个 Agent 的逻辑 Sandbox 名称、私有磁盘快照、OpenClaw 状态及 workspace。Agent A/B 使用独立进程和磁盘；并非多个 Agent 共用一个 OpenClaw。

## 原 payload 的限制

最初要求写 `MEMORY.md` 的测试失败：原 payload 的 AGENTS.md/SOUL.md 将核心文件修改权固定给原作者，模型拒绝写入。未修改该规则，也没有将失败记录当作通过。改为普通业务笔记 `memory/nexus-customer-preference.md` 后，上述验收全部通过。个性化阶段需按租户身份重做 Owner 规则及自动记忆发现。

可复现：在配置好私有 `.elastic/config.json` 后运行 `pnpm --filter @dealclaw/runtime-manager exec tsx scripts/verify-memory.ts`。该脚本创建两个测试 Sandbox，产生少量运行和快照费用，结束后停止实例并保留快照。原始证据：`.elastic/memory/acceptance-1789373460811.json`（gitignored）；测试值不是凭据。
