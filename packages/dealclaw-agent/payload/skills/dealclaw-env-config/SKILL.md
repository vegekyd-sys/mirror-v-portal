---
name: "dealclaw-env-config"
description: "手动配置 DealClaw 租户可变键（data/memory/tenant-env.json，可写）。supplier id / 数字人 open id 与默认值不同时，用 dc_env_config.py 写单个键；读取时 tenant-env.json 优先、.env(Secret) 兜底。"
---

# 配置租户环境变量

> 全局密钥（APOLLO_API_KEY / RESEND_API_KEY 等）由 `work/mio-api/.env`（symlink → K8s skill-env Secret，只读）提供。
> 但 supplier id（X-Supplier-Id）和数字人 open id（V 的 Feishu Open-Id）是**租户相关**的，不同租户值不同，
> 且 `.env` 在租户机器上只读、无法动态写入。故租户可变键改写到 `data/memory/tenant-env.json`（工作区根下、可写、跨重启保留）。
> 读取优先级：tenant-env.json > .env（Secret 兜底）。

## 核心原则

**只改目标键，绝不整文件重写。** 写入 `data/memory/tenant-env.json`（JSON，可写）；全局密钥（APOLLO_API_KEY、RESEND_API_KEY 等）留在只读的 `.env`（Secret），本工具不碰。

## 触发

| 场景 | 行为 |
|------|------|
| 用户说「配置 supplier id」「supplier id 是 xxx」「供应商 id 没配」 | 进入配置流程 |
| 用户说「配置数字人」「数字人 open id 没配」「V 的 open id 是 xxx」 | 进入配置流程 |
| 运行报错提示 `MIO_CDP_SUPPLIER_ID` / `MIO_V_OPEN_ID` 缺失或非法 | 先 `list` 确认状态，再引导配置 |
| 用户只说「配置环境变量」但没说是哪个 | 先 `list` 看哪些是「未配置」，让用户指认 |
| 用户说「初始化小元配置」「初始化」 | 进入初始化编排流程（绑定 push 到本群 + 设置 open id）|

## 初始化编排（「初始化小元配置」）

触发「初始化小元配置」/「初始化」时，按序执行两步，各自带确认门：

1. **绑定 push 到本群**（复用 `dealclaw-push-target` 逻辑）：
   - 取当前上下文 chat_id（`oc_` 开头）；DM 无群上下文则跳过，提示「到目标群里说一句再初始化」。
   - 若已有旧目标：先报「当前是 X，要改成 Y 吗」，**用户确认后**才 `python3 work/mio-api/dc_push_target.py set --force <oc_...>`；不确认不覆盖。
2. **设置 open id**（本 skill 逻辑）：
   - `python3 work/mio-api/dc_env_openid.py` 探测（或已知值 `python3 work/mio-api/dc_env_config.py set MIO_V_OPEN_ID <ou_...>`）。
   - 若已配置且值相同：跳过，报「open id 已配置」。
   - 若已配置但值不同：先报「当前是 X，要改成 Y 吗」，**用户确认后**再写；不确认不覆盖。
3. 两步完报「初始化完成：push→本群 oc_...，open id→ou_...」。

> 「重新设置」（已有 push 目标或 open id 时要覆盖）一律先确认再写，不静默覆盖。

## 取 open_id 子流程（机器人自己的 open_id）

**触发**：需要机器人自己的 open_id（配 `MIO_V_OPEN_ID`、绑定 `mention_open_id` 等），但用户没直接给值。

**首选（有 app_secret 时，无需进群，一条命令）**：

```bash
python3 work/mio-api/dc_env_openid.py
```

- 内部走 `bot/v3/info` 权威路径，直接探测并写入 `MIO_V_OPEN_ID`，返回即已完成 + 校验。
- 只探测不写入用 `--dry-run`。
- 依赖环境变量 `DEALCLAW_APP_SECRET`（镜像启动注入）；本地无 secret 时用下面的兜底。

**兜底（无 secret / 交互式排查，一条命令）**：

```bash
lark-cli im +chat-members-list --chat-id <oc_群id> --as bot --member-types bot \
  --jq '.data.bots[] | select(.name=="V - Makaron") | .member_id'
```

- 输出的 `member_id`（`ou_` 开头）就是机器人自己的 open_id。
- 群里多个 bot 时，`--jq` 按 `name` / `app_id` 过滤出自己；不确定就用 `.data.bots[] | {name, app_id, member_id}` 先看一遍再选。
- `<oc_群id>` 直接取当前会话 inbound 的群 id（`oc_` 开头）；DM 场景先 `lark-cli im +chat-list --types=p2p` 定位。

