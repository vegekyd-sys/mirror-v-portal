#!/usr/bin/env python3
"""find_buyers_v2.summarize — 模型输入摘要化 + fixture 脱敏（纯函数）。

两条链分开，不混用：
  - model_summary()：**给模型看**的摘要（生产用）。保留语义判断所需信号，
    砍掉对判断无用的体积（联系方式、内部 ID、深层嵌套）。
  - redact_for_fixture()：**给 replay/评测用**的脱敏行（白名单字段）。
    保留主营/行业/采购标签/买家类型/规模/展会关系；删除公司名/域名/联系人/内部ID。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

try:  # 稳定假名（本地 HMAC）；跨包复用，避免两套假名算法
    from cards.find_buyers_diag import candidate_id as _candidate_id
except Exception:  # pragma: no cover
    import hashlib
    import hmac
    import os

    def _candidate_id(company: str) -> str:
        salt = (os.environ.get("DC_DIAGNOSTIC_SALT") or "dealclaw-diag-v1").encode("utf-8")
        digest = hmac.new(salt, f"buyer:{company}".encode("utf-8"), hashlib.sha256).hexdigest()
        return f"buyer_{digest[:12]}"

FIXTURE_KEYS = ("candidate_id", "industry", "profile", "products", "buyer_type",
                "size", "exhibitions", "country", "score", "page", "position")

_CJK = re.compile(r"[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]")


def model_summary(norms: list[dict], *, profile_chars: int = 400,
                  max_products: int = 10) -> list[dict]:
    """语义判断阶段的模型输入：足够判断同行/采购角色/产品关系，不带联系方式与内部 ID。"""
    rows = []
    for n in norms:
        rows.append({
            "company": n.get("company", ""),
            "website": n.get("website", ""),
            "country": n.get("country", ""),
            "profile": (n.get("profile") or "")[:profile_chars],
            "products": (n.get("products") or [])[:max_products],
            "buyer_type": n.get("buyer_type", ""),
            "size": n.get("size", ""),
            "exhibitions": n.get("exhibitions") or [],
        })
    return rows


def estimate_tokens(obj) -> int:
    """粗估上界：CJK 1 token/字，其余约 4 字符/token。

    只是**对比用估计**，不是真实用量；真实 token 从运行时读取（读不到记 null）。
    """
    text = json.dumps(obj, ensure_ascii=False)
    cjk = len(_CJK.findall(text))
    other = len(text) - cjk
    return cjk + (other + 3) // 4


def redact_for_fixture(norms: list[dict]) -> list[dict]:
    """真实 semantic fixture 的脱敏行（白名单，含假名，不含公司名/域名/联系人/内部ID）。"""
    out = []
    for n in norms:
        full = {
            "candidate_id": _candidate_id(n.get("company") or ""),
            "industry": n.get("industry") or "",
            "profile": n.get("profile") or "",
            "products": n.get("products") or [],
            "buyer_type": n.get("buyer_type") or "",
            "size": n.get("size") or "",
            "exhibitions": n.get("exhibitions") or [],
            "country": n.get("country") or "",
            "score": n.get("score"),
            "page": n.get("page"),
            "position": n.get("position"),
        }
        out.append({k: v for k, v in full.items() if k in FIXTURE_KEYS})
    return out
