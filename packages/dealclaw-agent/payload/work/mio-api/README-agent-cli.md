# Agent-Friendly CRM/CDP CLI

这不是方案整理文档，而是给 Agent 直接调用的 CLI 交付物。

## Agent 调用契约

所有命令都输出统一 JSON envelope：

```json
{"count": 1, "data": [], "error": null, "meta": {"version": "..."}}
```

失败时也输出 JSON，不输出 Python traceback。

## 自发现入口

```bash
./crm commands
./crm schema
./crm orders schema
./selection commands
./selection schema
```

## 安全计划模式（不访问上游）

```bash
./crm orders list --zone "宠物展区" --project "2026印尼" --stage "赢单" --dry-run
./selection search --industry "宠物" --country "印尼" --dry-run
```

## Mock 契约模式（无凭证测试）

```bash
./crm orders list --mock
./selection search --industry "宠物" --country "印尼" --mock
```

## Live 示例

```bash
./crm accounts search --name "海南省"
./crm contacts search --name "张三"
./crm deals list --stage "赢单" --sales "杨盛麟"
./crm orders list --zone "宠物展区" --project "2026印尼" --stage "赢单"
./crm orders summary --zone "宠物展区" --project "2026印尼" --stage "赢单" --group-by sales
./crm events list --account-id "185165007858443947"
./crm users search --name "杨盛麟"

./selection industries
./selection search --industry "宠物" --country "印尼"
./selection cdp --industry "宠物" --max-results 10000
```

## CRM 环境变量

- `ZOHO_CRM_CLIENT_ID`
- `ZOHO_CRM_CLIENT_SECRET`
- `ZOHO_CRM_REFRESH_TOKEN`
- 可选：`ZOHO_CRM_TOKEN_CACHE`，默认 `~/.cache/meorient/zoho_crm_token.json`

`zoho_crm_client.py` 已实现跨进程 token cache + 文件锁，降低 OAuth refresh 限流风险。

## CDP 环境变量

- `MIO_CDP_APP_SECRET` 或 `SELECTION_API_TOKEN`
- `MIO_CDP_SUPPLIER_ID`
- `MIO_CDP_PPS_ID`
- 可选：`MIO_CDP_APP_KEY`，默认 `tradechina`

## 测试

```bash
python3 -m pytest -q tests/test_agent_cli.py
./tests/run_live_qc.py          # dry QC，只跑非 live/负向契约
./tests/run_live_qc.py --live   # 真实 55 条验收，需要凭证和上游数据
```
