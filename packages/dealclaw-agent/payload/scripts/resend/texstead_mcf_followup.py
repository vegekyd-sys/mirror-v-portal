#!/usr/bin/env python3
"""TexStead MCF (三菱商事ファッション) follow-up 邮件 — 下周二若买家未回复则追加。
幂等：state 记录已发；且若检测到买家已回复，跳过。"""
import os, json, sys, datetime, base64, urllib.request, urllib.error

WORKSPACE = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw"
ENV = os.path.join(WORKSPACE, "work/mio-api/.env")
STATE = os.path.join(WORKSPACE, "scripts/resend/texstead-mcf-followup-state.json")

TO = "kaoru.tsuruoka@mcf.co.jp"
CC = "xuyang1@meorient.com"
FROM = "Cecilia Xu <xuyang@mail.dealclaw.io>"
REPLY_TO = "xuyang@mail.dealclaw.io"
UNSUB = "https://send.mail.dogarm.top/unsub"
SUBJECT = "Re: TexStead｜寝具・キルトのOEM/ODM工場のご案内（フォローアップ）"

BODY = """鶴岡様

お世話になっております。テックスティード、Ceciliaでございます。

先日は日本向け実績（無印良品様OEMほか）についてご案内いたしましたが、その後いかがでしょうか。

改めて、当社は以下の製品について日本市場の品質基準に沿ったOEM/ODM生産に対応しております。

・枕（ピロー）
・毛布・ブランケット
・羽毛布団・人工羽毛布団
・敷き布団（和式敷布団）

ライフスタイル商品の新たなOEMパートナーとしてご検討いただけるようでしたら、ご希望の品番・仕様・目標価格帯をお知らせください。サンプル・見積書を速やかにご用意いたします。

ご多忙のところ恐れ入りますが、ご検討のほどよろしくお願いいたします。

TexStead（テックスティード）
Cecilia Xu（セシリア・シュー）
Sales Director"""

# 发信后，买家若回复，会在 sent-log 里无记录但 email-signals 有 reply 信号。
# 这里简单判断：检查本 followup state 是否已发过 + 是否已有来自 TO 的回复记录。
def load_key():
    for line in open(ENV):
        line = line.strip()
        if line.startswith("RESEND_API_KEY="):
            return line.split("=", 1)[1]
    return ""

def load_state():
    if os.path.exists(STATE):
        return json.load(open(STATE))
    return {"sent": False}

def buyer_replied():
    # 检查 email-signals / sent-log 中是否有 TO 的回复（粗暴：查 signals 里该邮箱的 reply 信号）
    sig_dir = os.path.join(WORKSPACE, "work/mio-api/data/email-signals/by-id")
    if not os.path.isdir(sig_dir):
        return False
    target_email = TO.lower()
    import glob
    for f in glob.glob(os.path.join(sig_dir, "*.md")):
        try:
            txt = open(f).read()
        except Exception:
            continue
        # 找 reply 类信号且含该邮箱
        if target_email in txt.lower() and ("reply" in txt.lower() or "sample_request" in txt.lower() or "quote_request" in txt.lower()):
            return True
    return False

def main():
    api_key = load_key()
    if not api_key:
        print("NO_API_KEY"); sys.exit(1)

    today = datetime.date.today().isoformat()
    target = os.environ.get("TEXSTEAD_MCF_FOLLOWUP_DATE", "2026-09-01")
    if today < target:
        print(f"SKIP (before {target})")
        return

    state = load_state()
    if state.get("sent"):
        print("SKIP already-sent")
        return

    if buyer_replied():
        print("SKIP (buyer already replied)")
        return

    def esc(s): return str(s or '').replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
    paras = ''.join(f'<p>{esc(p).replace(chr(10),"<br/>")}</p>' for p in BODY.split('\n\n'))
    html = f'<div style="font-family:\'Hiragino Kaku Gothic ProN\',\'Meiryo\',sans-serif;font-size:14px;line-height:1.7;color:#222;max-width:620px;">{paras}</div>'
    footer = f'\n\n--\n万一、このようなご案内が不要な場合は、こちらから配信停止できます: {UNSUB}'
    footerHtml = f'<p style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">万一、このようなご案内が不要な場合は、<a href="{UNSUB}" style="color:#888;">こちら</a>から配信停止できます。</p>'

    payload = {
        'from': FROM, 'to': [TO], 'cc': [CC], 'reply_to': [REPLY_TO],
        'subject': SUBJECT, 'html': html + footerHtml, 'text': BODY + footer,
        'track_opens': True, 'track_clicks': True,
        'headers': {'List-Unsubscribe': f'<{UNSUB}>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'},
    }
    req = urllib.request.Request('https://api.resend.com/emails', data=json.dumps(payload).encode(),
        headers={'Authorization': api_key, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) DealClaw/1.0'})
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        data = json.loads(resp.read())
        rid = data.get('id', '?')
        state["sent"] = {"date": today, "resend_id": rid, "to": TO}
        json.dump(state, open(STATE, "w"), ensure_ascii=False, indent=2)
        print(f"SENT | {TO} | {rid}")
        # 记录到 sent-log
        glog = os.path.join(WORKSPACE, "scripts/resend/sent-log.jsonl")
        with open(glog, "a") as f:
            f.write(json.dumps({'ts': datetime.datetime.now().isoformat(), 'to': TO, 'cc': CC, 'company': '三菱商事ファッション株式会社(MCF)', 'country': 'JP', 'resend_id': rid, 'subject': SUBJECT, 'campaign': 'texstead-jp-mcf-followup'}, ensure_ascii=False) + '\n')
    except urllib.error.HTTPError as e:
        print(f"FAIL | {e.code} | {e.read().decode()[:200]}")
    except Exception as e:
        print(f"ERROR | {e}")

if __name__ == "__main__":
    main()
