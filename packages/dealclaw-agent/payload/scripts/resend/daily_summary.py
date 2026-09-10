#!/usr/bin/env python3
"""STELANG 每日小结 — 每天 17:00 自动发群。

内容：今日主线任务 / 卡点 / 建议（结合当天实际动作，Agent 可覆盖静态文案）。
静态兜底：拉当天回复情况。真正的"主线/卡点/建议"建议由上层 Agent 每日维护一段 note。
"""
import os, json, datetime, subprocess, requests

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")
GROUP_CHAT_ID = "oc_5b727046f9100dcc9cd4613d2c76d2a1"
NOTE_FILE = os.path.join(WORKSPACE, "scripts/resend/stelang-daily-note.txt")

def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

def send_group(text):
    try:
        subprocess.run(["lark-cli", "im", "+messages-send", "--as", "bot",
                        "--chat-id", GROUP_CHAT_ID, "--text", text],
                       cwd=WORKSPACE, capture_output=True, timeout=30)
    except Exception as e:
        print("feishu error:", e)

def load_recent_replies():
    key = load_key()
    headers = {"Authorization": f"Bearer {key}"}
    r = requests.get("https://api.resend.com/emails/receiving?limit=50", headers=headers, timeout=30)
    data = (r.json() or {}).get("data") or []
    today = datetime.date.today().isoformat()
    cnt = 0
    names = []
    for m in data:
        created = (m.get("created_at") or "")[:10]
        to = m.get("to"); tos = to if isinstance(to, list) else [to]
        subj = (m.get("subject") or "")
        if not any("thia" in str(t) for t in tos):
            continue
        if not ("STELANG" in subj or "cafetera" in subj.lower() or "homelife" in subj.lower()):
            continue
        if created == today:
            cnt += 1
            names.append(str(m.get("from")))
    return cnt, names

def main():
    today = datetime.date.today().strftime("%Y-%m-%d")
    # 静态 note（Agent 每日可覆盖此文件更新"主线/卡点/建议"）
    note = ""
    if os.path.exists(NOTE_FILE):
        note = open(NOTE_FILE).read().strip()
    cnt, names = load_recent_replies()

    lines = []
    lines.append(f"📋 STELANG 每日小结 · {today}")
    lines.append("")
    if note:
        lines.append(note)
    else:
        lines.append("今日主线任务：买家跟进中（展前开发）")
        lines.append("卡点：待补充")
        lines.append("建议：持续关注买家回复")
    lines.append("")
    lines.append(f"今日新回复：{cnt} 封" + (f"（{', '.join(names)}）" if names else ""))
    msg = "\n".join(lines)
    send_group(msg)
    print("已发送每日小结")
    print(msg)

if __name__ == "__main__":
    main()
