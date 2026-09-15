"""通知投递层：绑定 → 通道选择（应用机器人 / 群自定义机器人 webhook）+ 失败回退。

改造背景（2026-09-15）：产品要求不再依赖群自定义机器人，回信应能直接投到用户对话。
历史实现把投递写死在群 webhook 上（自定义机器人无法私聊），本模块把"送达"抽出来，
使应用机器人（可 oc_ 群 / ou_ 私聊）成为首选通道，同时**保留旧 webhook 路径**。

设计原则（安全性优先）：
  1. **不动取信链路**：本模块只管"取到信之后怎么送达"，IMAP 轮询与 webhook 回调逻辑不受影响。
  2. **双通道，不删旧路**：应用机器人优先，群 webhook 保留为回退通道。
  3. **失败自动回退**：应用机器人失败且绑定上存在 ``webhook_url`` 时，自动改走 webhook，避免漏通知。
  4. **一键回退**：``DC_NOTIFY_DELIVERY=webhook_only`` 立即恢复改造前行为。
  5. **通知失败 ≠ 数据丢失**：任何失败都返回结构化结果（含每条通道的失败原因），不吞掉信息，
     也不影响已取回邮件本身的落库与状态。
"""

from __future__ import annotations

import os
from typing import Any, Callable

DELIVERY_MODE_ENV = "DC_NOTIFY_DELIVERY"
DELIVERY_MODES = ("app_bot_first", "app_bot_only", "webhook_only")
DEFAULT_DELIVERY_MODE = "app_bot_first"


def delivery_mode(explicit: str = "") -> str:
    """投递模式：显式参数 → ``DC_NOTIFY_DELIVERY`` → 默认 ``app_bot_first``。

    未知取值一律按默认处理（宁可走新通道的回退链，也不要静默变成"不发"）。
    """
    value = str(explicit or os.environ.get(DELIVERY_MODE_ENV, "") or "").strip().lower()
    return value if value in DELIVERY_MODES else DEFAULT_DELIVERY_MODE


def plan_channels(binding: dict | None, mode: str = "", *, fallback_webhook: str = "") -> list[str]:
    """按绑定与模式给出**按顺序尝试**的通道列表。

    - ``app_bot``：应用机器人（``FeishuSender``，支持 ``oc_`` 群与 ``ou_`` 私聊）
    - ``webhook``：群自定义机器人 webhook（旧路径，保留）

    不存在的通道不会被排进计划；两条都不具备时返回空列表（由调用方报错）。
    """
    resolved = delivery_mode(mode)
    binding = binding or {}
    chat_id = str(binding.get("chat_id") or "").strip()
    webhook_url = str(binding.get("webhook_url") or fallback_webhook or "").strip()

    has_app_bot = chat_id.startswith(("oc_", "ou_"))
    has_webhook = bool(webhook_url)

    if resolved == "webhook_only":
        return ["webhook"] if has_webhook else []
    if resolved == "app_bot_only":
        return ["app_bot"] if has_app_bot else []

    # app_bot_first：优先应用机器人，webhook 作为回退
    channels: list[str] = []
    if has_app_bot:
        channels.append("app_bot")
    if has_webhook:
        channels.append("webhook")
    return channels


def _default_sender():
    """应用机器人发送器（懒加载，避免与本仓库根模块形成导入环）。"""
    from dc_notify import FeishuSender  # noqa: PLC0415

    return FeishuSender()


