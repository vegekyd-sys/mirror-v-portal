# DealClaw Agent 定时器注册清单

> 整理日期：2026-09-04
> 入口：`packages/dealclaw-agent/runtime/entrypoint.sh` 的 `init_runtime()`（第 212–219 行）
> 调度器：OpenClaw 内置 scheduler（`openclaw cron add`，非系统 crontab）

## 概览

entrypoint 启动后，等 gateway 就绪，依次调用 5 个 cron 注册脚本 + 1 个预加载脚本，共注入 **8 个 cron job**（均为 `command` 类型、`isolated`、`--no-deliver`）。

| 注册脚本 | 注入 job 数 | job 名 |
|---|---|---|
| `dc-cron-daily.sh` | 2 | `dealclaw-morning` / `dealclaw-evening` |
| `dc-cron-resend-poll.sh` | 1 | `dealclaw-resend-poll` |
| `dc-cron-email-poll.sh` | 1 | `dealclaw-email-reply-poll` |
| `dc-cron-buyer-onsite.sh` | 1 | `dealclaw-buyer-onsite-monitor` |
| `dc-cron-onsite-recommend.sh` | 3 | `dealclaw-onsite-recommend-{10,14,16}h` |
| `dc-ensure-agent-preload.sh` | 0（非 cron）| agent 预加载画像+线索池 |

---

## 一、job 明细

### 1. dealclaw-morning / dealclaw-evening（早晚报）

注册脚本：`dc-cron-daily.sh`

| 字段 | morning | evening |
|---|---|---|
| cron | `30 9 * * *`（09:30）| `30 17 * * *`（17:30）|
| 时区 | `Asia/Shanghai`（`DEALCLAW_CRON_TZ` / `--tz` 可覆盖）|
| command | `python3 -m dc_daily_cycle run --slot morning --execute --dispatch` | `python3 -m dc_daily_cycle run --slot evening --execute --dispatch` |
| cwd | `/data/workspace/work/mio-api` |
| env | `MIO_CDP_SUPPLIER_ID=<租户>`、`DC_NOTIFY_ALLOWED_COMPANIES=<租户>`、`DC_DATA_DIR=/data/workspace/work/mio-api/data` |
| delivery | `none`（`--no-deliver`，早晚报推送由 dc_daily_cycle 内部 `--dispatch` 完成）|
| declaration-key | `dealclaw-morning` | `dealclaw-evening` |

### 2. dealclaw-resend-poll（Resend 投递状态轮询）

注册脚本：`dc-cron-resend-poll.sh`

| 字段 | 值 |
|---|---|
| cron | `*/5 * * * *`（每 5 分钟）|
| command | `python3 -m dc_email_controller.dc_resend_source` |
| cwd | `/data/workspace/work/mio-api` |
| env | （无额外 env，账号由模块内部自读）|
| delivery | `none` |
| declaration-key | `dealclaw-resend-poll` |

### 3. dealclaw-email-reply-poll（个人邮箱回复轮询）

注册脚本：`dc-cron-email-poll.sh`

| 字段 | 值 |
|---|---|
| cron | `*/5 * * * *`（每 5 分钟）|
| command | `python3 -m email_gateway.cron_notify --all` |
| cwd | `/data/workspace/work/mio-api` |
| env | `DC_DATA_DIR=/data/workspace/work/mio-api/data` |
| delivery | `none`（有买家回复时由 cron_notify 内部推群卡片）|
| declaration-key | `dealclaw-email-reply-poll` |

### 4. dealclaw-buyer-onsite-monitor（买家到场监控）

注册脚本：`dc-cron-buyer-onsite.sh`

| 字段 | 值 |
|---|---|
| cron | `*/5 * * * *`（每 5 分钟）|
| command | `python3 monitor_buyer_onsite.py` |
| cwd | `/data/workspace/work/mio-api` |
| env | `MIO_CDP_SUPPLIER_ID=<租户>`、`MIO_V_OPEN_ID=<open_id>`、`OPENCLAW_WORKSPACE_DIR=/data/workspace` |
| delivery | `none` |
| declaration-key | `dealclaw-buyer-onsite-monitor` |

