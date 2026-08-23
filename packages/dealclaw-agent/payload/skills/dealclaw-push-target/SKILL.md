---
name: "dealclaw-push-target"
description: "配置 DealClaw 推送主接收方。单租户单接收方：一个主群 chat_id 或主用户 open_id，写进 notify_routes.json 的 default 键，dispatch 时 dc_notify.resolve_target 读取，不以 company_id 作路由主键。"
---

# 配置推送目标

> 每个租户一个独立 DealClaw 镜像 + 固定 supplier id，只需一个「主接收方」收早晚报/买家提醒等推送。
> 推送目标写进 `work/mio-api/data/notifications/routes.json` 的 `default` 键，由 `dc_notify.resolve_target`（早晚报）和 `resolve_notification_route`（买家提醒 signal_item）读取。
> company_id 不作为路由主键（初始化时不知道），`default` 即主接收方；原 company_id 专属路由仅作兼容保留。

## 触发

| 场景 | 行为 |
|------|------|
| 用户说「配置推送」「绑定推送群」「推送发到这个群」「设置推送目标」 | 进入配置流程 |
| 初始化时用户说「开始初始化」「配置接收方」 | 进入配置流程 |
| 用户给了一个 `oc_` / `ou_` 开头的 id 说「发到这里」 | 直接 set |

## 配置流程

1. **确定目标**：
   - 群聊上下文里说「配置到这个群」→ 取**当前消息上下文的 chat_id**（`oc_` 开头），无需用户手动复制。
   - 私聊（DM）上下文 → 没有群 chat_id，问用户要 open_id（`ou_`），或让用户到目标群里说一句再配。
   - 用户要发给某个**人**→ 需要该用户的 open_id（`ou_` 开头），问用户要；注意这是「接收方的 open_id」，不是机器人自己的。
   - 用户直接给 id → 用它。
2. **写入**：
   - 首次：`python3 work/mio-api/dc_push_target.py set <oc_xxx|ou_xxx>`
   - 覆盖：若已存在主接收方，先告诉用户「当前是 X，要改成 Y 吗」，确认后再 `set --force <...>`；不确认不覆盖。
3. **验证（外部动作）**：目标确认无误后，`python3 work/mio-api/dc_push_target.py test` 发一条真实测试消息，让用户确认收到。
4. **回报**：告诉用户「推送已绑定到 xxx，刚才发了测试消息，看下收到没」。

## 校验规则

- 合法 target：`oc_`（群 chat_id）或 `ou_`（用户 open_id）开头。
- 其它一律拒绝，脚本会报错退出，不要降级去猜。
- `ou_`（私聊）需要机器人有该用户可见性；群 `oc_` 需要机器人在群内。

## 关键约束

- **单接收方**：只维护 routes.json 的 `default` 键一个值，要换就 `set --force` 覆盖。
- **覆盖需确认**：已有主接收方时，`set` 不带 `--force` 会返回 `needs_confirm`，不要静默覆盖。
- **文件是真相源**：`dc_push_target.py` 只改 `default` 键，routes.json 里其它 company_id 专属条目原样保留，禁止整文件重写。
- **不暴露**：chat_id/open_id 属内部路由信息，不在群外、不在报告里外泄。
- **company_id 不用作路由主键**：初始化时根本不知道 company_id，dispatch 优先认 `default`。

## 失败模式

| 现象 | 处理 |
|------|------|
| `set` 报 target 非法 | 检查是不是 `oc_`/`ou_` 开头，别把群名/人名当 id |
| `set` 返回 `needs_confirm` | 已存在主接收方，问用户是否覆盖，确认后 `set --force` |
| `test` 发不出去 | 检查机器人是否在该群 / 该 open_id 是否可见；查 `openclaw message send --dry-run` 看 payload |
| dispatch 仍 route_missing | 确认 routes.json 的 `default` 键已写入且内容合法 |
| 用户要换接收方 | `set --force` 覆盖 |

## 相关

- `work/mio-api/dc_notify.py` — `resolve_target` / `resolve_notification_route` 均优先 company_id 专属路由，其次 `default` 键
- `work/mio-api/dc_push_target.py` — get/set/test/unset 工具（set 覆盖需 --force）
- 发送走 `openclaw message send --channel feishu --target <id> --message ...`
