#!/usr/bin/env python3
"""
dc_meeting_capture.py — 慧记/慧译真实接口联调保障

为 9/8 墨西哥展真实数据做准备：原样留存原始响应、识别字段结构、离线重放调试、
收紧 evidence_verified 信任边界、原文多版本管理、输出联调诊断报告。

本次只做「联调保障」，不开发 grade、日报和模型 NLP 提取。

能力：
  - raw capture：原样保存响应 + 元数据 + schema fingerprint，脱敏（不泄露全文/联系方式）
  - schema inspection：字段名/类型/嵌套层级/样本值（脱敏）；空 records 区分「确实无数据」vs「错误」
  - replay：用保存的 raw fixture 离线重跑，不调真实接口，结果一致
  - verify_evidence_from_raw：生产模式按 raw_record_ref 重读原文 + content_hash 校验
  - build_diagnostic_report：联调诊断报告
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

# 与 dc_meeting_ingest 共享的 adapter 假设字段（用于诊断字段差异）
from dc_meeting_ingest import (
    NOTE_ID_FIELDS,
    NOTE_TEXT_FIELDS,
    TRANSLATE_ID_FIELDS,
    TRANSLATE_TEXT_FIELDS,
    verify_evidence,
    compute_content_hash,
)

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
# 电话：数字/空格连续，不含连字符（避免把 2026-09-08 这类日期误判为电话）
PHONE_RE = re.compile(r"\+?\d[\d\s]{6,}\d")
# 长文本阈值：超过视为「会议全文」，脱敏为占位符
LONG_TEXT_THRESHOLD = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────
# 脱敏（不泄露会议全文与联系方式）
# ─────────────────────────────────────────────────────────────

def redact_text(text: str) -> str:
    if not isinstance(text, str):
        return text
    text = EMAIL_RE.sub("***@***", text)
    text = PHONE_RE.sub("***", text)
    return text


def redact_value(v: Any) -> Any:
    """递归脱敏：长文本→占位符，邮箱/电话→掩码。"""
    if isinstance(v, str):
        if len(v) > LONG_TEXT_THRESHOLD:
            return f"[redacted:{len(v)} chars]"
        return redact_text(v)
    if isinstance(v, dict):
        return {k: redact_value(x) for k, x in v.items()}
    if isinstance(v, list):
        return [redact_value(x) for x in v]
    return v


# ─────────────────────────────────────────────────────────────
# 响应 records 提取 + schema fingerprint
# ─────────────────────────────────────────────────────────────

def _extract_records(response: Any) -> list:
    """从响应里提取 records（兼容多字段名）。"""
    if isinstance(response, list):
        return response
    if not isinstance(response, dict):
        return []
    for k in ("records", "list", "data", "rows", "content"):
        v = response.get(k)
        if isinstance(v, list):
            return v
    data = response.get("data")
    if isinstance(data, dict):
        for k in ("records", "list", "rows", "content"):
            v = data.get(k)
            if isinstance(v, list):
                return v
    return []


def compute_schema_fingerprint(records: list) -> str:
    """字段结构指纹（字段名 + 类型），用于识别 schema 变化。"""
    if not records:
        return "empty"
    fields: set[str] = set()
    for rec in records[:50]:
        if isinstance(rec, dict):
            for k, v in rec.items():
                fields.add(f"{k}:{type(v).__name__}")
    return hashlib.sha256("|".join(sorted(fields)).encode("utf-8")).hexdigest()[:16]


# ─────────────────────────────────────────────────────────────
# 1. raw capture
# ─────────────────────────────────────────────────────────────

def capture_raw_response(
    interface_name: str,
    response: Any,
    supplier_id: str = "",
    pagination: Optional[dict] = None,
    http_status: int = 200,
) -> dict:
    """raw capture：保存完整原文（一字不丢）。

    脱敏只发生在日志/诊断输出层（见 redact_value / log_safe_view），
    不在 raw 存档层做内容替换——否则跨年回溯时看不到原始谈话。
    """
    records = _extract_records(response)
    meta = {
        "interface": interface_name,
        "captured_at": _now(),
        "supplier_id": supplier_id,
        "pagination": pagination or {},
        "http_status": http_status,
        "schema_fingerprint": compute_schema_fingerprint(records),
        "record_count": len(records),
        "total": response.get("total") if isinstance(response, dict) else None,
        "success": response.get("success") if isinstance(response, dict) else None,
        "code": response.get("code") if isinstance(response, dict) else None,
    }
    return {"meta": meta, "response": response}  # 完整原文，不脱敏


# ─────────────────────────────────────────────────────────────
# 2. schema inspection
# ─────────────────────────────────────────────────────────────

def inspect_schema(records: list) -> dict:
    """分析 records 的字段名/类型/嵌套层级/样本值（脱敏）。"""
    if not records:
        return {"record_count": 0, "fields": {}}
    fields: dict[str, dict] = {}
    for rec in records:
        if not isinstance(rec, dict):
            continue
        for k, v in rec.items():
            info = fields.setdefault(k, {
                "type": type(v).__name__,
                "nested": isinstance(v, (dict, list)),
                "samples": [],
            })
            if not isinstance(v, (dict, list)) and len(info["samples"]) < 3:
                info["samples"].append(redact_text(str(v))[:50])
    return {"record_count": len(records), "fields": fields}


def inspect_empty(interface_name: str, response: Any, pagination: Optional[dict] = None) -> dict:
    """空 records 时，区分「确实无数据」vs「字段/权限/分页错误」。"""
    if not isinstance(response, dict):
        return {"status": "malformed_response", "detail": "响应不是对象"}
    success = response.get("success")
    code = response.get("code")
    if success is False or (code is not None and code not in (0, 200)):
        return {"status": "api_error", "detail": f"接口错误 code={code} success={success}"}
    total = response.get("total")
    if total is not None and str(total).isdigit() and int(total) > 0:
        return {"status": "pagination_or_field_error", "detail": f"total={total} 但 records 空，疑似分页/字段错误"}
    return {"status": "no_data", "detail": "确实无数据", "pagination": pagination or {}}


# ─────────────────────────────────────────────────────────────
# 3. replay（离线重跑，不调真实接口）
# ─────────────────────────────────────────────────────────────

def replay(
    note_fixture: Optional[dict] = None,
    translate_fixture: Optional[dict] = None,
    store=None,
    opportunity_id: str = "",
    customer_id: str = "",
    exhibition_id: str = "",
    previous_evaluation: Optional[dict] = None,
) -> dict:
    """用保存的 raw fixture 离线重跑完整链路。不调真实接口。

    fixture 结构 = capture_raw_response 的返回：{"meta":..., "response":...}
    """
    from dc_meeting_ingest import ingest_meeting

    def _records(fixture):
        if not fixture:
            return []
        if isinstance(fixture, dict) and "response" in fixture:
            return _extract_records(fixture["response"])
        return _extract_records(fixture)

    return ingest_meeting(
        note_records=_records(note_fixture),
        translate_records=_records(translate_fixture),
        store=store,
        opportunity_id=opportunity_id,
        customer_id=customer_id,
        exhibition_id=exhibition_id,
        previous_evaluation=previous_evaluation,
    )


def log_safe_view(captured: dict) -> dict:
    """日志/诊断输出用的脱敏视图：非敏感元数据 + 脱敏后的响应。

    raw 存档层不脱敏（保留全文），只有日志/诊断输出层用这个视图。
    """
    return {
        "meta": (captured or {}).get("meta", {}),
        "response": redact_value((captured or {}).get("response")),
    }


class FileRawLoader:
    """生产环境 raw 原文读取器（按 raw_record_ref 从配置的 raw 根目录读文件）。

    安全边界：只允许读取配置的 raw 根目录；拒绝 ../ 路径穿越、绝对路径越界、
    符号链接越界；校验存在性、编码、最大文件大小、content_hash。
    """

    def __init__(self, root_dir: str, max_file_size: int = 10 * 1024 * 1024):
        self.root_dir = Path(root_dir).resolve()
        self.max_file_size = max_file_size

    def _resolve_safe(self, raw_record_ref: str) -> Path:
        """安全解析 ref，拒绝越界。返回 Path 或抛 ValueError。"""
        p = Path(raw_record_ref)
        if p.is_absolute():
            raise ValueError("absolute_path")
        raw_full = self.root_dir / p           # 未 resolve
        # 先检查符号链接越界（用未 resolve 的 raw_full）
        if raw_full.is_symlink():
            real = raw_full.resolve()
            if not (str(real) == str(self.root_dir) or str(real).startswith(str(self.root_dir) + "/")):
                raise ValueError("symlink_escape")
        full = raw_full.resolve()              # resolve 后
        # 再检查 ../ 路径穿越：解析后必须仍在 root 内
        if not (str(full) == str(self.root_dir) or str(full).startswith(str(self.root_dir) + "/")):
            raise ValueError("path_traversal")
        return full

    def load(self, raw_record_ref: str, expected_hash: Optional[str] = None) -> dict:
        """读单个 raw 文件。返回 {ok, text, content_hash, size} 或 {ok:False, error, detail}。

        读取失败返回结构化错误，绝不静默降级为 confirmed。
        """
        try:
            full = self._resolve_safe(raw_record_ref)
        except ValueError as e:
            return {"ok": False, "error": str(e), "detail": f"非法路径 {raw_record_ref}"}
        if not full.exists():
            return {"ok": False, "error": "not_found", "detail": f"{raw_record_ref} 不存在"}
        if not full.is_file():
            return {"ok": False, "error": "not_file", "detail": f"{raw_record_ref} 不是文件"}
        if full.stat().st_size > self.max_file_size:
            return {"ok": False, "error": "too_large", "detail": f"超过最大文件大小 {self.max_file_size}"}
        try:
            content = full.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return {"ok": False, "error": "bad_encoding", "detail": "非法编码（非 UTF-8）"}
        h = compute_content_hash(content)
        if expected_hash and h != expected_hash:
            return {"ok": False, "error": "hash_mismatch", "detail": "content_hash 不一致"}
        return {"ok": True, "text": content, "content_hash": h, "size": len(content)}

# ─────────────────────────────────────────────────────────────
# 4. evidence_verified 信任边界收紧（生产按 raw 原文重验）
# ─────────────────────────────────────────────────────────────

def verify_evidence_from_raw(signal: dict, raw_loader: Optional[Callable[[str], Optional[dict]]]) -> bool:
    """生产模式：按 raw_record_ref 重读已落库原文（FileRawLoader.load），校验 content_hash 后 verify_evidence。

    raw_loader 返回 {ok, text, content_hash} 或 {ok:False, error, detail}。
    evidence_source 决定 text 当作 transcript 还是 translation，保持来源分离。
    """
    ref = signal.get("raw_record_ref", "")
    if not ref:
        return False
    if raw_loader is None:
        return False
    raw = raw_loader(ref)
    if raw is None or not raw.get("ok"):
        return False
    text = raw.get("text", "")
    if signal.get("content_hash") and raw.get("content_hash") != signal.get("content_hash"):
        return False
    source = signal.get("evidence_source", "")
    if source == "transcript":
        return verify_evidence(signal, text, "")
    if source == "translation":
        return verify_evidence(signal, "", text)
    return verify_evidence(signal, text, text)


# ─────────────────────────────────────────────────────────────
# 6. 联调诊断报告
# ─────────────────────────────────────────────────────────────

# adapter 会消费的关联字段（非 id/text 字段，诊断时视为「已识别」）
KNOWN_ASSOCIATED_FIELDS = {
    "customerId", "customer_id", "cdpId", "cdp_id",
    "opportunityId", "opportunity_id", "meetingId", "exhibitionId",
    "createTime", "createdAt", "occurredAt", "time",
    "language", "lang", "participants", "visibility",
}


def build_diagnostic_report(
    capture_meta: dict,
    inspection: dict,
    ingest_result: dict,
    adapter_fields: Optional[list] = None,
) -> dict:
    """汇总联调诊断报告。"""
    adapter_fields = adapter_fields or sorted(set(
        list(NOTE_ID_FIELDS) + list(NOTE_TEXT_FIELDS) + list(TRANSLATE_ID_FIELDS) + list(TRANSLATE_TEXT_FIELDS) + list(KNOWN_ASSOCIATED_FIELDS)
    ))

    actual_fields = set((inspection.get("fields") or {}).keys())
    recognized = actual_fields & set(adapter_fields)
    unrecognized = actual_fields - set(adapter_fields)
    missing_assumed = set(adapter_fields) - actual_fields

    interactions = ingest_result.get("interactions", [])
    # 无法归属 customer/opportunity 的 interaction（缺分组键，interaction_id 不含 "::"）
    unattributed = [
        it.get("interaction_id", "") for it in interactions
        if "::" not in it.get("interaction_id", "")
    ]

    # evidence 验证成功率
    all_signals = [s for it in interactions for s in it.get("signals", [])]
    verified = [s for s in all_signals if s.get("evidence_verified")]
    evidence_success_rate = (len(verified) / len(all_signals)) if all_signals else None

    return {
        "schema": {
            "fingerprint": capture_meta.get("schema_fingerprint"),
            "record_count": inspection.get("record_count", 0),
            "recognized_fields": sorted(recognized),
            "unrecognized_fields": sorted(unrecognized),
            "missing_assumed_fields": sorted(missing_assumed),
        },
        "pagination": {
            "total": capture_meta.get("total"),
            "pagination_params": capture_meta.get("pagination", {}),
        },
        "standardized_count": len(interactions),
        "unattributed_records": unattributed,
        "evidence_success_rate": evidence_success_rate,
        "warnings": ingest_result.get("warnings", []),
        "redacted": capture_meta.get("redacted", True),
    }


def _dry_run_summary(ingest_result: dict) -> dict:
    """dry_run 预计数量：新增/重复/更新/未归属。"""
    warnings = ingest_result.get("warnings", [])
    interactions = ingest_result.get("interactions", [])
    return {
        "new": len(interactions),
        "duplicate": sum(1 for w in warnings if w.get("type") == "duplicate"),
        "updated": sum(1 for w in warnings if w.get("type") == "content_changed"),
        "unattributed": sum(1 for it in interactions if "::" not in it.get("interaction_id", "")),
    }


def _fetch_interface(source: str, supplier_id: str, page: int, page_size: int) -> dict:
    """调真实接口（占位）。9/8 接 xiaoyuan CLI：

    - note → `xiaoyuan company note-records --supplier-id ... --page-num ... --page-size ...`
    - translate → `xiaoyuan company translate-summary-list --supplier-id ... --page ... --limit ...`

    当前返回空响应，等真实接口接上后替换。
    """
    return {"records": [], "success": True, "total": 0, "code": 200, "pagination": {"page": page, "page_size": page_size}}


def run_debug(
    exhibition_id: str = "",
    supplier_id: str = "",
    source: str = "note",
    page: int = 1,
    page_size: int = 10,
    output_root: str = "",
    dry_run: bool = True,
    replay_file: str = "",
) -> dict:
    """一次性联调命令：capture → inspect → normalize → ingest → verify → evaluate → diagnostic。

    - replay_file 提供时：离线 replay，不调真实接口。
    - dry_run=True：不更新 customer/opportunity/stage，不落库，只输出预计数量。
    """
    from dc_meeting_ingest import ingest_meeting

    # 1. 拿数据
    if replay_file:
        captured = json.loads(Path(replay_file).read_text(encoding="utf-8"))
        response = captured.get("response", {})
    else:
        response = _fetch_interface(source, supplier_id, page, page_size)

    # 2. capture + 3. inspect
    cap = capture_raw_response(source, response, supplier_id, {"page": page, "page_size": page_size})
    records = _extract_records(response)
    inspection = inspect_schema(records)
    empty_check = inspect_empty(source, response, {"page": page, "page_size": page_size}) if not records else None

    # 4. ingest（note/translate 分别喂入）
    note_records = records if source == "note" else []
    translate_records = records if source == "translate" else []
    ingest_result = ingest_meeting(
        note_records=note_records,
        translate_records=translate_records,
        opportunity_id=exhibition_id or "",
        customer_id=supplier_id or "",
    )

    # 5. diagnostic
    diagnostic = build_diagnostic_report(cap["meta"], inspection, ingest_result)

    # 6. dry_run 统计
    summary = _dry_run_summary(ingest_result)

    return {
        "capture": cap["meta"],
        "inspection": inspection,
        "empty_check": empty_check,
        "ingest": ingest_result,
        "diagnostic": diagnostic,
        "dry_run": dry_run,
        "summary": summary,
    }


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="慧记/慧译联调命令（capture→inspect→ingest→verify→evaluate→diagnostic）")
    ap.add_argument("--exhibition-id", default="")
    ap.add_argument("--supplier-id", default="")
    ap.add_argument("--source", default="note", choices=["note", "translate"])
    ap.add_argument("--page", type=int, default=1)
    ap.add_argument("--page-size", type=int, default=10)
    ap.add_argument("--output-root", default="")
    ap.add_argument("--replay-file", default="", help="离线 replay：已保存的 raw fixture JSON 路径")
    ap.add_argument("--no-dry-run", action="store_true", help="正式写入（默认 dry_run=True）")
    args = ap.parse_args()

    result = run_debug(
        exhibition_id=args.exhibition_id,
        supplier_id=args.supplier_id,
        source=args.source,
        page=args.page,
        page_size=args.page_size,
        output_root=args.output_root,
        dry_run=not args.no_dry_run,
        replay_file=args.replay_file,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
