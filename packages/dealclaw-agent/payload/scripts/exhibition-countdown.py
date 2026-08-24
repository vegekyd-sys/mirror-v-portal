#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""展会倒计时每日提醒 — 多企业通用 runner

每天 9:00 由 crontab 触发：遍历所有企业，计算距展会开展天数，发飞书卡片到各自群。
- 展会未开始：倒计时卡片 + 当日建议动作
- 展会进行中：提醒展中要点
- 展会已结束：不再发卡片（自动跳过）
- 企业无展会数据：标「待补」，静默不推（不编时间地点）

数据来源（config.companies[]）：
- exhibitions[]：企业展会数据（手动录入；后续可接 CDP 自动拉取）
- supplier_id：预留，用于后续按企业从 CDP 拉参展计划
- webhook：企业绑定群
"""
import json
import os
import urllib.request
from datetime import date, datetime

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "exhibition-countdown-config.json")


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def days_between(d1, d2):
    return (d1 - d2).days


def advice_for(days):
    if days >= 21:
        return "确认展品清单与运输计划，锁定新品样品"
    if days >= 15:
        return "确定目标买家名单，开始发邀约邮件"
    if days >= 8:
        return "邀约冲刺：跟进买家回复，确认行程/签证/酒店"
    if days >= 4:
        return "展前物料核对：样品、宣传册、名片、赠品装箱"
    return "最后冲刺：确认买家到展时间，布置展位动线"


def build_card(company, exh, today):
    start = datetime.strptime(exh["start"], "%Y-%m-%d").date()
    end = datetime.strptime(exh["end"], "%Y-%m-%d").date()
    days = days_between(start, today)

    lines = [
        "**%s**" % exh["name"],
        "展会时间：%s - %s" % (exh["start"], exh["end"]),
        "地点：%s · %s" % (exh.get("city", ""), exh.get("venue", "")),
        "品类：%s" % exh.get("sector", ""),
    ]

    if days > 0:
        title = "⏰ 距展会开展还有 %d 天" % days
        lines.append("**今日建议**：%s" % advice_for(days))
    elif start <= today <= end:
        title = "🎪 展会进行中（第 %d 天）" % (days_between(today, start) + 1)
        lines.append("**今日建议**：现场跟进买家名片，当日录入线索")
    else:
        return None  # 展会已结束

    card = {
        "msg_type": "interactive",
        "card": {
            "header": {
                "template": "blue",
                "title": {"tag": "plain_text", "content": title},
            },
            "elements": [
                {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(lines)}},
                {"tag": "hr"},
                {"tag": "note",
                 "elements": [{"tag": "plain_text",
                               "content": "%s 展会倒计时提醒 · %s" % (company, today.isoformat())}]},
            ],
        },
    }
    return card


def post_card(webhook, card):
    data = json.dumps(card, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        webhook, data=data, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return body


def main():
    cfg = load_config()
    today = date.today()
    companies = cfg.get("companies", [])
    if not companies:
        print("[warn] no companies configured")
        return

    for comp in companies:
        company = comp.get("company") or "未命名企业"
        webhook = comp.get("webhook", "")
        supplier_id = comp.get("supplier_id", "")
        exhibitions = comp.get("exhibitions", [])

        if not webhook:
            print("[skip] no webhook:", company)
            continue

        if not exhibitions:
            print("[pending] no exhibition data:", company,
                  "(supplier_id=%s)" % supplier_id)
            continue

        sent = False
        for exh in exhibitions:
            card = build_card(company, exh, today)
            if card is None:
                print("[skip] ended:", company, exh.get("name"))
                continue
            resp = post_card(webhook, card)
            print("[ok]", company, exh.get("name"), "->", resp)
            sent = True
            break  # 只推主展会

        if not sent:
            print("[none] no active exhibition:", company)


if __name__ == "__main__":
    main()
