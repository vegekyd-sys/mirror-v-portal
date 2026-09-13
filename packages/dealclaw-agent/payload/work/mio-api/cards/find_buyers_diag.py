#!/usr/bin/env python3
"""find-buyers 任务诊断（只读观测）：分阶段耗时、模型用量、候选分布。

田耕郡 2026-09-13 定的观测项：
  1. 分阶段耗时（search / normalize / qualify / contact / pool / card）
     + 模型调用次数 + input/output tokens
  2. 候选诊断：page / position / score / qualified / excluded_reason / delivered

约束（硬）：
  - 只写 data/runtime/diagnostics/；不进卡片、不进 metrics、不向用户输出；
  - 候选只存**稳定假名**（email_metrics.pseudonym），不存公司名 / 域名 / 联系方式；
  - 采不到的数值一律记 None，**不得估算或伪造**（缺 token 就记 null，宁可缺不编）；
  - 任何异常静默，绝不影响交付主流程。

用途：replay A/B 的基线数据源 —— 10–20 次真实任务后统计
「阶段耗时分布 / token 分布 / 分页分数分布 / 新旧 Top10 对比」。
"""
from __future__ import annotations

import json
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# 复用同仓库的稳定假名（HMAC-SHA256，盐来自 DC_DIAGNOSTIC_SALT）
_WS_ROOT = Path(__file__).resolve().parents[3]
if str(_WS_ROOT / "work" / "mio-api") not in sys.path:
    sys.path.insert(0, str(_WS_ROOT / "work" / "mio-api"))
try:  # pragma: no cover - 取决于部署布局
    from email_metrics.pseudonym import pseudonym as _pseudonym
except Exception:  # pragma: no cover
    _pseudonym = None  # 由 _candidate_id 兜底

DIAG_DIR = _WS_ROOT / "data" / "runtime" / "diagnostics"
JOBS_LOG = DIAG_DIR / "find-buyers-jobs.jsonl"
CANDIDATES_LOG = DIAG_DIR / "find-buyers-candidates.jsonl"

# 阶段口径（顺序即流水线顺序，不得随意新增/改名）
STAGES = ("search", "normalize", "qualify", "contact", "pool", "card")

