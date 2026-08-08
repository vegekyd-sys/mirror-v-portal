#!/usr/bin/env python3
"""
DC-Morning-Report — DealClaw 每日早报生成器

用法:
  python3 dc_morning_report.py solarunis.com           # 终端输出
  python3 dc_morning_report.py solarunis.com --json     # JSON 格式（供 cron 调用）
  python3 dc_morning_report.py solarunis.com ou_xxx     # 销售视角

输出:
  1. 漏斗数据（JSON 文本，供飞书卡片渲染）
  2. 线索摘要
  3. 操作摘要
"""

import json, os, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dc_ls_store import LeadStore
from dc_send_log import SendLog
from dc_audit import AuditLog

IQ_STAGE_LABELS = {0:"未建联", 1:"已回复", 2:"已表达兴趣", 3:"已索要资料", 4:"已预约会议", 5:"销售跟进", -1:"已暂停"}
FUNNEL_STAGES = ["线索池", "有效线索", "已触达", "已回复", "跟进中"]


def funnel(enterprise: str, user_open_id="") -> dict:
    """计算企业漏斗"""
    store = LeadStore()
    slog = SendLog()

    if user_open_id:
        leads = store.get_user_leads(user_open_id, enterprise=enterprise) or []
    else:
        leads = store.get_enterprise_leads(enterprise) or []

    pool = len(leads)
    valid = sum(1 for l in leads if l.get("status") == "我的买家")
    replied = sum(1 for l in leads if l.get("iq_stage", 0) >= 1)
    following = sum(1 for l in leads if l.get("iq_stage", 0) in (2, 3, 4))

    # 已触达：从 send_log 统计有发送记录的独立买家
    activities = slog.recent_activities(limit=500, enterprise=enterprise,
                                        user_open_id=user_open_id if user_open_id else "")
    touched = len({a.get("buyer_domain", "") for a in activities if a.get("type") == "sent"}) or valid

    stages = [
        {"name": "线索池",   "count": pool,     "pct": "—"},
        {"name": "有效线索", "count": max(valid, pool), "pct": f"{max(valid,pool)/max(pool,1)*100:.0f}%" if pool > 0 else "—"},
        {"name": "已触达",   "count": touched,   "pct": f"{touched/max(max(valid,pool),1)*100:.0f}%" if max(valid,pool) > 0 else "—"},
        {"name": "已回复",   "count": replied,   "pct": f"{replied/max(touched,1)*100:.0f}%" if touched > 0 else "—"},
        {"name": "跟进中",   "count": following, "pct": f"{following/max(replied,1)*100:.0f}%" if replied > 0 else "—"},
    ]
    # 修正：每一步 <= 上一步
    for i in range(1, len(stages)):
        stages[i]["count"] = min(stages[i]["count"], stages[i-1]["count"])

    return {
        "enterprise": enterprise,
        "funnel": stages,
        "total_leads": pool,
        "active_buyers": following + replied,
        "date": datetime.now().strftime("%m/%d"),
    }


def daily_stats(enterprise: str, user_open_id="") -> dict:
    """今日发送/回复统计"""
    slog = SendLog()
    aud = AuditLog()

    stats = slog.stats_today(enterprise=enterprise, user_open_id=user_open_id) if user_open_id else {
        "sent": 0, "delivered": 0, "bounced": 0, "opened": 0, "replied": 0,
    }

    # 本周审计操作统计
    week_actions = aud.action_stats(enterprise, days=7)
    total_actions = sum(sum(acts.values()) for acts in week_actions.values())

    return {
        "sent_today": stats.get("sent", 0),
        "delivered_today": stats.get("delivered", 0),
        "bounced_today": stats.get("bounced", 0),
        "opened_today": stats.get("opened", 0),
        "replied_today": stats.get("replied", 0),
        "week_actions": total_actions,
        "date": datetime.now().strftime("%m/%d"),
    }


def lead_summary(enterprise: str, user_open_id="", limit=8) -> list:
    """线索摘要：最近活动的买家"""
    store = LeadStore()
    if user_open_id:
        leads = store.get_user_leads(user_open_id, enterprise=enterprise) or []
    else:
        leads = store.get_enterprise_leads(enterprise) or []

    # 按最近活动排序
    leads.sort(key=lambda l: l.get("iq_updated_at") or l.get("updated_at") or "", reverse=True)
    active = [l for l in leads if l.get("iq_stage", 0) >= 1][:limit]
    inactive = [l for l in leads if l.get("iq_stage", 0) == 0][:2]

    result = []
    for l in active:
        stage = l.get("iq_stage", 0)
        result.append({
            "company": (l.get("company_name", "") or l.get("domain", ""))[:20],
            "domain": l.get("domain", ""),
            "stage": IQ_STAGE_LABELS.get(stage, "?"),
            "intent": l.get("iq_last_intent", ""),
        })
    if inactive and not active:
        result.append({"company": f"还有 {len(inactive)} 条线索待触达", "domain": "", "stage": "待触达", "intent": ""})
    return result


def build_card(enterprise: str, target_user="") -> dict:
    """生成飞书卡片 JSON（气泡通知用）"""
    f = funnel(enterprise, target_user)
    s = daily_stats(enterprise, target_user)
    ls = lead_summary(enterprise, target_user, limit=5)

    # 漏斗可视化条
    max_count = max(st["count"] for st in f["funnel"]) or 1
    funnel_bars = "\n".join(
        f"  {st['name']:6s}  {'█' * max(1, int(st['count']/max_count*15))} {st['count']}"
        for st in f["funnel"]
    )

    lead_lines = "\n".join(
        f"  · {l['company']:20s} {l['stage']}"
        for l in ls[:5]
    ) if ls else "  暂无活跃买家"

    # 🔄 Evolution→早报: 拉取进化建议
    evo_text = ""
    try:
        from dc_evolution import run_all as run_evolution
        insights = run_evolution(enterprise, days=7)
        if insights:
            evo_text = "\n🧬 进化建议\n"
            for ins in insights[:2]:
                evo_text += f"  · {ins.get('suggestion','')[:60]}\n"
    except Exception:
        pass

    body = f"""☀️ DealClaw 早报 · {f['date']}

📊 业务漏斗
{funnel_bars}

📬 今日发送 {s['sent_today']} 封 | 到达 {s['delivered_today']} | 打开 {s['opened_today']} | 回复 {s['replied_today']}

🔍 活跃买家
{lead_lines}{evo_text}
🔗 详情: https://hit5b11g3sf.feishu.cn/base/SxLabNXXkazqW9sxcIbcekf1nHe"""

    card = {
        "title": f"☀️ DealClaw 早报",
        "content": body,
        "elements": [
            {"tag": "markdown", "content": body},
        ],
    }
    return card


def main():
    import sys
    enterprise = sys.argv[1] if len(sys.argv) > 1 else "solarunis.com"
    user = sys.argv[2] if len(sys.argv) > 2 else ""
    as_json = "--json" in sys.argv

    if as_json:
        result = {
            "funnel": funnel(enterprise, user),
            "stats": daily_stats(enterprise, user),
            "leads": lead_summary(enterprise, user),
            "card": build_card(enterprise, user),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        card = build_card(enterprise, user)
        print(card["content"])


if __name__ == "__main__":
    main()
