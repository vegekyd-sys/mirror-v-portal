#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""户外家具邮件批量发送（Jasmine）——读本地 JSON 收件人，不依赖 lark-cli。
用法: python3 send_outdoor_email.py 南非|巴西 [--dry-run]
海报按国家选取，正文从收件人 JSON 里的话术转 HTML。
"""
import json, os, sys, base64, re, html as htmlmod, requests

BASE = '/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw'
DATA = BASE + '/data/campaign-assets/za_br_recipients.json'
POSTER = {
    '南非': BASE + '/data/campaign-assets/outdoor-furniture-south-africa/poster-original-1672x941.png',
    '巴西': BASE + '/data/campaign-assets/outdoor-furniture-brazil/poster-original-1672x941.png',
    '墨西哥': BASE + '/data/campaign-assets/outdoor-furniture-mexico/poster-original-1672x941.png',
}
FILENAME = {
    '南非': 'outdoor-furniture-poster.png',
    '巴西': 'outdoor-furniture-brazil-poster.png',
    '墨西哥': 'outdoor-furniture-mexico-poster.png',
}

def load_env():
    env = {}
    with open(BASE + '/work/mio-api/.env') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k] = v.strip().strip('"').strip("'")
    return env

def build(rec):
    text = rec['话术'] or ''
    lines = text.split('\n')
    subject = ''
    rest = text
    if lines and lines[0].strip().lower().startswith('subject'):
        subject = lines[1].strip() if len(lines) > 1 else ''
        rest = '\n'.join(lines[2:])
    out = []
    for ln in rest.split('\n'):
        if '[ATTACHMENT:' in ln:
            out.append('<p style="margin:8px 0;">Please find the product poster attached for your reference.</p>')
            continue
        s = htmlmod.escape(ln)
        s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
        out.append(s + '<br/>' if s.strip() else '')
    if not subject:
        if rec.get('country') == '南非':
            subject = 'Are you sourcing outdoor furniture? | Ready stock from USD 207.50'
        elif rec.get('country') == '巴西':
            subject = 'Vocês compram móveis para área externa? | Pronta entrega desde USD 207,50'
        else:
            subject = '¿Está comprando muebles de exterior? | Stock desde USD 207.50'
    body = '\n'.join(out)
    html = f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222;max-width:640px;">{body}</div>'
    return subject, html

def main():
    if len(sys.argv) < 2:
        print('用法: python3 send_outdoor_email.py 南非|巴西 [--dry-run]'); sys.exit(2)
    country = sys.argv[1]
    dry = '--dry-run' in sys.argv
    data = json.load(open(DATA))
    recs = data.get(country, [])
    if not recs:
        print(f'无 {country} 收件人'); sys.exit(1)
    env = load_env()
    key = env['RESEND_API_KEY']
    poster_b64 = base64.b64encode(open(POSTER[country], 'rb').read()).decode()
    results = []
    for rec in recs:
        rec['country'] = country
        subject, html = build(rec)
        if dry:
            print(' -', rec['邮箱'], '|', subject); continue
        payload = {"from": "Jasmine <jasmine@mail.dealclaw.io>", "to": [rec['邮箱']],
                   "subject": subject, "html": html,
                   "attachments": [{"filename": FILENAME[country], "content": poster_b64, "content_type": "image/png"}]}
        try:
            r = requests.post("https://api.resend.com/emails",
                              headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                              json=payload, timeout=60)
            rid = r.json().get('id', '') if r.status_code == 200 else ''
            results.append({'email': rec['邮箱'], 'ok': r.status_code == 200, 'id': rid,
                            'err': '' if r.status_code == 200 else r.text[:200]})
        except Exception as e:
            results.append({'email': rec['邮箱'], 'ok': False, 'id': '', 'err': str(e)})
    if dry:
        print(f'DRY-RUN {country}: {len(recs)} 封'); sys.exit(0)
    ok = sum(1 for x in results if x['ok'])
    print(f'[{country}] 结果: 成功 {ok}/{len(results)}')
    for x in results:
        print(('OK ' if x['ok'] else 'FAIL '), x['email'], x.get('id', ''), x.get('err', ''))
    json.dump(results, open(f'/tmp/{country}_email_results.json', 'w'), ensure_ascii=False, indent=2)

if __name__ == '__main__':
    main()
