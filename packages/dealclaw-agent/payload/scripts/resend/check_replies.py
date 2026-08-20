#!/usr/bin/env python3
"""Resend 邮件追踪轮询 — 每5分钟检查打开/回复/退信"""
import json, os, sys, time, time, requests
from datetime import datetime

RESEND_KEY = os.environ.get("RESEND_API_KEY", "")

# 需要追踪的邮件ID
TRACKED = {
    "24d63e80-fcbc-439c-8f72-c02f887669fc": "Castore",
    "bb908555-01bb-4d57-a37d-9a4d21da9a21": "Adanola",
    "4fab9de3-b9df-46a7-93a6-7d05c70f598a": "DICKS-Ali",
    "c06fd6fc-ce4d-4b74-9388-41d989de79cd": "DICKS-Jenna",
    "23c72938-9c04-4d6f-9c9e-7c9b33997fe4": "Oner Active",
    "950c1976-0db7-415a-9638-64bfb9ab9da7": "Varley",
    "b74991af-fc5e-41e0-ac2c-e02dc8bd23aa": "LSKD",
    "57087ae6-8fb6-4072-bc0e-ecf05dd10353": "LNDR",
    "a0e2b73b-8987-4119-b844-31568ed0e12e": "NAGNATA",
    "e2c48517-8199-4612-8caf-10c14993e75c": "GMG/SSS",
    "781ecb91-1a40-4cbf-9494-a519f1f565ba": "Rebel",
    "bf6d0375-0972-4685-a7b9-f938a3874cdf": "Korea",
}

CHECKED_FILE = "/tmp/resend_checked.json"

def load_checked():
    if os.path.exists(CHECKED_FILE):
        with open(CHECKED_FILE) as f:
            return json.load(f)
    return {}

def save_checked(data):
    with open(CHECKED_FILE, "w") as f:
        json.dump(data, f)

def check():
    checked = load_checked()
    changes = []
    headers = {"Authorization": RESEND_KEY}

    for eid, name in TRACKED.items():
        r = requests.get(f"https://api.resend.com/emails/{eid}", headers=headers)
        d = r.json()
        event = d.get("last_event", "?")
        opens = d.get("opens_count", 0)
        clicks = d.get("clicks_count", 0)

        prev = checked.get(eid, {})
        prev_event = prev.get("event", "")
        prev_opens = prev.get("opens", 0)

        if event != prev_event or opens > prev_opens:
            changes.append(f"{'🔔' if event == 'opened' else '📨'} {name}: {event} | opens={opens} | clicks={clicks}")

        checked[eid] = {"event": event, "opens": opens, "clicks": clicks, "time": datetime.now().isoformat()}

    save_checked(checked)

    if changes:
        print("=== 邮件状态变化 ===")
        for c in changes:
            print(c)
    else:
        print("无变化")

if __name__ == "__main__":
    check()

# ── 定时轮询模式 ──
if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        interval = int(sys.argv[2]) if len(sys.argv) > 2 else 300
        print(f"Starting reply poller (interval={interval}s)")
        while True:
            try:
                check()
            except Exception as e:
                print(f"Poll error: {e}")
            time.sleep(interval)
    else:
        check()
