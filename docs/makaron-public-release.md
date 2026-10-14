# Makaron 独立 Portal Agent

Makaron 作为独立的 `makaron` 模板发布，运行自己的 OpenClaw 创作循环。
每个新实例使用自己的 workspace、对话和 Makaron 账号；其他 Agent 和现有
Makaron 实例的 payload/snapshot 绑定保持原值。

## 创建流程

Portal 选择 Makaron → 注册或登录 Makaron，获取自己的 API Key →
连接账号并生成二维码 → 用飞书或微信扫码确认 → 创建专属 Agent。
创建页显示 Pixel Wizard 抱着 Spark 的头像，飞书新建应用预选同一张头像。

账号 Key 只在请求正文和短期服务内存中使用，验证账号后，在该扫码创建的
租户中加密保存。绑定失败不会发送就绪欢迎消息。Key 不进入 URL、返回值、
payload、共享模板或对话。创建流程不产生媒体费用；创作使用用户自己的额度。
隐藏模板不能从公开账号连接接口创建。公开开放前必须验证 HTTPS 回源。
当前回源使用主机已有 Tailscale Funnel 权限，由 Vercel 经可信 HTTPS
连接 Portal 节点，最后一段仅在本机 loopback 上转发。

## 不可变产物

- Payload：`makaron.v2.1.2`
- 源码：`1181b36f7ddfb7860afaaf70920093929236f7c9`
- tar SHA-256：`72a33bdb77d87b62c70e86d7d73ba9a14e5453711d3b1dd4dd761ce6aa8b9e0a`
- Snapshot：`snap_hF86YgSUGg4DQ8nO1J0ZlJDVLk0i`
- Native：OpenClaw 2026.7.1，Node 24.19.0，23 工具，72 Skills，25 prompts。
- 头像：1254×1254 PNG，SHA-256 `5b2041a991225001a3574c43377b028ae36f9bc1a61cffef96be3bc91e09d362`。

运行 profile 固定到已验收的 Makaron project facade 后端，不改变现有网站的
Agent 入口。发现时使用后端当前工具合同，不凭历史 prompt 推断供应商可用性。

## 发布与验收

把本变更合入当前 GitHub dev，按 `deploy/mirror-v/README.md` 发布控制面。
在私有配置中只更新 `templates.makaron` 的 version、snapshot、构建 provenance、
头像 URL 与 modelVersions（保留旧版本列表）。验收后再开启 listed。
模型密钥、租户 Key 和 config 备份留在 `/opt/nexus/data`，不入 Git。

本次云端验收通过新 snapshot 创建独立测试租户，完成实际原生工具发现并
返回已打包的头像媒体，字节 hash 匹配源文件，没有新建项目或媒体生成。
此测试证明新实例启动、工具可达和媒体回传；真实新用户扫码后的飞书／微信
最终绑定仍需要用户在手机确认，不能以健康端点或本地 fixture 替代。

CLI/NPM parity：公开 CLI 的模型、参数、命令、help、README 和 bundled Skill
合同均未改变；账号 Key 连接沿用 CLI 的现有接口。Agent Kit 为 private package，
无需公开 npm 发包。控制面 DB 测试使用独立本地 PostgreSQL；ledger 的两个迁移
测试在同一 disposable DB 上串行运行，以消除并发建表冲突。
