#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统计上周一(2026-08-10)至今发送的邮件数，按发件人分组。key 从 /tmp/rk.txt 读取"""
import json, urllib.request
from collections import Counter

KEY = open("/tmp/rk.txt").read().strip()
H = {"Authorization": "***" + KEY, "User-Agent": "Mozilla/5.0"}
SINCE = "2026-08-10"


def fetch_all():
    out = []
    cursor = None
    for _ in range(60):
        url = "https://api.resend.com/emails?limit=100"
        if cursor:
            url += "&after=" + cursor
        req = urllib.request.Request(url, headers=H)
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode())
        data = d.get("data", [])
        out.extend(data)
        if not d.get("has_more") or not data:
            break
        cursor = data[-1].get("id")
    return out


def main():
    emails = fetch_all()
    since = [e for e in emails if (e.get("created_at") or "")[:10] >= SINCE]
    print(f"上周一({SINCE})至今发送邮件总数: {len(since)}")
    ev = Counter(e.get("last_event", "?") for e in since)
    print("状态分布:", dict(ev))
    c = Counter(e.get("from", "") for e in since)
    print("按发件人分组:")
    for f, n in c.most_common():
        print(f"  {n} 封 | {f}")


if __name__ == "__main__":
    main()
