#!/usr/bin/env python3
"""
DC-Daily-Cycle — DealClaw 展会每日执行循环（P0-2）

Morning：生成今日 Todo 计划；Evening：核验结果、汇总、判断次日策略。
本阶段只生成计划并 dry-run 交给 dc_notify，不执行真实外部动作。

持久化：data/daily-plans/<company_id>/<date>.md
  早报和晚报使用同一个 plan_id。
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from dc_campaign import (
    get_active_campaign, evaluate_campaign, calculate_metrics, _today,
)

DATA_DIR = Path(os.environ.get("DC_DATA_DIR", str(Path(__file__).resolve().parent / "data")))
MEMORY_DIR = Path(__file__).resolve().parents[2] / "memory"
PLANS_DIR = DATA_DIR / "daily-plans"
EXPERIMENTS_DIR = DATA_DIR / "experiments"

_PLAN_HEADER = "# DealClaw Daily Plan\n# DO NOT EDIT MANUALLY. Managed by dc_daily_cycle.py. One JSON object per line.\n"
_EXP_HEADER = "# DealClaw Experiment\n# DO NOT EDIT MANUALLY. Managed by dc_daily_cycle.py. One JSON object per line.\n"

# 任务来源
SOURCES = ("campaign", "lead", "followup", "daily")
# 校准期买家校准样本数（5-10 范围内）
CALIBRATION_SAMPLE_COUNT = 8
# confirmed 阶段买家搜索每日安全上限（第一版）
CONFIRMED_SEARCH_CAP = 20


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_long_term_context(company_id: str, user_open_id: str) -> dict:
    """读长期规则（rules.md）+ 行为偏好（people/<open_id>.md），供 Todo 计划体现「记住了直接做」。"""
    rules, behaviors = [], []
    try:
        rules_path = MEMORY_DIR / "company" / company_id / "rules.md"
        if rules_path.exists():
            for ln in rules_path.read_text(encoding="utf-8").splitlines():
                s = ln.strip()
                if s.startswith("- [active"):
                    rules.append(s)
        if user_open_id:
            people_path = MEMORY_DIR / "people" / f"{user_open_id}.md"
            if people_path.exists():
                for ln in people_path.read_text(encoding="utf-8").splitlines():
                    s = ln.strip()
                    if s.startswith("- [行为"):
                        behaviors.append(s)
    except Exception:
        pass
    return {"rules": rules, "behaviors": behaviors}


def _plan_id(company_id: str, date: str) -> str:
    return "p_" + hashlib.sha1(f"{company_id}|{date}".encode()).hexdigest()[:16]


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


def _plan_path(company_id: str, date: str) -> Path:
    return PLANS_DIR / company_id / f"{date}.md"


def _read_plan(company_id: str, date: str) -> dict | None:
    path = _plan_path(company_id, date)
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


def _save_plan(record: dict) -> None:
    path = _plan_path(record["company_id"], record["date"])
    lock = path.parent / ".lock"
    with _file_lock(lock):
        _atomic_write(path, _PLAN_HEADER + json.dumps(record, ensure_ascii=False) + "\n")


# ── Todo 生成 ──────────────────────────────────────────────

def _task_id(company_id: str, campaign_id: str, date: str, action_type: str,
             strategy_version: int, idx: int) -> str:
    """Todo 稳定幂等键：company_id + campaign_id + date + action_type + strategy_version。

    idx 用于同 action_type 多实例去歧义（正常为 1）。重复生成 Morning 得到相同 task_id。
    """
    key = f"{company_id}|{campaign_id}|{date}|{action_type}|{strategy_version}|{idx}"
    return "t_" + hashlib.sha1(key.encode()).hexdigest()[:16]


def _buyer_search_sample_size(campaign: dict, buyer_readiness: str) -> tuple[int, str]:
    """买家搜索 sample_size：learning=8；confirmed=每日计划（默认8，安全上限20）。"""
    if buyer_readiness == "confirmed":
        n = int(campaign.get("daily_suggested_count") or CALIBRATION_SAMPLE_COUNT)
        n = min(n, CONFIRMED_SEARCH_CAP)
        return n, "confirmed_todo_count"
    return CALIBRATION_SAMPLE_COUNT, "learning_calibration_cap"


def _gen_todos(campaign: dict, eval_result: dict, metrics: dict, user_open_id: str = "",
               date: str | None = None) -> list[dict]:
    """根据 phase/urgency/progress_gap/授权范围生成今日 Todo。展会获客优先。

    每个 Campaign 每天最多 1 个 buyer_search Todo（不再扇出 8 个）；
    计划与结果分离：Todo 只表示 planned，执行证据由 execute_plan 返回。
    """
    phase = eval_result["phase"]
    buyer_readiness = eval_result.get("buyer_readiness", "learning")
    scope = campaign.get("automation_scope", "research_only")
    gap = eval_result["progress_gap"]
    date = date or _today()
    todos: list[dict] = []
    action_idx: dict[str, int] = {}

    def add(source, action, priority, action_type="other", auto=False, confirm=False,
            blocked=False, input=None, status="pending"):
        n = action_idx.get(action_type, 0) + 1
        action_idx[action_type] = n
        strategy_version = int(campaign.get("strategy_version", 0))
        todos.append({
            "task_id": _task_id(campaign["company_id"], campaign["campaign_id"], date,
                                action_type, strategy_version, n),
            "action": action,
            "action_type": action_type,
            "company_id": campaign["company_id"],
            "campaign_id": campaign["campaign_id"],
            "user_open_id": user_open_id,
            "status": status,
            "priority": priority,
            "input": input or {},
            "auto_executable": auto,
            "requires_confirmation": confirm,
            "blocked": blocked,
            "evidence": "",
            "failure_reason": "",
            "next_action": "",
            "attempts": 0,
        })

    # 买家搜索 Todo（每天最多 1 个）
    long_term = _load_long_term_context(campaign["company_id"], user_open_id)
    sample_size, limit_reason = _buyer_search_sample_size(campaign, buyer_readiness)
    if phase in ("calibration", "scale", "sprint"):
        if buyer_readiness == "confirmed":
            action = {
                "calibration": "搜索目标买家（画像已确认）",
                "scale": "搜索目标买家并补全画像",
                "sprint": f"集中高匹配买家，补邀约缺口 {gap['invites_gap']}",
            }[phase]
            add("campaign", action, "P1", action_type="buyer_search", auto=True,
                input={"sample_size": sample_size, "limit_reason": limit_reason,
                       "long_term_rules": long_term["rules"],
                       "behaviors": long_term["behaviors"]})
        else:
            # learning：等待画像确认，不自动执行
            add("campaign", "校准买家样本（等待画像确认）", "P1", action_type="buyer_search",
                auto=False, status="waiting_confirmation",
                input={"sample_size": sample_size, "limit_reason": limit_reason,
                       "long_term_rules": long_term["rules"],
                       "behaviors": long_term["behaviors"]})

    # scale 阶段其它任务
    if phase == "scale":
        add("campaign", "生成邀约草稿", "P1", action_type="other", auto=True)
        if scope in ("research_invite", "research_invite_followup", "full"):
            add("campaign", "在授权范围内发送邀约", "P0", action_type="other", auto=True)
        else:
            add("campaign", "邀约买家（需确认后发送）", "P0", action_type="other", confirm=True)
        add("followup", "跟进已回复买家", "P1", action_type="other",
            auto=scope in ("research_invite_followup", "full"),
            confirm=scope not in ("research_invite_followup", "full"))
        # 已确认画像 → 高匹配线索补全联系人（独立 Todo）
        if buyer_readiness == "confirmed":
            add("lead", "补全高匹配买家联系人", "P1", action_type="contact_enrichment", auto=True)

    # sprint 阶段其它任务
    if phase == "sprint":
        add("followup", "推进已回复买家的询盘", "P0", action_type="other",
            auto=scope in ("research_invite_followup", "full"),
            confirm=scope not in ("research_invite_followup", "full"))
        add("campaign", f"锁定约见（缺口 {gap['meetings_gap']} 场）", "P0", action_type="other", confirm=True)

    # pre_show 阶段
    if phase == "pre_show":
        add("campaign", "确认约见名单与会前准备", "P1", action_type="other", auto=True)
        add("followup", "跟进已表达兴趣买家，锁定约见", "P0", action_type="other", confirm=True)
        add("campaign", f"锁定约见（缺口 {gap['meetings_gap']} 场）", "P0", action_type="other", confirm=True)

    # 画像未确认 → 确认买家方向（requires_confirmation；不因画像未确认停留在校准）
    if buyer_readiness != "confirmed":
        add("campaign", "确认买家画像/首批买家方向", "P0", action_type="other", confirm=True)

    # 退信/失败任务（全局）
    if metrics.get("bounced", 0) > 0:
        add("daily", f"排查退信（今日 {metrics['bounced']} 封）", "P2", action_type="other", auto=True)

    return todos


# ── Morning ────────────────────────────────────────────────

def _resolve_user_open_id(company_id: str, user_open_id: str = "", camp: dict | None = None) -> str:
    """解析用户上下文：显式参数 → Campaign.owner_open_id → registry campaign_owner_open_id → 空。

    返回空表示 user_context_missing，execute_task 会 block（不自动执行）。
    """
    if user_open_id and str(user_open_id).strip():
        return str(user_open_id).strip()
    camp = camp or get_active_campaign(company_id)
    if camp and camp.get("owner_open_id"):
        return camp["owner_open_id"]
    try:
        from dc_company_registry import CompanyRegistry
        entry = CompanyRegistry().get(company_id)
        if entry and entry.get("campaign_owner_open_id"):
            return entry["campaign_owner_open_id"]
    except Exception:
        pass
    return ""


def _ensure_campaign_dynamic(company_id: str) -> dict | None:
    """无 active campaign 时，从 CDP 动态创建（orderRecords → selectAllExhibition 对账）。

    成功返回 campaign dict；拿不到参数/失败返回 None（交给降级路径）。
    """
    try:
        from dc_auto_campaign import ensure_campaign
        r = ensure_campaign(company_id)
        if r.get("status") in ("existing", "created") and r.get("campaign"):
            return r["campaign"]
        return None
    except Exception:
        return None


def _morning_without_campaign(company_id: str, date: str, dry_run: bool = True) -> dict:
    """无 campaign 的早报降级：不生成展会 Todo，只发 metrics/漏斗/跟进/草稿/KB。"""
    from dc_notify import NotifyEngine
    from dc_daily_report import build_morning_report
    try:
        rep = build_morning_report(company_id)
    except Exception:
        rep = {}
    notify_result = None
    if not dry_run:
        try:
            notify_result = NotifyEngine().publish(
                company_id, "plan_item", {
                    "plan_id": _plan_id(company_id, date),
                    "phase": "no_campaign",
                    "urgency": "normal",
                    "todo_count": 0,
                    "waiting_confirmation": [],
                    "auto_todos": [],
                    "report_text": rep.get("text", ""),
                    "metrics": rep.get("metrics", {}),
                    "pending_draft_count": rep.get("pending_draft_count", 0),
                    "due_followup_count": rep.get("due_followup_count", 0),
                },
                dedupe_key=f"morning:{company_id}:{date}",
            )
        except Exception as e:
            notify_result = {"status": "error", "error": str(e)}
    return {
        "status": "no_campaign_report",
        "plan_id": _plan_id(company_id, date),
        "company_id": company_id,
        "date": date,
        "report": rep,
        "notify": notify_result,
    }


def _evening_without_campaign(company_id: str, date: str, dry_run: bool = True) -> dict:
    """无 plan（无 campaign）的晚报降级。"""
    from dc_notify import NotifyEngine
    from dc_daily_report import build_evening_report
    try:
        rep = build_evening_report(company_id)
    except Exception:
        rep = {}
    notify_result = None
    if not dry_run:
        try:
            notify_result = NotifyEngine().publish(
                company_id, "summary_item", {
                    "report_text": rep.get("text", ""),
                    "metrics": rep.get("metrics", {}),
                    "pending_draft_count": rep.get("pending_draft_count", 0),
                    "due_followup_count": rep.get("due_followup_count", 0),
                },
                dedupe_key=f"evening:{company_id}:{date}",
            )
        except Exception as e:
            notify_result = {"status": "error", "error": str(e)}
    return {
        "status": "no_campaign_report",
        "company_id": company_id,
        "date": date,
        "report": rep,
        "notify": notify_result,
    }


def build_morning_plan(company_id: str, date: str | None = None, dry_run: bool = True,
                       user_open_id: str = "") -> dict:
    """生成今日 Todo 计划。只生成计划，不执行真实外部动作。

    无 active campaign 时：先尝试从 CDP 动态创建（orderRecords→selectAllExhibition 对账）；
    仍拿不到参数则降级为无 campaign 早报。
    """
    date = date or _today()
    # 展会阶段：日期兜底推进 + 读当前阶段（供 Todo/早报体现）
    exhibition_stage = ""
    try:
        from dc_exhibition_stage import reconcile_stage, read_stage
        reconcile_stage(company_id, date, write=not dry_run)
        exhibition_stage = read_stage(company_id)["stage"]
    except Exception:
        pass
    camp = get_active_campaign(company_id)
    if not camp:
        camp = _ensure_campaign_dynamic(company_id)
    if not camp:
        return _morning_without_campaign(company_id, date, dry_run=dry_run)

    # P0-E5：先跑跟进循环，生成到期的第二轮/第三轮跟进草稿（幂等，不发送）
    try:
        from dc_email_controller.dc_followup import run_followup_cycle
        run_followup_cycle(company_id)
    except Exception:
        pass

    # 用户上下文解析：显式参数 → Campaign.owner_open_id → registry → 空(block)
    user_open_id = _resolve_user_open_id(company_id, user_open_id, camp=camp)

    metrics = calculate_metrics(company_id)
    evaluation = evaluate_campaign(camp, metrics, today=date)
    todos = _gen_todos(camp, evaluation, metrics, user_open_id=user_open_id, date=date)

    plan_id = _plan_id(company_id, date)
    plan = {
        "plan_id": plan_id,
        "company_id": company_id,
        "campaign_id": camp["campaign_id"],
        "date": date,
        "phase": evaluation["phase"],
        "urgency": evaluation["urgency"],
        "strategy_version": camp.get("strategy_version", 0),
        "exhibition_stage": exhibition_stage,
        "status": "planning",
        "created_at": _now(),
        "evaluation": evaluation,
        "todos": todos,
    }
    _save_plan(plan)

    # dry-run 交给 dc_notify：生成 plan_item
    notify_result = None
    if not dry_run:
        notify_result = _emit_plan_item(company_id, plan)

    return {
        "status": "planned",
        "plan_id": plan_id,
        "company_id": company_id,
        "campaign_id": camp["campaign_id"],
        "date": date,
        "phase": evaluation["phase"],
        "urgency": evaluation["urgency"],
        "todo_count": len(todos),
        "exhibition_stage": exhibition_stage,
        "todos": todos,
        "notify": notify_result,
    }


def _emit_plan_item(company_id: str, plan: dict) -> dict:
    """把计划作为 plan_item 交给 dc_notify（统一出口）。含待确认/阻塞项 + 早报内容，供 Morning Push 展示。"""
    try:
        from dc_notify import NotifyEngine
        from dc_daily_report import build_morning_report
        engine = NotifyEngine()
        todos = plan.get("todos", [])
        evaluation = plan.get("evaluation", {})
        waiting = [{"task_id": t.get("task_id"), "action": t.get("action")}
                   for t in todos if t.get("requires_confirmation") or t.get("blocked")]
        auto = [{"task_id": t.get("task_id"), "action": t.get("action")}
                for t in todos if t.get("auto_executable") and not t.get("requires_confirmation")]
        try:
            rep = build_morning_report(company_id)
        except Exception:
            rep = {}
        return engine.publish(
            company_id, "plan_item", {
                "plan_id": plan["plan_id"],
                "phase": plan["phase"],
                "urgency": plan["urgency"],
                "days_remaining": evaluation.get("days_remaining", ""),
                "todo_count": len(todos),
                "waiting_confirmation": waiting,
                "auto_todos": auto,
                "report_text": rep.get("text", ""),
                "metrics": rep.get("metrics", {}),
                "pending_draft_count": rep.get("pending_draft_count", 0),
                "due_followup_count": rep.get("due_followup_count", 0),
            },
            dedupe_key=f"morning:{company_id}:{plan['date']}",
        )
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── 实验（策略调整幂等）──────────────────────────────────

def _experiment_id(company_id: str, campaign_id: str, strategy_version: int, reason: str) -> str:
    """稳定 experiment_id：同企业+Campaign+策略版本+复盘原因 → 同一 ID。"""
    key = f"{company_id}|{campaign_id}|{strategy_version}|{reason}"
    return "e_" + hashlib.sha1(key.encode()).hexdigest()[:16]


def _exp_path(company_id: str, experiment_id: str) -> Path:
    return EXPERIMENTS_DIR / company_id / f"{experiment_id}.md"


def _find_experiment(company_id: str, experiment_id: str) -> dict | None:
    path = _exp_path(company_id, experiment_id)
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


def _save_experiment(record: dict) -> None:
    path = _exp_path(record["company_id"], record["experiment_id"])
    lock = path.parent / ".lock"
    with _file_lock(lock):
        _atomic_write(path, _EXP_HEADER + json.dumps(record, ensure_ascii=False) + "\n")


def _list_experiments(company_id: str) -> list[dict]:
    """列出该企业全部实验。"""
    d = EXPERIMENTS_DIR / company_id
    if not d.exists():
        return []
    exps = []
    for f in d.glob("*.md"):
        exp = _find_experiment(company_id, f.stem)
        if exp:
            exps.append(exp)
    return exps


def _find_active_experiment_by_reason(company_id: str, campaign_id: str, reason: str) -> dict | None:
    """幂等判断：同 Campaign + 同复盘原因，是否已有 active（未出结果）实验。"""
    for exp in _list_experiments(company_id):
        if (exp.get("campaign_id") == campaign_id
                and exp.get("reason") == reason
                and exp.get("status") == "active"):
            return exp
    return None


def _review_reason(evaluation: dict) -> str:
    """推断具体复盘原因（用于稳定 experiment_id）。"""
    ev = evaluation.get("evidence", {})
    valid_delivered = int(ev.get("valid_delivered", 0))
    valid_inquiries = int(ev.get("valid_inquiries", 0))
    bounced = int(ev.get("bounced", 0))
    sent = int(ev.get("sent", 0))
    days_remaining = evaluation.get("days_remaining", 999)
    if valid_delivered >= 80 and valid_inquiries == 0:
        return "80封有效送达无回复"
    if sent > 0 and bounced / sent > 0.30:
        return "退信率异常"
    if days_remaining <= 14:
        return "临近展会约见落后"
    return "策略复盘"


def _hypothesis(reason: str) -> str:
    return f"假设：当前策略在「{reason}」维度效果不足，需单变量调整验证"


def _changed_dimension(reason: str) -> str:
    if "退信" in reason:
        return "投递/发件身份"
    if "约见" in reason:
        return "跟进节奏/价值主张"
    if "无回复" in reason:
        return "邮件内容/切入角度"
    return "未定维度"


def _maybe_create_experiment(company_id: str, plan: dict, evaluation: dict) -> dict | None:
    """幂等创建策略实验。

    幂等键 = 同 Campaign + 同复盘原因 + active 状态（不依赖 strategy_version）。
    第一次创建实验后 Campaign strategy_version 升级；重复运行晚报时复用原实验，不再次升级。
    """
    reason = _review_reason(evaluation)
    campaign_id = plan["campaign_id"]
    source_strategy_version = int(plan.get("strategy_version", 0))

    # 幂等：同 Campaign + 同原因已有 active 实验 → 复用，返回 Campaign 当前版本
    existing = _find_active_experiment_by_reason(company_id, campaign_id, reason)
    if existing:
        from dc_campaign import get_campaign
        camp = get_campaign(campaign_id)
        current_version = int(camp.get("strategy_version", 0)) if camp else source_strategy_version
        return {"action": "existing_experiment", "experiment": existing,
                "strategy_version": current_version}

    exp_id = _experiment_id(company_id, campaign_id, source_strategy_version, reason)
    exp = {
        "experiment_id": exp_id,
        "company_id": company_id,
        "campaign_id": campaign_id,
        "source_strategy_version": source_strategy_version,
        "reason": reason,
        "hypothesis": _hypothesis(reason),
        "sample_size": "10-20",
        "changed_dimension": _changed_dimension(reason),
        "created_at": _now(),
        "status": "active",
    }
    _save_experiment(exp)
    new_version = source_strategy_version + 1
    from dc_campaign import update_campaign
    update_campaign(campaign_id, strategy_version=new_version)
    return {"action": "created_experiment", "experiment": exp, "strategy_version": new_version}


# ── Evening ────────────────────────────────────────────────

def evaluate_evening(company_id: str, date: str | None = None, dry_run: bool = True,
                     evidence: dict | None = None) -> dict:
    """核验当天 Morning 的同一 plan_id。没有 evidence 不得标记 completed。"""
    date = date or _today()
    plan = _read_plan(company_id, date)
    if not plan:
        return _evening_without_campaign(company_id, date, dry_run=dry_run)

    evidence = evidence or {}
    completed = []
    pending = []
    blocked = []
    for todo in plan.get("todos", []):
        ev = evidence.get(todo["task_id"])
        if ev:
            todo["status"] = "completed"
            todo["evidence"] = ev
            completed.append(todo)
        elif todo.get("blocked"):
            todo["status"] = "blocked"
            blocked.append(todo)
        else:
            todo["status"] = "pending"
            pending.append(todo)

    plan["status"] = "reviewed"
    plan["updated_at"] = _now()
    _save_plan(plan)

    # 策略变化判断（幂等）：需要复盘时创建/复用实验，同原因不重复 strategy_version+1
    evaluation = plan.get("evaluation", {})
    strategy_change = None
    if evaluation.get("needs_strategy_review"):
        strategy_change = _maybe_create_experiment(company_id, plan, evaluation)

    summary = {
        "plan_id": plan["plan_id"],
        "company_id": company_id,
        "date": date,
        "completed": len(completed),
        "failed": 0,
        "pending": len(pending),
        "blocked": len(blocked),
        "needs_confirmation": sum(1 for t in plan["todos"] if t.get("requires_confirmation")),
        "strategy_change": strategy_change,
        "next_plan": "continue" if not strategy_change else "new_experiment",
    }

    notify_result = None
    if not dry_run:
        notify_result = _emit_summary_item(company_id, summary)

    return {
        "status": "reviewed",
        "plan_id": plan["plan_id"],
        "company_id": company_id,
        "date": date,
        "summary": summary,
        "todos": plan["todos"],
        "notify": notify_result,
    }


def _emit_summary_item(company_id: str, summary: dict) -> dict:
    try:
        from dc_notify import NotifyEngine
        from dc_daily_report import build_evening_report
        engine = NotifyEngine()
        try:
            rep = build_evening_report(company_id)
        except Exception:
            rep = {}
        payload = dict(summary)
        payload["report_text"] = rep.get("text", "")
        payload["metrics"] = rep.get("metrics", {})
        payload["pending_draft_count"] = rep.get("pending_draft_count", 0)
        payload["due_followup_count"] = rep.get("due_followup_count", 0)
        return engine.publish(company_id, "summary_item", payload,
                              dedupe_key=f"evening:{company_id}:{summary.get('date', '')}")
    except Exception as e:
        return {"status": "error", "error": str(e)}


# ── 执行记录 + execute_plan ────────────────────────────────

EXECUTIONS_DIR = DATA_DIR / "executions"
CONTACTS_DIR = DATA_DIR / "contacts"
_EXEC_HEADER = "# DealClaw Execution\n# DO NOT EDIT MANUALLY. One JSON object per line.\n"
_CONTACT_HEADER = "# DealClaw Contacts\n# DO NOT EDIT MANUALLY. One JSON object per line.\n"

EXECUTION_STATUSES = ("pending", "running", "completed", "failed", "blocked", "waiting_confirmation")
# 第一版仅支持的 action_type
VALID_ACTION_TYPES = ("buyer_search", "contact_enrichment")


def _exec_path(company_id: str, date: str) -> Path:
    return EXECUTIONS_DIR / company_id / f"{date}.md"


def _contact_path(company_id: str, date: str) -> Path:
    return CONTACTS_DIR / company_id / f"{date}.md"


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _append_jsonl(path: Path, header: str, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = path.parent / ".lock"
    with _file_lock(lock):
        if not path.exists():
            path.write_text(header, encoding="utf-8")
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _run_id(plan_id: str, task_id: str) -> str:
    return "r_" + hashlib.sha1(f"{plan_id}|{task_id}".encode()).hexdigest()[:16]


def _has_completed(company_id: str, date: str, task_id: str) -> bool:
    for rec in _read_jsonl(_exec_path(company_id, date)):
        if rec.get("task_id") == task_id and rec.get("status") == "completed":
            return True
    return False


def _find_plan_by_id(company_id: str, plan_id: str) -> dict | None:
    d = PLANS_DIR / company_id
    if not d.exists():
        return None
    for f in d.glob("*.md"):
        rec = _read_plan(company_id, f.stem)
        if rec and rec.get("plan_id") == plan_id:
            return rec
    return None


def _empty_buyer_evidence() -> dict:
    return {"query_count": 0, "raw_count": 0, "duplicate_count": 0,
            "rejected_count": 0, "saved_count": 0, "lead_ids": [],
            "source": "引擎搜索", "queries": []}


def _intermediate_path(company_id: str, task_id: str, kind: str) -> Path:
    """中断恢复用的中间文件路径（保存大体积原始结果，不写进 plan 正文）。"""
    return EXECUTIONS_DIR / company_id / f"{task_id}.{kind}.json"


def _read_json_file(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_json_file(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _run_buyer_search(task: dict, dry_run: bool = False) -> dict:
    """找买家：get_search_plan → search → 标准化 → 去重 → Bitable 写入 → LeadStore → audit。

    中断恢复：evidence.checkpoint 记录步骤，从最后成功步骤恢复。
    learning/confirmed 数量分流：learning 默认8封顶10；confirmed 按 Todo.input.sample_size（安全上限20）。
    """
    company_id = task["company_id"]
    user_open_id = task.get("user_open_id", "")
    from dc_buyer_state import BuyerState
    from dc_ls_store import LeadStore, normalize_domain
    from dc_company_registry import CompanyRegistry, sync_leads_to_pool, BitableResponseParseError
    from dc_buyer_adapter import search, format_results
    from dc_campaign import get_active_campaign, buyer_readiness_from_state
    from dc_audit import AuditLog

    camp = get_active_campaign(company_id)
    buyer_readiness = buyer_readiness_from_state(company_id, (camp or {}).get("owner_open_id", ""))

    # ── learning / confirmed 数量分流 ──
    requested_count = int((task.get("input") or {}).get("sample_size") or 0)
    if buyer_readiness == "learning":
        if requested_count <= 0:
            effective_limit = 8
        else:
            effective_limit = min(requested_count, 10)
        limit_reason = "learning_calibration_cap"
    else:  # confirmed
        if requested_count <= 0:
            requested_count = int((camp or {}).get("daily_suggested_count") or 8)
        if requested_count > 20:
            return {"status": "waiting_confirmation", "result_count": 0,
                    "failure_reason": "exceeds_safe_cap", "next_action": "user_confirm_sample_size",
                    "evidence": {**_empty_buyer_evidence(), "buyer_readiness": buyer_readiness,
                                 "requested_count": requested_count, "effective_limit": 0,
                                 "limit_reason": "exceeds_safe_cap_20"}}
        effective_limit = requested_count
        limit_reason = "confirmed_todo_count"

    state = BuyerState()
    plan = state.get_search_plan(company_id, user_open_id)
    products = plan.get("products", [])
    countries = plan.get("countries", [])

    if not products:
        return {"status": "blocked", "result_count": 0,
                "failure_reason": "no_search_profile", "next_action": "user_review",
                "evidence": {**_empty_buyer_evidence(), "buyer_readiness": buyer_readiness,
                             "requested_count": requested_count, "effective_limit": effective_limit,
                             "limit_reason": limit_reason}}

    if dry_run:
        return {"status": "dry_run", "result_count": 0,
                "planned_call": {"action": "buyer_search", "keywords": products,
                                 "countries": countries, "sample_size": effective_limit},
                "evidence": {**_empty_buyer_evidence(), "buyer_readiness": buyer_readiness,
                             "requested_count": requested_count, "effective_limit": effective_limit,
                             "limit_reason": limit_reason}}

    # ── checkpoint 恢复 ──
    prev_evidence = task.get("evidence") if isinstance(task.get("evidence"), dict) else {}
    ck = dict(prev_evidence.get("checkpoint") or {})

    # Step 1: search（已搜则复用中间文件，不重调 search()）
    raw_records: list = []
    queries: list = list(prev_evidence.get("queries") or [])
    if ck.get("search_completed"):
        loaded = _read_json_file(_intermediate_path(company_id, task["task_id"], "search_results"))
        raw_records = (loaded or {}).get("records", [])
        queries = (loaded or {}).get("queries", queries)
    else:
        queries = []
        for kw in products[:3]:
            for c in (countries or [None])[:3]:
                queries.append({"tag_keyword": kw, "country": c, "page_size": effective_limit})
                try:
                    raw = search(tag_keyword=kw, country=[c] if c else None, page_size=effective_limit)
                    result = format_results(raw, kw, [c] if c else [], field="tag_keyword")
                    if result.get("status") == "success":
                        raw_records.extend(result.get("records", []))
                except Exception:
                    continue
                if len(raw_records) >= effective_limit * 2:
                    break
            if len(raw_records) >= effective_limit * 2:
                break
        ck["search_completed"] = True
        ck["search_results_path"] = str(_intermediate_path(company_id, task["task_id"], "search_results"))
        _write_json_file(_intermediate_path(company_id, task["task_id"], "search_results"),
                         {"records": raw_records, "queries": queries,
                          "requested_count": requested_count, "effective_limit": effective_limit})

    # Step 2+3: 标准化 + 去重（纯内存，可重推）
    store = LeadStore()
    seen_cdp = set()
    seen_domain = set()
    normalized: list = []
    duplicate_count = 0
    rejected_count = 0
    for rec in raw_records:
        cdp_id = rec.get("companyCdpId", "")
        domain = normalize_domain(rec.get("website", ""))
        if not cdp_id and not domain:
            rejected_count += 1
            continue
        if cdp_id and cdp_id in seen_cdp:
            duplicate_count += 1
            continue
        if domain and domain in seen_domain:
            duplicate_count += 1
            continue
        if cdp_id:
            seen_cdp.add(cdp_id)
        if domain:
            seen_domain.add(domain)
        if domain and store.is_duplicate(domain, company_id):
            duplicate_count += 1
            continue
        normalized.append(rec)
        if len(normalized) >= effective_limit:
            break
    ck["normalized_completed"] = True
    ck["dedupe_completed"] = True

    # Step 4: Bitable 写入（已写则不重复写）
    bitable_record_ids: list = list(ck.get("bitable_record_ids") or [])
    if not ck.get("bitable_write_completed"):
        try:
            registry = CompanyRegistry()
            entry = registry.get(company_id)
            company_name = entry.get("company_name") if entry else company_id
            bitable_records = [{"companyName": r.get("companyName", ""),
                                "website": r.get("website", ""),
                                "companyCdpId": r.get("companyCdpId", ""),
                                "countryCnName": r.get("countryCnName", ""),
                                "country": r.get("country", "")} for r in normalized]
            sync_result = sync_leads_to_pool(company_id, company_name, bitable_records, source="引擎搜索")
            bitable_record_ids = sync_result.get("record_ids", [])
            updated_record_ids = sync_result.get("updated_record_ids", [])
            created_count = sync_result.get("created", 0)
            updated_count = sync_result.get("updated", 0)
            skipped_count = sync_result.get("skipped", 0)
            # checkpoint 完整性校验：每条待保存线索均有明确结果，新建记录都有 record_id，已有记录命中原 record_id
            total_processed = len(normalized)
            accounted = created_count + updated_count + skipped_count
            if (accounted != total_processed
                    or len(bitable_record_ids) != created_count
                    or len(updated_record_ids) != updated_count):
                raise BitableResponseParseError(
                    f"bitable 写入结果不完整: created={created_count} updated={updated_count} "
                    f"skipped={skipped_count} record_ids={len(bitable_record_ids)} "
                    f"updated_record_ids={len(updated_record_ids)} total={total_processed}")
            ck["bitable_write_completed"] = True
            ck["bitable_record_ids"] = bitable_record_ids
            ck["bitable_updated_record_ids"] = updated_record_ids
            ck["bitable_created_count"] = created_count
            ck["bitable_updated_count"] = updated_count
            ck["bitable_skipped_count"] = skipped_count
            ck["bitable_unique_keys"] = sync_result.get("unique_keys", [])
            ck["response_schema_version"] = sync_result.get("response_schema_version", "")
        except BitableResponseParseError as e:
            ck["last_successful_step"] = "search"
            return {"status": "failed", "result_count": 0,
                    "failure_reason": "bitable_response_parse_failed",
                    "next_action": "retry_parse_or_verify_pool",
                    "resume_from": "bitable", "last_successful_step": ck["last_successful_step"],
                    "evidence": {**_empty_buyer_evidence(), "query_count": len(queries),
                                 "raw_count": len(raw_records), "duplicate_count": duplicate_count,
                                 "rejected_count": rejected_count, "queries": queries,
                                 "checkpoint": ck, "buyer_readiness": buyer_readiness,
                                 "requested_count": requested_count, "effective_limit": effective_limit,
                                 "limit_reason": limit_reason, "error": str(e)[:200]}}
        except Exception as e:
            ck["last_successful_step"] = "search"
            return {"status": "failed", "result_count": 0,
                    "failure_reason": "lead_pool_write_failed", "next_action": "retry_lead_pool_write",
                    "resume_from": "bitable", "last_successful_step": ck["last_successful_step"],
                    "evidence": {**_empty_buyer_evidence(), "query_count": len(queries),
                                 "raw_count": len(raw_records), "duplicate_count": duplicate_count,
                                 "rejected_count": rejected_count, "queries": queries,
                                 "checkpoint": ck, "buyer_readiness": buyer_readiness,
                                 "requested_count": requested_count, "effective_limit": effective_limit,
                                 "limit_reason": limit_reason, "error": str(e)[:200]}}

    # Step 5: LeadStore 写入（已写则不重复写；失败可恢复）
    lead_ids: list = list(ck.get("lead_ids") or [])
    if not ck.get("leadstore_write_completed"):
        leadstore_failed = False
        leadstore_error = ""
        for r in normalized:
            lead = {"company_name": r.get("companyName", ""), "domain": r.get("website", ""),
                    "company_cdp_id": r.get("companyCdpId", ""),
                    "country": r.get("countryCnName") or r.get("country", ""),
                    "user_open_id": user_open_id, "enterprise": company_id,
                    "source": "引擎搜索", "status": "pending_review"}
            try:
                store.save_lead(lead)
                lead_ids.append(r.get("companyCdpId") or normalize_domain(r.get("website", "")))
            except Exception as exc:
                leadstore_failed = True
                leadstore_error = str(exc)[:200]
                break
        if leadstore_failed:
            ck["last_successful_step"] = "bitable"
            return {"status": "failed", "result_count": 0,
                    "failure_reason": "leadstore_write_failed", "next_action": "retry_leadstore_write",
                    "resume_from": "leadstore", "last_successful_step": "bitable",
                    "evidence": {**_empty_buyer_evidence(), "query_count": len(queries),
                                 "raw_count": len(raw_records), "duplicate_count": duplicate_count,
                                 "rejected_count": rejected_count, "queries": queries,
                                 "checkpoint": ck, "buyer_readiness": buyer_readiness,
                                 "requested_count": requested_count, "effective_limit": effective_limit,
                                 "limit_reason": limit_reason, "error": leadstore_error}}
        ck["leadstore_write_completed"] = True
        ck["lead_ids"] = lead_ids

    # Step 6: audit（已审计则跳过；失败可恢复，只补 audit）
    if not ck.get("audit_completed"):
        try:
            AuditLog().log(action="buyer_search", user_open_id=user_open_id, enterprise=company_id,
                           target=task["task_id"],
                           detail=f"saved={len(lead_ids)} limit={effective_limit} readiness={buyer_readiness}")
        except Exception as e:
            ck["last_successful_step"] = "leadstore"
            return {"status": "failed", "result_count": len(lead_ids),
                    "failure_reason": "audit_failed", "next_action": "retry_audit",
                    "resume_from": "audit", "last_successful_step": "leadstore",
                    "evidence": {**_empty_buyer_evidence(), "query_count": len(queries),
                                 "raw_count": len(raw_records), "duplicate_count": duplicate_count,
                                 "rejected_count": rejected_count, "queries": queries,
                                 "saved_count": len(lead_ids), "lead_ids": lead_ids,
                                 "checkpoint": ck, "buyer_readiness": buyer_readiness,
                                 "requested_count": requested_count, "effective_limit": effective_limit,
                                 "limit_reason": limit_reason, "error": str(e)[:200]}}
        ck["audit_completed"] = True

    saved_count = len(lead_ids)
    evidence = {"query_count": len(queries), "raw_count": len(raw_records),
                "duplicate_count": duplicate_count, "rejected_count": rejected_count,
                "saved_count": saved_count, "lead_ids": lead_ids,
                "source": "引擎搜索", "queries": queries,
                "checkpoint": ck, "buyer_readiness": buyer_readiness,
                "requested_count": requested_count, "effective_limit": effective_limit,
                "limit_reason": limit_reason,
                "bitable_created_count": ck.get("bitable_created_count", 0),
                "bitable_updated_count": ck.get("bitable_updated_count", 0),
                "bitable_skipped_count": ck.get("bitable_skipped_count", 0),
                "bitable_record_ids": ck.get("bitable_record_ids", []),
                "bitable_unique_keys": ck.get("bitable_unique_keys", []),
                "response_schema_version": ck.get("response_schema_version", "")}
    if saved_count == 0:
        return {"status": "completed", "result_count": 0, "evidence": evidence,
                "failure_reason": "", "next_action": "review_search_strategy",
                "resume_from": "", "last_successful_step": "audit"}
    return {"status": "completed", "result_count": saved_count, "evidence": evidence,
            "failure_reason": "", "next_action": "", "resume_from": "", "last_successful_step": "audit"}


def _run_contact_enrichment(task: dict, dry_run: bool = False) -> dict:
    """补全联系人：选已确认+有 cdp_id 的线索 → get_contacts → 按 companyCdpId 回绑 → 同步 Bitable。

    联系人必须更新到正式飞书线索池才计入 contacts_saved；Bitable 更新失败只重试更新，不重调 get_contacts()。
    """
    company_id = task["company_id"]
    user_open_id = task.get("user_open_id", "")
    from dc_ls_store import LeadStore
    from dc_buyer_adapter import get_contacts
    from dc_campaign import get_active_campaign, buyer_readiness_from_state
    from dc_company_registry import CompanyRegistry, sync_contacts_to_pool

    camp = get_active_campaign(company_id)
    buyer_readiness = buyer_readiness_from_state(company_id, (camp or {}).get("owner_open_id", ""))
    store = LeadStore()
    leads = store.get_enterprise_leads(company_id) or []
    confirmed = [l for l in leads if l.get("status") in ("我的买家", "pending_review", "待处理")]
    if not confirmed:
        return {"status": "blocked", "result_count": 0,
                "failure_reason": "no_confirmed_buyer", "next_action": "user_review",
                "evidence": {"requested_lead_ids": [], "requested_cdp_ids": [],
                             "matched_count": 0, "contacts_saved": 0,
                             "no_contact_lead_ids": [], "source": "CDP联系人"}}
    targets = [l for l in confirmed if l.get("company_cdp_id")]
    if not targets:
        return {"status": "blocked", "result_count": 0,
                "failure_reason": "unsupported_identifier", "next_action": "resolve_company_cdp_id",
                "evidence": {"requested_lead_ids": [], "requested_cdp_ids": [],
                             "matched_count": 0, "contacts_saved": 0,
                             "no_contact_lead_ids": [], "source": "CDP联系人"}}

    cdp_ids = [l["company_cdp_id"] for l in targets][:20]
    requested_lead_ids = [l.get("company_cdp_id") for l in targets][:20]
    if dry_run:
        return {"status": "dry_run", "result_count": 0,
                "planned_call": {"action": "contact_enrichment", "cdp_ids": cdp_ids},
                "evidence": {"requested_lead_ids": requested_lead_ids, "requested_cdp_ids": cdp_ids,
                             "matched_count": 0, "contacts_saved": 0,
                             "no_contact_lead_ids": [], "source": "CDP联系人"}}

    # ── checkpoint 恢复 ──
    prev_evidence = task.get("evidence") if isinstance(task.get("evidence"), dict) else {}
    ck = dict(prev_evidence.get("checkpoint") or {})

    # Step 1: get_contacts（已取则复用中间文件，不重调）
    records: list = []
    if ck.get("contacts_fetched"):
        loaded = _read_json_file(_intermediate_path(company_id, task["task_id"], "contacts"))
        records = (loaded or {}).get("records", [])
    else:
        try:
            raw = get_contacts(cdp_ids)
        except Exception as e:
            return {"status": "failed", "result_count": 0,
                    "failure_reason": str(e)[:200], "next_action": "retry",
                    "evidence": {"requested_lead_ids": requested_lead_ids, "requested_cdp_ids": cdp_ids,
                                 "matched_count": 0, "contacts_saved": 0,
                                 "no_contact_lead_ids": [], "source": "CDP联系人",
                                 "checkpoint": ck}}
        records = raw.get("page", {}).get("records") or raw.get("records") or []
        ck["contacts_fetched"] = True
        _write_json_file(_intermediate_path(company_id, task["task_id"], "contacts"),
                         {"records": records})

    # Step 2: 构建联系人更新 + 回绑（严格按 companyCdpId）
    contact_updates: list = []
    contact_records: list = []
    returned_cdp = {r.get("companyCdpId", "") for r in records}
    for rec in records:
        cdp_id = rec.get("companyCdpId", "")
        if cdp_id not in cdp_ids:
            continue  # 严格按 companyCdpId 回绑
        items = rec.get("contacts") or rec.get("contactList") or [rec]
        texts = []
        for c in (items if isinstance(items, list) else [items]):
            email = (c.get("email") or c.get("emailsValid") or "").strip()
            name = (c.get("name") or c.get("contactName") or "").strip()
            role = (c.get("role") or c.get("position") or c.get("jobTitle") or "").strip()
            if not email and not name:
                continue
            texts.append(f"{name} ({role}) {email}".strip())
            contact_records.append({"lead_id": cdp_id, "company_id": company_id,
                                   "contact_id": c.get("contactId") or c.get("id") or c.get("contactCdpId") or "",
                                   "name": name, "role": role, "email": email,
                                   "source": "CDP联系人",
                                   "confidence": c.get("confidence") or "", "verified_at": _now()})
        if texts:
            contact_updates.append({"companyCdpId": cdp_id, "contact_text": "；".join(texts)})
    no_contact_lead_ids = [c for c in cdp_ids if c not in returned_cdp]
    matched_count = len(contact_updates)

    # Step 3: 同步联系人到正式飞书线索池（已同步则跳过；失败只重试更新）
    contacts_saved = 0
    if not ck.get("bitable_contacts_completed"):
        if contact_updates:
            try:
                registry = CompanyRegistry()
                entry = registry.get(company_id)
                company_name = entry.get("company_name") if entry else company_id
                sync_result = sync_contacts_to_pool(company_id, company_name, contact_updates)
                contacts_saved = sync_result.get("updated", 0)
            except Exception as e:
                ck["last_successful_step"] = "contacts_fetched"
                return {"status": "failed", "result_count": 0,
                        "failure_reason": "contact_pool_write_failed", "next_action": "retry_contact_pool_write",
                        "resume_from": "bitable_contacts", "last_successful_step": ck["last_successful_step"],
                        "evidence": {"requested_lead_ids": requested_lead_ids, "requested_cdp_ids": cdp_ids,
                                     "matched_count": matched_count, "contacts_saved": 0,
                                     "no_contact_lead_ids": no_contact_lead_ids, "source": "CDP联系人",
                                     "checkpoint": ck, "error": str(e)[:200]}}
        ck["bitable_contacts_completed"] = True
        ck["contacts_saved"] = contacts_saved
    else:
        contacts_saved = ck.get("contacts_saved", 0)

    # Step 4: 本地联系人记录（幂等 append，重复重跑不会破坏已写入结果）
    date = task.get("date", _today())
    for c in contact_records:
        _append_jsonl(_contact_path(company_id, date), _CONTACT_HEADER, c)

    # Step 5: audit
    if not ck.get("audit_completed"):
        try:
            from dc_audit import AuditLog
            AuditLog().log(action="contact_enrichment", user_open_id=user_open_id, enterprise=company_id,
                           target=task["task_id"], detail=f"contacts_saved={contacts_saved}")
        except Exception:
            pass
        ck["audit_completed"] = True

    evidence = {"requested_lead_ids": requested_lead_ids, "requested_cdp_ids": cdp_ids,
                "matched_count": matched_count, "contacts_saved": contacts_saved,
                "no_contact_lead_ids": no_contact_lead_ids, "source": "CDP联系人",
                "checkpoint": ck}
    if contacts_saved == 0:
        return {"status": "completed", "result_count": 0, "evidence": evidence,
                "failure_reason": "", "next_action": "try_alternative_contact_source",
                "resume_from": "", "last_successful_step": "audit"}
    return {"status": "completed", "result_count": contacts_saved, "evidence": evidence,
            "failure_reason": "", "next_action": "", "resume_from": "", "last_successful_step": "audit"}


# 集中执行映射（禁止 Cron/Agent Prompt/action 文本决定调用哪个函数）
EXECUTORS = {
    "buyer_search": _run_buyer_search,
    "contact_enrichment": _run_contact_enrichment,
}


def execute_task(task: dict, dry_run: bool = True) -> dict:
    """执行单个 todo。dry_run 验证输入但不调真实 API。"""
    atype = task.get("action_type")
    if atype not in VALID_ACTION_TYPES:
        return {"status": "rejected", "result_count": 0, "failure_reason": "unknown_action_type",
                "next_action": "", "evidence": ""}
    if task.get("status") == "completed":
        return {"status": "already_completed", "result_count": 0,
                "failure_reason": "", "next_action": "", "evidence": task.get("evidence", "")}
    if not task.get("user_open_id"):
        return {"status": "blocked", "result_count": 0, "failure_reason": "user_context_missing",
                "next_action": "resolve_user_context", "evidence": ""}
    if dry_run:
        return {"status": "dry_run", "result_count": 0, "planned_action": atype, "evidence": ""}
    return EXECUTORS[atype](task, dry_run=False)


def execute_plan(company_id: str, plan_id: str, dry_run: bool = True) -> dict:
    """统一执行接口：执行 plan 中 buyer_search / contact_enrichment 低风险任务。"""
    plan = _find_plan_by_id(company_id, plan_id)
    if not plan:
        return {"status": "error", "error": "plan not found", "plan_id": plan_id}
    date = plan["date"]
    results = []
    for todo in plan.get("todos", []):
        atype = todo.get("action_type", "other")
        if atype not in VALID_ACTION_TYPES:
            continue
        if todo.get("blocked") or todo.get("requires_confirmation"):
            continue
        out = execute_task(todo, dry_run=dry_run)
        if not dry_run:
            try:
                from dc_audit import AuditLog
                AuditLog().log(action="task.execute",
                               user_open_id=todo.get("user_open_id", ""),
                               enterprise=company_id, target=todo["task_id"],
                               detail=f"{atype}: {out['status']} count={out.get('result_count', 0)}")
            except Exception:
                pass
        rec = {"task_id": todo["task_id"], "run_id": _run_id(plan_id, todo["task_id"]),
               "action": atype, "status": out["status"], "started_at": _now(),
               "completed_at": _now() if not dry_run else "",
               "result_count": out.get("result_count", 0),
               "evidence": out.get("evidence", ""),
               "failure_reason": out.get("failure_reason", ""),
               "next_action": out.get("next_action", ""),
               "attempts": 0 if dry_run else 1}
        if not dry_run:
            _append_jsonl(_exec_path(company_id, date), _EXEC_HEADER, rec)
            todo["status"] = out["status"]
            if out.get("evidence"):
                todo["evidence"] = out["evidence"]
            if out.get("failure_reason"):
                todo["failure_reason"] = out["failure_reason"]
            if out.get("next_action"):
                todo["next_action"] = out["next_action"]
        results.append(rec)
    if not dry_run:
        plan["updated_at"] = _now()
        _save_plan(plan)
    return {"status": "dry_run" if dry_run else "executed", "plan_id": plan_id,
            "company_id": company_id, "date": date, "results": results}


def close_experiment(company_id: str, experiment_id: str, outcome: str,
                     observed_sample: int = 0, decision: str = "") -> dict:
    """实验生命周期：active → completed | ineffective | cancelled。"""
    if outcome not in ("completed", "ineffective", "cancelled"):
        return {"status": "error", "error": f"invalid outcome: {outcome}"}
    exp = _find_experiment(company_id, experiment_id)
    if not exp or exp.get("status") != "active":
        return {"status": "error", "error": "no active experiment"}
    exp["status"] = outcome
    exp["completed_at"] = _now()
    exp["observed_sample"] = observed_sample
    exp["outcome"] = outcome
    exp["decision"] = decision
    _save_experiment(exp)
    return {"status": "closed", "experiment": exp}


# ── CLI ────────────────────────────────────────────────────


def _append_job_log(slot: str, record: dict) -> None:
    """把作业元数据追加到 data/cron/cron-<slot>.log（JSONL）。"""
    cron_dir = DATA_DIR / "cron"
    cron_dir.mkdir(parents=True, exist_ok=True)
    path = cron_dir / f"cron-{slot}.log"
    lock = cron_dir / ".lock"
    with _file_lock(lock):
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _should_send_evening(summary: dict) -> bool:
    """判断晚报是否值得发送：有完成/失败/策略变化才算有新结果。

    校准期无新执行证据时不发空晚报，不重复催促已早报通知过的确认事项。
    """
    if not summary:
        return False
    if summary.get("completed", 0) > 0:
        return True
    if summary.get("failed", 0) > 0:
        return True
    if summary.get("strategy_change"):
        return True
    return False


def _refresh_email_followup(company_id: str) -> None:
    """刷新邮件跟进数据：memory email_followup.json → 飞书「邮件跟进」表。

    只对注册表里配了 followup_table_id 的企业生效；任何异常静默吞掉，不阻断日报。
    """
    try:
        from dc_memory_data import sync_email_followup_to_memory
        from dc_company_registry import CompanyRegistry
        from enterprise_ids import slug_for
        slug = slug_for(company_id)
        entry = CompanyRegistry().get(slug)
        if not entry or not entry.get("app_token"):
            return
        sync_email_followup_to_memory(company_id)
        import dc_feishu_standard as std
        std.sync_email_followup(company_id, entry["app_token"])
    except Exception:
        pass


def run_daily_job(company_id: str, slot: str, execute: bool = False,
                  dispatch: bool = False) -> dict:
    """完整每日循环（生成→执行→publish→dispatch）+ slot flock + 作业元数据 + 一次重试。

    Morning：读 Campaign → 生成 plan → 执行可自动 Todo → 存 evidence → publish plan_item → dispatch。
    Evening：读同一 plan_id → 核验 evidence → 评估策略 → publish summary_item → dispatch/quiet。

    重跑幂等由 dc_daily_cycle/dc_notify 已有机制保证（稳定 plan_id、publish 去重、dispatch quiet）。
    """
    from dc_notify import NotifyEngine

    started_at = _now()
    # 优先使用调度器注入的真实 job_id（DC_CRON_JOB_ID），否则用内部生成值
    env_job_id = os.environ.get("DC_CRON_JOB_ID", "").strip()
    job_id = env_job_id or ("dc-" + hashlib.sha1(f"{company_id}|{slot}|{started_at}".encode()).hexdigest()[:12])
    record = {
        "job_id": job_id, "slot": slot, "company_id": company_id,
        "plan_id": "", "started_at": started_at, "completed_at": "",
        "status": "running", "message_id": "", "failure_reason": "",
        "next_action": "",
    }

    cron_dir = DATA_DIR / "cron"
    cron_dir.mkdir(parents=True, exist_ok=True)
    lock_path = cron_dir / f"{slot}.lock"

    def _run_once() -> dict:
        # 先刷新邮件跟进表（memory email_followup.json + 飞书「邮件跟进」表），
        # 保证日报里的「跟进明细」链接始终指向最新数据。失败不影响日报。
        _refresh_email_followup(company_id)
        if slot == "morning":
            r = build_morning_plan(company_id, dry_run=not execute)
            record["plan_id"] = r.get("plan_id", "")
            if execute and r.get("status") == "planned":
                r["execution"] = execute_plan(company_id, r["plan_id"], dry_run=False)
            if dispatch:
                r["dispatch"] = NotifyEngine().dispatch(company_id, slot="morning", dry_run=False)
        elif slot == "evening":
            # P0-E5/P0-E7：晚报每天发送（有 plan 则发简短版；无 plan 记 error 不崩，由 dedupe 保证不重发）
            r = evaluate_evening(company_id, dry_run=not execute)
            record["plan_id"] = r.get("plan_id", "")
            if dispatch:
                r["dispatch"] = NotifyEngine().dispatch(company_id, slot="evening", dry_run=False)
        else:
            raise ValueError(f"invalid slot: {slot}")
        return r

    def _extract_message_id(r: dict) -> None:
        d = (r or {}).get("dispatch") or {}
        for res in d.get("results", []):
            if res.get("status") == "sent" and res.get("message_id"):
                record["message_id"] = res["message_id"]
                return

    cycle: dict = {}
    with open(lock_path, "a") as lock_f:
        fcntl.flock(lock_f, fcntl.LOCK_EX)  # 阻塞，slot 级防并发
        try:
            try:
                cycle = _run_once()
                _extract_message_id(cycle)
                record["status"] = "ok"
            except Exception as e:
                record["failure_reason"] = str(e)[:200]
                record["next_action"] = "retry_once"
                time.sleep(2)
                try:
                    cycle = _run_once()
                    _extract_message_id(cycle)
                    record["status"] = "ok"
                    record["failure_reason"] = ""
                    record["next_action"] = ""
                except Exception as e2:
                    record["status"] = "failed"
                    record["failure_reason"] = str(e2)[:200]
                    record["next_action"] = "audit_log_only"
        finally:
            fcntl.flock(lock_f, fcntl.LOCK_UN)

    record["completed_at"] = _now()
    record["cycle"] = cycle
    _append_job_log(slot, record)
    return record


def _cli():
    ap = argparse.ArgumentParser(description="DealClaw 展会每日执行循环")
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("morning", help="生成今日 Todo 计划")
    m.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    m.add_argument("--execute", action="store_true",
                   help="真实执行低风险任务（buyer_search/contact_enrichment）并 push（默认 dry-run）")

    e = sub.add_parser("evening", help="核验当天结果")
    e.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    e.add_argument("--execute", action="store_true", help="真实 push 晚报（默认 dry-run）")

    run = sub.add_parser("run", help="完整每日循环（生成→执行→publish→dispatch）+ flock + 作业元数据")
    run.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    run.add_argument("--slot", required=True, choices=["morning", "evening"])
    run.add_argument("--execute", action="store_true", help="真实执行内部 Todo 并 publish（默认 dry-run）")
    run.add_argument("--dispatch", action="store_true", help="真实 dispatch pending（发送 push）")

    args = ap.parse_args()

    if not args.company_id:
        raise SystemExit("[dc_daily_cycle] 缺少 company-id：请 --company-id 指定，或确保环境变量 MIO_CDP_SUPPLIER_ID 已设置")

    if args.cmd == "morning":
        result = build_morning_plan(args.company_id, dry_run=not args.execute)
        if args.execute and result.get("status") == "planned":
            result["execution"] = execute_plan(args.company_id, result["plan_id"], dry_run=False)
    elif args.cmd == "evening":
        result = evaluate_evening(args.company_id, dry_run=not args.execute)
    elif args.cmd == "run":
        result = run_daily_job(args.company_id, slot=args.slot,
                               execute=args.execute, dispatch=args.dispatch)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
