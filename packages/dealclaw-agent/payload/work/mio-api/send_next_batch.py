#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发送下一个未发送的批次（幂等，供每日 cron 调用）。修复：称呼不再重复 + 退订 header"""
import json, os, time, urllib.request

API_KEY = os.environ.get("RESEND_" + "API_KEY", "")
BATCH_DIR = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw/work/mio-api/data/campaign_batches"
MANIFEST = os.path.join(BATCH_DIR, "manifest.json")
STATE = os.path.join(BATCH_DIR, "send_state.json")
TEMPLATE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspace/work/intex-email/email-pt-standalone.html"

GREETING_FULL = 'Prezado(a) <span style="color:#7a1f2b; font-weight:600;">[Nome do Comprador]</span>,'


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def load_template():
    return open(TEMPLATE, encoding="utf-8").read()


def personalize(tpl, name):
    """模板里已含 'Prezado(a) '，这里只回填名字；无名字则整段替换为 Prezado(a),"""
    if name:
        first = (name.split()[0] or "").strip()
        first = (first[0].upper() + first[1:]) if first else ""
        return tpl.replace("[Nome do Comprador]", first)
    return tpl.replace(GREETING_FULL, "Prezado(a),")


def send_one(to, html):
    body = json.dumps({
        "from": MANIFEST_DATA.get("from"),
        "to": [to],
        "subject": MANIFEST_DATA.get("subject"),
        "html": html,
        "reply_to": [MANIFEST_DATA.get("reply_to")],
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
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


MANIFEST_DATA = json.load(open(MANIFEST, encoding="utf-8"))


def main():
    state = {}
    if os.path.exists(STATE):
        state = json.load(open(STATE, encoding="utf-8"))
    sent_days = set(state.get("sent_days", []))
    total_days = MANIFEST_DATA.get("days", 10)

    next_day = None
    for d in range(total_days):
        if d not in sent_days:
            next_day = d
            break
    if next_day is None:
        log("全部批次已发送完成，退出")
        return

    batch = MANIFEST_DATA["batches"][next_day]
    fn = os.path.join(BATCH_DIR, batch["file"])
    rows = json.load(open(fn, encoding="utf-8"))
    tpl = load_template()

    log(f"开始发送 day={next_day}（batch {batch['file']}）共 {len(rows)} 封")
    sent = 0
    failed = 0
    for i, row in enumerate(rows):
        email = row.get("email", "")
        name = row.get("name", "")
        html = personalize(tpl, name)
        try:
            send_one(email, html)
            sent += 1
        except Exception as e:
            failed += 1
            log(f"  FAIL {email}: {e}")
        if (i + 1) % 20 == 0:
            log(f"  进度 {i+1}/{len(rows)} sent={sent} failed={failed}")
        time.sleep(0.25)

    sent_days.add(next_day)
    state["sent_days"] = sorted(sent_days)
    state[f"day{next_day}_count"] = sent
    state[f"day{next_day}_failed"] = failed
    state["last_sent_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    json.dump(state, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    log(f"day={next_day} 完成：sent={sent} failed={failed}")


if __name__ == "__main__":
    main()
