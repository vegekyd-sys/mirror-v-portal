#!/usr/bin/env python3
"""
DC-Evolution — 自进化回路引擎

四个学习回路，每个回路定期扫描已有数据，产出改进建议:

  回路 1: 模板优化    — 哪个开发信模板回复率最高？
  回路 2: 意图纠错    — IQ 意图分类有没有误判模式？
  回路 3: 搜索词学习  — 哪些搜索词带来了最好的买家？
  回路 4: KB 缺口     — 知识库里最应该补什么？

每个回路输出: {insight: "发现", suggestion: "建议", confidence: 0-1}

用法:
  python3 dc_evolution.py loop1 solarunis.com  # 模板优化
  python3 dc_evolution.py all solarunis.com     # 全部回路
"""

import json, os, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import Counter

DATA_DIR = Path(__file__).resolve().parent / "data"
EVOLUTION_FILE = DATA_DIR / "evolution_insights.jsonl"


def _now():
    return datetime.now(timezone.utc).isoformat()


def _save_insight(enterprise, loop, insight, suggestion, confidence, evidence=""):
    entry = {
        "_ts": _now(),
        "enterprise": enterprise,
        "loop": loop,
        "insight": insight[:200],
        "suggestion": suggestion[:200],
        "confidence": round(confidence, 2),
        "evidence": evidence[:200],
    }
    os.makedirs(str(DATA_DIR), exist_ok=True)
    with open(EVOLUTION_FILE, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    return entry


# ═══════════════════════════════════════════════════════════
#  回路 1: 模板优化 — 哪种邮件最有效？
# ═══════════════════════════════════════════════════════════

def loop_template_optimization(enterprise, days=30):
    """分析 send_log 中的发送→回复模式，找出最有效的邮件模板"""
    path = DATA_DIR / "send_log.jsonl"
    if not path.exists():
        return []

    sent_emails = {}  # resend_id → {template_type, buyer_domain, ts}
    replies = {}       # buyer_domain → count

    with open(path) as f:
        for line in f:
            try:
                r = json.loads(line.strip())
                if r.get("enterprise", "").lower() != enterprise.lower():
                    continue
                ts = r.get("_ts", "")
                cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
                if ts < cutoff:
                    continue

                if r.get("type") == "sent":
                    sid = r.get("resend_id") or r.get("fd_id")
                    if sid:
                        round_num = r.get("round", 1)
                        channel = r.get("channel", "")
                        sent_emails[r.get("buyer_domain", "")] = {
                            "round": round_num, "channel": channel,
                            "subject": r.get("subject", ""), "ts": ts,
                        }
                elif r.get("type") == "reply":
                    domain = r.get("buyer_domain", "")
                    replies[domain] = replies.get(domain, 0) + 1
            except Exception:
                pass

    insights = []
    if not sent_emails:
        return insights

    # 按轮次统计回复率
    round_stats = Counter()
    round_replies = Counter()
    for domain, info in sent_emails.items():
        rn = info["round"]
        round_stats[rn] += 1
        if domain in replies:
            round_replies[rn] += 1

    for rn in sorted(round_stats.keys()):
        sent = round_stats[rn]
        replied = round_replies.get(rn, 0)
        rate = replied / max(sent, 1)
        if sent >= 2:  # 样本量够才有意义
            if rate > 0.3:
                insights.append(_save_insight(enterprise, "template_opt",
                    f"R{rn} 邮件回复率 {rate:.0%} ({replied}/{sent})",
                    f"R{rn} 模板效果显著优于其他轮次，建议新买家优先使用 R{rn} 模板",
                    0.6, f"{replied}/{sent} replied"))

    # 检查是否有从未回复的轮次
    for rn in sorted(round_stats.keys()):
        if round_stats[rn] >= 5 and round_replies.get(rn, 0) == 0:
            insights.append(_save_insight(enterprise, "template_opt",
                f"R{rn} 邮件发送 {round_stats[rn]} 封，零回复",
                f"R{rn} 模板可能需要重写。检查主题行、CTA 和 value prop",
                0.7, f"{round_stats[rn]} sent, 0 replies"))

    return insights


# ═══════════════════════════════════════════════════════════
#  回路 2: 意图纠错 — IQ 分类有没有误判？
# ═══════════════════════════════════════════════════════════

def loop_intent_correction(enterprise, days=30):
    """检查 IQ 处理日志，找可能的意图误判模式"""
    path = DATA_DIR / "send_log.jsonl"
    if not path.exists():
        return []

    insights = []
    intent_counts = Counter()
    stage_dist = Counter()

    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with open(path) as f:
        for line in f:
            try:
                r = json.loads(line.strip())
                if r.get("enterprise", "").lower() != enterprise.lower():
                    continue
                if r.get("_ts", "") < cutoff:
                    continue
                if r.get("type") == "reply":
                    intent_counts[r.get("iq_intent", "unknown")] += 1
                    stage_dist[r.get("iq_stage", 0)] += 1
            except Exception:
                pass

    total = sum(intent_counts.values())
    if total < 5:
        return insights

    # 高置信度但冲突的模式
    rejected = intent_counts.get("拒绝", 0)
    if rejected / max(total, 1) > 0.4:
        insights.append(_save_insight(enterprise, "intent_correction",
            f"近{days}天 {rejected}/{total} 买家回复被识别为'拒绝'",
            "退订率偏高。检查是否有买家表达'暂时不需要'被误判为'拒绝'。建议复核INTENT_PATTERNS中'拒绝'的正则",
            0.5, f"{rejected}/{total} rejected"))

    # Stage 停滞: 大量买家停在 stage 1, 2
    stuck_1 = stage_dist.get(1, 0)
    if stuck_1 > total * 0.5:
        insights.append(_save_insight(enterprise, "intent_correction",
            f"{stuck_1}/{total} 买家停在'已回复'阶段未推进",
            "IQ 可能没有很好地引导买家到下一步。检查索要资料/表达兴趣的 CTA 是否足够具体",
            0.4, f"{stuck_1} stuck at stage 1"))

    return insights


# ═══════════════════════════════════════════════════════════
#  回路 3: 搜索词学习 — 什么关键词最有效？
# ═══════════════════════════════════════════════════════════

def loop_search_learning(enterprise, days=30):
    """分析搜索→标注→回复链条，找出哪些关键词带来了最好的买家"""
    # 从 leads.json 中找"被标注为买家"且"有回复"的线索，提取搜索关键词
    leads_path = DATA_DIR / "leads.json"
    if not leads_path.exists():
        return []

    insights = []
    try:
        leads = json.loads(leads_path.read_text())
        good_leads = [l for l in leads
                      if l.get("enterprise", "").lower() == enterprise.lower()
                      and l.get("status") == "我的买家"
                      and l.get("iq_stage", 0) >= 1]

        if not good_leads:
            return insights

        # 从好线索中提取共同特征
        countries = Counter(l.get("country", "") for l in good_leads if l.get("country"))
        if len(countries) > 1:
            top = countries.most_common(1)[0]
            if countries.most_common(2)[1][1] < top[1] * 0.5:
                insights.append(_save_insight(enterprise, "search_learning",
                    f"成交买家集中在 {top[0]} ({top[1]}/{len(good_leads)})",
                    f"建议搜索时优先筛选 {top[0]}，目标更精准",
                    0.7, f"{top[1]}/{len(good_leads)} from {top[0]}"))

        # 检查是否有从未成交的国家
        all_countries = set(l.get("country", "") for l in leads
                          if l.get("enterprise", "").lower() == enterprise.lower())
        dead_countries = all_countries - set(countries.keys())
        if dead_countries and len(dead_countries) <= 5:
            insights.append(_save_insight(enterprise, "search_learning",
                f"{len(dead_countries)} 个国家从未成交: {', '.join(sorted(dead_countries)[:5])}",
                "这些国家的搜索优先级可以降低，把精力集中在成交国",
                0.5, str(dead_countries)[:100]))

    except Exception:
        pass

    return insights


# ═══════════════════════════════════════════════════════════
#  回路 4: KB 缺口 — 最该补什么？
# ═══════════════════════════════════════════════════════════

def loop_kb_gap(enterprise, days=30):
    """分析 IQ 交互记忆 + KB 物料清单，建议最该补的内容"""
    kb_path = DATA_DIR / "kb" / f"{enterprise.lower().replace('.','').replace('-','')}.json"
    if not kb_path.exists():
        return []

    insights = []
    try:
        kb = json.loads(kb_path.read_text())

        # 检查缺失物料
        mats = kb.get("materials", {})
        missing = [t for t, m in mats.items() if m.get("status") != "ready"]
        if missing:
            labels = {"catalog": "产品目录", "price": "报价单", "spec": "技术规格",
                      "certificate": "认证", "sample": "样品", "case_study": "案例", "video": "视频"}
            names = [labels.get(m, m) for m in missing]
            insights.append(_save_insight(enterprise, "kb_gap",
                f"知识库缺 {len(missing)} 项: {', '.join(names[:4])}",
                f"补齐 {names[0]} 即可让 IQ 自动回复覆盖更多买家问题",
                0.8, f"missing: {names}"))

        # 从 IQ memory 找高频问题，看对应材料是否齐全
        iq_mem = kb.get("iq_memory", {})
        questions = iq_mem.get("common_questions", [])
        if questions:
            top_q = questions[0]
            keywords = top_q.get("question", "").lower()
            # 检查: 买家最常问的问题 → KB 有没有对应的材料
            if "price" in keywords or "报价" in keywords:
                if mats.get("price", {}).get("status") != "ready":
                    insights.append(_save_insight(enterprise, "kb_gap",
                        f"买家最常问报价 ({top_q['count']}次)，但 KB 无报价单",
                        "补齐报价单后 IQ 可以自动回复定价相关问题",
                        0.9, f"'{top_q['question'][:60]}' asked {top_q['count']}x"))
            if "catalog" in keywords or "目录" in keywords:
                if mats.get("catalog", {}).get("status") != "ready":
                    insights.append(_save_insight(enterprise, "kb_gap",
                        f"买家最常要目录 ({top_q['count']}次)，但 KB 无目录",
                        "补齐产品目录后 IQ 可以在首次互动中就提供",
                        0.9, f"'{top_q['question'][:60]}' asked {top_q['count']}x"))

    except Exception:
        pass

    return insights


# ═══════════════════════════════════════════════════════════
#  主入口
# ═══════════════════════════════════════════════════════════

LOOPS = {
    "loop1": ("模板优化", loop_template_optimization),
    "loop2": ("意图纠错", loop_intent_correction),
    "loop3": ("搜索词学习", loop_search_learning),
    "loop4": ("KB缺口", loop_kb_gap),
}


def run_all(enterprise, days=30):
    """运行全部四个回路"""
    all_insights = []
    for name, (label, fn) in LOOPS.items():
        results = fn(enterprise, days)
        if results:
            all_insights.extend(results)
    return all_insights


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: loop1|loop2|loop3|loop4|all <enterprise> [days]")
        sys.exit(1)

    cmd = sys.argv[1]
    enterprise = sys.argv[2] if len(sys.argv) > 2 else "solarunis.com"
    days = int(sys.argv[3]) if len(sys.argv) > 3 else 30

    if cmd == "all":
        insights = run_all(enterprise, days)
    elif cmd in LOOPS:
        insights = LOOPS[cmd][1](enterprise, days)
    else:
        print(f"未知回路: {cmd}")
        sys.exit(1)

    if not insights:
        print(f"🔇 近 {days} 天没有产生新的进化建议 (数据量可能不足)")
    else:
        print(f"🧬 自进化回路 — {enterprise} (近 {days} 天)")
        print(f"   {len(insights)} 条建议\n")
        for i, ins in enumerate(insights, 1):
            bar = "█" * int(ins["confidence"] * 10)
            print(f"  {i}. [{ins['loop']:15s}] {bar} {ins['confidence']:.0%}")
            print(f"     发现: {ins['insight']}")
            print(f"     建议: {ins['suggestion']}")
            print()
