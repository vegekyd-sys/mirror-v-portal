#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""南非户外家具邮件批量发送（Jasmine），requests + Bearer + 海报附件 + HTML 加粗。"""
import json, os, sys, base64, requests, subprocess

BASE = '/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw'
POSTER = BASE + '/data/campaign-assets/outdoor-furniture-south-africa/poster-original-1672x941.png'
LARK_CLI = '/opt/node-v22.23.1/bin/lark-cli'
LARK_CFG = '/home/openclaw/.lark-cli/openclaw'

def load_env():
    env = {}
    with open(BASE + '/work/mio-api/.env') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k] = v.strip().strip('"').strip("'")
    return env

def get_sa_records():
    env = dict(os.environ)
    env['LARK_CLI_CONFIG_PATH'] = LARK_CFG
    out = subprocess.run(
        [LARK_CLI, 'base', '+record-list', '--base-token', 'FUGubEKazaKMrfsyAhNcjTHqnsh',
         '--table-id', 'tblwp64E1Ghy658B', '--view-id', 'vewcpjHmt8',
         '--field-id', '公司名称', '--field-id', '联系人', '--field-id', '邮箱', '--field-id', '邮件话术',
         '--limit', '200', '--format', 'json', '--as', 'bot'],
        capture_output=True, text=True, cwd=BASE, env=env)
    d = json.loads(out.stdout)['data']
    idx = {n: i for i, n in enumerate(d['fields'])}
    recs = []
    for rid, row in zip(d['record_id_list'], d['data']):
        email = (row[idx['邮箱']] or '').strip()
        if not email or email == '未获取':
            continue
        recs.append({'rid': rid, '公司': row[idx['公司名称']], '联系人': row[idx['联系人']],
                     '邮箱': email, '话术': row[idx['邮件话术']]})
    return recs

def build(rec):
    import re, html as htmlmod
    text = rec['话术']
    lines = text.split('\n')
    subject = ''
    rest = text
    if lines and lines[0].strip().lower().startswith('subject'):
        subject = lines[1].strip() if len(lines) > 1 else ''
        rest = '\n'.join(lines[2:])
    # 解析正文，去掉附件标记行
    out = []
    for ln in rest.split('\n'):
        if '[ATTACHMENT:' in ln:
            out.append('<p style="margin:8px 0;">Please find the product poster attached for your reference.</p>')
            continue
        s = htmlmod.escape(ln)
        s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
        s = s.replace('I’ve attached a quick product overview for your reference.',
                      'I’ve attached a quick product overview for your reference.')
        out.append(s + '<br/>' if s.strip() else '')
    body = '\n'.join(out)
    if not subject:
        subject = 'Are you sourcing outdoor furniture? | Ready stock from USD 207.50'
    html = f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222;max-width:640px;">{body}</div>'
    return subject, html

def send(env, recs):
    key = env['RESEND_API_KEY']
    poster_b64 = base64.b64encode(open(POSTER, 'rb').read()).decode()
    results = []
    for rec in recs:
        subject, html = build(rec)
        payload = {
            "from": "Jasmine <jasmine@mail.dealclaw.io>",
            "to": [rec['邮箱']],
            "subject": subject,
            "html": html,
            "attachments": [{"filename": "outdoor-furniture-poster.png",
                             "content": poster_b64, "content_type": "image/png"}]
        }
        try:
            r = requests.post("https://api.resend.com/emails",
                              headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                              json=payload, timeout=60)
            rid = r.json().get('id', '?') if r.status_code == 200 else ''
            results.append({'email': rec['邮箱'], 'ok': r.status_code == 200, 'id': rid,
                            'err': '' if r.status_code == 200 else r.text[:200]})
        except Exception as e:
            results.append({'email': rec['邮箱'], 'ok': False, 'id': '', 'err': str(e)})
    return results

if __name__ == '__main__':
    env = load_env()
    recs = get_sa_records()
    if '--dry-run' in sys.argv:
        print('DRY-RUN:', len(recs), '封')
        for r in recs:
            s, _ = build(r)
            print(' -', r['邮箱'], '|', s)
        sys.exit(0)
    print(f'[{len(recs)} emails] 发送中...')
    res = send(env, recs)
    ok = sum(1 for x in res if x['ok'])
    print(f'结果: 成功 {ok}/{len(res)}')
    for x in res:
        print(('OK ' if x['ok'] else 'FAIL '), x['email'], x.get('id', ''), x.get('err', ''))
    json.dump(res, open('/tmp/za_email_results.json', 'w'), ensure_ascii=False, indent=2)
