# TOOLS.md — DealClaw Routing

## Core routes
- 企业官网/公开资料：`web_fetch` → `web_search` → `browser`（登录态或复杂页面）
- B2B 买家与市场：`work/mio-api/dc_buyer_adapter.py`、`apollo_client.py`，失败后用公开 Web 兜底
- 社交/平台检索：Apify-first skills + `APIFY_TOKEN` 环境变量；先小样本验证再放大
- PDF/图片材料：优先一等工具 `pdf` / `image`，再按 skill 处理
- 飞书文档/多维表格：`lark-cli` 与 lark/feishu skills
- 邮件：`scripts/resend/` 或 `scripts/founder-direct/`；必须预览并获得明确确认后发送

## Credentials
真实凭证不得进入 workspace/git。通过进程环境、独立 secrets 注入或 agent 专属 auth 配置提供：
`APIFY_TOKEN`, `APOLLO_API_KEY`, `MIO_CDP_APP_KEY`, `MIO_CDP_APP_SECRET`, `RESEND_API_KEY`, SMTP/IMAP 账号, YCloud/WhatsApp, Feishu/Lark。

迁移自同机旧目录的密钥仅作为待迁移来源，不在此 workspace 复制：
- `/home/openclaw/makaron-openclaw/.openclaw-local/workspace/work/mio-api/.env`
- `/home/openclaw/makaron-openclaw/.openclaw-local/workspace/scripts/resend/.env`
- `/home/openclaw/makaron-openclaw/.openclaw-local/workspace/scripts/founder-direct/accounts/`
