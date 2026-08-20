#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把修复后的模板发一份到 mengyuchuan@meorient.com 供检查。用法: python3 send_test_fixed.py <api_key>"""
import json, sys, urllib.request

API_KEY = sys.argv[1] if len(sys.argv) > 1 else ""
TEMPLATE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspace/work/intex-email/email-pt-standalone.html"


def main():
    html = open(TEMPLATE, encoding="utf-8").read()
    html = html.replace("[Nome do Comprador]", "Boris")

    body = json.dumps({
        "from": "INTEX Brasil 2026 <mengyuchuan@mail.dealclaw.io>",
        "to": ["mengyuchuan@meorient.com"],
        "subject": "INTEX Brasil 2026 — Convite Oficial para Compradores (修復版)",
        "html": html,
        "reply_to": ["mengyuchuan@meorient.com"],
        "headers": {
            "List-Unsubscribe": "<mailto:unsubscribe@mail.dealclaw.io?subject=Unsubscribe>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.resend.com/emails", data=body, method="POST",
        headers={
            "Authorization": API_KEY,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        },
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        print("SEND OK:", r.read().decode()[:120])


if __name__ == "__main__":
    main()
