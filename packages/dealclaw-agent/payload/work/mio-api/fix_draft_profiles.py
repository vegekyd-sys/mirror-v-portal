#!/usr/bin/env python3
"""一次性固化 3 个 draft_pending 群的 profile（意图确认口径）。

数据来源：草稿文档（用户亲口产品/市场）+ 记忆里的对话原话。
口径：用户亲口说的产品/市场 = 确认，不再等按钮。雪特朗目标市场取用户自报「主打墨西哥」。
"""
import json, hashlib, os
from datetime import datetime, timezone

DATA_DIR = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw/data/buyer-leads-v10"

def norm_hash(profile: dict) -> str:
    s = json.dumps({
        "products": profile.get("products", []),
        "buyer_types": profile.get("buyer_types", []),
        "target_countries": profile.get("target_countries", []),
    }, ensure_ascii=False, sort_keys=True)
    return "sha256:" + hashlib.sha256(s.encode("utf-8")).hexdigest()

def build_profile(chat_id, products, buyer_types, target_countries, keywords=()):
    p = {
        "source_chat_id": chat_id,
        "source_kind": "intent_confirmed",
        "status": "active",
        "products": products,
        "buyer_types": buyer_types,
        "target_countries": target_countries,
        "moq": None,
        "desired_buyer_tags": [],
        "buyer_profile_keywords": list(keywords),
        "intent_keywords": [],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    p["normalized_hash"] = norm_hash(p)
    return p

def P(name, aliases=(), categories=()):
    return {"name": name, "aliases": list(aliases), "categories": list(categories)}

def T(name, aliases=()):
    return {"name": name, "aliases": list(aliases)}

def C(name, aliases=()):
    return {"name": name, "aliases": list(aliases)}

PLANS = {
    "<GROUP_ID>": {  # 杭州金洢纺织
        "products": [
            P("polyester fabric", ["全涤面料"], ["纺织面料"]),
            P("taffeta fabric", ["窗帘塔夫绸"], ["纺织面料"]),
            P("oxford fabric", ["牛津布"], ["纺织面料"]),
            P("synthetic leather", ["合成皮革", "PVC仿皮"], ["面料"]),
            P("bag fabric", ["箱包面料"], ["面料"]),
        ],
        "buyer_types": [
            T("制造商", ["Manufacturer", "ODM工厂"]),
            T("贸易公司", ["Trading Company", "分销商"]),
            T("批发商", ["Wholesaler"]),
        ],
        "target_countries": [C("墨西哥", ["Mexico"])],
        "keywords": ["polyester fabric", "taffeta fabric", "oxford fabric", "synthetic leather", "bag fabric"],
    },
    "<GROUP_ID>": {  # 领艺智能家居
        "products": [
            P("office furniture", ["办公家具"], ["办公家具"]),
            P("executive desk", ["班台"], ["办公家具"]),
            P("standing desk", ["升降桌", "height adjustable desk"], ["办公家具"]),
            P("nursing bed", ["护理床"], ["养老护理"]),
        ],
        "buyer_types": [
            T("经销商", ["Distributor"]),
            T("品牌商", ["Brand"]),
        ],
        "target_countries": [C("南非", ["South Africa"]), C("墨西哥", ["Mexico"])],
        "keywords": ["office furniture", "executive desk", "standing desk", "nursing bed"],
    },
    "<GROUP_ID>": {  # 雪特朗电器
        "products": [
            P("coffee machine", ["咖啡机", "coffee maker"], ["咖啡机"]),
            P("kitchen appliance", ["厨房小家电"], ["小家电"]),
            P("personal care appliance", ["家居/个人护理小家电"], ["小家电"]),
        ],
        "buyer_types": [
            T("进口商", ["Importer"]),
            T("品牌商", ["Brand"]),
            T("经销商", ["Distributor"]),
        ],
        "target_countries": [C("墨西哥", ["Mexico"])],
        "keywords": ["coffee machine", "kitchen appliance", "coffee maker"],
    },
}

for chat_id, plan in PLANS.items():
    path = os.path.join(DATA_DIR, f"{chat_id}.json")
    state = json.load(open(path, encoding="utf-8"))
    state["profile"] = build_profile(
        chat_id, plan["products"], plan["buyer_types"], plan["target_countries"], plan.get("keywords", ())
    )
    state["status"] = "active"
    state["revision"] = int(state.get("revision", 0)) + 1
    gu = state.setdefault("固化", {})
    gu["confirmed_by"] = "intent_based"
    gu["confirmed_at"] = datetime.now(timezone.utc).isoformat()
    gu["source"] = gu.get("source", "") + " | 意图确认固化 2026-08-19（用户亲口产品/市场，非按钮）"
    # 保留 pending_fields 里的企业名变体，但不阻塞推送
    tmp = path + ".tmp"
    json.dump(state, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    print(f"✓ {chat_id} → active, products={len(plan['products'])}, countries={[c['name'] for c in plan['target_countries']]}")