def deliver(
    binding: dict | None,
    *,
    text: str,
    card: dict | None = None,
    mode: str = "",
    fallback_webhook: str = "",
    webhook_secret: str = "",
    sender: Any = None,
    webhook_send: Callable[[str, str, dict], None] | None = None,
) -> dict:
    """按计划通道投递一条通知，失败自动回退。**本函数不抛异常。**

    参数
    ----
    binding          绑定记录（含 ``chat_id`` / ``webhook_url`` / ``webhook_secret``）
    text             文本正文（应用机器人通道使用；私聊场景下不应含 @ 提及）
    card             交互卡片载荷（webhook 通道使用；``None`` 时回退为文本包装）
    mode             投递模式，见 :func:`delivery_mode`
    fallback_webhook 绑定未配 ``webhook_url`` 时的全局兜底 webhook（对应旧 ``--webhook`` 参数）
    sender           注入的应用机器人发送器（测试用；``None`` 时使用 FeishuSender）
    webhook_send     注入的 webhook 发送函数（测试用；``None`` 时使用 cron_notify._send_webhook）

    返回
    ----
    ``{"ok", "channel", "fallback", "attempts": [{"channel","ok","error"}], "error"}``

    ``ok=False`` 时说明**所有可用通道都失败**（或不具备任何通道）；调用方应把 ``error``
    向上暴露为可见告警，但**不得**因此丢弃已取回的邮件数据。
    """
    resolved = delivery_mode(mode)
    channels = plan_channels(binding, resolved, fallback_webhook=fallback_webhook)
    result: dict[str, Any] = {
        "ok": False,
        "mode": resolved,
        "channel": "",
        "fallback": False,
        "attempts": [],
        "error": "",
    }
    if not text and not card:
        result["error"] = "empty payload"
        return result
    if not channels:
        result["error"] = "no delivery channel available（既无应用机器人目标，也无 webhook）"
        return result

    for index, channel in enumerate(channels):
        if channel == "app_bot":
            body = text or _card_to_text(card)
            try:
                s = sender if sender is not None else _default_sender()
                res = s.send(str((binding or {}).get("chat_id") or ""), body)
                dry_run = bool(getattr(res, "dry_run", False))
                ok = bool(getattr(res, "ok", False)) and not dry_run
                err = "" if ok else str(getattr(res, "error", "") or "send failed")
                if dry_run:
                    # 全局发送开关被关闭：尊重开关，**不回退到 webhook**（否则等于绕过开关）。
                    err = "dry_run（发送被 DC_NOTIFY_SEND_ENABLED 禁用）"
                    result["attempts"].append({"channel": channel, "ok": False, "error": err})
                    result["error"] = err
                    return result
            except Exception as exc:  # noqa: BLE001 - 投递失败必须可见且不打断链路
                ok, err = False, f"{type(exc).__name__}: {exc}"
        else:  # webhook
            url = str((binding or {}).get("webhook_url") or fallback_webhook or "").strip()
            secret = str((binding or {}).get("webhook_secret") or webhook_secret or "")
            payload = card if isinstance(card, dict) else _text_to_card(text)
            try:
                fn = webhook_send or _default_webhook_send()
                fn(url, secret, payload)
                ok, err = True, ""
            except Exception as exc:  # noqa: BLE001
                ok, err = False, f"{type(exc).__name__}: {exc}"

        result["attempts"].append({"channel": channel, "ok": ok, "error": err})
        if ok:
            result["ok"] = True
            result["channel"] = channel
            result["fallback"] = index > 0
            return result

    result["error"] = "；".join(
        f"{a['channel']}:{a['error']}" for a in result["attempts"] if a.get("error")
    ) or "all channels failed"
    return result


def _default_webhook_send() -> Callable[[str, str, dict], None]:
    """旧 webhook 发送实现（懒加载，保持单一实现，不复制发送逻辑）。"""
    from email_gateway.cron_notify import _send_webhook  # noqa: PLC0415

    return _send_webhook


def _card_to_text(card: dict | None) -> str:
    """极简卡片→文本降级：只在没有 text 时兜底，避免投递内容为空。"""
    if not isinstance(card, dict):
        return ""
    try:
        title = (((card.get("card") or {}).get("header") or {}).get("title") or {}).get("content", "")
        return str(title) or "（无标题通知）"
    except Exception:  # noqa: BLE001
        return "（无标题通知）"


def _text_to_card(text: str) -> dict:
    """文本→卡片包装：仅在 webhook 通道未提供 card 时兜底。"""
    return {
        "msg_type": "interactive",
        "card": {
            "header": {
                "template": "purple",
                "title": {"content": "[出海精灵小元] 新邮件提醒", "tag": "plain_text"},
            },
            "elements": [
                {"tag": "div", "text": {"content": str(text or "")[:4000], "tag": "lark_md"}}
            ],
        },
    }
