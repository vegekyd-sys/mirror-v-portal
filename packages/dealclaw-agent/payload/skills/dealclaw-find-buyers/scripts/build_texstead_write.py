#!/usr/bin/env python3
"""Build final TexStead exhibition-buyer dataset and batch-create JSON for Base write."""
import json, re, os
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(HERE, 'texstead_expo_results.json')))
recs = d['records']

TARGET_2026 = {
    '152996309411': ('报名', '2026巴西展(9/16-18)'),
    '152996309420': ('报名', '2026墨西哥展(9/8-10)'),
    '152996309388': ('报名', '2026南非展(9/23-25)'),
}
ENDED = {
    '152681324147': '2025沙特展(12/22-24)',
    '152681324144': '2025阿联酋展(12/17-19)',
    '152683595067': '2025印尼展(11/26-29)',
    '152996309417': '2026波兰展(6/23-25)',
    '153066408645': '2026印尼展(6/3-6)',
    '152996309349': '2026越南展(5/13-15)',
}
EXTRA_2025 = {
    '152681324140': '2025-12同期展',
    '152681324142': '2025-12同期展',
    '152681324149': '2025-12同期展',
    '152681324150': '2025-12同期展',
    '152681324151': '2025-12同期展',
    '152683595070': '2025-11印尼同期展',
}

STRONG_KW = ['bedding','bedspread','quilt','pillow','cushion','rug','carpet','linen','duvet',
             'headboard','mattress','bolster','upholstery','blanket','throw','towel','curtain',
             'home textile','bed sheet','bedsheet','bedlinen','bed linen','comforter']
DROP_KW = ['jewelry','jewellery','food','machinery','gold','diamond']

def strip_em(t):
    return re.sub(r'</?em>', '', t or '')

def txt(r):
    return strip_em((r.get('companyProfile') or '') + ' ' + (r.get('seoProducts') or '') + ' ' +
                    (r.get('seoDescriptions') or '')).lower()

def ht_tag(r):
    return 'Home Textiles' in {t.get('nameEn') for t in r.get('sortedT2TagInfo', [])}

def matched_kws(r):
    t = txt(r)
    return [k for k in STRONG_KW if k in t]

def relevant(r):
    if ht_tag(r):
        return True
    kws = matched_kws(r)
    t = txt(r)
    if any(k in t for k in DROP_KW):
        return False
    return bool(kws)

def ex_info(r):
    pre = set(r.get('preExhibitionIds') or [])
    on = set(r.get('onExhibitionIds') or [])
    parts = []
    for eid, label in TARGET_2026.items():
        if eid in pre:
            parts.append(f"{label[0]}{label[1]}")
    for eid, name in ENDED.items():
        if eid in pre:
            parts.append(f"报名{name}")
        elif eid in on:
            parts.append(f"到展{name}")
    for eid, name in EXTRA_2025.items():
        if eid in pre:
            parts.append(f"报名{name}")
    # dedupe preserve order
    seen, out = set(), []
    for p in parts:
        if p not in seen:
            seen.add(p); out.append(p)
    return '; '.join(out)

def grade(r, kws):
    nat = (r.get('businessNatures') or '').lower()
    attr = ' '.join(r.get('companyAttributes') or []).lower()
    buyerish = any(k in nat for k in ['importer','wholesaler','traders','dealer','retailer','distributor','supermarket','brand','online'])
    strong = bool(set(kws) & {'bedding','bedspread','quilt','pillow','cushion','rug','carpet','duvet','headboard','bolster'})
    if ht_tag(r) and buyerish and strong:
        return '高'
    if ht_tag(r):
        return '中'
    return '低'

def reason(r, exs, kws):
    nat = (r.get('businessNatures') or '').split(',')[0] or '类型未标注'
    p = f"展会：{exs}。主营/标签命中家纺（{'、'.join(kws[:3]) or 'Home Textiles'}），买家性质：{nat}"
    return p[:400]

def profile_clean(r):
    p = strip_em(r.get('companyProfile') or '').strip()
    if not p:
        p = strip_em(r.get('seoProducts') or '').strip()
    return re.sub(r'\s+', ' ', p)[:400]

pool = {}
for r in recs:
    if not relevant(r):
        continue
    cid = r.get('companyCdpId') or r.get('companyName')
    pre = set(r.get('preExhibitionIds') or [])
    on = set(r.get('onExhibitionIds') or [])
    if not ((pre | on) & (set(TARGET_2026) | set(ENDED) | set(EXTRA_2025))):
        continue
    if cid not in pool:
        pool[cid] = r
    else:
        pool[cid] = r

now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
rows, stats = [], {'高': 0, '中': 0, '低': 0}
for r in pool.values():
    kws = matched_kws(r)
    exs = ex_info(r)
    if not exs:
        continue
    g = grade(r, kws)
    stats[g] += 1
    rows.append([
        r.get('companyName', ''),                     # 买家公司名称
        r.get('companyCdpId', ''),                    # 买家CDPID
        r.get('country', ''),                         # 买家国家
        'Home Textiles' if ht_tag(r) else '家纺相关',  # 产品类别T2
        '; '.join(kws) if kws else '家纺',            # 关注产品
        exs,                                          # 报名参展展会
        reason(r, exs, kws),                          # AI匹配理由
        g,                                            # AI匹配等级
        round(r.get('totalQualityScore') or 0, 1),    # AI匹配分
        '待确认',                                     # 是否匹配
        '未跟进',                                     # 跟进状态
        now,                                          # 首次入池时间
        r.get('companyCdpId', ''),                    # 唯一去重键
        'oc_6cdf054ad3b42944b004307e5d27b97c',        # 飞书群ID
        ((r.get('businessNatures') or '') + ' / ' + ' '.join(r.get('companyAttributes') or [])).strip(' / ')[:200],  # 买家特征
        profile_clean(r),                             # 买家公司简介
        now,                                          # AI处理时间
        now,                                          # 最近更新时间
    ])

fields = ['买家公司名称','买家CDPID','买家国家','产品类别T2','关注产品','报名参展展会',
          'AI匹配理由','AI匹配等级','AI匹配分','是否匹配','跟进状态','首次入池时间',
          '唯一去重键','飞书群ID','买家特征','买家公司简介','AI处理时间','最近更新时间']

batches = [rows[i:i+200] for i in range(0, len(rows), 200)]
print('total rows:', len(rows), '| batches:', len(batches), '| grade:', stats)
out = {'fields': fields, 'rows': rows}
json.dump(out, open(os.path.join(HERE, 'texstead_base_write.json'), 'w', encoding='utf-8'), ensure_ascii=False)
for i, b in enumerate(batches):
    json.dump({'fields': fields, 'rows': b}, open(os.path.join(HERE, f'texstead_base_batch{i+1}.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('wrote texstead_base_write.json + batch files')
