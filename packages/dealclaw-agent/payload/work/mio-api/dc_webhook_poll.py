#!/usr/bin/env python3
"""
DC Webhook Poller — 轮询 webhook 事件 → 飞书 DM 通知
====================================================
每分钟拉一次 webhook.dealclaw.io/events/recent，
按 to_address 反查 open_id，DM 推送通知。

绑定表 email→open_id 在本地配置文件维护，不写死在 handler 上。

用法:
  python3 dc_webhook_poll.py                    # 单次检查
  python3 dc_webhook_poll.py --daemon 60        # 每60秒轮询
"""

import json, os, sys, time, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
CURSOR_FILE = DATA_DIR / "webhook_cursor.json"
BINDING_FILE = Path(__file__).resolve().parent / "dc_email_bindings.json"

WEBHOOK_EVENTS_URL = "https://webhook.dealclaw.io/events/recent"

def _now():
    return datetime.now(timezone.utc).isoformat()

# ── 绑定表 ──────────────────────────────────────────
def load_bindings():
    """加载 email → owner 绑定"""
    if BINDING_FILE.exists():
        return json.loads(BINDING_FILE.read_text())
    return {}

def resolve_owner(to_address, bindings=None):
    """根据收件邮箱反查 owner 信息"""
    if bindings is None:
        bindings = load_bindings()
    # 精确匹配
    if to_address in bindings:
        return bindings[to_address]
    # 域名通配匹配：@mail.dealclaw.io 默认归管理员
    for email, info in bindings.items():
        if email == to_address:
            return info
    return None

# ── 游标管理 ────────────────────────────────────────
def load_cursor():
    if CURSOR_FILE.exists():
        return json.loads(CURSOR_FILE.read_text())
    return {"last_ts": None, "last_id": None}

def save_cursor(ts, event_id):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CURSOR_FILE.write_text(json.dumps({"last_ts": ts, "last_id": event_id}))

# ── 事件拉取 ────────────────────────────────────────
def fetch_events():
    try:
        r = urllib.request.Request(WEBHOOK_EVENTS_URL, method="GET")
        with urllib.request.urlopen(r, timeout=10) as resp:
            data = json.loads(resp.read())
            if isinstance(data, list):
                return data
            return data.get("events", [])
    except Exception as e:
        print(f"[{_now()}] Fetch error: {e}")
        return None

# ── 筛选新事件 ──────────────────────────────────────
def filter_new(events):
    cursor = load_cursor()
    last_ts = cursor.get("last_ts")
    new_events = []
    for ev in events:
        ev_ts = ev.get("timestamp", ev.get("created_at", ""))
        if last_ts and ev_ts <= last_ts:
            continue
        new_events.append(ev)
    if new_events:
        latest = new_events[-1]
        save_cursor(latest.get("timestamp", latest.get("created_at", "")),
                    latest.get("id", ""))
    return new_events

# ── 通知格式化 ──────────────────────────────────────
def format_notification(event):
    etype = event.get("type", event.get("event_type", "unknown"))
    sender = event.get("from", "?")
    to_addr = event.get("to", "?")
    subject = event.get("subject", "")
    text = (event.get("text", "") or "")[:150]
    timestamp = (event.get("timestamp", ""))[:19]

    if etype in ("email.received", "inbound", "email.inbound"):
        return (
            f"📩 收件: {to_addr}\n"
            f"发件: {sender}\n"
            f"主题: {subject}\n"
            f"时间: {timestamp}\n\n"
            f"{text}"
        )
    return f"📨 {etype} | from {sender}"

# ── 推送 ────────────────────────────────────────────
# 推送由外部的 message.send 机制处理，这里只输出结构化通知
# 实际运行时由 OpenClaw 消费 stdout 或通过子进程调用
def format_notify_json(event, owner_info):
    """生成标准通知 JSON，供 message.send 消费"""
    to_address = event.get("to", "")
    etype = event.get("type", event.get("event_type", "unknown"))
    sender = event.get("from", "?")
    subject = event.get("subject", "")
    text = (event.get("text", "") or "")[:300]
    timestamp = (event.get("timestamp", ""))[:19]

    if owner_info is None:
        owner_info = {"open_id": "", "name": "unknown", "enterprise": "unknown"}

    return {
        "open_id": owner_info.get("open_id", ""),
        "name": owner_info.get("name", "unknown"),
        "enterprise": owner_info.get("enterprise", "unknown"),
        "message": format_notification(event),
        "event": {
            "type": etype,
            "from": sender,
            "to": to_address,
            "subject": subject,
            "timestamp": timestamp,
        }
    }

def poll_once():
    events = fetch_events()
    if events is None:
        return []
    new = filter_new(events)
    notifications = []
    bindings = load_bindings()
    for ev in new:
        to_addr = ev.get("to", "")
        owner = resolve_owner(to_addr, bindings)
        notifications.append(format_notify_json(ev, owner))
        # 🔗 Heartbeat: 邮件回复记录
        try:
            from heartbeat_data import append_email_reply
            event_id = ev.get("id", ev.get("event_id", ev.get("message_id", "")))
            sender_email = ev.get("from", "")
            append_email_reply(
                message_id=event_id,
                buyer=sender_email,
                contact=sender_email,
                subject=ev.get("subject", "")[:200],
                intent=ev.get("iq_intent", "") or "unknown",
                value=ev.get("iq_value", "") or "normal",
                notes=(ev.get("text", "") or "")[:200],
            )
        except Exception as _hb_err:
            print(f"[heartbeat] append_email_reply failed: {_hb_err}")
    return notifications

# ── 守护模式 ────────────────────────────────────────
def daemon(interval=60):
    print(f"[{_now()}] DC Webhook Poller started, interval={interval}s")
    print(f"  Endpoint: {WEBHOOK_EVENTS_URL}")

    while True:
        try:
            notifs = poll_once()
            if notifs:
                print(f"[{_now()}] {len(notifs)} new event(s)")
                for n in notifs:
                    print(f"  → DM to {n['name']} ({n['open_id']}): {n['message'][:80]}")
                    # 实际推送在这里由 OpenClaw message.send 完成
                    # print(json.dumps(n, ensure_ascii=False))
            time.sleep(interval)
        except KeyboardInterrupt:
            print(f"\n[{_now()}] Stopped")
            break
        except Exception as e:
            print(f"[{_now()}] Error: {e}")
            time.sleep(interval)

if __name__ == "__main__":
    import sys
    if "--daemon" in sys.argv:
        interval = int(sys.argv[sys.argv.index("--daemon") + 1]) if len(sys.argv) > 2 else 60
        daemon(interval)
    else:
        notifs = poll_once()
        if notifs:
            for n in notifs:
                print(f"[{_now()}] New: {n['name']} ({n['open_id']})")
                print(f"  {n['message']}")
        else:
            print(f"[{_now()}] No new events")
