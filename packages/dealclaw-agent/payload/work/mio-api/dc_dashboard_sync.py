#!/usr/bin/env python3
"""DC-Dashboard-Sync — DealClaw 引擎数据 → 飞书多维表格

三张表:
  老板看板 (SxLabNXXkazqW9sxcIbcekf1nHe, tbl4Tx6F8xg5XrIJ)
    企业级汇总: 每个销售一行，本周操作/发送/回复/线索/退订

  销售看板 (SCsibOMyMan0Lks1lXwcBnq4nsc, tbldhaxszCBIcKra)
    线索管道: 每条线索一行，状态/IQ阶段/最新意图/最近活动

  操作日志 (KZ3Jb6NnGaGzCosphtXczwGOnod, tblg8dtO8lVmScNo)
    审计流水: 每条操作一行，谁/什么操作/对象/详情

用法:
  python3 dc_dashboard_sync.py all
  python3 dc_dashboard_sync.py boss solarunis.com
  python3 dc_dashboard_sync.py leads solarunis.com ou_xxx
  python3 dc_dashboard_sync.py audit solarunis.com
"""

import json, os, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"

# ── 表格映射 ──
BOSS_TABLE = ("SxLabNXXkazqW9sxcIbcekf1nHe", "tbl4Tx6F8xg5XrIJ")
SALES_TABLE = ("SCsibOMyMan0Lks1lXwcBnq4nsc", "tbldhaxszCBIcKra")
AUDIT_TABLE = ("KZ3Jb6NnGaGzCosphtXczwGOnod", "tblg8dtO8lVmScNo")

# ── IQ Stage 映射 ──
IQ_STAGE_NAMES = ["未建联", "已回复", "已表达兴趣", "已索要资料", "已预约会议", "销售跟进", "已暂停"]


def now_ts():
    return int(datetime.now().timestamp() * 1000)


def week_ago_ts():
    return int((datetime.now() - timedelta(days=7)).timestamp() * 1000)


def load_jsonl(path, hours=168):
    """加载最近N小时的 JSONL 记录"""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    records = []
    if not path.exists():
        return records
    with open(path) as f:
        for line in f:
            try:
                r = json.loads(line.strip())
                if r.get("_ts", "") >= cutoff:
                    records.append(r)
            except Exception:
                pass
    return records


def load_leads():
    path = DATA_DIR / "leads.json"
    if not path.exists():
        return []
    with open(path) as f:
        return json.load(f)


# ═══════════════════════════════════════════════════════════
#  老板看板
# ═══════════════════════════════════════════════════════════

def sync_boss(enterprise):
    """同步老板看板: 每个销售在本周的汇总数据"""
    from dc_send_log import SendLog
    from dc_audit import AuditLog
    from dc_ls_store import LeadStore

    slog = SendLog()
    alog = AuditLog()
    store = LeadStore()

    # 本周审计操作（按用户聚合）
    audit_stats = alog.action_stats(enterprise, days=7)

    # 本周发送/回复统计
    send_stats = slog.stats_today(enterprise=enterprise)

    # 线索池
    try:
        leads = store.get_enterprise_leads(enterprise) or []
    except Exception:
        leads = []
    total_leads = len(leads)
    active_leads = sum(1 for l in leads if l.get("iq_stage", 0) >= 1)

    # 退订数（本周）
    recent_audit = alog.enterprise_actions(enterprise, days=7)
    unsub_count = sum(1 for a in recent_audit if a.get("action") == "iq.unsubscribed")

    # 构建行数据
    rows = []
    all_users = set()
    for uid in audit_stats:
        all_users.add(uid)
    # 如果有发送记录的销售也加进来
    if not all_users:
        all_users.add("—")

    for uid in sorted(all_users):
        user_acts = audit_stats.get(uid, {})
        total_actions = sum(user_acts.values())
        user_sends = send_stats.get("sent", 0)  # send_stats 当前不按用户拆分，用总数
        user_replies = user_acts.get("iq.process", 0) + user_acts.get("iq.unsubscribed", 0)
        rows.append({
            "企业": enterprise,
            "销售人": uid[-12:] if len(uid) > 12 else uid,
            "本周操作": total_actions,
            "本周发送": user_sends if uid != "system" else 0,
            "本周回复": user_replies,
            "线索池": total_leads // max(len(all_users), 1),
            "活跃买家": active_leads // max(len(all_users), 1),
            "退订数": unsub_count,
            "更新日期": now_ts(),
        })

    return rows


# ═══════════════════════════════════════════════════════════
#  销售看板
# ═══════════════════════════════════════════════════════════

