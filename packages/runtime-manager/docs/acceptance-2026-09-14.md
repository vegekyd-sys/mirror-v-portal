# 2026-09-14 试用验收

代码基线：原仓库 master `e2af898`，工作分支 `codex/dealclaw-elastic-runtime`。原 payload 校验通过，运行引擎 OpenClaw 2026.7.1。

## 真实 Vercel + 模型 + 文件工具

1. 从基础快照创建命名 Sandbox，DealClaw readiness 10,166 ms。
2. 请求用文件工具写入 `trial-marker.txt`，内容 `nexus-trial-914`。Agent 返回真实工作目录路径。
3. 显式 quiesce 后 Sandbox 返回 stopped，生成状态快照。
4. 再次恢复 readiness 13,146 ms。Agent 用文件工具读回同一内容，并正确复述上一轮写文件请求，验证文件和会话都跨 VM 生命周期保留。
5. 再次停止成功。
6. 浏览器向 HTTP → PostgreSQL → pg-boss → Sandbox 链路发消息读取同一文件。readiness 7,524 ms，返回 `nexus-trial-914`，任务 succeeded。
7. 最后消息完成时间 15:07:49；60 秒空闲阈值到达后于 15:08:51 进入 quiescing，15:08:59 记录 sleeping / computeReleased=true。未人工触发该次释放。

上述是三个样本，不是性能分位数；7–13 秒是 Agent 可用时间，不包含模型生成回复的时间，也不意味着亚秒回复。

本机备份扫描未检出模型 API key 明文。扫描只报告是否命中，不输出凭据。

## 原有飞书入口

原 `/onboard` HTML 和 registerApp 能正常显示、生成真实飞书设备授权二维码。用户随后已扫码创建《出海精灵 AI外贸专家》，完成真实飞书聊天，并明确确认第一阶段验收成功。后续性能版的原生卡片流式显示也得到用户确认；详见 latency-profile-2026-09-14.md。

## 范围

控制面和 PostgreSQL 在 Mac 上，计算在 Vercel。现有生产服务、Bot 和 Kubernetes 部署未切换；多 channel 和可配置 agent payload 本轮未做。当前没有完整业务插件凭据。

## 控制面验证

7 项 PostgreSQL 集成测试通过，包括真实 pg-boss 队列连续 5 条消息按租户顺序执行、最大并发为 1。构建通过。未认证 `/api/state` 返回 401，非本机 Host 和跨站 Origin 返回 403。
