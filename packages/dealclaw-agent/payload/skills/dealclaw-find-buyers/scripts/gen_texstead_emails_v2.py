#!/usr/bin/env python3
"""TexStead 开发信 v2：不分展会、按买家类型分段、含公司优势/热品价格/图片占位。"""
import json, os, re, html

HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, 'texstead_base_write.json')))
rows = d['rows']
F = d['fields']

def row_dict(r):
    return dict(zip(F, r))

def f(r, name):
    return row_dict(r).get(name, '')

SIG = "Cecilia Xu\nSales Director, TexStead"

# ── 产品库（取自 2026 目录）──
SKUS = {
    'headboard': [
        ("Quilted Stretch Velvet Headboard Protector", "EXW $7.0", "suggested retail $27.9", "img_headboard"),
        ("Canvas Headboard Protector with Tie Straps", "EXW $10.2", "suggested retail $40.8", "img_headboard"),
    ],
    'reading': [
        ("Air Mesh Wedge Reading Pillow with Neck Support", "EXW $11.3", "suggested retail $45.1", "img_reading"),
        ("Air Mesh Ear Support Memory Foam Pillow", "EXW $3.4", "suggested retail $13.6", "img_reading"),
    ],
    'yoga': [
        ("Corduroy Rectangular Yoga Bolster", "EXW $8.6", "suggested retail $34.4", "img_yoga"),
        ("3D Air Mesh Knee Pillow", "EXW $2.7", "suggested retail $10.7", "img_knee"),
    ],
    'decor': [
        ("Printed Plush Round Seat Cushion", "EXW $4.5", "suggested retail $17.9", "img_decor"),
        ("Sherpa Seat Cushion", "EXW $6.6", "suggested retail $26.5", "img_decor"),
    ],
    'bedding': [
        ("Solid Brushed Microfiber Quilt", "EXW $7.5", "suggested retail $30.1", "img_bedding"),
        ("Vintage Floral Plaid Bedspread Set", "EXW $16.7", "suggested retail $66.6", "img_bedding"),
    ],
    'rug': [
        ("Home Rugs Collection (modern & classic series)", "wholesale on request", "", "img_rug"),
        ("Custom rug programs (size / color / weave)", "OEM pricing", "", "img_rug"),
    ],
}
FALLBACK = SKUS['reading'] + SKUS['bedding'][:1]

def pick_skus(r):
    p = f(r, '关注产品').lower()
    if 'headboard' in p: return SKUS['headboard']
    if 'yoga' in p or 'bolster' in p or 'knee' in p: return SKUS['yoga']
    if 'bedding' in p or 'quilt' in p or 'bedspread' in p or 'mattress' in p or 'duvet' in p or 'linen' in p: return SKUS['bedding']
    if 'rug' in p or 'carpet' in p: return SKUS['rug']
    if 'cushion' in p and 'headboard' not in p and 'reading' not in p: return SKUS['decor']
    if 'pillow' in p or 'reading' in p: return SKUS['reading']
    return FALLBACK

# ── 买家类型分段 ──
def buyer_segment(r):
    nat = f(r, '买家特征').lower()
    attr = nat
    if 'brand' in nat: return 'brand'
    if 'distributor' in nat or 'dealer' in nat or 'wholesaler' in nat or 'importer' in nat or '分销商' in attr:
        return 'distributor'
    if 'retailer' in nat or 'supermarket' in nat or '零售商' in attr: return 'retailer'
    if 'online' in nat: return 'online'
    if 'oem' in nat or 'factory' in nat or '生产商' in attr or '制造商' in attr: return 'factory'
    return 'generic'

SEG_HEAD = {
    'distributor': "Here is why we believe these lines can work for your distribution network:",
    'brand': "As a brand, here is how we can support your product development:",
    'retailer': "For your retail shelf, here is what we can offer:",
    'online': "For your online assortment, here is what we can offer:",
    'factory': "If you already manufacture in some of these categories, here is how we can complement your range:",
    'generic': "What we can offer:",
}

SEG_BODY = {
    'distributor': (
        "Several of these lines are not yet widely available in your market, but are already proven "
        "best-sellers in other markets' retail and e-commerce channels. The margins leave room for a solid "
        "resale story: e.g. our velvet headboard protector carries an EXW of $7.0 against a suggested retail "
        "of $27.9, and the wedge reading pillow $11.3 vs $45.1 — healthy distributor economics, ready stock, "
        "MOQ from 50 pcs per SKU, 30-day lead."
    ),
    'brand': (
        "We run OEM, ODM and private-label programs: custom fabrics, fillings, colors and packaging under "
        "your own brand, MOQ from 50 pcs for test orders and 30-day lead time. You can validate new SKUs "
        "quickly without tooling risk, and scale later with dedicated production runs."
    ),
    'retailer': (
        "All lines are in ready stock with wholesale pricing from $2.7 EXW and MOQ of just 50 pcs per SKU — "
        "easy to test new home-textile SKUs on your shelf without deep inventory. Private-label options are "
        "available as you scale."
    ),
    'online': (
        "All lines are in ready stock with wholesale pricing from $2.7 EXW and MOQ of just 50 pcs per SKU — "
        "fast SKU testing, photo-ready products, and private-label options as you scale your store brand."
    ),
    'factory': (
        "We can be your stable OEM supply partner for the categories you do not produce in-house — cushions, "
        "reading pillows, yoga & floor cushions, bedding and rugs — or co-develop new lines for your market. "
        "MOQ from 50 pcs, 30-day lead, factory-direct pricing."
    ),
    'generic': (
        "We offer ready-stock wholesale plus OEM/ODM/private-label programs, MOQ from 50 pcs per SKU, 30-day "
        "lead time, and factory-direct pricing from $2.7 EXW."
    ),
}

