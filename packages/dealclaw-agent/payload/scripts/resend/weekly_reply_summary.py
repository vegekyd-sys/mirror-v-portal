#!/usr/bin/env python3
"""STELANG 邮件收发情况周报 — 周一/周四 10:00 自动发群提醒。

汇总：回复过的买家 + 跟进建议 + 回复率。
"""
import os, json, datetime, subprocess, requests

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")
GROUP_CHAT_ID = "oc_5b727046f9100dcc9cd4613d2c76d2a1"

def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

# 雪特朗已触达买家总数（8 赛道 + 12 线索池 = 20 家）
TOTAL_REACHED = 20

def load_replies():
    key = load_key()
    headers = {"Authorization": f"Bearer {key}"}
    r = requests.get("https://api.resend.com/emails/receiving?limit=100", headers=headers, timeout=30)
    data = (r.json() or {}).get("data") or []
    replies = {}
    for m in data:
        to = m.get("to"); tos = to if isinstance(to, list) else [to]
        if not any("thia" in str(t) for t in tos):
            continue
        subj = (m.get("subject") or "")
        if not ("STELANG" in subj or "cafetera" in subj.lower() or "homelife" in subj.lower()):
            continue
        fr = str(m.get("from")).strip()
        dt = m.get("created_at") or ""
        if fr not in replies or dt > replies[fr]["date"]:
            replies[fr] = {"date": dt}
    return replies

def send_group(text):
    try:
        subprocess.run(["lark-cli", "im", "+messages-send", "--as", "bot",
                        "--chat-id", GROUP_CHAT_ID, "--text", text],
                       cwd=WORKSPACE, capture_output=True, timeout=30)
    except Exception as e:
        print("feishu error:", e)

def main():
    replies = load_replies()
    n = len(replies)
    rate = round(n / TOTAL_REACHED * 100, 1) if TOTAL_REACHED else 0

    lines = []
    lines.append("📊 STELANG 邮件跟进周报")
    lines.append(f"触达买家：{TOTAL_REACHED} 家")
    lines.append(f"已回复：{n} 家 ｜ 回复率：{rate}%")
    lines.append("")

    # 跟进建议（按已知买家）
    advice = []
    if "arthur.242@gmail.com" in replies:
        advice.append("· CAFÉ CALUPOH（Luis）：已同意面谈，等 Lucky 决策后约见")
    if "aniimportaciones@gmail.com" in replies:
        advice.append("· ANIMO（Gustavo）：要目录已回，建议再二次跟进催反馈")
    if "mauricio@dalto.coffee" in replies or "msandoval@catermex.mx" in replies:
        advice.append("· CATERMEX（Mauricio）：问地点已答，建议再二次约展位")
    if advice:
        lines.append("跟进建议：")
        lines.extend(advice)
    else:
        lines.append("跟进建议：暂无新回复，可对未回复买家做 follow-up")

    msg = "\n".join(lines)
    send_group(msg)
    print("已发送周报群提醒")
    print(msg)

if __name__ == "__main__":
    main()
