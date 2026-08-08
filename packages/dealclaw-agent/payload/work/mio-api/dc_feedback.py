#!/usr/bin/env python3
"""
DC-Feedback — 用户反馈纠错引擎

核心回路:
  用户说"这个错了" → capture 反馈 → 精准修正 → 对应引擎/Skill 立即生效

反馈类型:
  intent_correct   — "这个买家回复不是'拒绝'，是'索要资料'"
  search_bad       — "这5条搜索结果是垃圾"
  persona_wrong    — "画像里德国权重太高了"
  template_better  — "用这个模板替代默认模板"
  lead_mislabel    — "这个买家不该是'我的买家'"

每条反馈 = 直接训练数据，比统计推断精确得多。

用法:
  python3 dc_feedback.py record intent_correct "买家回复其实是在要目录"
  python3 dc_feedback.py apply   # 应用所有待处理的纠错
  python3 dc_feedback.py stats   # 反馈统计
"""

import json, os, sys
from datetime import datetime, timezone
from pathlib import Path
from collections import Counter

DATA_DIR = Path(__file__).resolve().parent / "data"
FEEDBACK_FILE = DATA_DIR / "feedback.jsonl"
CORRECTIONS_FILE = DATA_DIR / "corrections_applied.jsonl"


def _now():
    return datetime.now(timezone.utc).isoformat()


# ═══════════════════════════════════════════════════════════
#  反馈捕获
# ═══════════════════════════════════════════════════════════

FEEDBACK_TYPES = {
    "intent_correct": {
        "label": "意图纠错",
        "target": "dc_iq_engine.INTENT_PATTERNS",
        "example": "用户说: '这个买家回复不是在拒绝，他是在索要资料'",
    },
    "search_bad": {
        "label": "搜索结果差",
        "target": "dc_customer_import.buyer_similarity",
        "example": "用户说: '这5条都不对，我要的是安装商不是分销商'",
    },
    "persona_wrong": {
        "label": "画像不准",
        "target": "dc_kb_engine.persona",
        "example": "用户说: '德国权重太高了，我的买家主要是荷兰的'",
    },
    "template_better": {
        "label": "模板优化",
        "target": "dc_copy_engine.email templates",
        "example": "用户说: '用这个模板回复效果更好'",
    },
    "lead_mislabel": {
        "label": "线索标错",
        "target": "dc_ls_store.annotate",
        "example": "用户说: '这家不是我的买家，是竞品'",
    },
    "material_missing": {
        "label": "物料缺失",
        "target": "dc_kb_engine.materials",
        "example": "用户说: '买家要FDE-800 datasheet，我们没有'",
    },
    "general": {
        "label": "通用反馈",
        "target": "system",
        "example": "用户说: '整体搜索结果质量下降了'",
    },
}


