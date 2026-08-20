#!/usr/bin/env python3
"""DC-Audit 审计日志引擎 — 谁、什么企业、做了什么、改了什么、什么时候"""

import json, os
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent / "data")))
AUDIT_FILE = DATA_DIR / "audit_log.jsonl"

# ── 操作类型 ──────────────────────────────────────────────
ACTION_LABELS = {
    "lead.annotate":     "标注线索",
    "lead.save":         "线索入库",
    "lead.dedup_filter": "去重过滤",
    "kb.seed":           "KB 播种",
    "kb.delete":         "删除材料",
    "profile.update":    "更新画像",
    "send.gs":           "GS 发送",
    "send.fd":           "FD 发送",
    "iq.process":        "IQ 处理",
    "iq.unsubscribed":   "IQ 退订",
    "prefs.update":      "修改偏好",
    "enterprise.create": "新企业入驻",
    "search.perform":    "买家搜索",
}


def _now():
    return datetime.now(timezone.utc).isoformat()


class AuditLog:
    """审计日志引擎 — 企业隔离，不可篡改"""

    def __init__(self):
        os.makedirs(str(DATA_DIR), exist_ok=True)

    def log(self, action, user_open_id="", enterprise="", target="",
            detail="", before=None, after=None):
        """
        写入一条审计记录。

        action:   操作类型 (lead.annotate / send.gs / kb.seed 等)
        user:     操作人 open_id
        enterprise: 所属企业
        target:   操作对象 (域名、邮箱、材料名等)
        detail:   人类可读的操作描述
        before:   变更前值 (可选)
        after:    变更后值 (可选)
        """
        if not enterprise:
            raise ValueError("audit log requires enterprise for tenant isolation")
        entry = {
            "_ts": _now(),
            "action": action,
            "user_open_id": user_open_id,
            "enterprise": enterprise,
            "target": target,
            "detail": detail[:200],
        }
        if before is not None:
            entry["before"] = before
        if after is not None:
            entry["after"] = after
        with open(AUDIT_FILE, 'a') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')

    # ── 查询 ──

    def _read(self, days=30):
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        records = []
        if not AUDIT_FILE.exists():
            return records
        with open(AUDIT_FILE) as f:
            for line in f:
                try:
                    r = json.loads(line.strip())
                    if r.get("_ts", "") >= cutoff:
                        records.append(r)
                except Exception:
                    pass
        return records

    def user_actions(self, user_open_id, enterprise, days=7):
        """某销售在某企业内的操作记录"""
        ent = enterprise.lower()
        records = self._read(days)
        return [r for r in records
                if r.get("enterprise", "").lower() == ent
                and r.get("user_open_id") == user_open_id]

    def enterprise_actions(self, enterprise, days=7):
        """某企业所有成员的操作记录（老板视角）"""
        ent = enterprise.lower()
        records = self._read(days)
        return [r for r in records
                if r.get("enterprise", "").lower() == ent]

    def action_stats(self, enterprise, days=7):
        """操作统计：按用户 × 操作类型聚合"""
        actions = self.enterprise_actions(enterprise, days)
        stats = {}
        for a in actions:
            uid = a.get("user_open_id", "?")
            action = a.get("action", "?")
            if uid not in stats:
                stats[uid] = {}
            stats[uid][action] = stats[uid].get(action, 0) + 1
        return stats

    def recent(self, enterprise, limit=20):
        """最近操作列表（老板实时看板用）"""
        actions = self.enterprise_actions(enterprise, days=30)
        actions.sort(key=lambda r: r.get("_ts", ""), reverse=True)
        return actions[:limit]

    # ── 批量查询（飞书看板用） ──

    def dashboard_data(self, enterprise, days=7):
        """返回看板需要的聚合数据"""
        stats = self.action_stats(enterprise, days)
        recent = self.recent(enterprise, 15)
        total = sum(sum(acts.values()) for acts in stats.values())

        user_summaries = []
        for uid, acts in stats.items():
            user_summaries.append({
                "user": uid,
                "total": sum(acts.values()),
                "breakdown": {
                    ACTION_LABELS.get(k, k): v
                    for k, v in sorted(acts.items(), key=lambda x: -x[1])
                },
            })
        user_summaries.sort(key=lambda u: -u["total"])

        return {
            "enterprise": enterprise,
            "days": days,
            "total_actions": total,
            "users": user_summaries,
            "recent": [
                {
                    "ts": r.get("_ts", "")[:19],
                    "user": r.get("user_open_id", "")[-8:],
                    "action": ACTION_LABELS.get(r.get("action", ""), r.get("action", "")),
                    "detail": r.get("detail", ""),
                }
                for r in recent
            ],
        }


# ── CLI ───────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    al = AuditLog()
    if len(sys.argv) < 2:
        print("dc_audit.py dashboard|stats|recent|user <enterprise> [user_open_id]")
        sys.exit(1)

    cmd = sys.argv[1]
    enterprise = sys.argv[2] if len(sys.argv) > 2 else ""

    if cmd == "dashboard":
        print(json.dumps(al.dashboard_data(enterprise), ensure_ascii=False, indent=2))
    elif cmd == "stats":
        stats = al.action_stats(enterprise)
        for uid, acts in stats.items():
            print(f"\n{uid[-12:]}:")
            for act, count in sorted(acts.items(), key=lambda x: -x[1]):
                print(f"  {ACTION_LABELS.get(act, act)}: {count}")
    elif cmd == "recent":
        for r in al.recent(enterprise, 20):
            label = ACTION_LABELS.get(r["action"], r["action"])
            print(f"[{r['_ts'][:19]}] {r['user_open_id'][-8:]:8s} | {label:10s} | {r['detail'][:60]}")
    elif cmd == "user":
        if len(sys.argv) < 4:
            print("用法: user <enterprise> <user_open_id>"); sys.exit(1)
        for r in al.user_actions(sys.argv[3], enterprise):
            label = ACTION_LABELS.get(r["action"], r["action"])
            print(f"[{r['_ts'][:19]}] {label:10s} | {r['detail'][:60]}")
    elif cmd == "log":
        # 手动写一条审计记录
        # python dc_audit.py log <enterprise> <user_open_id> <action> <target> <detail>
        if len(sys.argv) < 7:
            print("用法: log <enterprise> <user_open_id> <action> <target> <detail>")
            sys.exit(1)
        al.log(action=sys.argv[4], user_open_id=sys.argv[3], enterprise=sys.argv[2],
               target=sys.argv[5], detail=sys.argv[6])
        print("✅ 审计记录已写入")