**禁止走的弯路（已验证全是坑，慢就慢在这）**：
- ❌ 全盘 grep `.env` / `ou_` / 历史日志 jsonl —— 值就在 bot 身份里，翻磁盘没必要
- ❌ 用 lark-cli 的 `api GET /open-apis/bot/v3/info` —— 它吞掉 `bot` 字段返回空 data，直接 HTTP 才能拿到（即 dc_env_openid.py 内部做法）
- ❌ 试 `contact +get-user` / `whoami` 等多轮网络往返
- 真正干活（读配置 + 写入 + 校验）不到 2s，别被弯路拖到 8s+

**校验**：拿到的值必须 `ou_` 开头，否则不是 open_id，不写入。

**备注**：查到的 open_id 属账号/路由信息，不写进群聊外的报告，不外泄。

## 配置流程

1. **确定键 + 值**：
   - 用户给了值 → 直接用。
   - 用户只说「没配」但没给值 → 问用户要，并说明格式：
     - `MIO_CDP_SUPPLIER_ID` = 纯数字（tradechina 供应商 id，X-Supplier-Id）
     - `MIO_V_OPEN_ID` = `ou_` 开头（数字人 V 的 Feishu Open-Id，不是群 `oc_`）
2. **看现状**：`python3 work/mio-api/dc_env_config.py get <KEY>` 看当前值。
3. **覆盖确认**：若已有值且与新值不同，先告诉用户「当前是 X，要改成 Y 吗」，确认后再写。
4. **写入**：`python3 work/mio-api/dc_env_config.py set <KEY> <VALUE>`（写入 tenant-env.json，不是 .env）
5. **验证**：`get <KEY>` 确认新值已写入（tenant-env.json 优先）；再 `list` 确认只有目标键变了、其它键仍「已配置」。
6. **生效说明**：各引擎启动时先 `load_tenant_env()`（读 tenant-env.json 塞 os.environ），再加载 .env 兜底，改完**下次触发即生效**；正在跑的长驻进程要重启才生效。改完明确告诉用户这一点。

## 校验规则

- `MIO_CDP_SUPPLIER_ID`：必须纯数字，否则工具报错退出，不要降级去猜。
- `MIO_V_OPEN_ID`：必须 `ou_` 开头，否则报错；别把群 `oc_` 或人名当 open id。
- 其它键：工具不校验格式，但**不建议**随意改 API key 类键（APOLLO_API_KEY / RESEND_API_KEY 等是全局密钥，改错会全线失败）。

## 关键约束

- **保留其它键**：`dc_env_config.py set` 只写 `data/memory/tenant-env.json` 的单个键（JSON，保留其它键）；`.env`（Secret）只读、只作兜底，本工具不改它。
- **值不外泄**：supplier id / open id 是账号/路由信息，不在群外、不在报告里外泄；`list` 只显示「已配置/未配置」，需要看具体值才 `get`。
- **覆盖需确认**：已有值不同时先确认，不静默覆盖。
- **生效时机**：引擎启动时 `load_tenant_env()` 优先读 tenant-env.json，改完下次触发生效；长驻进程需重启。别跟用户说「立刻生效」除非确实重启了。

## 失败模式

| 现象 | 处理 |
|------|------|
| `set` 报「非法值」 | 检查格式：supplier id 纯数字、open id `ou_` 开头 |
| `get` 返回「（未配置）」 | 确认键名拼写正确，或 tenant-env.json 与 .env 都没有该键 |
| 改了但运行还报缺 | 确认 tenant-env.json 路径正确（工作区根 `data/memory/tenant-env.json`）；长驻进程需重启，cron 等下次触发 |
| tenant-env.json 不存在 | 工具 `set` 会自动创建（mkdir + 写），不必手动建 |
| 用户给的是群 `oc_` | 那是聊天群 id，不是 open id；open id 是 `ou_`，让用户去确认 |

## 相关

- `work/mio-api/dc_env_config.py` — 本工具（list/get/set，写 tenant-env.json、读 .env 兜底）
- `work/mio-api/_tenant_env.py` — `load_tenant_env()`：引擎启动时把 tenant-env.json 塞进 os.environ（优先于 .env）
- `work/mio-api/dc_env_openid.py` — 一键固化 `MIO_V_OPEN_ID`（bot 自身 open_id，无需进群）
- `packages/dealclaw-agent/runtime/dc-env-config.sh` — 历史遗留（已废弃，entrypoint 不再调用；.env 现由 skill-env Secret 挂载）
- 读 `MIO_CDP_SUPPLIER_ID` / `MIO_V_OPEN_ID` 的引擎：`buyer_leads_daily.py`、`company_info.py`、`dc_daily_cycle.py`、`dc_auto_campaign.py`、`dc_lead_push_init.py`、`dc_profile_provision.py`