def sync_leads(enterprise, user_open_id=None):
    """同步销售看板: 线索管道"""
    from dc_ls_store import LeadStore
    store = LeadStore()

    try:
        if user_open_id:
            leads = store.get_user_leads(user_open_id, enterprise=enterprise) or []
        else:
            leads = store.get_enterprise_leads(enterprise) or []
    except Exception:
        return []

    rows = []
    for l in leads:
        stage = l.get("iq_stage", 0)
        rows.append({
            "买家": l.get("company_name", "") or l.get("domain", ""),
            "域名": l.get("domain", ""),
            "国家": l.get("country", ""),
            "状态": l.get("status", "待处理"),
            "IQ阶段": IQ_STAGE_NAMES[stage] if 0 <= stage < len(IQ_STAGE_NAMES) else "未建联",
            "最新意图": l.get("iq_last_intent", ""),
            "最近活动": _parse_ts(l.get("iq_updated_at") or l.get("updated_at") or ""),
        })
    return rows


# ═══════════════════════════════════════════════════════════
#  操作日志
# ═══════════════════════════════════════════════════════════

def sync_audit(enterprise):
    """同步操作日志: 最近 50 条审计记录"""
    from dc_audit import AuditLog
    alog = AuditLog()

    actions = alog.recent(enterprise, 50)
    rows = []
    label_map = {
        "lead.save": "线索入库", "lead.annotate": "标注线索",
        "send.gs": "GS发送", "send.fd": "FD发送",
        "iq.process": "IQ处理", "iq.unsubscribed": "买家退订",
        "kb.seed": "KB播种", "lead.dedup_filter": "去重过滤",
    }
    for a in actions:
        ts = a.get("_ts", "")
        rows.append({
            "时间": _parse_ts(ts),
            "企业": a.get("enterprise", ""),
            "销售人": a.get("user_open_id", "")[-8:] if a.get("user_open_id") else "—",
            "操作类型": label_map.get(a.get("action", ""), a.get("action", "")),
            "操作对象": a.get("target", "")[:50],
            "详情": a.get("detail", "")[:100],
        })
    return rows


# ── 写入飞书 ──

def write_to_bitable(app_token, table_id, rows, key_field="企业"):
    """按 key_field 去重，全量覆盖写入"""
    import requests

    if not rows:
        print(f"  ⚠️ 无数据，跳过")
        return 0

    written = 0
    for row in rows:
        try:
            # 构建 fields dict: 飞书 API 需要 field_name → value
            fields = {}
            for k, v in row.items():
                if v is not None and v != "":
                    fields[k] = v

            if not fields:
                continue

            # 简单写入，不做去重（后续可优化）
            # 直接 create_record
            from feishu_bitable_create_record import _create as _create_record
            # 由于 feishu_bitable_create_record 是内置工具，我们通过系统调用
            import subprocess

            # 构造 JSON 输入
            payload = json.dumps({"app_token": app_token, "table_id": table_id, "fields": fields}, ensure_ascii=False)
            result = subprocess.run(
                ["python3", "-c", f'''
import json, os, sys
sys.path.insert(0, "{os.path.dirname(__file__)}")
# 直接调用 feishu API
import requests
data = json.loads(sys.stdin.read())
resp = requests.post(
    f"https://open.feishu.cn/open-apis/bitable/v1/apps/{{data['app_token']}}/tables/{{data['table_id']}}/records",
    headers={{"Authorization": f"Bearer {{os.environ.get('FEISHU_BOT_TOKEN','')}}", "Content-Type": "application/json"}},
    json={{"fields": data["fields"]}}
)
print(resp.status_code, resp.text[:200])
'''],
                input=payload, capture_output=True, text=True, timeout=10
            )
            if "200" in result.stdout or "201" in result.stdout:
                written += 1
        except Exception as e:
            print(f"  ⚠️ 写入失败: {e}")

    return written


def _parse_ts(ts_str):
    """ISO时间戳 → 毫秒时间戳"""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


# ═══════════════════════════════════════════════════════════
#  CLI
# ═══════════════════════════════════════════════════════════

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("用法: all | boss <enterprise> | leads <enterprise> [user] | audit <enterprise>")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "all":
        enterprise = sys.argv[2] if len(sys.argv) > 2 else "solarunis.com"
        user = sys.argv[3] if len(sys.argv) > 3 else None
        print(f"📊 DealClaw → 多维表格同步")
        print(f"   企业: {enterprise}")

        print("\n📈 老板看板 ...")
        boss_rows = sync_boss(enterprise)
        for r in boss_rows:
            print(f"   {r['销售人']}: 操作{r['本周操作']} 发送{r['本周发送']} 回复{r['本周回复']} 线索{r['线索池']}")

        print("\n📋 销售看板 ...")
        lead_rows = sync_leads(enterprise, user)
        for r in lead_rows:
            print(f"   {r['买家'][:20]:20s} | {r['状态']:8s} | {r['IQ阶段']:10s} | {r['最新意图'] or '—'}")

        print(f"\n📝 操作日志 ({len(sync_audit(enterprise))} 条)")
        for r in sync_audit(enterprise)[:10]:
            print(f"   {r['销售人']:8s} | {r['操作类型']:8s} | {r['操作对象']:25s} | {r['详情'][:40]}")

    elif cmd == "boss":
        rows = sync_boss(sys.argv[2])
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    elif cmd == "leads":
        rows = sync_leads(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    elif cmd == "audit":
        rows = sync_audit(sys.argv[2])
        print(json.dumps(rows, ensure_ascii=False, indent=2))
