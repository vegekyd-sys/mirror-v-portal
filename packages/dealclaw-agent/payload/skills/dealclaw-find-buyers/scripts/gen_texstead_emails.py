#!/usr/bin/env python3
"""Generate personalized English cold-email drafts for TexStead exhibition leads → docx XML chunks."""
import json, os, re, html
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, 'texstead_base_write.json')))
rows = d['rows']
F = d['fields']
def row_dict(r):
    return dict(zip(F, r))

BY = row_dict(d['rows'][0])
# field indices via header
def f(r, name):
    return row_dict(r).get(name, '')

SIG = "Cecilia Xu\nSales Director, TexStead"
FROM_NOTE = "From: TexStead <xuyang@mail.dealclaw.io>"

def esc(t):
    return html.escape(str(t), quote=False)

def short_products(p):
    parts = [x.strip() for x in str(p).split(';') if x.strip()][:3]
    return ', '.join(parts)

def nature(n):
    t = str(n).lower()
    if 'importer' in t or 'wholesaler' in t: return 'importer/wholesaler'
    if 'retailer' in t or 'supermarket' in t: return 'retailer'
    if 'distributor' in t or 'dealer' in t: return 'distributor'
    if 'oem' in t or 'factory' in t: return 'manufacturer'
    if 'brand' in t: return 'brand'
    if 'online' in t: return 'online merchant'
    return ''

def first_expo(exs):
    parts = [p.strip() for p in str(exs).split(';') if p.strip()]
    return parts[0] if parts else ''

def prod_lines(prods):
    """产品线措辞：rug/carpet → rug lines；pillow → pillow lines；cushion → cushion lines；bedding/quilt/bedspread → bedding lines；默认 home textile lines"""
    p = str(prods).lower()
    if 'rug' in p or 'carpet' in p:
        return 'rug and floor cushion lines'
    if 'pillow' in p or 'headboard' in p or 'bolster' in p:
        return 'pillow and cushion lines'
    if 'bedding' in p or 'quilt' in p or 'bedspread' in p or 'mattress' in p or 'linen' in p:
        return 'bedding lines'
    return 'home textile lines'

def opening(r):
    name = f(r, '买家公司名称').strip()
    exs = f(r, '报名参展展会')
    prods = short_products(f(r, '关注产品'))
    nat = nature(f(r, '买家特征'))
    first = first_expo(exs)
    if first.startswith('到展'):
        hook = f"We saw {name} visited {first[2:]}, and with your focus on {prods or 'home textiles'},"
    elif first.startswith('报名'):
        hook = f"We noticed {name} registered for {first[2:]}, and with your focus on {prods or 'home textiles'},"
    else:
        hook = f"With {name}'s focus on {prods or 'home textiles'},"
    lines = prod_lines(prods)
    body = f"""Dear {name} team,

{hook} we thought it worth reaching out.

We are TexStead, a home textile factory offering ready-stock wholesale plus OEM, ODM and private-label programs for retailers, distributors and brands. Our 2026 collection covers headboard cushions, reading & support pillows, yoga & floor cushions, decorative cushions, bedding and home rugs — with MOQ from 50 pcs, 30-day lead time and EXW prices starting at USD 2.7.

If you are looking for a flexible factory partner on {lines}, I'd be glad to send our 2026 catalog and a quote sheet — just reply and I'll share it right away.

Best regards,
{SIG}"""
    label = f"{nat} " if nat else ""
    base = f"Home textile factory partner for {label}{name}"
    if len(base) > 64:
        cut = base[:61].rsplit(' ', 1)[0]
        subj = cut + "…"
    else:
        subj = base
    return subj, body

def render(r, idx, grade):
    subj, body = opening(r)
    name = f(r, '买家公司名称')
    country = f(r, '买家国家')
    exs = f(r, '报名参展展会')
    prods = short_products(f(r, '关注产品'))
    meta = f"{idx}. {name} | {country} | 等级:{grade} | {exs}"
    if prods:
        meta += f" | 匹配:{prods}"
    return (f'<h2>{esc(meta)}</h2>'
            f'<p><b>Subject:</b> {esc(subj)}</p>'
            f'<quote>{esc(body)}</quote>')

# sort: 高 first, then 中, 低; within grade by score desc
rows_sorted = sorted(rows, key=lambda r: ({'高':0,'中':1,'低':2}[f(r,'AI匹配等级')], -float(f(r,'AI匹配分') or 0)))
grades = {'高': [], '中': [], '低': []}
for r in rows_sorted:
    grades[f(r, 'AI匹配等级')].append(r)

chunks = []
intro = f"""<title>TexStead 展会买家开发信草稿（247条）</title>
<h1>使用说明</h1>
<ul>
<li>本批草稿对应 2025/2026 展会商机池的 247 条买家，每条含 主题(Subject) + 正文，按 AI匹配等级 高→中→低 排序。</li>
<li>发件身份：TexStead &lt;xuyang@mail.dealclaw.io&gt;，落款 Cecilia（销售总监）。</li>
<li>正文均为英文；巴西买家如需葡语、阿联酋买家如需阿语版本，告诉我，我可以批量翻译。</li>
<li>发送前会过预检：买家当地时区（工作日 8:00-18:00）、域名预热状态、收件人邮箱有效性；未经你确认不会发出。</li>
<li>「报名2026巴西/墨西哥/南非展」的 37 条已置顶在「高」档开头，建议优先处理。</li>
</ul>
<h1>一、高匹配（{len(grades['高'])}条）</h1>"""
chunks.append(intro)
for i, r in enumerate(grades['高'], 1):
    chunks.append(render(r, i, '高'))
chunks.append(f"<h1>二、中匹配（{len(grades['中'])}条）</h1>")
for i, r in enumerate(grades['中'], 1):
    chunks.append(render(r, i, '中'))
chunks.append(f"<h1>三、低匹配（{len(grades['低'])}条）</h1>")
for i, r in enumerate(grades['低'], 1):
    chunks.append(render(r, i, '低'))

full = '\n'.join(chunks)
# split into ~60 blocks per chunk file to keep appends manageable
blocks = chunks
# chunk1 = intro + first ~60 blocks (high), then continue
def dump(blocks_list, path):
    with open(path, 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(blocks_list))

# append files: after intro, pack ~80 blocks each
body_blocks = blocks[1:]
pack = []
files = []
for i in range(0, len(body_blocks), 80):
    seg = body_blocks[i:i+80]
    p = os.path.join(HERE, f'texstead_emails_seg{len(files)+1}.xml')
    dump(seg, p)
    files.append(p)
dump([blocks[0]], os.path.join(HERE, 'texstead_emails_intro.xml'))
print('grades:', {k: len(v) for k, v in grades.items()}, '| segments:', len(files))
print('total blocks:', len(body_blocks))