SUBJ = {
    'distributor': "Proven home-textile sellers for your distribution network",
    'brand': "OEM/ODM home textile partner for your brand",
    'retailer': "Ready-stock home textiles for your stores",
    'online': "Ready-stock home textiles for your online assortment",
    'factory': "OEM supply partner for cushions & home textiles",
    'generic': "Home textile factory partner — ready stock & OEM/ODM",
}

def esc(t):
    return html.escape(str(t), quote=False)

def render(r, idx, grade):
    name = f(r, '买家公司名称').strip()
    country = f(r, '买家国家')
    prods = '; '.join(x.strip() for x in f(r, '关注产品').split(';') if x.strip()) or 'home textiles'
    seg = buyer_segment(r)
    skus = pick_skus(r)
    lines = []
    for nm, price, srp, img in skus:
        s = f"{nm} — {price}"
        if srp:
            s += f" / {srp}"
        s += f"  [{img}]"
        lines.append(s)
    sku_block = '\n'.join('- ' + l for l in lines)
    body = f"""Dear {name} team,

We are TexStead, a home textile factory serving retailers, distributors and brands worldwide. Our 2026 collection covers six categories — headboard cushions, reading & support pillows, yoga & floor cushions, decorative cushions, bedding and home rugs — all in ready stock, with OEM, ODM and private-label programs available. Key terms: MOQ from 50 pcs per SKU, 30-day lead time, factory-direct EXW pricing from $2.7.

Given your focus on {prods}, these two lines may be of interest:
{sku_block}
(product images are attached in the catalog we can send)

{SEG_HEAD[seg]} {SEG_BODY[seg]}

I'd be glad to send our full 2026 catalog with photos and a quote sheet — just reply and I will share it right away.

Best regards,
{SIG}"""
    subj = SUBJ[seg] + (f" — for {name}" if len(name) <= 30 else "")
    meta = f"{idx}. {name} | {country} | 等级:{grade} | 买家类型:{seg}"
    return (f'<h2>{esc(meta)}</h2>'
            f'<p><b>Subject:</b> {esc(subj)}</p>'
            f'<quote>{esc(body)}</quote>')

rows_sorted = sorted(rows, key=lambda r: ({'高': 0, '中': 1, '低': 2}[f(r, 'AI匹配等级')], -float(f(r, 'AI匹配分') or 0)))
grades = {'高': [], '中': [], '低': []}
for r in rows_sorted:
    grades[f(r, 'AI匹配等级')].append(r)

intro = f"""<title>TexStead 开发信草稿 v2（247条，按买家类型定制）</title>
<h1>使用说明</h1>
<ul>
<li>本版按你的要求重写：正文不再提报名展会；内容加厚（公司优势 + 热销品与价格 + 买家类型定制话术）。</li>
<li>买家类型五档：分销/批发/进口商（利润空间+市场验证话术）、品牌商（OEM/ODM代工话术）、零售商（现货+起订量话术）、在线商家（现货+贴牌话术）、工厂/其他（互补代工合作话术）。</li>
<li>价格均为目录 EXW 真实价格，suggested retail 来自目录建议零售价，可支撑经销商利润话术。</li>
<li>图片占位（[img_xxx]）对应已从目录提取的产品图，正式发送 HTML 版时直接嵌入；图片已发在群里。</li>
<li>落款 Cecilia，发件 xuyang@mail.dealclaw.io；英文正文；可批量出葡语/阿语版。发送前过时区/预热/邮箱预检，未经确认不发出。</li>
</ul>
<h1>一、高匹配（{len(grades['高'])}条）</h1>"""
blocks = [intro]
for i, r in enumerate(grades['高'], 1):
    blocks.append(render(r, i, '高'))
blocks.append(f"<h1>二、中匹配（{len(grades['中'])}条）</h1>")
for i, r in enumerate(grades['中'], 1):
    blocks.append(render(r, i, '中'))
blocks.append(f"<h1>三、低匹配（{len(grades['低'])}条）</h1>")
for i, r in enumerate(grades['低'], 1):
    blocks.append(render(r, i, '低'))

def dump(bl, path):
    open(path, 'w', encoding='utf-8').write('\n'.join(bl))

dump([blocks[0]], os.path.join(HERE, 'texstead_emails_v2_intro.xml'))
body = blocks[1:]
for i in range(0, len(body), 80):
    dump(body[i:i+80], os.path.join(HERE, f'texstead_emails_v2_seg{i//80+1}.xml'))

# 纯文本版
txt_out = ['TexStead 开发信草稿 v2（247条，按买家类型定制）', '',
           '说明：不提报名展会；含公司优势+热销品价格+买家类型定制话术。图片占位对应群内产品图。发件 xuyang@mail.dealclaw.io，落款 Cecilia。', '']
n = 0
for b in body:
    m = re.match(r'<h2>(.*?)</h2><p><b>Subject:</b>\s*(.*?)</p><quote>(.*?)</quote>', b, re.S)
    if not m: continue
    n += 1
    h, s, q = m.groups()
    txt_out += ['=' * 72, html.unescape(h), 'Subject: ' + html.unescape(s), '-' * 72, html.unescape(q).strip(), '']
open(os.path.join(HERE, 'TexStead_开发信草稿_v2_247条.txt'), 'w', encoding='utf-8').write('\n'.join(txt_out))
print('grades:', {k: len(v) for k, v in grades.items()}, '| segments:', len(body) // 80 + 1, '| emails:', n)
