#!/usr/bin/env python3
"""
Apply authoritative pricing (Feishu doc rev 167, 2026-08-13) to credits-ledger skill_prices.
Source of truth: 小元（出海精灵）商业化方案&目前进展 — 1.3 稳定在跑的 Skill.
Only touches credit_per_unit + cost (+ serviceLine); keeps status=shadow (内测不扣费).
Idempotent: safe to re-run.
"""
import json, os, sys, urllib.request, urllib.error

LEDGER = os.environ.get("CREDITS_LEDGER_URL", "http://localhost:8081")
TOKEN_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", ".billing-token")

def load_token():
    tok = os.environ.get("DC_BILLING_TOKEN")
    if tok:
        return tok
    try:
        with open(TOKEN_PATH) as f:
            return f.read().strip()
    except Exception:
        return None

TOKEN = load_token()

# (skill_id, skill_name, credit_per_unit, cost_yuan, billing_unit, category)
SKILLS = [
    ("dealclaw-analyze-company",       "企业画像分析",       2000, 0.36, "per_use",    "insight"),
    ("dealclaw-market-insight",        "市场洞察报告",       1000, 1.15, "per_report", "insight"),
    ("dealclaw-buyer-leads-push",      "买家线索推送",       1000, 0.30, "per_item",   "buyer"),
    ("dealclaw-find-buyers",           "搜索买家",            800, 0.63, "per_item",   "buyer"),
    ("dealclaw-exhibition-leads",      "展后线索处理",        800, 0.99, "per_person", "exhibition"),
    ("dealclaw-exhibition-invitation", "展会邀约",            200, 0.27, "per_person", "exhibition"),
    ("dealclaw-email-founder-direct",  "一对一精准开发信",    100, 0.17, "per_email",  "outreach"),
    ("dealclaw-lead-import",           "导入线索",            100, 0.06, "per_use",    "admin"),
    ("dealclaw-email-growth-send",     "批量开发信群发",       50, 0.14, "per_email",  "outreach"),
    ("dealclaw-smart-reply",           "自动处理买家回复",     50, 0.05, "per_reply",  "outreach"),
]

# Free skills — assert zero (no-op unless drifted)
FREE = [
    ("dealclaw-email-bindings", "邮箱绑定",   "admin"),
    ("dealclaw-knowledge-base", "知识库浏览", "admin"),
    ("dealclaw-review",         "画像偏好标注", "admin"),
]

def put(skill_id, skill_name, credit, cost, unit, category):
    body = json.dumps({
        "skillName": skill_name,
        "category": category,
        "creditPerUnit": credit,
        "cost": cost,
        "billingUnit": unit,
        "status": "shadow",
        "serviceLine": "dealclaw",
        "changedBy": "v-price-sync-rev167",
    }).encode()
    req = urllib.request.Request(
        f"{LEDGER}/v1/skill-prices/{skill_id}",
        data=body, method="PUT",
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        d = json.loads(resp.read())
        return d.get("ok", False), d.get("message", "")
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode()[:200]}"
    except Exception as e:
        return False, str(e)

def main():
    results = []
    for sid, name, credit, cost, unit, cat in SKILLS:
        ok, msg = put(sid, name, credit, cost, unit, cat)
        results.append((sid, credit, cost, ok, msg))
        print(f"{'✅' if ok else '❌'} {sid:36s} → {credit:>5} credit / cost {cost}  {msg}")

    for sid, name, cat in FREE:
        ok, msg = put(sid, name, 0, None, "per_use", cat)
        results.append((sid, 0, None, ok, msg))
        print(f"{'✅' if ok else '❌'} {sid:36s} → FREE (0)  {msg}")

    fails = [r for r in results if not r[3]]
    print(f"\nDone: {len(results)-len(fails)}/{len(results)} ok, {len(fails)} failed")
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
