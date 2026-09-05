#!/usr/bin/env python3
"""
dc_meeting_ingest.py — 展会会议数据标准化入库 + signals 提取链路

把慧记 note-records / 慧译 translate-summary-list 的真实或模拟响应，转换为
exhibition memory 的 raw record、interaction 和 canonical signals，并调用
dc_opportunity_stage.evaluate_stage() 得阶段建议。

数据流：
  慧记/慧译响应 → 原文存档(raw, 不可变) → interaction 标准化(幂等) → signals 提取
  → evidence 原文核验 → evaluate_stage()

核心约定：
  - 原文先存档再做任何提取；transcript（慧记）与 translation（慧译）分开，不覆盖、不拼接。
  - 幂等键 = source + source_record_id；content_hash 变化时旧 signals 标 stale，重新提取，不删除旧信号。
  - evidence_text 必须能在 evidence_source（transcript|translation）指定的原文中定位；定位不到 → suggested。
  - 不修改 raw_record 原文；本模块不直接写文件（store 抽象，生产接文件/DB，测试用内存）。
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any, Optional

EXTRACTOR_VERSION = "1.0.0"

# 慧记 / 慧译 响应字段映射（多字段名兜底，真实字段待联调校准）
NOTE_ID_FIELDS = ("id", "noteId", "recordId", "note_id", "record_id")
NOTE_TEXT_FIELDS = ("text", "content", "summary", "transcript", "note")
TRANSLATE_ID_FIELDS = ("id", "translateId", "summaryId", "recordId", "record_id")
TRANSLATE_TEXT_FIELDS = ("text", "content", "translation", "summary")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pick(record: dict, fields: tuple, default: str = "") -> str:
    """从 record 里取第一个非空字段值（字段名兜底）。"""
    for f in fields:
        v = record.get(f)
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    return default


def compute_content_hash(text: str) -> str:
    """原文内容哈希，合并去重 / 变化判断用。"""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


# ─────────────────────────────────────────────────────────────
# 1. 慧记/慧译响应标准化 adapter（→ raw record，原文不可变）
# ─────────────────────────────────────────────────────────────

def normalize_note_record(
    record: dict,
    opportunity_id: str = "",
    customer_id: str = "",
    exhibition_id: str = "",
    synced_at: str = "",
) -> dict:
    """慧记 note-records 单条 → raw transcript record。"""
    text = _pick(record, NOTE_TEXT_FIELDS)
    return {
        "source": "note",                        # 慧记
        "source_record_id": _pick(record, NOTE_ID_FIELDS),
        "kind": "transcript",
        "text": text,
        "content_hash": compute_content_hash(text),
        "occurred_at": _pick(record, ("createTime", "createdAt", "occurredAt", "time")),
        "synced_at": synced_at or _now(),
        "language": _pick(record, ("language", "lang")),
        "source_system": "慧记",
        "customer_id": customer_id or _pick(record, ("customerId", "customer_id", "cdpId")),
        "opportunity_id": opportunity_id or _pick(record, ("opportunityId", "opportunity_id", "meetingId", "exhibitionId")),
        "exhibition_id": exhibition_id,
        "participants": record.get("participants", ""),
        "visibility": record.get("visibility", "private"),
    }


def normalize_translate_record(
    record: dict,
    opportunity_id: str = "",
    customer_id: str = "",
    exhibition_id: str = "",
    synced_at: str = "",
) -> dict:
    """慧译 translate-summary-list 单条 → raw translation record。"""
    text = _pick(record, TRANSLATE_TEXT_FIELDS)
    return {
        "source": "translate",                   # 慧译
        "source_record_id": _pick(record, TRANSLATE_ID_FIELDS),
        "kind": "translation",
        "text": text,
        "content_hash": compute_content_hash(text),
        "occurred_at": _pick(record, ("createTime", "createdAt", "occurredAt", "time")),
        "synced_at": synced_at or _now(),
        "language": _pick(record, ("language", "lang")),
        "source_system": "慧译",
        "customer_id": customer_id or _pick(record, ("customerId", "customer_id", "cdpId")),
        "opportunity_id": opportunity_id or _pick(record, ("opportunityId", "opportunity_id", "meetingId", "exhibitionId")),
        "exhibition_id": exhibition_id,
        "participants": record.get("participants", ""),
        "visibility": record.get("visibility", "private"),
    }


# ─────────────────────────────────────────────────────────────
# 2. interaction 标准化（transcript + translation 合并，幂等）
# ─────────────────────────────────────────────────────────────

def build_interaction(
    transcript_raw: Optional[dict],
    translate_raw: Optional[dict],
    opportunity_id: str = "",
    customer_id: str = "",
    exhibition_id: str = "",
) -> dict:
    """合并 transcript + translation → 标准 interaction（不覆盖、不静默拼接原文）。"""
    transcript_raw = transcript_raw or {}
    translate_raw = translate_raw or {}

    occurred_at = (
        _pick(transcript_raw, ("occurred_at",))
        or _pick(translate_raw, ("occurred_at",))
    )

    # 幂等主键：customer + opportunity（同客户同商机归同一 interaction）
    key = f"{customer_id or transcript_raw.get('customer_id') or translate_raw.get('customer_id')}::{opportunity_id}"

    interaction = {
        "interaction_id": f"meeting:{key}" if (customer_id or opportunity_id) else "",
        "source": "meeting",
        "occurred_at": occurred_at,
        "contact_id": "",
        "summary": "",                            # 展示用，不作为硬证据
        "raw_record_ref": "",
        "transcript_ref": transcript_raw.get("source_record_id") and f"raw/meeting/{transcript_raw.get('source_record_id')}.txt" or "",
        "translation_ref": translate_raw.get("source_record_id") and f"raw/meeting/{translate_raw.get('source_record_id')}.txt" or "",
        "transcript": transcript_raw.get("text", ""),     # 慧记原文（内存态，落库走 raw ref）
        "translation": translate_raw.get("text", ""),     # 慧译原文（内存态）
        "signals": [],
    }
    return interaction


# ─────────────────────────────────────────────────────────────
# 3. evidence 原文定位校验
# ─────────────────────────────────────────────────────────────

def verify_evidence(signal: dict, transcript_text: str = "", translation_text: str = "") -> bool:
    """校验 signal 的 evidence_text 是否能在 evidence_source 指定的原文中定位。

    - evidence_source=transcript → 只在 transcript 原文里找。
    - evidence_source=translation → 只在 translation 原文里找。
    - 有 evidence_start/end → 切片必须精确等于 evidence_text。
    - 无 start/end → evidence_text 必须在原文中（find）。
    """
    evidence_text = (signal.get("evidence_text") or "").strip()
    if not evidence_text:
        return False

    source = signal.get("evidence_source", "")
    if source == "transcript":
        text = transcript_text or ""
    elif source == "translation":
        text = translation_text or ""
    else:
        return False

    start = signal.get("evidence_start")
    end = signal.get("evidence_end")
    if start is not None and end is not None:
        try:
            return text[start:end] == evidence_text
        except Exception:
            return False
    return evidence_text in text


def classify_signals(
    candidate_signals: list,
    transcript_text: str = "",
    translation_text: str = "",
) -> list:
    """对 candidate signals 做证据核验，标记 evidence_verified。

    - 先清除上游传入的 evidence_verified（防止伪造），只由本地 verify_evidence 重新计算。
    - evidence_verified=True → 可进入 confirmed 判断；False → 仅 suggested。
    """
    out = []
    for sig in candidate_signals or []:
        sig = {k: v for k, v in sig.items() if k != "evidence_verified"}  # 清除上游伪造
        verified = verify_evidence(sig, transcript_text, translation_text)
        out.append({**sig, "evidence_verified": verified})
    return out


# ─────────────────────────────────────────────────────────────
# 4. 简单规则信号提取（placeholder，真实 NLP 提取由模型做）
# ─────────────────────────────────────────────────────────────

# (正则, signal_type)
EXTRACTION_RULES = [
    (r"(?:需要|采购|要买|想买|interested in|need|want|sourcing)[^。！.!?]{0,30}(?:桌|椅|家具|table|chair|furniture|灯具|lighting|帐篷|遮阳)", "product_need"),
    (r"\d+\s*(?:套|个|件|张|pcs|sets|units|pieces)", "quantity"),
    (r"(?:报价|价格|quote|price|样品|sample|合同|contract|付款|payment)", "quote_request"),
    (r"(?:不需要|不要了|不感兴趣|not interested|no need|no longer need)", "deny_need"),
]


def extract_candidate_signals(
    text: str,
    evidence_source: str,
    source_record_id: str = "",
    extractor_version: str = EXTRACTOR_VERSION,
) -> list:
    """从原文（transcript/translation）用规则提取 candidate signals，带证据定位。

    只做可重算的规则匹配，作为「模型提取」的 placeholder。
    """
    signals: list = []
    if not text:
        return signals
    for pattern, stype in EXTRACTION_RULES:
        for m in re.finditer(pattern, text):
            ev = m.group(0)
            signals.append({
                "type": stype,
                "value": ev,
                "normalized_value": "",
                "evidence_text": ev,
                "evidence_source": evidence_source,
                "evidence_start": m.start(),
                "evidence_end": m.end(),
                "source_record_id": source_record_id,
                "confidence": 0.9,
                "origin": "agent_extracted",
                "extractor_version": extractor_version,
                "extracted_at": _now(),
            })
    return signals


# ─────────────────────────────────────────────────────────────
# 5. 幂等存储（内存实现，生产替换为文件/DB）
# ─────────────────────────────────────────────────────────────

class IngestStore:
    """raw record 幂等存储 + interaction 缓存。

    - raw 幂等键 = source + source_record_id；重复同步不重复生成 interaction。
    - 保留 signal 版本历史，重新提取不删除旧信号（标 stale）。
    """

    def __init__(self):
        self._raw: dict[str, dict] = {}
        self._raw_versions: dict[str, list] = {}   # key -> [raw versions]，不覆盖旧版本
        self._interactions: dict[str, dict] = {}
        self._signal_history: dict[str, list] = {}

    @staticmethod
    def raw_key(source: str, source_record_id: str) -> str:
        return f"{source}:{source_record_id}"

    def get_raw(self, source: str, source_record_id: str) -> Optional[dict]:
        return self._raw.get(self.raw_key(source, source_record_id))

    def put_raw(self, raw: dict) -> Optional[dict]:
        """存档 raw：追加版本（不覆盖旧 raw），返回旧最新版（若存在）。"""
        key = self.raw_key(raw.get("source", ""), raw.get("source_record_id", ""))
        prev = self._raw.get(key)
        self._raw_versions.setdefault(key, []).append(raw)  # 追加版本
        self._raw[key] = raw                                # 更新 latest
        return prev

    def raw_versions(self, source: str, source_record_id: str) -> list:
        return self._raw_versions.get(self.raw_key(source, source_record_id), [])

    def get_interaction(self, key: str) -> Optional[dict]:
        return self._interactions.get(key)

    def put_interaction(self, key: str, interaction: dict) -> None:
        self._interactions[key] = interaction

    def mark_signals_stale(self, key: str, stale_signals: list) -> None:
        """把旧 signals 标 stale 存入历史，不删除。"""
        self._signal_history.setdefault(key, []).extend(
            {**s, "status": "stale"} for s in stale_signals
        )


# ─────────────────────────────────────────────────────────────
# 6. 编排入口
# ─────────────────────────────────────────────────────────────

def ingest_meeting(
    note_records: Optional[list] = None,
    translate_records: Optional[list] = None,
    store: Optional[IngestStore] = None,
    opportunity_id: str = "",
    customer_id: str = "",
    exhibition_id: str = "",
    previous_evaluation: Optional[dict] = None,
) -> dict:
    """编排：归一化 → 幂等存档 → interaction → signals 提取/核验 → evaluate_stage。

    返回：
      { raw_records, interactions, stage, warnings }
    """
    from dc_opportunity_stage import evaluate_stage

    store = store or IngestStore()
    note_records = [r for r in (note_records or []) if isinstance(r, dict)]
    translate_records = [r for r in (translate_records or []) if isinstance(r, dict)]

    warnings: list = []
    raw_records: list = []

    # 1. 归一化 + 幂等存档
    for rec in note_records:
        raw = normalize_note_record(rec, opportunity_id, customer_id, exhibition_id)
        prev = store.put_raw(raw)
        if prev and prev.get("content_hash") == raw["content_hash"]:
            warnings.append({"type": "duplicate", "source": "note", "source_record_id": raw["source_record_id"], "detail": "重复同步，跳过"})
        elif prev:
            warnings.append({"type": "content_changed", "source": "note", "source_record_id": raw["source_record_id"], "detail": "原文内容更新"})
        raw_records.append(raw)

    for rec in translate_records:
        raw = normalize_translate_record(rec, opportunity_id, customer_id, exhibition_id)
        prev = store.put_raw(raw)
        if prev and prev.get("content_hash") == raw["content_hash"]:
            warnings.append({"type": "duplicate", "source": "translate", "source_record_id": raw["source_record_id"], "detail": "重复同步，跳过"})
        elif prev:
            warnings.append({"type": "content_changed", "source": "translate", "source_record_id": raw["source_record_id"], "detail": "原文内容更新"})
        raw_records.append(raw)

    # 2. 按 (customer_id, opportunity_id) 分组（同客户同商机归同一 interaction）
    groups: dict[str, dict] = {}
    for raw in raw_records:
        gkey = f"{raw.get('customer_id','')}::{raw.get('opportunity_id','')}"
        groups.setdefault(gkey, {"transcript": None, "translation": None})
        if raw.get("kind") == "transcript":
            groups[gkey]["transcript"] = raw
        elif raw.get("kind") == "translation":
            groups[gkey]["translation"] = raw

    # 3. 每组生成 interaction + signals 提取/核验 + stage
    interactions: list = []
    stages: list = []
    for gkey, g in groups.items():
        transcript = g["transcript"]
        translation = g["translation"]
        g_opp = (transcript or {}).get("opportunity_id", "") or (translation or {}).get("opportunity_id", "")
        g_cust = (transcript or {}).get("customer_id", "") or (translation or {}).get("customer_id", "")
        interaction = build_interaction(transcript, translation, g_opp, g_cust, exhibition_id)

        all_signals: list = []
        if transcript and transcript.get("text"):
            all_signals += extract_candidate_signals(transcript["text"], "transcript", transcript["source_record_id"])
        if translation and translation.get("text"):
            all_signals += extract_candidate_signals(translation["text"], "translation", translation["source_record_id"])

        verified_signals = classify_signals(
            all_signals,
            transcript_text=(transcript or {}).get("text", ""),
            translation_text=(translation or {}).get("text", ""),
        )
        interaction["signals"] = verified_signals

        # 幂等：已有 interaction 且原文变化 → 旧 signals 标 stale，不删除
        ikey = interaction["interaction_id"]
        prev_interaction = store.get_interaction(ikey)
        if prev_interaction and prev_interaction.get("signals"):
            if any(w.get("type") == "content_changed" for w in warnings):
                store.mark_signals_stale(ikey, prev_interaction["signals"])
                interaction["signals"] = [{**s, "status": "stale"} for s in prev_interaction["signals"]] + verified_signals
                warnings.append({"type": "signals_stale", "interaction_id": ikey, "detail": "原文变化，旧 signals 标 stale，已重新提取"})

        store.put_interaction(ikey, interaction)
        interactions.append(interaction)

        stage = evaluate_stage(
            opportunity={},
            interactions=[interaction] if interaction.get("interaction_id") else [],
            previous_evaluation=previous_evaluation,
        )
        stages.append(stage)

    return {
        "raw_records": raw_records,
        "interactions": interactions,
        "stages": stages,
        "stage": stages[0] if stages else {},
        "warnings": warnings,
    }


if __name__ == "__main__":
    import argparse
    import json

    ap = argparse.ArgumentParser(description="会议数据入库 + signals 提取（调试用）")
    ap.add_argument("--note", default="[]", help="慧记 note-records JSON 数组")
    ap.add_argument("--translate", default="[]", help="慧译 translate-summary-list JSON 数组")
    ap.add_argument("--opportunity-id", default="")
    ap.add_argument("--customer-id", default="")
    args = ap.parse_args()

    result = ingest_meeting(
        json.loads(args.note),
        json.loads(args.translate),
        opportunity_id=args.opportunity_id,
        customer_id=args.customer_id,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
