---
name: "dealclaw-env-config"
description: "手动配置 DealClaw 租户环境变量（work/mio-api/.env）。当 supplier id / 数字人 open id 与镜像默认值不同或未配置时，用 dc_env_config.py 安全改单个键，不整文件重写。"
---

# 配置租户环境变量

> 每个租户一个独立 DealClaw 镜像，启动时 `dc-env-config.sh` 用**默认值**写 `work/mio-api/.env`。
> 但 supplier id（X-Supplier-Id）和数字人 open id（V 的 Feishu Open-Id）是**租户相关**的，不同租户值不同。
> 当租户这两个值跟默认值不一致、或压根没配时，用本 skill 手动改 `.env` 的对应键。

## 核心原则

**只改目标键，绝不整文件重写 `.env`。** 其余键（APOLLO_API_KEY、RESEND_API_KEY 等）是全局密钥，注释和顺序都保留原样。

## 触发

| 场景 | 行为 |
|------|------|
| 用户说「配置 supplier id」「supplier id 是 xxx」「供应商 id 没配」 | 进入配置流程 |
| 用户说「配置数字人」「数字人 open id 没配」「V 的 open id 是 xxx」 | 进入配置流程 |
| 运行报错提示 `MIO_CDP_SUPPLIER_ID` / `MIO_V_OPEN_ID` 缺失或非法 | 先 `list` 确认状态，再引导配置 |
| 用户只说「配置环境变量」但没说是哪个 | 先 `list` 看哪些是「未配置」，让用户指认 |

## 配置流程

1. **确定键 + 值**：
   - 用户给了值 → 直接用。
   - 用户只说「没配」但没给值 → 问用户要，并说明格式：
     - `MIO_CDP_SUPPLIER_ID` = 纯数字（tradechina 供应商 id，X-Supplier-Id）
     - `MIO_V_OPEN_ID` = `ou_` 开头（数字人 V 的 Feishu Open-Id，不是群 `oc_`）
2. **看现状**：`python3 work/mio-api/dc_env_config.py get <KEY>` 看当前值。
3. **覆盖确认**：若已有值且与新值不同，先告诉用户「当前是 X，要改成 Y 吗」，确认后再写。
4. **写入**：`python3 work/mio-api/dc_env_config.py set <KEY> <VALUE>`
5. **验证**：`get <KEY>` 确认新值已写入；再 `list` 确认只有目标键变了、其它键仍「已配置」。
6. **生效说明**：cron 任务每次触发时 `source .env` 重新读，改完**下次触发即生效**；正在跑的长驻进程要重启才生效。改完明确告诉用户这一点。

## 校验规则

- `MIO_CDP_SUPPLIER_ID`：必须纯数字，否则工具报错退出，不要降级去猜。
- `MIO_V_OPEN_ID`：必须 `ou_` 开头，否则报错；别把群 `oc_` 或人名当 open id。
- 其它键：工具不校验格式，但**不建议**随意改 API key 类键（APOLLO_API_KEY / RESEND_API_KEY 等是全局密钥，改错会全线失败）。

## 关键约束

- **保留其它键**：`dc_env_config.py` 只改目标键，注释、顺序、其它 `KEY=VALUE` 原样保留，禁止整文件重写。
- **值不外泄**：supplier id / open id 是账号/路由信息，不在群外、不在报告里外泄；`list` 只显示「已配置/未配置」，需要看具体值才 `get`。
- **覆盖需确认**：已有值不同时先确认，不静默覆盖。
- **生效时机**：`.env` 由 cron 运行时 `source`，改完下次触发生效；长驻进程需重启。别跟用户说「立刻生效」除非确实重启了。

## 失败模式

| 现象 | 处理 |
|------|------|
| `set` 报「非法值」 | 检查格式：supplier id 纯数字、open id `ou_` 开头 |
| `get` 返回「（未配置）」 | 确认键名拼写正确，或 `.env` 文件不存在/为空 |
| 改了但运行还报缺 | 确认改的是 `work/mio-api/.env`（相对工作区根）；长驻进程需重启，cron 等下次触发 |
| `.env` 不存在 | 工具 `set` 会自动创建（mkdir + 写），不必手动建 |
| 用户给的是群 `oc_` | 那是聊天群 id，不是 open id；open id 是 `ou_`，让用户去确认 |

## 相关

- `work/mio-api/dc_env_config.py` — 本工具（list/get/set，安全读写单个键）
- `packages/dealclaw-agent/runtime/dc-env-config.sh` — 启动时用默认值写 `.env`（镜像入口）
- 读 `MIO_CDP_SUPPLIER_ID` / `MIO_V_OPEN_ID` 的引擎：`buyer_leads_daily.py`、`company_info.py`、`dc_daily_cycle.py`、`dc_auto_campaign.py`、`dc_lead_push_init.py`、`dc_profile_provision.py`