### 5. dealclaw-onsite-recommend（现场未邀约买家推荐）

注册脚本：`dc-cron-onsite-recommend.sh`

> **2026-09-16 改造**：从「3 条固定北京时间 cron」改成「1 条每小时 cron + 运行时按展会当地时间判断」。
> 旧的 `dealclaw-onsite-recommend-{10,14,16}h` 三条由注册脚本自动删除。

| 字段 | 值 |
|---|---|
| cron | `0 * * * *`（每小时轮询；**不代表推荐时点**）|
| command | `python3 dc_onsite_recommend.py run --slot-gate` |
| cwd | `/data/workspace/work/mio-api` |
| env | `MIO_CDP_SUPPLIER_ID=<租户>`、`MIO_V_OPEN_ID=<open_id>`、`OPENCLAW_WORKSPACE_DIR=/data/workspace` |
| delivery | `none` |
| timeout | 900s |
| declaration-key | `dealclaw-onsite-recommend` |

真正的推荐时点由脚本按展会当地时间判断，顺序：

1. 有没有 `state=3` 的在售展会 → 没有就 NO_RUN
2. 取展会国家 → 映射 IANA 时区（表在 `dc_onsite_recommend.py` 的 `COUNTRY_TZ`）
3. 用展会**当地日期**判断今天是否在展期内
4. 展会当地小时 ∈ 推荐时点（默认 10/14/16，可用 `DEALCLAW_ONSITE_SLOTS` 覆盖）→ 不是就 NO_RUN
5. 命中才拉现场买家、落池、发卡

**为什么每小时够**：北京每小时一次 = 任何时区每小时正好一次，每个「当地小时」恰好覆盖一次，
天然不重复推送。印度这类 +5:30 时区，北京整点对应当地 :30，小时值仍正确。

**API 成本**：`state=3` 展会记录在 py 侧有 6 小时缓存（空结果同样缓存），实际约 4 次/天，
和改造前 3 次/天基本持平。

---

## 二、入口 Python 及参数明细

### dc_daily_cycle.py（早晚报）

模块调用：`python3 -m dc_daily_cycle run ...`

`run` 子命令参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `--slot` | ✅ | `morning` / `evening` |
| `--execute` | ❌ | 真实执行内部 Todo 并 publish（默认 dry-run）|
| `--dispatch` | ❌ | 真实 dispatch pending（发送 push）|
| `--company-id` | ❌ | 企业 ID（缺省读 `MIO_CDP_SUPPLIER_ID`）|

另有独立子命令 `morning`（生成 Todo 计划）/ `evening`（核验当天结果）。

### dc_email_controller.dc_resend_source（Resend 轮询）

模块调用：`python3 -m dc_email_controller.dc_resend_source`（无命令行参数，入口 `if __name__ == "__main__"`）。

### email_gateway.cron_notify（邮箱回复轮询）

模块调用：`python3 -m email_gateway.cron_notify --all`

| 参数 | 说明 |
|---|---|
| `--data-dir` | 数据目录（默认 `DC_DATA_DIR`）|
| `--account-id` / `--all` | 账号范围（互斥，`--all` 处理全部账号）|
| `--webhook` / `--webhook-secret` | 飞书 bot webhook（fallback，未绑定群时用）|

### monitor_buyer_onsite.py（买家到场监控）

调用：`python3 monitor_buyer_onsite.py`

| 参数 | 说明 |
|---|---|
| `--company-id` | 企业 ID（缺省读 `MIO_CDP_SUPPLIER_ID`）|
| `--chat-id` | 展商群 chat_id（缺省读 dc_notify routes default）|
| `--mock-file` | 本地 mock 到场通知 JSON（不走真实接口）|
| `--dry-run` | 只打印不执行 |

### dc_onsite_recommend.py（现场推荐）

