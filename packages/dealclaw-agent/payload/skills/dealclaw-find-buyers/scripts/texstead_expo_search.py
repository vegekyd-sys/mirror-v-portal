#!/usr/bin/env python3
"""TexStead 展会买家搜索：多 tag × 多展会组合，去重后落 JSON。"""
import json, subprocess, sys, os
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TAGS = [
    "headboard cushion", "reading pillow", "yoga bolster", "knee pillow",
    "decorative cushion", "cushion", "bedding", "quilt", "bedspread",
    "home textile", "rug",
]
EXHIBITIONS = {
    "BR_MX_ZA_2026": ["152996309411", "152996309420", "152996309388"],  # 巴西/墨西哥/南非 2026 展前
    "ENDED_2025_2026": ["152681324147", "152681324144", "152683595067",
                        "152996309417", "153066408645", "152996309349"],  # 沙特/阿联酋/印尼2025 + 波兰/印尼/越南2026
}

def run(tag, ex_ids, features):
    cmd = [sys.executable, "search_aiv2.py",
           "--tag-keyword", tag,
           "--pre-exhibition-ids-json", ",".join(ex_ids),
           "--features-json", ",".join(map(str, features)),
           "--page-size", "100"]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout
    d = json.loads(out)
    resp = d["response"]
    if not resp.get("success"):
        return None, f"API error: {resp.get('code')} {resp.get('msg','')}"
    data = resp.get("data") or {}
    page = data.get("page") or {}
    records = page.get("records") or []
    return records, None

def main():
    pool = OrderedDict()
    for ex_name, ex_ids in EXHIBITIONS.items():
        for tag in TAGS:
            recs, err = run(tag, ex_ids, [5, 21])
            if err:
                print(f"[{ex_name}][{tag}] {err}", file=sys.stderr)
                continue
            print(f"[{ex_name}][{tag}] {len(recs)}")
            for r in recs:
                cid = r.get("companyCdpId") or r.get("companyName")
                if cid not in pool:
                    pool[cid] = r
                else:
                    # merge tags / exhibitions info
                    prev = pool[cid]
                    prev["_tags"] = list(set(prev.get("_tags", []) + [tag]))
                    prev["_exhibitions"] = list(set(prev.get("_exhibitions", []) + [ex_name]))
    for cid, r in pool.items():
        r.setdefault("_tags", []).append("")
        r.setdefault("_exhibitions", [])
    out = {
        "count": len(pool),
        "records": list(pool.values()),
    }
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "texstead_expo_results.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("TOTAL unique:", len(pool), "->", path)

if __name__ == "__main__":
    main()
