#!/usr/bin/env python3
"""
DC-Campaign — DealClaw 展会 Campaign 管理（P0-2）

围绕用户购买的展会建立倒计时 Campaign。提供 CRUD、指标计算和动态评估。

持久化：data/campaigns/<company_id>/<campaign_id>.md
  JSONL-in-markdown（头部 # 注释 + 单条 JSON），沿用 dc_notify 的文件锁+原子替换约定。

phase 是 evaluate_campaign 的动态判断结果，不建立复杂状态机：
  - calibration  校准画像和首批内容
  - scale        稳定寻找并邀约
  - sprint       集中高匹配买家和跟进
  - pre_show     确认约见和会前准备

展会临近只能提高任务优先级，不得自动突破用户发送授权。
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path

DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent / "data")))
CAMPAIGNS_DIR = DATA_DIR / "campaigns"

VALID_STATUSES = {"active", "paused", "completed", "cancelled"}
# 自动化授权范围（由窄到宽）；展会临近不得自动升级
AUTOMATION_SCOPES = ("research_only", "research_invite", "research_invite_followup", "full")

_CAMPAIGN_FIELDS = {
    "campaign_id", "company_id", "exhibition_name", "exhibition_date",
    "target_invites", "target_meetings", "status", "buyer_profile_confirmed",
    "automation_scope", "strategy_version", "current_strategy",
    "owner_open_id", "created_at", "updated_at",
}

_HEADER = "# DealClaw Campaign\n# DO NOT EDIT MANUALLY. Managed by dc_campaign.py. One JSON object per line.\n"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today(tz_name: str = "Asia/Shanghai") -> str:
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo(tz_name)).strftime("%Y-%m-%d")


@contextmanager
def _file_lock(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    f = open(lock_path, "a")
    fcntl.flock(f, fcntl.LOCK_EX)
    try:
        yield
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _campaign_path(company_id: str, campaign_id: str) -> Path:
    return CAMPAIGNS_DIR / company_id / f"{campaign_id}.md"


def _slug(value: str) -> str:
    """把展览名转成安全 slug。"""
    import re
    s = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "-", value or "").strip("-").lower()
    return s or "campaign"


def _gen_campaign_id(company_id: str, exhibition_name: str) -> str:
    base = f"{company_id}-{_slug(exhibition_name)}"
    suffix = hashlib.sha1(f"{base}-{_now()}".encode()).hexdigest()[:6]
    return f"{base[:40]}-{suffix}"


# ── CRUD ───────────────────────────────────────────────────

def create_campaign(company_id: str, exhibition_name: str, exhibition_date: str,
                    target_invites: int = 0, target_meetings: int = 0,
                    automation_scope: str = "research_only",
                    buyer_profile_confirmed: bool = False,
                    current_strategy: str = "",
                    owner_open_id: str = "") -> dict:
    """创建 Campaign。exhibition_date 格式 YYYY-MM-DD。"""
    if not company_id or not company_id.strip():
        return {"status": "error", "error": "company_id required"}
    if not exhibition_name or not exhibition_name.strip():
        return {"status": "error", "error": "exhibition_name required"}
    if automation_scope not in AUTOMATION_SCOPES:
        return {"status": "error", "error": f"invalid automation_scope: {automation_scope}"}
    try:
        datetime.strptime(exhibition_date, "%Y-%m-%d")
    except ValueError:
        return {"status": "error", "error": "exhibition_date must be YYYY-MM-DD"}

    # 同一 company 已有 active campaign 则先停用（一个企业一个主 Campaign）
    existing = get_active_campaign(company_id)
    if existing:
        update_campaign(existing["campaign_id"], status="completed")

    campaign_id = _gen_campaign_id(company_id, exhibition_name)
    now = _now()
    record = {
        "campaign_id": campaign_id,
        "company_id": company_id,
        "exhibition_name": exhibition_name,
        "exhibition_date": exhibition_date,
        "target_invites": int(target_invites),
        "target_meetings": int(target_meetings),
        "status": "active",
        "buyer_profile_confirmed": bool(buyer_profile_confirmed),
        "automation_scope": automation_scope,
        "strategy_version": 0,
        "current_strategy": current_strategy or "initial",
        "owner_open_id": owner_open_id or "",
        "created_at": now,
        "updated_at": now,
    }
    _save_campaign(record)
    return {**record, "result": "created"}


def _save_campaign(record: dict) -> None:
    path = _campaign_path(record["company_id"], record["campaign_id"])
    lock = path.parent / ".lock"
    with _file_lock(lock):
        _atomic_write(path, _HEADER + json.dumps(record, ensure_ascii=False) + "\n")


def _read_campaign(company_id: str, campaign_id: str) -> dict | None:
    path = _campaign_path(company_id, campaign_id)
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def get_campaign(campaign_id: str) -> dict | None:
    """按 campaign_id 查找（需要先知道 company_id，这里遍历目录）。"""
    if not CAMPAIGNS_DIR.exists():
        return None
    for company_dir in CAMPAIGNS_DIR.iterdir():
        if not company_dir.is_dir():
            continue
        for f in company_dir.glob("*.md"):
            if f.stem == campaign_id:
                return _read_campaign(company_dir.name, campaign_id)
    return None


def get_active_campaign(company_id: str) -> dict | None:
    """返回该 company 的 active 主 Campaign。"""
    d = CAMPAIGNS_DIR / company_id
    if not d.exists():
        return None
    for f in d.glob("*.md"):
        rec = _read_campaign(company_id, f.stem)
        if rec and rec.get("status") == "active":
            return rec
    return None


def update_campaign(campaign_id: str, **fields) -> dict:
    """更新 Campaign 字段（排除 campaign_id/company_id 只读字段）。"""
    rec = get_campaign(campaign_id)
    if not rec:
        return {"status": "error", "error": f"campaign not found: {campaign_id}"}
    for k, v in fields.items():
        if k in ("campaign_id", "company_id"):
            continue
        if k == "status" and v not in VALID_STATUSES:
            return {"status": "error", "error": f"invalid status: {v}"}
        if k == "automation_scope" and v not in AUTOMATION_SCOPES:
            return {"status": "error", "error": f"invalid automation_scope: {v}"}
        rec[k] = v
    rec["updated_at"] = _now()
    _save_campaign(rec)
    return {**rec, "result": "updated"}


# ── 指标计算 ───────────────────────────────────────────────

def calculate_metrics(company_id: str, campaign_id: str = None) -> dict:
    """从现有数据源读取 Campaign 指标。缺失数据返回空，不编造。

    campaign_id 给定则按 campaign_id 精确过滤（另一 Campaign 事件不混入）；
    否则按 enterprise 过滤。发送/送达/退信来自 EmailStore outbound 记录，
    回复/有效询盘/会议意向来自 email-signals（统一口径，与看板/早晚报一致）。
    """
    metrics = {
        "leads_total": 0, "leads_confirmed": 0,
        "sent": 0, "delivered": 0, "bounced": 0, "opened": 0, "replied": 0,
        "valid_inquiries": 0, "meetings": 0,
        "followup_pending": 0, "failed_tasks": 0,
    }
    # 线索
    try:
        leads_path = DATA_DIR / "leads.json"
        if leads_path.exists():
            leads = json.loads(leads_path.read_text(encoding="utf-8"))
            if isinstance(leads, list):
                metrics["leads_total"] = len(leads)
                metrics["leads_confirmed"] = sum(
                    1 for l in leads if isinstance(l, dict) and l.get("status") == "我的买家")
    except Exception:
        pass
    # 发送/送达/退信/回复：委托统一口径 dc_daily_report.collect_metrics（EmailStore + 信号层）。
    # 不直接引入邮件传输层，保持 dc_campaign 与邮件传输层解耦（P0-2 边界）。
    # opened 不再从 send_log 读（open 追踪像素不可靠且 EmailStore 不落 opened，保留字段恒 0）。
    try:
        from dc_daily_report import collect_metrics
        base = collect_metrics(company_id, campaign_id=campaign_id)
        metrics["sent"] = base["sent"]
        metrics["delivered"] = base["delivered"]
        metrics["bounced"] = base["bounced"]
        metrics["replied"] = base["replied"]
    except Exception:
        pass
    # 有效询盘 / 会议意向：从信号层按唯一 source_message_id 计数
    # （意图识别结果落在 email-signals，signal_type=quote_request/sample_request/meeting_interest）。
    try:
        from dc_email_controller.dc_email_signals import list_signals
        signals = list_signals(company_id, campaign_id=campaign_id, status="active")
        inquiry_ids = {s.get("source_message_id") for s in signals if s.get("source_message_id")
                       and s.get("signal_type") in ("quote_request", "sample_request")}
        meeting_ids = {s.get("source_message_id") for s in signals if s.get("source_message_id")
                       and s.get("signal_type") == "meeting_interest"}
        metrics["valid_inquiries"] = len(inquiry_ids)
        metrics["meetings"] = len(meeting_ids)
    except Exception:
        pass
    return metrics


# ── 动态评估 ───────────────────────────────────────────────

def _days_until(exhibition_date: str, today_str: str | None = None) -> int:
    today = datetime.strptime(today_str or _today(), "%Y-%m-%d").date()
    target = datetime.strptime(exhibition_date, "%Y-%m-%d").date()
    return (target - today).days


def evaluate_campaign(campaign: dict, metrics: dict | None = None, today: str | None = None) -> dict:
    """根据事实动态判断 Campaign 状态。不做复杂状态机。"""
    metrics = metrics or {}
    days_remaining = _days_until(campaign["exhibition_date"], today)

    buyer_confirmed = bool(campaign.get("buyer_profile_confirmed"))
    target_invites = int(campaign.get("target_invites", 0))
    target_meetings = int(campaign.get("target_meetings", 0))
    # valid_delivered = 有送达证据的邮件数（delivery 事件 status=delivered）；区别于 sent（仅发送记录）
    valid_delivered = int(metrics.get("delivered", 0))
    replied = int(metrics.get("replied", 0))
    valid_inquiries = int(metrics.get("valid_inquiries", 0))
    meetings = int(metrics.get("meetings", 0))
    bounced = int(metrics.get("bounced", 0))
    sent = int(metrics.get("sent", 0))
    invites_actual = valid_inquiries  # 以有效询盘近似邀约进度
    meetings_actual = meetings

    # 进度差距
    invites_gap = max(0, target_invites - invites_actual)
    meetings_gap = max(0, target_meetings - meetings_actual)
    progress_gap = {
        "target_invites": target_invites, "invites_actual": invites_actual,
        "invites_gap": invites_gap, "invites_pct": (invites_actual / target_invites * 100) if target_invites else 0,
        "target_meetings": target_meetings, "meetings_actual": meetings_actual,
        "meetings_gap": meetings_gap, "meetings_pct": (meetings_actual / target_meetings * 100) if target_meetings else 0,
    }

    # phase 只基于倒计时 + 进度 + 结果，不依赖画像确认
    phase = _judge_phase(days_remaining, invites_gap, meetings_gap)
    # buyer_readiness 独立：画像成熟度
    buyer_readiness = _judge_buyer_readiness(campaign)

    # urgency
    urgency = _judge_urgency(days_remaining, invites_gap, target_invites)

    # 策略健康（只保留三态，80 封阈值用 valid_delivered）
    health = _judge_strategy_health(days_remaining, valid_delivered, valid_inquiries,
                                    bounced, sent, meetings_gap)
    needs_review = health == "needs_review"

    # 推荐动作（按 phase）
    recommended = _recommend_actions(phase, buyer_readiness, invites_gap, meetings_gap, days_remaining)

    # 确认事项：画像/内容/发件身份/超授权
    confirmation_reasons = _judge_confirmation_reasons(campaign, phase, buyer_readiness)

    return {
        "days_remaining": days_remaining,
        "phase": phase,
        "buyer_readiness": buyer_readiness,
        "urgency": urgency,
        "progress_gap": progress_gap,
        "strategy_health": health,
        "recommended_actions": recommended,
        "needs_strategy_review": needs_review,
        "needs_user_confirmation": bool(confirmation_reasons),
        "confirmation_reasons": confirmation_reasons,
        "evidence": {
            "buyer_profile_confirmed": buyer_confirmed,
            "automation_scope": campaign.get("automation_scope", "research_only"),
            "valid_delivered": valid_delivered, "replied": replied,
            "valid_inquiries": valid_inquiries, "meetings": meetings,
            "bounced": bounced, "sent": sent,
        },
    }


def _judge_phase(days_remaining: int, invites_gap: int, meetings_gap: int) -> str:
    """phase 只基于倒计时 + 进度 + 结果，不依赖画像确认。"""
    if days_remaining <= 7:
        return "pre_show"
    if days_remaining <= 14 and (invites_gap > 0 or meetings_gap > 0):
        return "sprint"
    if days_remaining <= 30:
        return "scale"
    return "calibration"


def buyer_readiness_from_state(company_id: str, owner_open_id: str = "") -> str:
    """买家画像就绪度：唯一事实源 = BuyerState（key=company_id:owner_open_id）。

    buyer_profile_status ∈ {draft, searching, correcting, corrected, confirmed}
    只有 confirmed → "confirmed"，其余一律 "learning"。
    Campaign.buyer_profile_confirmed 已 deprecated，不再参与业务决策。
    """
    if owner_open_id:
        try:
            from dc_buyer_state import BuyerState
            status = BuyerState().get_state(company_id, owner_open_id).get("buyer_profile_status", "draft")
        except Exception:
            status = "draft"
    else:
        status = "draft"
    return "confirmed" if status == "confirmed" else "learning"


def _judge_buyer_readiness(campaign: dict) -> str:
    """画像成熟度：以 BuyerState 为唯一事实源；旧字段仅兼容。与 phase 独立。"""
    company_id = campaign.get("company_id", "")
    owner = campaign.get("owner_open_id", "")
    readiness = buyer_readiness_from_state(company_id, owner)

    # 旧字段兼容：如与 BuyerState 不一致，以 BuyerState 为准，写 audit warning（不修改、不阻塞）
    legacy = bool(campaign.get("buyer_profile_confirmed"))
    legacy_readiness = "confirmed" if legacy else "learning"
    if legacy and legacy_readiness != readiness:
        try:
            from dc_audit import AuditLog
            AuditLog().log(action="buyer_readiness.legacy_conflict",
                           user_open_id="system", enterprise=company_id,
                           target="buyer_profile_confirmed",
                           detail=f"deprecated buyer_profile_confirmed={legacy} 与 BuyerState readiness={readiness} 不一致，以 BuyerState 为准")
        except Exception:
            pass
    return readiness


def _judge_urgency(days_remaining: int, invites_gap: int, target_invites: int) -> str:
    if days_remaining <= 7:
        return "critical"
    if days_remaining <= 14:
        return "high"
    if days_remaining <= 30:
        return "medium"
    return "low"


def _judge_strategy_health(days_remaining: int, valid_delivered: int, valid_inquiries: int,
                           bounced: int, sent: int, meetings_gap: int) -> str:
    """只保留三态。80 封阈值用 valid_delivered（有效送达），不用 invites_sent。
    只有发送记录、无送达证据 → insufficient_data。"""
    # 无有效送达证据 → 样本不足，不得判定策略无效
    if valid_delivered < 10:
        return "insufficient_data"
    # 退信率异常（>30%）
    if sent > 0 and bounced / sent > 0.30:
        return "needs_review"
    # 80 封有效送达仍无有效回复
    if valid_delivered >= 80 and valid_inquiries == 0:
        return "needs_review"
    # 距展会不足 14 天且约见明显落后
    if days_remaining <= 14 and meetings_gap > 0 and valid_delivered >= 10:
        return "needs_review"
    return "healthy"


def _recommend_actions(phase: str, buyer_readiness: str, invites_gap: int,
                       meetings_gap: int, days_remaining: int) -> list[str]:
    actions = []
    if buyer_readiness != "confirmed":
        actions.append("确认买家画像/首批买家方向")
    if phase == "calibration":
        actions.append("生成首批买家校准样本")
    if phase == "scale":
        actions.append("稳定寻找并邀约目标买家")
    if phase == "sprint":
        actions.append(f"集中高匹配买家，补齐 {invites_gap} 个邀约缺口")
        actions.append("推进已回复买家的询盘与约见")
    if phase == "pre_show":
        actions.append("确认约见名单与会前准备")
        actions.append("跟进已表达兴趣的买家，锁定约见")
    if meetings_gap > 0 and days_remaining <= 14:
        actions.append(f"优先推进约见（缺口 {meetings_gap} 场）")
    return actions


def _judge_confirmation_reasons(campaign: dict, phase: str, buyer_readiness: str) -> list[str]:
    """确认事项：画像/首批方向待确认、首批内容待确认、发件身份待确认、动作超授权。
    只写入早晚计划 Todo，不新增实时提醒。"""
    reasons = []
    # 买家画像或首批买家方向待确认
    if buyer_readiness != "confirmed":
        reasons.append("买家画像/首批买家方向待确认")
    # 动作超出已有授权（冲刺/会前推进约见，但授权范围不含跟进）
    scope = campaign.get("automation_scope", "research_only")
    if phase in ("sprint", "pre_show") and scope not in ("research_invite_followup", "full"):
        reasons.append("推进约见超出当前授权范围")
    # 首批营销内容待确认（本阶段以 strategy_version==0 且未确认画像近似）
    if buyer_readiness != "confirmed" and int(campaign.get("strategy_version", 0)) == 0:
        reasons.append("首批营销内容待确认")
    return reasons


# ── CLI ────────────────────────────────────────────────────

def _cli():
    ap = argparse.ArgumentParser(description="DealClaw 展会 Campaign 管理")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="创建 Campaign")
    c.add_argument("--company-id", required=True)
    c.add_argument("--exhibition-name", required=True)
    c.add_argument("--exhibition-date", required=True, help="YYYY-MM-DD")
    c.add_argument("--target-invites", type=int, default=0)
    c.add_argument("--target-meetings", type=int, default=0)
    c.add_argument("--automation-scope", default="research_only", choices=list(AUTOMATION_SCOPES))
    c.add_argument("--buyer-profile-confirmed", action="store_true")

    s = sub.add_parser("show", help="查看 Campaign")
    s.add_argument("--company-id", required=True)

    e = sub.add_parser("evaluate", help="评估 Campaign")
    e.add_argument("--company-id", required=True)

    args = ap.parse_args()

    if args.cmd == "create":
        result = create_campaign(args.company_id, args.exhibition_name, args.exhibition_date,
                                 target_invites=args.target_invites,
                                 target_meetings=args.target_meetings,
                                 automation_scope=args.automation_scope,
                                 buyer_profile_confirmed=args.buyer_profile_confirmed)
    elif args.cmd == "show":
        result = get_active_campaign(args.company_id) or {"status": "error", "error": "no active campaign"}
    elif args.cmd == "evaluate":
        camp = get_active_campaign(args.company_id)
        if not camp:
            result = {"status": "error", "error": "no active campaign"}
        else:
            result = evaluate_campaign(camp, calculate_metrics(camp["company_id"], camp["campaign_id"]))

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