# 交付口径：分页分数分布需要知道的阈值档位
SCORE_BUCKETS = (75.0, 70.0, 50.0)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _num(value) -> Optional[float]:
    """只接受真实数值；缺失/非法 → None（不补 0，不估算）。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _int_or_none(value) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def candidate_id(company: str) -> str:
    """候选假名（稳定、可跨次对齐、不可反查公司名）。"""
    if _pseudonym is not None:
        return _pseudonym("buyer", str(company or ""))
    import hashlib
    import hmac
    import os

    salt = (os.environ.get("DC_DIAGNOSTIC_SALT") or "dealclaw-diag-v1").encode("utf-8")
    digest = hmac.new(salt, f"buyer:{company}".encode("utf-8"), hashlib.sha256).hexdigest()
    return f"buyer_{digest[:12]}"


class JobDiagnostics:
    """单次找买家任务的诊断记录器（只读观测）。"""

    def __init__(self, job_id: str, tenant_id: str = "", chat_id: str = "",
                 *, jobs_log: Optional[Path] = None,
                 candidates_log: Optional[Path] = None,
                 dry_run: bool = False):
        self.job_id = str(job_id or "").strip()
        self.tenant_id = tenant_id or ""
        self.chat_id = chat_id or ""
        self.dry_run = bool(dry_run)
        self._jobs_log = Path(jobs_log) if jobs_log else JOBS_LOG
        self._cand_log = Path(candidates_log) if candidates_log else CANDIDATES_LOG
        self.stages: dict[str, dict] = {}
        self.llm: dict[str, dict] = {}
        self.candidates: list[dict] = []
        self.notes: list[str] = []
        self.started_at = _now()

    # ── 阶段耗时 ──
    @contextmanager
    def stage(self, name: str):
        """with diag.stage("search"): ... —— 自动记录耗时（毫秒）。"""
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self.record_stage(name, (time.perf_counter() - t0) * 1000.0)

    def record_stage(self, name: str, duration_ms: Optional[float]) -> None:
        try:
            ms = _num(duration_ms)
            slot = self.stages.setdefault(name, {"count": 0, "total_ms": 0.0, "last_ms": None})
            if ms is not None:
                slot["count"] += 1
                slot["total_ms"] = round(slot["total_ms"] + ms, 1)
                slot["last_ms"] = round(ms, 1)
        except Exception:
            pass

    # ── 模型用量（采不到就 None，不估算）──
    def record_llm(self, stage: str = "", calls: Optional[int] = None,
                   input_tokens: Optional[int] = None,
                   output_tokens: Optional[int] = None) -> None:
        try:
            key = stage or "job"
            slot = self.llm.setdefault(key, {"calls": 0, "input_tokens": 0, "output_tokens": 0,
                                             "calls_known": True, "tokens_known": True})
            c = _int_or_none(calls)
            i = _int_or_none(input_tokens)
            o = _int_or_none(output_tokens)
            if c is None:
                slot["calls_known"] = False
            else:
                slot["calls"] += c
            if i is None or o is None:
                slot["tokens_known"] = False
            else:
                slot["input_tokens"] += i
                slot["output_tokens"] += o
        except Exception:
            pass

    # ── 候选诊断（脱敏）──
    def add_candidate(self, company: str, *, page: Optional[int] = None,
                      position: Optional[int] = None, score=None,
                      qualified: Optional[bool] = None, excluded_reason: str = "",
                      delivered: bool = False) -> dict:
        """落一条候选诊断。company 只用于生成假名，不落盘。"""
        row: dict = {}
        try:
            cid = candidate_id(company)
            if not cid:
                return {}
            row = {
                "candidate_id": cid,
                "page": _int_or_none(page),
                "position": _int_or_none(position),
                "score": _num(score),
                "qualified": None if qualified is None else bool(qualified),
                "excluded_reason": (excluded_reason or "").strip()[:60],
                "delivered": bool(delivered),
            }
            self.candidates.append(row)
        except Exception:
            return {}
        return row

    def note(self, text: str) -> None:
        try:
            if text:
                self.notes.append(str(text)[:200])
        except Exception:
            pass

    # ── 汇总 ──
    def summary(self) -> dict:
        stages = {k: dict(v) for k, v in self.stages.items()}
        for name in STAGES:
            stages.setdefault(name, {"count": 0, "total_ms": 0.0, "last_ms": None})
        llm = {k: dict(v) for k, v in self.llm.items()}
        cand = [c for c in self.candidates if c.get("candidate_id")]
        scored = [c for c in cand if c.get("score") is not None]
        per_page: dict[str, dict] = {}
        for c in scored:
            key = str(c.get("page") if c.get("page") is not None else "unknown")
            slot = per_page.setdefault(key, {"scored": 0, "min": None, "max": None, "ge": {}})
            s = c["score"]
            slot["scored"] += 1
            slot["min"] = s if slot["min"] is None else min(slot["min"], s)
            slot["max"] = s if slot["max"] is None else max(slot["max"], s)
            for th in SCORE_BUCKETS:
                if s >= th:
                    k = f"ge_{int(th)}"
                    slot["ge"][k] = slot["ge"].get(k, 0) + 1
        excluded: dict[str, int] = {}
        for c in cand:
            r = c.get("excluded_reason") or ""
            if r:
                excluded[r] = excluded.get(r, 0) + 1
        return {
            "job_id": self.job_id,
            "tenant_id": self.tenant_id,
            "chat_id": self.chat_id,
            "started_at": self.started_at,
            "recorded_at": _now(),
            "stages": stages,
            "llm": llm,
            "candidates": {
                "total": len(cand),
                "scored": len(scored),
                "qualified": sum(1 for c in cand if c.get("qualified") is True),
                "delivered": sum(1 for c in cand if c.get("delivered")),
                "unscored": len(cand) - len(scored),
                "per_page": per_page,
                "excluded_reasons": excluded,
            },
            "notes": list(self.notes),
        }

    def flush(self) -> dict:
        """落盘：job 汇总一行 + 候选逐条一行。失败静默。"""
        summary = {}
        try:
            summary = self.summary()
            if self.dry_run:
                return summary
            self._jobs_log.parent.mkdir(parents=True, exist_ok=True)
            with self._jobs_log.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(summary, ensure_ascii=False) + "\n")
            if self.candidates:
                with self._cand_log.open("a", encoding="utf-8") as fh:
                    for c in self.candidates:
                        fh.write(json.dumps({"job_id": self.job_id, **c}, ensure_ascii=False) + "\n")
        except Exception:
            return summary
        return summary


def aggregate(jobs_log: Optional[Path] = None, last_n: int = 20) -> dict:
    """聚合最近 N 次任务：阶段耗时分布 / token 分布 / 分页分数分布。

    只读；用于 A/B 决策，不参与交付逻辑。
    """
    path = Path(jobs_log) if jobs_log else JOBS_LOG
    rows: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    except OSError:
        rows = []
    rows = rows[-int(last_n):] if last_n else rows

    def _pct(vals: list[float], q: float) -> Optional[float]:
        vals = sorted(vals)
        if not vals:
            return None
        if len(vals) == 1:
            return round(vals[0], 1)
        pos = (len(vals) - 1) * q
        lo = int(pos)
        hi = min(lo + 1, len(vals) - 1)
        return round(vals[lo] + (vals[hi] - vals[lo]) * (pos - lo), 1)

    stage_ms: dict[str, list[float]] = {}
    tokens: dict[str, list[float]] = {}
    per_page: dict[str, dict] = {}
    delivered: list[float] = []
    for r in rows:
        for name, slot in (r.get("stages") or {}).items():
            if slot.get("last_ms") is not None:
                stage_ms.setdefault(name, []).append(float(slot["last_ms"]))
        for name, slot in (r.get("llm") or {}).items():
            if slot.get("tokens_known"):
                tokens.setdefault(name, []).append(
                    float((slot.get("input_tokens") or 0) + (slot.get("output_tokens") or 0)))
        for page, slot in ((r.get("candidates") or {}).get("per_page") or {}).items():
            tgt = per_page.setdefault(page, {"jobs": 0, "scored": 0, "ge_75": 0, "ge_70": 0, "ge_50": 0})
            tgt["jobs"] += 1
            tgt["scored"] += int(slot.get("scored") or 0)
            for k in ("ge_75", "ge_70", "ge_50"):
                tgt[k] += int((slot.get("ge") or {}).get(k) or 0)
        d = (r.get("candidates") or {}).get("delivered")
        if isinstance(d, int):
            delivered.append(float(d))
    return {
        "jobs": len(rows),
        "stage_ms": {k: {"p50": _pct(v, 0.5), "p90": _pct(v, 0.9), "n": len(v)}
                     for k, v in sorted(stage_ms.items())},
        "tokens_total": {k: {"p50": _pct(v, 0.5), "p90": _pct(v, 0.9), "n": len(v)}
                         for k, v in sorted(tokens.items())},
        "per_page_scores": {k: per_page[k] for k in sorted(per_page)},
        "delivered": {"p50": _pct(delivered, 0.5), "n": len(delivered)},
    }


if __name__ == "__main__":  # pragma: no cover
    print(json.dumps(aggregate(), ensure_ascii=False, indent=2))
