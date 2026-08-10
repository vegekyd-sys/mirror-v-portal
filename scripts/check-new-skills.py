#!/usr/bin/env python3
"""Check for new DealClaw skills not yet in the pricing bitable.
Run periodically or on demand. Outputs new skills with auto-pricing."""

import subprocess, json, sys, os

SKILLS_DIR = os.path.expanduser(
    "~/makaron-openclaw/.openclaw-local/workspace/dealclaw/packages/dealclaw-agent/payload/skills/"
)
BASE_TOKEN = "Tc8ZbEHGDaYthHsubHZcp7m1nNh"
TABLE_ID = "tblrK2J6J6OmL6aQ"

# Pricing formula: Skill Credit = max(biz_value_floor, cost_floor)
# cost_floor = direct_cost × risk_coef ÷ 0.01 ÷ (1 - margin_target)
# Categories and their default pricing params:
CATEGORY_PARAMS = {
    "买家搜索与分析": {"direct_cost": 0.80, "risk": 1.3, "margin": 0.65, "biz_value": 200, "unit": "per_item"},
    "客户触达":       {"direct_cost": 0.20, "risk": 1.2, "margin": 0.50, "biz_value": 30,  "unit": "per_email"},
    "展会服务":       {"direct_cost": 0.50, "risk": 1.3, "margin": 0.55, "biz_value": 100, "unit": "per_person"},
    "数据管理":       {"direct_cost": 0.10, "risk": 1.1, "margin": 0.80, "biz_value": 50,  "unit": "per_use"},
    "免费服务":       {"direct_cost": 0,    "risk": 1.0, "margin": 0,    "biz_value": 0,   "unit": "per_use"},
}

def classify_skill(skill_name: str) -> str:
    """Guess category from skill name."""
    if any(w in skill_name for w in ["buyer", "hunter", "find", "买家", "猎客"]): return "买家搜索与分析"
    if any(w in skill_name for w in ["email", "mail", "reply", "smart", "邮件", "开发信", "回复"]): return "客户触达"
    if any(w in skill_name for w in ["exhibition", "expo", "展会", "展后", "邀约"]): return "展会服务"
    if any(w in skill_name for w in ["import", "lead", "导入", "线索"]): return "数据管理"
    if any(w in skill_name for w in ["review", "bind", "knowledge", "base", "知识库", "邮箱绑定", "画像"]): return "免费服务"
    return "数据管理"  # default

def auto_price(category: str) -> int:
    """Calculate credit price using formula from the pricing doc."""
    p = CATEGORY_PARAMS.get(category, CATEGORY_PARAMS["数据管理"])
    if p["direct_cost"] == 0:
        return 0
    cost_floor = p["direct_cost"] * p["risk"] / 0.01 / (1 - p["margin"])
    final = max(p["biz_value"], round(cost_floor / 100) * 100)  # round to nearest 100
    return max(final, 50)  # minimum 50

def get_bitable_skills():
    """Get all skill IDs already in the bitable."""
    result = subprocess.run([
        "lark-cli", "base", "+record-list",
        "--base-token", BASE_TOKEN,
        "--table-id", TABLE_ID,
        "--as", "bot"
    ], capture_output=True, text=True)
    import re
    # Extract Skill IDs from table output
    ids = set()
    for line in result.stdout.split('\n'):
        if '| dealclaw-' in line:
            parts = line.split('|')
            for p in parts:
                p = p.strip()
                if p.startswith('dealclaw-'):
                    ids.add(p)
    return ids

def get_code_skills():
    """Get all skill IDs from the codebase."""
    skills = set()
    for entry in os.listdir(SKILLS_DIR):
        if entry.startswith("dealclaw-"):
            skills.add(entry)
    return skills

def main():
    code_skills = get_code_skills()
    bitable_skills = get_bitable_skills()
    
    new_skills = code_skills - bitable_skills
    
    if not new_skills:
        print("✅ All skills in codebase are already in the pricing table.")
        return 0
    
    print(f"🔔 Found {len(new_skills)} new skill(s) not yet priced:\n")
    
    for skill_id in sorted(new_skills):
        category = classify_skill(skill_id)
        price = auto_price(category)
        params = CATEGORY_PARAMS.get(category, CATEGORY_PARAMS["数据管理"])
        cost_floor = (params["direct_cost"] * params["risk"] / 0.01 / (1 - params["margin"])) if params["direct_cost"] > 0 else 0
        
        print(f"  {skill_id}")
        print(f"    分类: {category}")
        print(f"    建议定价: {price} Credit/{params['unit']}")
        print(f"    状态: shadow（待人工确认后切 live）")
        print(f"    成本底线: {cost_floor:.0f}")
        print()
    
    print(f"Run with --commit to add them to the bitable automatically.")
    return len(new_skills)

if __name__ == "__main__":
    sys.exit(main())
