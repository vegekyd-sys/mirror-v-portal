# Nexus TODO

> Created: 2026-08-07

## 当前卡点

### 🔴 DealClaw Agent 镜像构建
- Build #111 进行中（23:30 仍在构建，大镜像 10-15min）
- 之前 #109/#110 失败原因：CI Dockerfile npm test 在 COPY src 前执行；customer-overlay 测试依赖已删数据
- 已完成：Mirror V 全量 131 skill 搬入 payload；write-config.mjs 改为运行时自动发现

### 🔴 Credential 管理模块（新 P0）
管理员 明确提出不满意当前 ENV/key 管理方式。需要新增 Nexus Credential Manager。
- 目标：中央 credential 注册表 → tenant↔key 绑定 → Gateway Header 动态注入
- 估 6d 开发
- 详细方案见 `dealclaw/docs/progress/2026-08-07-status-and-nexus-credential.md`

### 🟡 DealClaw Agent M1
- 补齐 5 个剩余 Skill（数据圈选/话术拆解/方案生成/拜访评分/客户历程）
- 用真实米奥 API + CRM 数据替换 M0 stub
- 阻塞项：需要真实米奥测试 key

### 🟡 Payment Service
- 王建决定延后
- 支付宝沙箱 APPID + 密钥已就绪（2026-08-04）

## 下周会议议题

1. Credential 管理优先级确认（是否设为当前 P0）
2. 米奥 API 对接时间线
3. 运维分工：Credential 模块谁主力？
4. M2 上线目标日期
