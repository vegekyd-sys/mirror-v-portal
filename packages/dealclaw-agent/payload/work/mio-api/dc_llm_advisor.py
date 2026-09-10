#!/usr/bin/env python3
"""dc_llm_advisor.py — 真实 LLM Advisor 影子模式（LLMAdvisor 适配器 + ShadowRunner）

分层：
  Provider 事实 → 规则候选 action → TemplateAdvisor（唯一用户可见 + 强制 fallback）
                                ↘ LLMAdvisor（影子，不展示）→ Guard → data/evals 落盘

约束（对应需求 1-10）：
  1. TemplateAdvisor 是唯一用户可见结果和强制 fallback；LLM 只做影子对照。
  2. 不改 Provider 业务逻辑。
  3. 输入限权：当前目标 / 展会阶段 / ≤10 候选 / ≤30 事实 / 有效偏好 / 模板建议。
  4. 不传完整 Memory、原始邮件、会议全文、退订名单。
  5. LLM 输出现有 Advice / ProposedAction 结构化 JSON。
  6. 依次通过 GroundingGuard、DecisionGuard；proposal 一律 authorized=false，禁止 materialize/执行。
  7. 超时 / 429 / 5xx / HTML / 非法 JSON / 字段缺失 / Token 超限 → 降级 TemplateAdvisor，不影响日报。
  8. snapshot_hash + model + prompt_version 做调用幂等与过期响应拦截。
  9. 影子结果写 data/evals/daily-advisor，不写企业 Memory、不展示用户。
  10. 记录延迟 / 输入输出 Token / 解析状态 / Guard 违规 / fallback / 与模板排序差异。

本模块不发送、不改 Provider、不切生产早晚报。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from dc_daily_advisor import (
    Advice, ProposedAction, GuardContext, Violation,
    GroundingGuard, DecisionGuard, validate_advice,
    build_snapshot,
)
from dc_daily_brief import EvidenceRef, FactRef, TargetRef

# ── 常量 ────────────────────────────────────────────────────
MAX_CANDIDATES = 10
MAX_FACTS = 30
MAX_GOALS = 5
PROMPT_VERSION = "1.0.0"
DEFAULT_MODEL = os.environ.get("LLM_ADVISOR_MODEL", "openai/gpt-4o-mini")

# 异常/降级类别
ERROR_TIMEOUT = "timeout"
ERROR_RATE_LIMIT = "rate_limit_429"
ERROR_SERVER = "server_error_5xx"
ERROR_HTML = "html_response"
ERROR_INVALID_JSON = "invalid_json"
ERROR_MISSING_FIELD = "missing_field"
ERROR_TOKEN_LIMIT = "token_limit"
ERROR_GUARD = "guard_violation"
ERROR_UNAUTHORIZED = "unauthorized_proposal"
ERROR_STALE = "stale_snapshot"
ERROR_UNKNOWN = "unknown_error"

_HTML_RE = re.compile(r"<\s*(!doctype|html|body|head)\b", re.IGNORECASE)


class LLMAdvisorError(Exception):
    def __init__(self, kind: str, detail: str = ""):
        super().__init__(f"{kind}: {detail}")
        self.kind = kind
        self.detail = detail


# ── 结构化序列化 ────────────────────────────────────────────
def serialize_advice(a: Advice) -> dict:
    return {
        "advice_key": a.advice_key, "claim": a.claim,
        "evidence_refs": [asdict(e) for e in a.evidence_refs],
        "confidence": a.confidence, "confidence_reason": a.confidence_reason,
        "assumptions": list(a.assumptions),
        "counter_evidence": [asdict(e) for e in a.counter_evidence],
        "limitations": list(a.limitations), "recommendation": a.recommendation,
        "proposed_actions": [asdict(p) for p in a.proposed_actions],
        "action_refs": list(a.action_refs), "fact_refs": list(a.fact_refs),
        "reason_adjusted": a.reason_adjusted,
    }


def _req(d: dict, key: str):
    if key not in d or d[key] is None:
        raise LLMAdvisorError(ERROR_MISSING_FIELD, key)
    return d[key]


def _ev(d: dict) -> EvidenceRef:
    return EvidenceRef(type=_req(d, "type"), source=_req(d, "source"), id=_req(d, "id"),
                       missing=d.get("missing"))


def _pa(d: dict) -> ProposedAction:
    # 需求 6：proposal 一律 authorized=false（忽略模型返回值）
    return ProposedAction(
        proposal_id=_req(d, "proposal_id"), action_type=_req(d, "action_type"),
        scope=d.get("scope") or "global",
        target_refs=tuple(TargetRef(type=t.get("type", "buyer"), id=t.get("id", ""))
                          for t in (d.get("target_refs") or [])),
        reason=_req(d, "reason"), fact_refs=tuple(d.get("fact_refs") or []),
        outbound_content=d.get("outbound_content"), due_at=d.get("due_at"),
        authorized=False,
    )


def deserialize_advice(d: dict) -> Advice:
    if not isinstance(d, dict):
        raise LLMAdvisorError(ERROR_INVALID_JSON, "advice not an object")
    return Advice(
        advice_key=_req(d, "advice_key"), claim=_req(d, "claim"),
        evidence_refs=tuple(_ev(e) for e in (d.get("evidence_refs") or [])),
        confidence=_req(d, "confidence"), confidence_reason=d.get("confidence_reason") or "",
        assumptions=tuple(d.get("assumptions") or []),
        counter_evidence=tuple(_ev(e) for e in (d.get("counter_evidence") or [])),
        limitations=tuple(d.get("limitations") or []),
        recommendation=_req(d, "recommendation"),
        proposed_actions=tuple(_pa(p) for p in (d.get("proposed_actions") or [])),
        action_refs=tuple(d.get("action_refs") or []), fact_refs=tuple(d.get("fact_refs") or []),
        reason_adjusted=d.get("reason_adjusted"),
    )


def parse_advices(content: str) -> tuple[Advice, ...]:
    """把 LLM 文本解析为 Advice 元组；HTML / 非法 JSON / 字段缺失 → LLMAdvisorError。"""
    if content is None:
        raise LLMAdvisorError(ERROR_INVALID_JSON, "empty content")
    text = str(content).strip()
    if not text:
        raise LLMAdvisorError(ERROR_INVALID_JSON, "empty content")
    if _HTML_RE.search(text):
        raise LLMAdvisorError(ERROR_HTML, "html response")
    # 容忍 ```json 包裹
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    try:
        data = json.loads(text)
    except (ValueError, TypeError) as e:
        raise LLMAdvisorError(ERROR_INVALID_JSON, str(e))
    advices = data.get("advices") if isinstance(data, dict) else data
    if not isinstance(advices, list):
        raise LLMAdvisorError(ERROR_INVALID_JSON, "advices not a list")
    return tuple(deserialize_advice(a) for a in advices)


# ── 限权输入（需求 3/4）──────────────────────────────────────
def _candidate_view(c: "BriefItem") -> dict:
    return {
        "item_key": c.item_key, "kind": c.kind, "source": c.source, "category": c.category,
        "priority": c.priority, "title": c.title, "reason": c.reason,
        "fact_refs": [f.fact_id for f in c.reason_facts],
        "evidence_refs": [{"type": e.type, "source": e.source, "id": e.id}
                          for e in c.evidence_refs],
        "targets": [{"type": t.type, "id": t.id} for t in c.target_refs],
        "action_key": c.action_key, "due_at": c.due_at,
        "detail": {k: v for k, v in (c.detail or {}).items()
                   if k in ("customer_id", "stage", "company", "trigger", "fit_grade")},
    }


def bounded_input(snapshot, template_advices=()) -> dict:
    """构造限权输入：只含当前目标 / 阶段 / ≤10 候选 / ≤30 事实 / 有效偏好 / 模板建议。

    不包含完整 Memory、原始邮件、会议全文、退订名单。
    """
    cands = list(snapshot.candidates)[:MAX_CANDIDATES]
    facts: list[dict] = []
    seen: set[str] = set()
    for c in cands:
        for f in c.reason_facts:
            if f.fact_id in seen:
                continue
            seen.add(f.fact_id)
            facts.append({"fact_id": f.fact_id, "kind": f.kind, "value": f.value})
            if len(facts) >= MAX_FACTS:
                break
        if len(facts) >= MAX_FACTS:
            break
    return {
        "target": {"tenant": snapshot.tenant, "company": snapshot.company,
                   "report_type": snapshot.report_type, "date": snapshot.date,
                   "tz": snapshot.tz, "as_of": snapshot.as_of},
        "exhibition_stage": snapshot.exhibition_stage,
        "company_goals": list(snapshot.company_goals)[:MAX_GOALS],
        "preferences": dict(snapshot.preferences or {}),  # 只传生效偏好
        "candidates": [_candidate_view(c) for c in cands],
        "facts": facts,
        "template_advice": [
            {"advice_key": a.advice_key, "claim": a.claim, "recommendation": a.recommendation,
             "action_refs": list(a.action_refs)}
            for a in template_advices
        ],
    }


def snapshot_hash(payload: dict, model: str, prompt_version: str) -> str:
    """snapshot_hash + model + prompt_version 组合键（幂等 + 过期拦截）。"""
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(f"{blob}|{model}|{prompt_version}".encode("utf-8")).hexdigest()[:24]


def build_prompt(payload: dict) -> str:
    schema = {
        "advices": [{
            "advice_key": "str", "claim": "str",
            "evidence_refs": [{"type": "record|snapshot|query", "source": "str", "id": "str"}],
            "confidence": "low|medium|high", "confidence_reason": "str",
            "assumptions": ["str"], "counter_evidence": [], "limitations": ["str"],
            "recommendation": "str",
            "proposed_actions": [{"proposal_id": "str", "action_type": "str", "scope": "str",
                                  "target_refs": [{"type": "buyer", "id": "str"}],
                                  "reason": "str", "fact_refs": ["str"]}],
            "action_refs": ["str"], "fact_refs": ["str"],
        }]
    }
    return (
        "你是 DealClaw 的营销决策影子顾问。只能依据给定事实，不得编造 fact_id 或数字。\n"
        "只输出严格 JSON（不要 Markdown/解释），形如：\n"
        f"{json.dumps(schema, ensure_ascii=False)}\n"
        "proposal 一律 authorized=false（无需输出该字段）。\n"
        "--- 输入 ---\n" + json.dumps(payload, ensure_ascii=False)
    )


# ── LLM 客户端 ──────────────────────────────────────────────
class MockLLMClient:
    """确定性 mock：按 plan 返回内容/异常，用于测试与 mock 影子结果。"""

    def __init__(self, responses=None, exc=None):
        self._responses = list(responses) if isinstance(responses, list) else (
            [responses] if responses is not None else [])
        self._exc = exc
        self.calls = 0

    def complete(self, prompt: str, **kw) -> dict:
        self.calls += 1
        if self._exc is not None:
            raise self._exc
        content = self._responses[min(self.calls - 1, len(self._responses) - 1)] \
            if self._responses else '{"advices": []}'
        if isinstance(content, Exception):
            raise content
        return {"content": content, "input_tokens": max(1, len(prompt) // 4),
                "output_tokens": max(1, len(str(content)) // 4)}


class HTTPLLMClient:
    """真实 LLM 接口（OpenAI 兼容 chat/completions）。密钥只从环境变量读，不落日志。"""

    def __init__(self, base_url: str | None = None, model: str | None = None,
                 api_key_env: str = "OPENROUTER_API_KEY", timeout: int = 30,
                 max_tokens: int = 1024, extra_headers: dict | None = None):
        self.base_url = (base_url or os.environ.get(
            "LLM_ADVISOR_BASE_URL", "https://openrouter.ai/api/v1")).rstrip("/")
        self.model = model or DEFAULT_MODEL
        self.api_key_env = api_key_env
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.extra_headers = extra_headers or {}

    def complete(self, prompt: str, **kw) -> dict:
        import urllib.error
        import urllib.request
        key = os.environ.get(self.api_key_env, "").strip()
        if not key:
            raise LLMAdvisorError(ERROR_UNKNOWN, f"missing env {self.api_key_env}")
        body = json.dumps({
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": kw.get("max_tokens", self.max_tokens),
            "temperature": 0,
        }).encode("utf-8")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
        headers.update(self.extra_headers)
        req = urllib.request.Request(f"{self.base_url}/chat/completions", data=body,
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            code = getattr(e, "code", 0)
            if code == 429:
                raise LLMAdvisorError(ERROR_RATE_LIMIT, f"HTTP {code}")
            if 500 <= code < 600:
                raise LLMAdvisorError(ERROR_SERVER, f"HTTP {code}")
            raise LLMAdvisorError(ERROR_UNKNOWN, f"HTTP {code}")
        except TimeoutError:
            raise LLMAdvisorError(ERROR_TIMEOUT, "timeout")
        except urllib.error.URLError as e:
            raise LLMAdvisorError(ERROR_TIMEOUT, str(getattr(e, "reason", e)))
        data = json.loads(raw)
        choice = (data.get("choices") or [{}])[0]
        if choice.get("finish_reason") == "length":
            raise LLMAdvisorError(ERROR_TOKEN_LIMIT, "finish_reason=length")
        content = (choice.get("message") or {}).get("content") or choice.get("text") or ""
        usage = data.get("usage") or {}
        return {"content": content,
                "input_tokens": usage.get("prompt_tokens"),
                "output_tokens": usage.get("completion_tokens"),
                "snapshot_hash": data.get("snapshot_hash")}


# ── Guard 校验（需求 6）─────────────────────────────────────
def _guard_context(snapshot, template_advices) -> GuardContext:
    """GuardContext：facts 只来自候选事实；退订名单不传入（影子不接触）。"""
    facts: dict = {}
    allowed: set[str] = set()
    for c in snapshot.candidates:
        allowed.add(c.category)
        for f in c.reason_facts:
            facts.setdefault(f.fact_id, f.value)
    return GuardContext(unsubscribe_blocked=frozenset(), executed_action_keys=frozenset(),
                        allowed_action_types=frozenset(allowed), frequency={},
                        forbidden_expression=(), facts=facts)


def validate_llm_advice(advice: Advice, ctx: GuardContext) -> tuple[Violation, ...]:
    """依次通过 GroundingGuard → DecisionGuard（需求 6）。"""
    v = list(GroundingGuard().validate(advice, ctx))
    v += list(DecisionGuard().validate(advice, ctx))
    return tuple(v)


# ── 影子记录 ────────────────────────────────────────────────
@dataclass
class ShadowRecord:
    snapshot_hash: str
    model: str
    prompt_version: str
    ok: bool
    fallback: bool
    fallback_reason: str = ""
    parse_status: str = "ok"
    latency_ms: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    guard_violations: list = field(default_factory=list)
    template_order: list = field(default_factory=list)
    llm_order: list = field(default_factory=list)
    order_diff: list = field(default_factory=list)
    advices: list = field(default_factory=list)
    cached: bool = False
    stale_intercepted: bool = False
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _order(advices) -> list:
    return [a.advice_key for a in advices]


def _order_diff(template_order: list, llm_order: list) -> list:
    diff = []
    for key in set(template_order) | set(llm_order):
        ti = template_order.index(key) if key in template_order else None
        li = llm_order.index(key) if key in llm_order else None
        if ti != li:
            diff.append({"advice_key": key, "template_pos": ti, "llm_pos": li})
    return diff


def _safe_eval_dir(base: Path, tenant: str, company: str, date: str) -> Path:
    for name, val in (("tenant", tenant), ("company", company), ("date", date)):
        if not val or val in (".", "..") or "/" in val or "\\" in val or "\x00" in val:
            raise ValueError(f"invalid {name}: {val!r}")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError(f"invalid date: {date!r}")
    return base / tenant / company / date


def _atomic_write_json(path: Path, data: dict) -> None:
    import tempfile
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class LLMAdvisor:
    """LLM Advisor 适配器：限权输入 → 结构化输出 → Guard。失败抛 LLMAdvisorError。"""
    name = "llm"

    def __init__(self, client, model: str | None = None, prompt_version: str = PROMPT_VERSION,
                 max_tokens: int = 1024):
        self.client = client
        self.model = model or DEFAULT_MODEL
        self.prompt_version = prompt_version
        self.max_tokens = max_tokens

    def advise(self, snapshot, template_advices=()) -> tuple[tuple[Advice, ...], dict]:
        payload = bounded_input(snapshot, template_advices)
        h = snapshot_hash(payload, self.model, self.prompt_version)
        prompt = build_prompt(payload)
        t0 = time.monotonic()
        resp = self.client.complete(prompt, max_tokens=self.max_tokens)
        latency_ms = int((time.monotonic() - t0) * 1000)
        if isinstance(resp, dict) and resp.get("snapshot_hash") and resp["snapshot_hash"] != h:
            raise LLMAdvisorError(ERROR_STALE, f"{resp['snapshot_hash']} != {h}")
        advices = parse_advices(resp.get("content"))
        meta = {"snapshot_hash": h, "latency_ms": latency_ms,
                "input_tokens": int(resp.get("input_tokens") or max(1, len(prompt) // 4)),
                "output_tokens": int(resp.get("output_tokens") or 0)}
        return advices, meta


class ShadowRunner:
    """影子运行器：TemplateAdvisor 为权威结果，LLM 只做影子对照并落盘 evals。"""

    def __init__(self, eval_base: Path | str, advisor: LLMAdvisor | None = None):
        self.eval_base = Path(eval_base)
        self.advisor = advisor

    def _cache_path(self, tenant, company, date, h) -> Path:
        return _safe_eval_dir(self.eval_base, tenant, company, date) / f"{h}.json"

    def run(self, snapshot, template_advices, *, force=False) -> dict:
        """跑影子对照。返回 ShadowRecord dict；同时写 evals。绝不修改 TemplateAdvisor 结果。"""
        payload = bounded_input(snapshot, template_advices)
        model = self.advisor.model if self.advisor else DEFAULT_MODEL
        pv = self.advisor.prompt_version if self.advisor else PROMPT_VERSION
        h = snapshot_hash(payload, model, pv)

        rec = ShadowRecord(snapshot_hash=h, model=model, prompt_version=pv,
                           ok=False, fallback=True,
                           template_order=_order(template_advices))

        cache_path = self._cache_path(snapshot.tenant, snapshot.company, snapshot.date, h)
        if cache_path.exists() and not force:
            try:
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                cached["cached"] = True
                return cached
            except (OSError, ValueError):
                pass

        if self.advisor is None:
            rec.fallback_reason = "no_advisor"
            rec.parse_status = "skipped"
            _atomic_write_json(cache_path, rec.to_dict())
            return rec.to_dict()

        try:
            advices, meta = self.advisor.advise(snapshot, template_advices)
        except LLMAdvisorError as e:
            rec.fallback_reason = e.kind
            rec.parse_status = e.kind
            rec.note = e.detail
            _atomic_write_json(cache_path, rec.to_dict())
            return rec.to_dict()
        except Exception as e:  # noqa: BLE001
            rec.fallback_reason = ERROR_UNKNOWN
            rec.parse_status = ERROR_UNKNOWN
            rec.note = f"{type(e).__name__}: {e}"
            _atomic_write_json(cache_path, rec.to_dict())
            return rec.to_dict()

        rec.latency_ms = meta["latency_ms"]
        rec.input_tokens = meta["input_tokens"]
        rec.output_tokens = meta["output_tokens"]
        rec.parse_status = "ok"

        # 需求 6：Guard + 未授权 proposal 强制
        ctx = _guard_context(snapshot, template_advices)
        violations: list[dict] = []
        for a in advices:
            for v in validate_llm_advice(a, ctx):
                violations.append({"guard": v.guard, "rule": v.rule, "detail": v.detail})
        rec.guard_violations = violations
        rec.llm_order = _order(advices)
        rec.order_diff = _order_diff(rec.template_order, rec.llm_order)

        if violations:
            rec.fallback = True
            rec.fallback_reason = ERROR_GUARD
            rec.advices = [serialize_advice(a) for a in advices]
            _atomic_write_json(cache_path, rec.to_dict())
            return rec.to_dict()

        rec.ok = True
        rec.fallback = False
        rec.advices = [serialize_advice(a) for a in advices]
        _atomic_write_json(cache_path, rec.to_dict())
        return rec.to_dict()


def snapshot_from_plan(plan: dict, *, tenant: str, company: str, report_type: str, date: str,
                       tz: str, as_of: str, exhibition_stage: str | None = None,
                       company_goals=(), preferences: dict | None = None):
    """从 plan 构造 AdvisorSnapshot（只读，不改 plan/Provider）。"""
    from dc_daily_brief import BriefItem, CompletionRule, EvidenceRef, FactRef, TargetRef

    def _item(d: dict) -> BriefItem:
        cr = d.get("completion_rule")
        return BriefItem(
            item_key=d["item_key"], kind=d["kind"], dedupe_key=d["dedupe_key"],
            source=d["source"], scope=d["scope"], category=d["category"],
            priority=d["priority"], title=d["title"],
            reason_facts=[FactRef(**f) for f in d.get("reason_facts", [])],
            reason=d["reason"],
            target_refs=[TargetRef(**t) for t in d.get("target_refs", [])],
            evidence_refs=[EvidenceRef(**e) for e in d.get("evidence_refs", [])],
            due_at=d.get("due_at"), detail=d.get("detail") or {},
            completion_rule=CompletionRule(**cr) if cr else None,
            action_key=d.get("action_key"), policy_version=d.get("policy_version"))

    candidates = tuple(_item(d) for d in plan.get("actions", []))
    return build_snapshot(tenant=tenant, company=company, report_type=report_type, date=date,
                          tz=tz, as_of=as_of, exhibition_stage=exhibition_stage,
                          company_goals=tuple(company_goals),
                          preferences=preferences or {}, candidates=candidates)


def run_shadow_for_plan(plan: dict, *, tenant: str, company: str, date: str, tz: str,
                        as_of: str, exhibition_stage: str | None, preferences: dict,
                        advisor: LLMAdvisor | None, eval_base: Path | str,
                        template_advices) -> dict:
    """从 plan 构造 AdvisorSnapshot → 跑影子。仅读 plan，不改任何 Provider/plan。"""
    snap = snapshot_from_plan(plan, tenant=tenant, company=company, report_type="morning",
                              date=date, tz=tz, as_of=as_of,
                              exhibition_stage=exhibition_stage, preferences=preferences)
    runner = ShadowRunner(eval_base=eval_base, advisor=advisor)
    return runner.run(snap, template_advices)


if __name__ == "__main__":
    import argparse
    print("dc_llm_advisor: 影子模式；请用 sidecar 脚本或测试驱动（不接生产早晚报）。")
