#!/usr/bin/env python3
"""DC-Chain-Reconcile — 触达 → Memory interaction → 飞书沟通明细 **只读**完整性对账

问题：一条触达（邮件/展会互动）在链路上要过三跳，
```
  触达（email_followup.emails[]，一行一次互动）
    → Memory interaction（interactions.json，沟通明细权威层）
      → 飞书「沟通明细」子表（一行一次互动，运营/客户看的那份）
```
任何一跳漏写，运营在飞书看到的沟通记录就比真实互动少，且**没有任何地方报错**。

本模块只做一件事：把三层的键对齐后，列出**三层缺失清单 + 反向孤儿项**，
每条给出可下钻的脱敏 id 与发生时间，供人工定点补数。

**只读保证**（设计约束，不是注释口号）：
  - 不写任何存储（不 mkdir、不落 json、不写 registry）；
  - 不调飞书任何接口（含只读接口）：飞书层只吃**离线快照/桩**
    （`--feishu-json`、或 memory 目录下的 `feishu_interactions_snapshot.json`）；
  - 不发送任何消息、不触发任何重试；
  - 飞书层拿不到数据时，该层判为 `unavailable` 并**明确说「无法判定」**，
    绝不把「查不到」当成「没问题」（不产生假 0 结论）。

对账口径（对齐 D5 验收：**未解释差异 = 0**，不要求新旧数字完全相同）：
  缺失清单里的每一条都必须是**可解释**的（能定位到具体 id 与时间），
  解释不了的计数不允许留下——`summary.unexplained_total` 就是这条口径的落点。

用法：
  python3 dc_chain_reconcile.py <company_id> [--json]
                                [--touch-json PATH] [--interaction-json PATH]
                                [--feishu-json PATH] [--memory-dir PATH]
  exit code: 0 = 没有缺失；1 = 有缺失；2 = 无法判定（飞书层不可用/入参错误）

样例（离线桩）见 tests/test_chain_reconcile.py 与 docs 汇报。
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from email_metrics.pseudonym import pseudonym  # noqa: E402

LAYER_TOUCH = "touch"
LAYER_INTERACTION = "interaction"
LAYER_FEISHU = "feishu"

STATUS_OK = "ok"
STATUS_EMPTY = "empty"
STATUS_MISSING = "missing_file"
STATUS_UNAVAILABLE = "unavailable"

MAX_ITEMS = 200            # 单个缺失清单上限，超出只报计数
SNAPSHOT_NAME = "feishu_interactions_snapshot.json"

# ── 差异归类（D2 验收口径：只允许这 7 类，不自创）────────────
CAT_MISSING_MEMORY = "缺失于Memory"
CAT_MISSING_FEISHU = "缺失于飞书"
CAT_DUPLICATE = "重复记录"
CAT_UNASSIGNED = "未归属"
CAT_PENDING_SYNC = "等待同步"
CAT_EXCLUDED = "按规则有意排除"
CAT_UNEXPLAINED = "未解释差异"

DIFF_CATEGORIES = (
    CAT_MISSING_MEMORY, CAT_MISSING_FEISHU, CAT_DUPLICATE,
    CAT_UNASSIGNED, CAT_PENDING_SYNC, CAT_EXCLUDED,
)
# 前四类是「未解释差异」（需要人处理）；后两类是解释得清的正常状态。
UNEXPLAINED_CATEGORIES = (
    CAT_MISSING_MEMORY, CAT_MISSING_FEISHU, CAT_DUPLICATE, CAT_UNASSIGNED,
)


def _normalize_watermark(source_watermark) -> dict:
    """把水位输入归一成 `{layer|'any': iso}`。None → 空（不做等待同步判定）。"""
    if not source_watermark:
        return {}
    if isinstance(source_watermark, str):
        return {"any": source_watermark}
    if isinstance(source_watermark, dict):
        return {str(k): str(v) for k, v in source_watermark.items() if v}
    return {}


def _parse_ts(value: str):
    """ISO 时间字符串 → UTC datetime；解析不了返回 None。

    不能直接用字符串比较：`_norm()` 会小写化，水位值未必小写，
    't' > 'T' 会让「水位已过」误判成「等待同步」（假阴性）。
    """
    s = str(value or "").strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _dup_findings(rows: list, key_fn, layer: str, *, note: str) -> list:
    """同一键出现多次 → 重复记录（附键与重复次数）。"""
    groups: dict[str, list] = {}
    for row in rows:
        k = key_fn(row)
        if k:
            groups.setdefault(k, []).append(row)
    out = []
    for k, group in groups.items():
        if len(group) > 1:
            item = _item(group[0], layer, note=note)
            item["key"] = k
            item["dup_count"] = len(group)
            out.append(item)
    return out

# 飞书「沟通明细」子表列名 → 本模块规范字段名
_FEISHU_FIELD_ALIASES = {
    "interaction_id": ("interaction_id", "互动ID"),
    "source_system": ("source_system", "来源系统"),
    "source_record_id": ("source_record_id", "来源记录ID"),
    "customer_id": ("customer_id", "客户ID"),
    "customer_display": ("customer_display", "客户", "客户名称"),
    "occurred_at": ("occurred_at", "时间"),
    "channel": ("channel", "渠道"),
    "direction": ("direction", "方向"),
    "subject": ("subject", "主题"),
    "thread_id": ("thread_id",),
}


def _norm(value) -> str:
    """键归一：去空白 + 小写（不改变语义，只消除脏空白/大小写）。"""
    return " ".join(str(value or "").split()).strip().lower()


def _ref_key(source_system, source_record_id) -> str:
    """来源定位键：`<source_system>|<source_record_id>`（空任一 → 空）。"""
    ss, srid = _norm(source_system), _norm(source_record_id)
    return f"{ss}|{srid}" if ss and srid else ""


def _masked(entry: dict) -> dict:
    """脱敏后的可下钻 id（HMAC 稳定假名，不含邮箱/正文/公司名明文）。"""
    out = {}
    for key, kind, value in (
            ("customer_id", "buyer", entry.get("customer_id")),
            ("source_record_id", "msg", entry.get("source_record_id")),
            ("interaction_id", "it", entry.get("interaction_id")),
            ("thread_id", "thread", entry.get("thread_id"))):
        masked = pseudonym(kind, value)
        if masked:
            out[key] = masked
    return out


def _item(entry: dict, layer: str, *, note: str = "") -> dict:
    """缺失/孤儿清单条目：脱敏下钻 id + 定位信息，不含正文。"""
    return {
        "layer": layer,
        "occurred_at": str(entry.get("occurred_at") or ""),
        "channel": str(entry.get("channel") or entry.get("source_system") or ""),
        "direction": str(entry.get("direction") or ""),
        "customer_display_present": bool(str(entry.get("customer_display") or "").strip()),
        "subject_present": bool(str(entry.get("subject") or "").strip()),
        "status": str(entry.get("status") or ""),
        "note": note,
        "drilldown": _masked(entry),
    }


# ── 读取（只读，绝不 mkdir / 绝不调飞书）────────────────
def memory_dir_for(company_id: str, memory_dir=None) -> Path:
    """memory 权威层目录（只读解析，不复用会 mkdir 的写路径）。"""
    if memory_dir is not None:
        return Path(memory_dir) / (company_id or "_global")
    from dc_memory_data import MEMORY_DATA_DIR, resolve_supplier_id
    return Path(MEMORY_DATA_DIR) / (resolve_supplier_id() or (company_id or "_global"))


def _read_json_list(path: Path) -> tuple[list, str]:
    """返回 (数据, 状态)。文件不存在 → missing_file（不伪造空成功）。"""
    if not path.exists():
        return [], STATUS_MISSING
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return [], f"unreadable:{type(e).__name__}"
    if not isinstance(data, list):
        return [], f"bad_shape:{type(data).__name__}"
    return data, (STATUS_OK if data else STATUS_EMPTY)


def _coerce_touches(data) -> list:
    """把输入归一成 touch 列表。

    接受两种形态：
      A. email_followup 行（含 `emails[]`）→ 展平成一行一次互动
      B. 已展平的 touch dict（含 source_system/source_record_id/customer_id/occurred_at）
    """
    from dc_memory_data import _customer_id
    out = []
    for row in data or []:
        if not isinstance(row, dict):
            continue
        emails = row.get("emails")
        if isinstance(emails, list):
            customer_id = row.get("company_cdp_id") or _customer_id(
                row.get("company_cdp_id"), row.get("company"), row.get("website"))
            for mail in emails:
                if not isinstance(mail, dict):
                    continue
                out.append({
                    "customer_id": customer_id,
                    "customer_display": row.get("company", ""),
                    "source_system": mail.get("source_system", "") or "email",
                    "source_record_id": mail.get("source_record_id", ""),
                    "interaction_id": "",
                    "occurred_at": mail.get("sent_at") or mail.get("occurred_at") or "",
                    "channel": "email",
                    "direction": {"out": "outbound", "in": "inbound"}.get(
                        str(mail.get("direction") or ""), str(mail.get("direction") or "")),
                    "subject": mail.get("subject", ""),
                    "thread_id": mail.get("thread_id", ""),
                    "status": mail.get("status", ""),
                })
            continue
        if any(row.get(k) for k in ("source_system", "source_record_id", "interaction_id")):
            out.append({k: row.get(k, "") for k in (
                "customer_id", "customer_display", "source_system", "source_record_id",
                "interaction_id", "occurred_at", "channel", "direction", "subject",
                "thread_id", "status")})
    return out


def _coerce_feishu_rows(data) -> list:
    """把离线快照归一成规范 dict 列表。

    接受三种形态：
      A. dict({"fields": [...], "rows": [[...]]})  ← `_build_interaction_rows` 的落盘形态
      B. 规范 dict 列表（interaction_id / source_system / ...）
      C. 飞书列名 dict 列表（互动ID / 来源系统 / ...）
    """
    def canon(d: dict) -> dict:
        out = {}
        for field, aliases in _FEISHU_FIELD_ALIASES.items():
            for alias in aliases:
                if alias in d:
                    out[field] = d[alias]
                    break
        return out

    if isinstance(data, dict) and isinstance(data.get("rows"), list):
        fields = [str(f) for f in (data.get("fields") or [])]
        return [canon(dict(zip(fields, row))) for row in data["rows"]
                if isinstance(row, list)]
    if isinstance(data, list):
        return [canon(x) for x in data if isinstance(x, dict)]
    return []


def _load_feishu_rows(company_id: str, *, feishu_rows=None, feishu_json=None,
                      memory_dir=None) -> tuple[list, str, str]:
    """飞书层数据（离线）：显式桩 > --feishu-json > memory 目录快照。绝不调飞书。"""
    if feishu_rows is not None:
        return _coerce_feishu_rows(feishu_rows), STATUS_OK, "injected"
    if feishu_json:
        path = Path(feishu_json)
        if not path.exists():
            return [], STATUS_UNAVAILABLE, f"snapshot_not_found:{path}"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            return [], STATUS_UNAVAILABLE, f"snapshot_unreadable:{type(e).__name__}"
        rows = _coerce_feishu_rows(data)
        return rows, (STATUS_OK if rows else STATUS_EMPTY), str(path)
    path = memory_dir_for(company_id, memory_dir) / SNAPSHOT_NAME
    if not path.exists():
        return [], STATUS_UNAVAILABLE, (
            f"no_offline_snapshot（未提供 --feishu-json，且 {path} 不存在）："
            "为避免假绿，本层不做判定")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        return [], STATUS_UNAVAILABLE, f"snapshot_unreadable:{type(e).__name__}"
    rows = _coerce_feishu_rows(data)
    return rows, (STATUS_OK if rows else STATUS_EMPTY), str(path)


# ── 对账 ────────────────────────────────────────────────
def reconcile_chain(company_id: str, *, touches=None, interactions=None,
                    feishu_rows=None, feishu_json=None, memory_dir=None,
                    source_watermark=None, as_of=None, exclude_rules=None) -> dict:
    """三层只读对账。返回报告 dict（`--json` 直接序列化这个）。

    `source_watermark`：上游已同步水位（`{layer: iso}` 或单个 iso）。
      **事件时间晚于水位 → 归「等待同步」，不算数据丢失**（避免把正常延迟误报成缺失）。
    `as_of`：判定时点（默认 now）。
    `exclude_rules`：按规则有意排除，形如 `{"channels": [...], "statuses": [...]}`；
      未显式给出规则时**不猜**，一律不进这一类。
    """
    root = memory_dir_for(company_id, memory_dir)
    layer_status: dict[str, dict] = {}

    if touches is None:
        raw, st = _read_json_list(root / "email_followup.json")
        touches = _coerce_touches(raw)
        layer_status[LAYER_TOUCH] = {"status": st, "source": str(root / "email_followup.json")}
    else:
        touches = _coerce_touches(touches)
        layer_status[LAYER_TOUCH] = {"status": STATUS_OK, "source": "injected"}

    if interactions is None:
        raw, st = _read_json_list(root / "interactions.json")
        interactions = [x for x in raw if isinstance(x, dict)]
        layer_status[LAYER_INTERACTION] = {"status": st,
                                           "source": str(root / "interactions.json")}
    else:
        interactions = [x for x in interactions if isinstance(x, dict)]
        layer_status[LAYER_INTERACTION] = {"status": STATUS_OK, "source": "injected"}

    feishu, feishu_status, feishu_source = _load_feishu_rows(
        company_id, feishu_rows=feishu_rows, feishu_json=feishu_json, memory_dir=memory_dir)
    layer_status[LAYER_FEISHU] = {"status": feishu_status, "source": feishu_source,
                                  "count": len(feishu)}
    for name, data in ((LAYER_TOUCH, touches), (LAYER_INTERACTION, interactions)):
        layer_status[name]["count"] = len(data)

    # 索引：来源定位键 / interaction_id / customer_id
    def key_index(rows, getter) -> dict:
        idx: dict[str, list] = {}
        for row in rows:
            k = getter(row)
            if k:
                idx.setdefault(k, []).append(row)
        return idx

    inter_by_ref = key_index(interactions, lambda r: _ref_key(r.get("source_system"),
                                                             r.get("source_record_id")))
    inter_by_iid = key_index(interactions, lambda r: _norm(r.get("interaction_id")))
    inter_by_cust = key_index(interactions, lambda r: _norm(r.get("customer_id")))
    touch_by_ref = key_index(touches, lambda r: _ref_key(r.get("source_system"),
                                                        r.get("source_record_id")))
    touch_by_cust = key_index(touches, lambda r: _norm(r.get("customer_id")))
    feishu_by_iid = key_index(feishu, lambda r: _norm(r.get("interaction_id")))
    feishu_by_ref = key_index(feishu, lambda r: _ref_key(r.get("source_system"),
                                                        r.get("source_record_id")))

    def cap(items: list) -> dict:
        return {"count": len(items), "truncated": len(items) > MAX_ITEMS,
                "items": items[:MAX_ITEMS]}

    # 跳 1：有触达但没有对应 interaction
    touch_without_interaction = []
    for t in touches:
        ref = _ref_key(t.get("source_system"), t.get("source_record_id"))
        if ref and ref in inter_by_ref:
            continue
        iid = _norm(t.get("interaction_id"))
        if iid and iid in inter_by_iid:
            continue
        # 兜底：同客户同渠道同时间也视为已进 interaction（避免键缺失时假阳性）
        cust = _norm(t.get("customer_id"))
        if cust and cust in inter_by_cust:
            pool = inter_by_cust[cust]
            if any(_norm(x.get("occurred_at")) == _norm(t.get("occurred_at")) for x in pool):
                continue
        touch_without_interaction.append(_item(
            t, LAYER_TOUCH, note="触达事件在 interactions.json 中找不到对应行（未展平/未同步）"))

    # 跳 2（及反向孤儿）：interaction 有没有进飞书沟通明细
    interaction_without_feishu: list = []
    feishu_without_interaction: list = []
    feishu_layer_usable = feishu_status in (STATUS_OK, STATUS_EMPTY)
    if feishu_layer_usable:
        matched_feishu: set[int] = set()
        for it in interactions:
            iid = _norm(it.get("interaction_id"))
            ref = _ref_key(it.get("source_system"), it.get("source_record_id"))
            hits = list(feishu_by_iid.get(iid, [])) if iid else []
            if not hits and ref:
                hits = list(feishu_by_ref.get(ref, []))
            if hits:
                for h in hits:
                    matched_feishu.add(id(h))
                continue
            interaction_without_feishu.append(_item(
                it, LAYER_INTERACTION,
                note="Memory interaction 未出现在飞书「沟通明细」快照（子表未同步/被清表）"))
        for row in feishu:
            if id(row) in matched_feishu:
                continue
            feishu_without_interaction.append(_item(
                row, LAYER_FEISHU,
                note="飞书「沟通明细」有行但 Memory 找不到对应 interaction（孤儿行）"))

    # 反向孤儿：有 interaction 但没有对应触达
    interaction_without_touch = []
    for it in interactions:
        ref = _ref_key(it.get("source_system"), it.get("source_record_id"))
        if ref and ref in touch_by_ref:
            continue
        cust = _norm(it.get("customer_id"))
        if cust and cust in touch_by_cust:
            continue
        interaction_without_touch.append(_item(
            it, LAYER_INTERACTION,
            note="interaction 无对应触达（非邮件来源，或触达源已被裁剪）"))

    # ── 差异归类（只允许 7 类；不自创类别）──────────────────────
    wm = _normalize_watermark(source_watermark)
    as_of_raw = as_of or datetime.now(timezone.utc).isoformat()
    as_of_dt = _parse_ts(as_of_raw)
    ex = exclude_rules or {}
    ex_channels = {_norm(x) for x in ex.get("channels", []) if _norm(x)}
    ex_statuses = {_norm(x) for x in ex.get("statuses", []) if _norm(x)}

    def _is_pending(entry: dict, layer: str) -> bool:
        """事件时间晚于上游水位 → 等待同步（正常延迟，不得算丢失）。

        按 datetime（带时区）比较；解析不了就**不声称等待同步**，
        宁可报真缺失，也不拿水位当挡箭牌。
        """
        w_raw = wm.get(layer) or wm.get("any") or ""
        w_dt, ts_dt = _parse_ts(w_raw), _parse_ts(entry.get("occurred_at"))
        if not (w_dt and ts_dt):
            return False
        if as_of_dt and as_of_dt < w_dt:
            return False   # as_of 还没到水位，不做等待同步判定
        return ts_dt > w_dt

    def _is_excluded(entry: dict) -> bool:
        """只认显式规则，不猜；没给规则就永远不进这一类。"""
        return bool((entry.get("channel") and _norm(entry.get("channel")) in ex_channels)
                    or (entry.get("status") and _norm(entry.get("status")) in ex_statuses)
                    or entry.get("excluded") is True)

    cat: dict[str, list] = {c: [] for c in DIFF_CATEGORIES}

    def _sig(item: dict) -> tuple:
        return (item.get("layer"), item.get("occurred_at"),
                json.dumps(item.get("drilldown") or {}, sort_keys=True, ensure_ascii=False))

    _seen_all: set = set()

    def _add(cat_name: str, item: dict) -> None:
        """每个事实只归一类：同一（层+时间+下钻键）已在任何类别出现过就不再重复计。"""
        s = _sig(item)
        if s in _seen_all:
            return
        _seen_all.add(s)
        cat[cat_name].append(item)

    # 分类优先级（每个事实只归一类，不重复计数）：
    #   未归属 → 重复记录 → 等待同步/缺失于Memory → 缺失于飞书
    # 理由：归属不明和重复展平是根因，先用它们定性，再用「缺在哪层」描述。
    for layer, rows in ((LAYER_TOUCH, touches), (LAYER_INTERACTION, interactions),
                        (LAYER_FEISHU, feishu)):
        for r in rows:
            if _norm(r.get("customer_id")):
                continue
            if _ref_key(r.get("source_system"), r.get("source_record_id")):
                continue
            if layer == LAYER_FEISHU and _norm(r.get("interaction_id")):
                continue
            _add(CAT_UNASSIGNED, _item(
                r, layer, note="既无 customer_id 也无来源定位键（无法归属）"))
    # 反向孤儿留到最后处理（见下）：先把「缺在哪一层」「重复展平」这些可行动信号定下来。
    # 重复记录：一条来源记录被展平多次 / 飞书同一 interaction 多行。
    # 注意「多对一」是允许的（慧记+慧译多条原始记录 → 一个 interaction），不进这一类。
    for _dup in _dup_findings(
            interactions, lambda r: _ref_key(r.get("source_system"), r.get("source_record_id")),
            LAYER_INTERACTION,
            note="同一来源记录产生多条 interaction（重复展平；多对一允许，重复展平不允许）"):
        _add(CAT_DUPLICATE, _dup)
    for _dup in _dup_findings(
            feishu, lambda r: _norm(r.get("interaction_id")), LAYER_FEISHU,
            note="同一 interaction_id 在飞书沟通明细出现多行（重复行）"):
        _add(CAT_DUPLICATE, _dup)
    for e in touch_without_interaction:
        _add(CAT_PENDING_SYNC if _is_pending(e, LAYER_TOUCH) else CAT_MISSING_MEMORY, e)
    for e in interaction_without_feishu:
        _add(CAT_PENDING_SYNC if _is_pending(e, LAYER_INTERACTION) else CAT_MISSING_FEISHU, e)
    for e in feishu_without_interaction:
        _add(CAT_MISSING_MEMORY, e)
    # 反向孤儿放到最后：它们往往是「已在 memory / 已缺于飞书」的同一批事实，
    # 不应把「缺失于飞书」这个真正可行动的信号盖掉。
    for e in interaction_without_touch:
        _add(CAT_UNASSIGNED, e)
    # 显式排除规则先于「未解释」：命中规则的挪到「按规则有意排除」
    for c in (CAT_MISSING_MEMORY, CAT_MISSING_FEISHU, CAT_DUPLICATE, CAT_UNASSIGNED):
        kept = []
        for e in cat[c]:
            (cat[CAT_EXCLUDED] if _is_excluded(e) else kept).append(e)
        cat[c] = kept
    unexplained_total = sum(len(cat[c]) for c in UNEXPLAINED_CATEGORIES)

    missing_total = len(touch_without_interaction) + len(interaction_without_feishu)
    orphan_total = len(interaction_without_touch) + len(feishu_without_interaction)
    report = {
        "object": "chain_reconciliation",
        "company_id": company_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "read_only": True,
        "sends_messages": False,
        "calls_feishu_api": False,
        "layers": layer_status,
        "missing": {
            "touch_without_interaction": cap(touch_without_interaction),
            "interaction_without_feishu": cap(interaction_without_feishu),
        },
        "orphans": {
            "interaction_without_touch": cap(interaction_without_touch),
            "feishu_without_interaction": cap(feishu_without_interaction),
        },
        "categories": {c: cap(cat[c]) for c in DIFF_CATEGORIES},
        "watermark": {"source": wm, "as_of": as_of_raw,
                       "note": "事件时间晚于水位 → 等待同步，不算丢失"},
        "summary": {
            "touch": len(touches),
            "interaction": len(interactions),
            "feishu": len(feishu),
            "touch_without_interaction": len(touch_without_interaction),
            "interaction_without_feishu": len(interaction_without_feishu),
            "interaction_without_touch": len(interaction_without_touch),
            "feishu_without_interaction": len(feishu_without_interaction),
            "missing_total": missing_total,
            "orphan_total": orphan_total,
            "unexplained_total": unexplained_total,
            "categories": {c: len(cat[c]) for c in DIFF_CATEGORIES},
            "unexplained_categories": list(UNEXPLAINED_CATEGORIES),
            "feishu_layer_judged": feishu_layer_usable,
            "feishu_layer_note": ("" if feishu_layer_usable
                                  else "飞书层不可用 → 跳 2 无法判定（不计入未解释差异）"),
        },
        "acceptance": {
            "caliber": "未解释差异 = 0（D5）：每条差异都必须能下钻定位；不要求新旧数字完全相同",
            "note": "第一周指标用已知异常发现率 / 问题可复现率 / 已确认代码 Bug 回归覆盖率",
        },
    }
    report["exit_code"] = (0 if (unexplained_total == 0 and feishu_layer_usable)
                           else (2 if not feishu_layer_usable else 1))
    return report


def render_text(report: dict) -> str:
    """人读渲染：三层计数 + 缺失/孤儿清单（脱敏下钻 id）。"""
    s = report["summary"]
    lines = [
        f"【链路只读对账】company={report['company_id']}  "
        f"(read_only={report['read_only']} · 调用飞书接口={report['calls_feishu_api']} · "
        f"发送消息={report['sends_messages']})",
        f"层计数：触达 {s['touch']} → interaction {s['interaction']} → 飞书沟通明细 {s['feishu']}",
    ]
    for name in (LAYER_TOUCH, LAYER_INTERACTION, LAYER_FEISHU):
        info = report["layers"][name]
        lines.append(f"  · {name}: status={info['status']} count={info.get('count', '-')} "
                     f"source={info.get('source', '')}")
    lines.append("缺失清单：")
    lines.append(f"  1) 有触达但没有 interaction：{s['touch_without_interaction']} 条")
    for it in report["missing"]["touch_without_interaction"]["items"]:
        lines.append(f"     - {it['occurred_at']} {it['channel']}/{it['direction']} "
                     f"drilldown={it['drilldown']}")
    lines.append(f"  2) 有 interaction 但没有进飞书明细：{s['interaction_without_feishu']} 条")
    for it in report["missing"]["interaction_without_feishu"]["items"]:
        lines.append(f"     - {it['occurred_at']} {it['channel']}/{it['direction']} "
                     f"drilldown={it['drilldown']}")
    if not s["feishu_layer_judged"]:
        lines.append(f"  ⚠ 飞书层无法判定：{s['feishu_layer_note']}")
    lines.append("反向孤儿：")
    lines.append(f"  3) 有 interaction 但没有触达：{s['interaction_without_touch']} 条")
    for it in report["orphans"]["interaction_without_touch"]["items"]:
        lines.append(f"     - {it['occurred_at']} {it['channel']}/{it['direction']} "
                     f"drilldown={it['drilldown']}")
    lines.append(f"  4) 飞书明细有行但无 interaction：{s['feishu_without_interaction']} 条")
    for it in report["orphans"]["feishu_without_interaction"]["items"]:
        lines.append(f"     - {it['occurred_at']} {it['channel']}/{it['direction']} "
                     f"drilldown={it['drilldown']}")
    lines.append("差异归类（只允许 7 类）：")
    for c in DIFF_CATEGORIES:
        lines.append(f"  · {c}: {s['categories'].get(c, 0)}")
    import json as _json  # noqa: PLC0415
    for c in DIFF_CATEGORIES:
        for it in report["categories"][c]["items"]:
            extra = (f" key={it['key']} dup={it['dup_count']}" if it.get("key") else "")
            lines.append(f"     - [{c}] {it.get('occurred_at', '')} "
                         f"{it.get('channel', '')}/{it.get('direction', '')}"
                         f" drilldown={it.get('drilldown', '')}{extra}")
    lines.append(f"未解释差异 = {s['unexplained_total']}（验收口径：= 0）；"
                 f"等待同步 {s['categories'].get(CAT_PENDING_SYNC, 0)} · "
                 f"有意排除 {s['categories'].get(CAT_EXCLUDED, 0)}；"
                 f"exit_code={report['exit_code']}")
    return "\n".join(lines)


def _read_json_file(path: str):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip().split("用法：")[-1].strip())
        return 2
    company_id = argv[0]
    flags = {"--json": False}
    for name in ("--touch-json", "--interaction-json", "--feishu-json", "--memory-dir",
                 "--source-watermark-json", "--as-of", "--exclude-json"):
        if name in argv:
            flags[name] = argv[argv.index(name) + 1]
    if "--json" in argv:
        flags["--json"] = True

    kwargs = {"memory_dir": flags.get("--memory-dir")}
    if flags.get("--touch-json"):
        kwargs["touches"] = _read_json_file(flags["--touch-json"])
    if flags.get("--interaction-json"):
        kwargs["interactions"] = _read_json_file(flags["--interaction-json"])
    if flags.get("--feishu-json"):
        kwargs["feishu_json"] = flags["--feishu-json"]
    if flags.get("--source-watermark-json"):
        kwargs["source_watermark"] = _read_json_file(flags["--source-watermark-json"])
    if flags.get("--exclude-json"):
        kwargs["exclude_rules"] = _read_json_file(flags["--exclude-json"])
    if flags.get("--as-of"):
        kwargs["as_of"] = flags["--as-of"]

    report = reconcile_chain(company_id, **kwargs)
    print(json.dumps(report, ensure_ascii=False, indent=2) if flags["--json"]
          else render_text(report))
    return int(report["exit_code"])


if __name__ == "__main__":
    sys.exit(main())