def record_feedback(fb_type, user_message, enterprise="", user_open_id="",
                    context=None, severity="normal"):
    """
    记录一条用户反馈。

    fb_type:   反馈类型 (intent_correct / search_bad / ...)
    user_message: 用户原话
    context:   上下文 ({buyer_domain, keyword, engine_output, ...})
    severity:  low / normal / high
    """
    if fb_type not in FEEDBACK_TYPES:
        fb_type = "general"

    entry = {
        "_ts": _now(),
        "type": fb_type,
        "user_message": user_message[:500],
        "enterprise": enterprise,
        "user_open_id": user_open_id,
        "severity": severity,
        "context": context or {},
        "applied": False,
        "applied_at": None,
    }
    os.makedirs(str(DATA_DIR), exist_ok=True)
    with open(FEEDBACK_FILE, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    return entry


def pending_feedback(fb_type=None, enterprise=None):
    """获取待处理的反馈"""
    if not FEEDBACK_FILE.exists():
        return []
    results = []
    with open(FEEDBACK_FILE) as f:
        for line in f:
            try:
                r = json.loads(line.strip())
                if r.get("applied"):
                    continue
                if fb_type and r.get("type") != fb_type:
                    continue
                if enterprise and r.get("enterprise","").lower() != enterprise.lower():
                    continue
                results.append(r)
            except Exception:
                pass
    return results


# ═══════════════════════════════════════════════════════════
#  纠错应用 — 把反馈变成实际的引擎修正
# ═══════════════════════════════════════════════════════════

def apply_corrections(enterprise=None, auto_apply=False):
    """
    遍历待处理反馈，应用修正。

    auto_apply=True: 自动应用低风险修正
    auto_apply=False: 仅展示建议，不实际修改
    """
    pending = pending_feedback(enterprise=enterprise)
    if not pending:
        return {"status": "ok", "applied": 0, "message": "没有待处理的反馈"}

    applied = []
    suggestions = []

    for fb in pending:
        fb_type = fb["type"]
        action = _apply_one(fb, dry_run=not auto_apply)

        if action["status"] == "applied":
            fb["applied"] = True
            fb["applied_at"] = _now()
            applied.append(action)
            # 记录修正历史
            with open(CORRECTIONS_FILE, 'a') as f:
                f.write(json.dumps({
                    "feedback": fb["user_message"][:200],
                    "type": fb_type,
                    "action": action["description"],
                    "at": _now(),
                }, ensure_ascii=False) + '\n')
        elif action["status"] == "suggestion":
            suggestions.append(action)

    # 标记已应用
    if auto_apply and applied:
        _rewrite_feedback_file(pending)

    return {
        "status": "ok",
        "applied_count": len(applied),
        "suggestion_count": len(suggestions),
        "applied": [a["description"] for a in applied],
        "suggestions": [s["description"] for s in suggestions],
    }


def _apply_one(fb, dry_run=False):
    """应用单条反馈"""
    fb_type = fb["type"]
    ctx = fb.get("context", {})

    # ── intent_correct ──
    if fb_type == "intent_correct":
        actual = ctx.get("actual_intent", "")
        original = ctx.get("original_intent", "")
        if actual and original:
            desc = f"意图分类纠错: {original} → {actual}"
            if not dry_run:
                # 记录纠错到 IQ 学习文件，供 INTENT_PATTERNS 读取
                _record_intent_correction(fb["enterprise"], original, actual, fb["user_message"])
            return {"status": "applied" if not dry_run else "suggestion",
                    "description": desc, "target": "dc_iq_engine"}
        return {"status": "suggestion", "description": "缺少 actual/original 上下文", "target": "dc_iq_engine"}

    # ── search_bad ──
    if fb_type == "search_bad":
        expected_type = ctx.get("expected_buyer_type", "")
        actual = ctx.get("keyword", "")
        if expected_type:
            desc = f"搜索偏好调整: 推送更多'{expected_type}'类型，减少无关结果"
            if not dry_run:
                try:
                    from dc_kb_engine import KBEngine
                    kb = KBEngine()
                    persona = kb.get_persona(fb.get("enterprise", ""))
                    if persona:
                        persona["buyer_type"][expected_type] = persona.get("buyer_type", {}).get(expected_type, 0) + 0.15
                        kb.update_persona(fb["enterprise"], persona, source="feedback",
                                         weight=0.15, change=f"用户反馈: 偏好{expected_type}")
                except Exception:
                    pass
            return {"status": "applied" if not dry_run else "suggestion",
                    "description": desc, "target": "dc_kb_engine.persona.buyer_type"}

    # ── persona_wrong ──
    if fb_type == "persona_wrong":
        desc = "画像权重已根据用户反馈调整"
        if not dry_run:
            try:
                from dc_kb_engine import KBEngine
                kb = KBEngine()
                persona = kb.get_persona(fb.get("enterprise", ""))
                adjust = ctx.get("adjustments", {})
                if persona and adjust:
                    for field, values in adjust.items():
                        if field in persona:
                            persona[field].update(values)
                    kb.update_persona(fb["enterprise"], persona, source="feedback",
                                     weight=0.5, change=f"用户纠错: 画像调整")
            except Exception:
                pass
        return {"status": "applied" if not dry_run else "suggestion",
                "description": desc, "target": "dc_kb_engine.persona"}

    # ── template_better ──
    if fb_type == "template_better":
        desc = "模板偏好已记录，后续开发信将参考此模板"
        if not dry_run:
            _record_template_preference(fb["enterprise"], fb.get("context", {}))
        return {"status": "applied" if not dry_run else "suggestion",
                "description": desc, "target": "dc_copy_engine"}

    # ── material_missing ──
    if fb_type == "material_missing":
        material = ctx.get("material_type", "")
        desc = f"用户指出缺物料'{material}'，KB 缺口已更新"
        if not dry_run and material:
            try:
                from dc_kb_engine import KBEngine
                kb = KBEngine()
                kb.set_material(fb.get("enterprise", ""), material, name=f"待补充: {material}",
                               description=f"用户反馈缺失: {fb['user_message'][:100]}")
            except Exception:
                pass
        return {"status": "applied" if not dry_run else "suggestion",
                "description": desc, "target": "dc_kb_engine.materials"}

    return {"status": "suggestion", "description": f"反馈类型 {fb_type} 暂无自动修正逻辑",
            "target": FEEDBACK_TYPES.get(fb_type, {}).get("target", "unknown")}


def _rewrite_feedback_file(pending_fbs):
    """重写反馈文件，标记已应用"""
    all_entries = []
    with open(FEEDBACK_FILE) as f:
        for line in f:
            try:
                all_entries.append(json.loads(line.strip()))
            except Exception:
                pass
    for pf in pending_fbs:
        for ae in all_entries:
            if ae.get("_ts") == pf.get("_ts"):
                ae["applied"] = pf.get("applied", False)
                ae["applied_at"] = pf.get("applied_at")
                break
    with open(FEEDBACK_FILE, 'w') as f:
        for ae in all_entries:
            f.write(json.dumps(ae, ensure_ascii=False) + '\n')


def _record_intent_correction(enterprise, original, actual, user_message):
    """记录意图纠错到 IQ 学习文件，供 classify_intent() 读取"""
    intent_file = DATA_DIR / "intent_corrections.jsonl"
    entry = {
        "_ts": _now(),
        "enterprise": enterprise,
        "original": original,
        "actual": actual,
        "user_message": user_message[:200],
    }
    os.makedirs(str(DATA_DIR), exist_ok=True)
    with open(intent_file, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def _record_template_preference(enterprise, context):
    """记录模板偏好到 Copy 引擎可读的文件"""
    pref_file = DATA_DIR / "template_preferences.jsonl"
    entry = {
        "_ts": _now(),
        "enterprise": enterprise,
        "preferred_template": context.get("template_name", ""),
        "scenario": context.get("scenario", ""),
        "user_message": context.get("user_message", "")[:200],
    }
    os.makedirs(str(DATA_DIR), exist_ok=True)
    with open(pref_file, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


# ═══════════════════════════════════════════════════════════
#  统计 & 趋势
# ═══════════════════════════════════════════════════════════

def feedback_stats(enterprise=None, days=30):
    """反馈统计: 类型分布、趋势、修正率"""
    if not FEEDBACK_FILE.exists():
        return {"total": 0, "by_type": {}, "correction_rate": 0}

    cutoff = (datetime.now(timezone.utc) - __import__('datetime').timedelta(days=days)).isoformat()
    total = 0
    applied = 0
    by_type = Counter()
    severity = Counter()

    with open(FEEDBACK_FILE) as f:
        for line in f:
            try:
                r = json.loads(line.strip())
                if r.get("_ts", "") < cutoff:
                    continue
                if enterprise and r.get("enterprise","").lower() != enterprise.lower():
                    continue
                total += 1
                if r.get("applied"):
                    applied += 1
                by_type[r.get("type", "general")] += 1
                severity[r.get("severity", "normal")] += 1
            except Exception:
                pass

    return {
        "total": total,
        "applied": applied,
        "correction_rate": f"{applied/max(total,1)*100:.0f}%",
        "by_type": dict(by_type),
        "by_severity": dict(severity),
    }


# ── CLI ──
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("dc_feedback.py record|pending|apply|stats [enterprise]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "record":
        if len(sys.argv) < 4:
            print("用法: record <type> <message> [enterprise]")
            sys.exit(1)
        record_feedback(sys.argv[2], sys.argv[3],
                        enterprise=sys.argv[4] if len(sys.argv) > 4 else "")
        # 静默——不对用户输出

    elif cmd == "pending":
        enterprise = sys.argv[2] if len(sys.argv) > 2 else None
        items = pending_feedback(enterprise=enterprise)
        print(json.dumps([{"type": fb["type"], "msg": fb["user_message"][:80]} for fb in items],
                         ensure_ascii=False, indent=2))

    elif cmd == "apply":
        enterprise = sys.argv[2] if len(sys.argv) > 2 else None
        result = apply_corrections(enterprise=enterprise, auto_apply=True)
        # 静默——只输出 JSON 给自动化用
        print(json.dumps({"applied": result["applied_count"], "queued": result["suggestion_count"]}))

    elif cmd == "stats":
        enterprise = sys.argv[2] if len(sys.argv) > 2 else None
        print(json.dumps(feedback_stats(enterprise), ensure_ascii=False, indent=2))
