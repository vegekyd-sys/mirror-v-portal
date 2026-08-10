#!/usr/bin/env python3
"""
Auto-sync: detect new DealClaw skills and add them to the pricing database.
Runs via cron or manually. Safe to run repeatedly (idempotent).
"""
import subprocess, json, os, sys, re

SKILLS_DIR = os.path.expanduser(
    "~/makaron-openclaw/.openclaw-local/workspace/dealclaw/packages/dealclaw-agent/payload/skills/"
)
LEDGER_URL = os.environ.get("CREDITS_LEDGER_URL", "http://localhost:8081")

CATEGORY_PARAMS = {
    "买家搜索与分析":   {"direct_cost": 0.80, "risk": 1.3, "margin": 0.65, "biz_value": 200, "unit": "per_item"},
    "客户触达":         {"direct_cost": 0.15, "risk": 1.2, "margin": 0.50, "biz_value": 30,  "unit": "per_email"},
    "展会服务":         {"direct_cost": 0.50, "risk": 1.3, "margin": 0.55, "biz_value": 100, "unit": "per_person"},
    "数据管理":         {"direct_cost": 0.10, "risk": 1.1, "margin": 0.80, "biz_value": 50,  "unit": "per_use"},
    "免费服务":         {"direct_cost": 0,    "risk": 1.0, "margin": 0,    "biz_value": 0,   "unit": "per_use"},
}

def classify(skill_name):
    name = skill_name.lower()
    if any(w in name for w in ["buyer", "hunter", "find"]): return "买家搜索与分析"
    if any(w in name for w in ["email", "mail", "reply", "smart"]): return "客户触达"
    if any(w in name for w in ["exhibition", "expo"]): return "展会服务"
    if any(w in name for w in ["import", "lead"]): return "数据管理"
    if any(w in name for w in ["review", "bind", "knowledge", "base"]): return "免费服务"
    return "数据管理"

def auto_price(category):
    p = CATEGORY_PARAMS[category]
    if p["direct_cost"] == 0: return 0
    cost_floor = p["direct_cost"] * p["risk"] / 0.01 / (1 - p["margin"])
    return max(p["biz_value"], round(cost_floor / 100) * 100)

def get_db_skills():
    """Get all registered skill IDs from credits-ledger."""
    try:
        import urllib.request
        req = urllib.request.Request(f"{LEDGER_URL}/v1/skill-prices")
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read())
        return {p["skillId"] for p in data.get("prices", [])}
    except Exception as e:
        print(f"Warning: could not reach credits-ledger: {e}", file=sys.stderr)
        return set()

def get_code_skills():
    """Get all dealclaw skill IDs from the codebase."""
    skills = set()
    if not os.path.isdir(SKILLS_DIR):
        return skills
    for entry in os.listdir(SKILLS_DIR):
        if entry.startswith("dealclaw-") and os.path.isdir(os.path.join(SKILLS_DIR, entry)):
            skills.add(entry)
    return skills

def add_skill(skill_id, category, credit, unit):
    """Add a skill to credits-ledger via API."""
    import urllib.request
    name = skill_id.replace("dealclaw-", "").replace("-", " ").title()
    body = json.dumps({
        "skillName": name,
        "description": f"Auto-synced from codebase",
        "category": category,
        "creditPerUnit": credit,
        "billingUnit": unit,
        "status": "shadow",
        "sortOrder": 99,
    }).encode()
    req = urllib.request.Request(
        f"{LEDGER_URL}/v1/skill-prices/{skill_id}",
        data=body, method="PUT",
        headers={"Content-Type": "application/json"}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=5)
        return json.loads(resp.read())
    except Exception as e:
        return {"ok": False, "error": str(e)}

def main():
    code = get_code_skills()
    db = get_db_skills()
    
    new_skills = code - db
    if not new_skills:
        print(f"✅ Synced: {len(code)} skills in code, {len(db)} in DB. No new skills.")
        return 0
    
    print(f"🔔 {len(new_skills)} new skill(s) detected:")
    added = 0
    for sid in sorted(new_skills):
        cat = classify(sid)
        price = auto_price(cat)
        unit = CATEGORY_PARAMS[cat]["unit"]
        print(f"  + {sid} → {cat} → {price} Credit/{unit} (shadow)")
        
        result = add_skill(sid, cat, price, unit)
        if result.get("ok"):
            added += 1
            print(f"    ✅ Added")
        else:
            print(f"    ❌ Failed: {result.get('error', 'unknown')}")
    
    print(f"\nDone: {added}/{len(new_skills)} new skills added.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
