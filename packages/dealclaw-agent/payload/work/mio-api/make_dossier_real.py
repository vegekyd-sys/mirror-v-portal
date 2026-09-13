#!/usr/bin/env python3
"""生成真实「一客一案」样例：按对手方邮箱挑一条有双向往来的线程，导出原文。"""
import json, glob, re, os, collections
from pathlib import Path

D = Path(os.environ.get('DC_DATA_DIR', 'data'))


def mask_mail(s):
    s = str(s)
    return re.sub(r'([\w.+-]{1,2})[\w.+-]*(@[\w.-]+)', r'\1***\2', s)


def load(direction):
    out = []
    for p in glob.glob(str(D / f'email-facts/{direction}/**/*.md'), recursive=True):
        t = Path(p).read_text(encoding='utf-8', errors='ignore')
        m = re.search(r'\{.*\}', t, re.S)
        if not m:
            continue
        try:
            j = json.loads(m.group(0))
        except Exception:
            continue
        j['_dir'] = direction
        out.append(j)
    return out


facts = load('outbound') + load('inbound')


def cp_email(j):
    if j['_dir'] == 'outbound':
        r = j.get('recipients') or []
        return str(r[0] if r else '')
    return str(j.get('sender') or '')


def ts(j):
    return str(j.get('created_at') or j.get('received_at') or j.get('sent_at') or '')


def thread_key(j):
    sub = re.sub(r'^(re|fwd|fw|回复|答复)\s*[:：]\s*', '', str(j.get('subject') or ''), flags=re.I).strip().lower()
    return sub or (cp_email(j).lower())

groups = collections.defaultdict(lambda: {'out': [], 'in': []})
for j in facts:
    groups[thread_key(j)]['out' if j['_dir'] == 'outbound' else 'in'].append(j)

pick = os.environ.get('PICK', '')
both = [(k, v) for k, v in groups.items() if (pick.lower() in k.lower() if pick else (v['out'] and v['in']))]
both.sort(key=lambda kv: -sum(len(str(x.get('text') or '')) for x in kv[1]['out'] + kv[1]['in']))
both = [kv for kv in both if len(kv[1]['out']) >= 1]
if not both:
    print('没有找到双向往来的线程')
    raise SystemExit(1)
who, grp = both[0]

L = []
L.append('# 一客一案 · 真实样例（同一买家的双向往来）')
L.append('')
L.append('- 会话线程：**' + str(who)[:60] + '**')
L.append('- 买家标识：**' + mask_mail(cp_email((grp['out'] or grp['in'])[0])) + '**（本机 contacts 未匹配，暂以邮箱为键）')
L.append('- 互动：出站 ' + str(len(grp['out'])) + ' 条 / 入站 ' + str(len(grp['in'])) + ' 条')
L.append('- 数据来源：Resend 两侧拉取 → 邮件事实层（已落库，幂等）')
L.append('')
L.append('## 沟通记录 · 原文（按时间正序）')
L.append('')
for j in sorted(grp['out'] + grp['in'], key=ts):
    tag = '邮件(出)' if j['_dir'] == 'outbound' else '邮件(入)'
    L.append('### [' + ts(j)[:16] + '] ' + tag + ' · ' + str(j.get('subject') or '(无主题)'))
    L.append('')
    L.append('- 发件：' + mask_mail(j.get('sender') or '') + ' ｜ 收件：' + mask_mail(', '.join(j.get('recipients') or [])))
    body = (j.get('text') or '').strip()
    L.append('- 原文：')
    L.append('')
    L.append('```')
    L.append(body[:1200] if body else '(正文为空)')
    L.append('```')
    L.append('')

L.append('## 我的分析（待补：基于以上原文逐条给出）')
L.append('')
L.append('- 买家意图：')
L.append('- 角色 / 采购阶段：')
L.append('- 下一步动作与时间：')
L.append('- 风险 / 需人工确认：')

out = D / 'dossier-samples' / ('真实样例-' + re.sub(r'[^\w.@-]', '_', who) + '.md')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text('\n'.join(L), encoding='utf-8')
print('样例:', out)
print('字节:', len('\n'.join(L).encode('utf-8')), '| 记录条数:', len(grp['out']) + len(grp['in']))
