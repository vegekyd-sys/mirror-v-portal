# 微信通知链路改动（2026-09-12）

> 来源：田耕郡当日微信端全链路实测复盘（5 个卡点）
> 用途：① 运行时改动回灌仓库的留档；② 发布时「数据可信 / 通道可换」的素材；③ 后续同类问题的回归基线

## 一、当日任务（已跑通）

企业画像（上海兆勤）→ 越南找买家（50 家入线索池）→ 联系人解锁（16 家）→ 越南市场报告（18 页 HTML + 摘要图）→ 邮件发信（gege@mail.dealclaw.io）→ **微信回复通知全链路**（发信 → 收信 → 识别意图 → 微信弹通知带原文）

## 二、卡点 → 根因 → 修复 → 回归测试

| # | 现象 | 根因 | 修复（落库位置） | 回归测试 |
|---|---|---|---|---|
| 1 | `send.dealclaw.io` 收不到回复 | 该域名只配了发信验证，没有收信 MX | 换用 `mail.dealclaw.io`（收发都配好），发件地址 `gege@mail.dealclaw.io` | 配置项，人工验证（见校验命令） |
| 2 | 回复弹不到微信 | 通知发送器只有 `feishu`/`disabled` 两档，通道写死飞书 | `dc_notify.py`：新增 `WeixinSender`（走 `openclaw message send --channel openclaw-weixin`）+ 工厂加 `weixin` 分支 + 路由校验放行 `@im.wechat`（`resolve_target` / `resolve_notification_route` 两处） | `tests/test_notify_weixin.py`：工厂选型、参数校验、dry-run、CLI 参数拼装、失败/超时/命令缺失、路由放行与拒绝 |
| 3 | 检测到回复但 signals=0、不推送 | 直发通道只写 `sent-log.jsonl`，**没落 outbound 事实** → 收信匹配不到原发件（`no_matching_outbound`） | `dc_email_send.py`：发信成功后 best-effort 落 outbound 事实（含 `account_id`/`resend_id`/`company_id`，account 按 `from_addr` 匹配） | `tests/test_notify_weixin.py::OutboundFactTest`：成功落一条事实且字段正确；失败不落 |
| 4 | 通知只有摘要，看不到买家原话 | `format_candidate_message` 没带 `evidence` | `dc_email_controller/dc_signal_push.py`：通知带「买家原文」（剥掉 `---- 回复的原邮件 ----` 之后的引用，截 300 字） | 同上：原文出现、引用被剥离、截断生效、缺字段提示保留 |
| 5 | WhatsApp 发不出去 | `YCLOUD_API_KEY` 未配置 | **未修复**：需凭据（走受控隐藏输入，不进聊天/不进仓库） | — |

另有一处配套改动：`dc_signal_push._push_enabled()` 的通道白名单由 `!= "feishu"` 改为 `not in ("feishu", "weixin")`——否则通道换好了，推送开关仍然把消息拦在 `push_disabled`。

## 三、两条对所有租户成立的教训（不是微信专属）

1. **通知通道不能写死单一 IM。** 写死飞书 = 微信租户直接失能：数据齐、信号生成了，却没人收到。
2. **发信必须落事实。** 事实层少写一条 → 下游匹配失败 → 静默失效、不报错。这与「回复恒 0」（读错字段名）是同一类病：**缺失/错读被静默吞掉，而不是报错**。

## 四、配置（属于租户数据，不进 payload 源）

`data/memory/tenant-env.json` 追加：

```json
{
  "DC_NOTIFY_SENDER_MODE": "weixin",
  "DC_NOTIFY_WEIXIN_ACCOUNT": "<openclaw 微信账号 id>",
  "DC_SIGNAL_PUSH_AUTOMATION_MODE": "live"
}
```

`data/notifications/routes.json`：`default` 指向微信会话 id（形如 `<...>@im.wechat`）。

校验（只读，不发送）：

```bash
python3 - <<'PY'
import json, os
from dc_notify import build_sender_from_env, NotifyEngine
print("sender =", type(build_sender_from_env()).__name__)
print("route  =", NotifyEngine().resolve_notification_route(os.getenv("DC_COMPANY_ID", "default")))
PY
```

上线前必须确认：`sender` 是 `WeixinSender`、`route.status == "ok"`，且 `DC_NOTIFY_SEND_ENABLED` 与 `DC_SIGNAL_PUSH_*` 的开关组合符合预期（默认关闭，显式开启）。

## 五、遗留

- WhatsApp：等 `YCLOUD_API_KEY`（受控隐藏输入，值不入聊天/仓库）。
- 本文件记录的是**等价落库**（仓库侧实现 + 测试）；运行时那份改动若与仓库实现有出入，以仓库为源、运行时重新同步。