调用：`python3 dc_onsite_recommend.py run`（cron 额外带 `--slot-gate`）

| 参数 | 说明 |
|---|---|
| `action` | 位置参数，`run` |
| `--company-id` | 企业 ID（缺省读 `MIO_CDP_SUPPLIER_ID`）|
| `--exhibition-id` | 指定展会 ID（跳过自动判断当前展会）|
| `--chat-id` | 群 chat_id（缺省读 dc_notify routes default）|
| `--dry-run` | 只打印不执行 |
| `--slot-gate` | **cron 专用**：按展会当地时间判断是否到推荐时点，不到就 NO_RUN |
| `--slots` | 推荐时点，展会当地整点，逗号分隔（默认 `10,14,16`），仅配合 `--slot-gate` 生效 |
| `--no-cache` | 跳过展会记录缓存，强制重新拉取 |

> ⚠️ skill `dealclaw-onsite-recommend` 调的是同一条命令但**不带 `--slot-gate`**，
> 所以用户现场主动喊「搜现场买家」任何时间都能跑，行为和改造前一致。加时点闸门时
> 务必保持这个默认关闭，否则手动触发会被挡掉。

---

## 三、关键设计说明

1. **统一 `--no-deliver`**：8 个 job 全部 `delivery: none`。因为它们的「通知」走各自入口内部逻辑（dc_daily_cycle `--dispatch`、cron_notify 推群卡片、dc_notify routes），cron 层投 stdout 是多余的，且默认 `channel:last` 在隔离环境无路由会报错。

2. **身份显式传 env**：morning/evening、buyer-onsite、onsite-recommend 都通过 `--command-env` 显式传 `MIO_CDP_SUPPLIER_ID` / `MIO_V_OPEN_ID`，不再依赖运行时 `set -a; . .env`（早前 `.env` 不存在导致 `exit 2` 的坑已修）。

3. **幂等**：每个 job 用 `--declaration-key` 判重，重启 Pod 不重复注册。

4. **时区**：默认 `Asia/Shanghai`；早晚报可用 `DEALCLAW_CRON_TZ` / `--tz` 覆盖；onsite-recommend 按展会国家自动映射当地时间。

5. **xiaoyuan CLI 路径兼容**：onsite 相关脚本调 `xiaoyuan` 用 `shutil.which` / `command -v` 优先 PATH，fallback `/opt/xiaoyuan-venv/bin/xiaoyuan`（cron 环境 PATH 不含 venv 的坑已修）。

6. **agent 预加载**：`dc-ensure-agent-preload.sh` 不是 cron，是 gateway 就绪后一次性预加载画像+线索池（marker 版本判重，`DEALCLAW_PRELOAD_FORCE=1` 可强制重跑）。

---

## 四、开发约定（新增定时任务 checklist）

**当开发涉及「定期拉取」（轮询拉数据）或「定期推送」（定时通知）时，必须同步添加 cron 注册脚本**，否则定时任务不会被注册、不会跑：

1. 在 `runtime/` 下新增 `dc-cron-<name>.sh`（参考现有 `dc-cron-*.sh` 结构）。
2. 在 `entrypoint.sh` 的 `init_runtime()` 里加一行注册调用：`bash /opt/dealclaw/runtime/dc-cron-<name>.sh || echo "[dealclaw-runtime] dc-cron-<name>.sh 失败" >&2`。
3. 注册命令（`openclaw cron add`）务必带：
   - `--declaration-key`（幂等，重启不重复注册）
   - `--no-deliver`（除非确实需要 cron 层投递，否则通知走内部逻辑）
   - `--command-env` 显式传身份（`MIO_CDP_SUPPLIER_ID` / `MIO_V_OPEN_ID`），不依赖 `set -a; . .env`
4. 命令调 `xiaoyuan` 时用 `shutil.which` / `command -v` 兼容绝对路径（cron 环境 PATH 不含 `/opt/xiaoyuan-venv/bin`）。
