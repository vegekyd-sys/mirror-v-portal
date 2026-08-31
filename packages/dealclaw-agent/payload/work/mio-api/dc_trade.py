#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dc_trade.py — 贸易宏观数据接口，供展会 planning 的「数据判断层」

已接入：
  comtradeGet          UN Comtrade 进出口额/贸易流（走 blade-agent-adapter，鉴权头同 CDP）
  getTagCollectionAli  datathink 类目标签（公开免鉴权），拿 tagId 供后续查同行

待接入（by-product-category 需 AppCode，田耕郡明天给）：
  by-product-category  datathink 按 tagId 查同行（阿里云网关，需 X-Ca-Key/APPCODE）

用法：
  python3 dc_trade.py comtrade --reporter 484 --cmd 6907 --flow M --period 2024 [--partner 0]
  python3 dc_trade.py snapshot --reporter 484 --cmd 6907 --period 2024    # 市场快照：总进口 + 分主要供应国
  python3 dc_trade.py tag --keyword 瓷砖                                   # 类目标签 → tagId
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"

# 主要供应国（UN M49 数字码），供竞争格局（供应国对比）
MAJOR_SUPPLIERS = [
    ("中国", "156"),
    ("印度", "356"),
    ("西班牙", "724"),
    ("意大利", "380"),
    ("越南", "704"),
    ("德国", "276"),
    ("美国", "842"),
]


def _load_env() -> None:
    try:
        from _tenant_env import load_tenant_env
        load_tenant_env()
    except ImportError:
        pass
    dirs = []
    d = os.path.dirname(os.path.abspath(__file__))
    while d and d != os.path.dirname(d):
        dirs.append(d)
        d = os.path.dirname(d)
    for d in dirs:
        f = os.path.join(d, ".env")
        if os.path.exists(f):
            with open(f, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        if k not in os.environ:
                            os.environ[k] = v.strip()


def env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    return v.strip() if v else default


def post_json(base_url: str, path: str, body, open_id: str, supplier_id: str,
              timeout: int = 60):
    url = base_url.rstrip("/") + path
    payload = b"null" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, method="POST", data=payload,
        headers={"Content-Type": "application/json; charset=utf-8",
                 "Accept": "application/json",
                 "X-Feishu-Open-Id": open_id.strip(),
                 "X-Supplier-Id": supplier_id.strip()},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        return {"success": False, "code": e.code, "msg": f"HTTP {e.code}",
                "data": None, "errorBody": e.read().decode("utf-8", errors="replace")[:500]}
    except urllib.error.URLError as e:
        return {"success": False, "code": -1, "msg": f"网络错误: {e.reason}", "data": None}


def comtrade_get(reporter_code: str, cmd_code: str, *, flow_code: str = "M",
                 period: str = "2024", partner_code: str = "0", freq_code: str = "A",
                 cl_code: str = "HS", type_code: str = "C") -> dict:
    """UN Comtrade 取数。返回 {success, total, records, raw}，total=primaryValue 求和。"""
    body = {
        "clCode": cl_code, "cmdCode": cmd_code, "flowCode": flow_code,
        "freqCode": freq_code, "partnerCode": partner_code, "period": period,
        "reporterCode": reporter_code, "typeCode": type_code,
    }
    resp = post_json(DEFAULT_BASE_URL, "/agent/trade/comtradeGet.json", body,
                     env("MIO_V_OPEN_ID"), env("MIO_CDP_SUPPLIER_ID"))
    records = (resp.get("data") or {}).get("data") or []
    total = sum(float(r.get("primaryValue") or 0) for r in records if isinstance(r, dict))
    return {"success": bool(resp.get("success") or resp.get("code") == 0 or resp.get("code") == 200),
            "total": total, "records": records, "raw": resp}


def market_snapshot(reporter_code: str, cmd_code: str, period: str = "2024") -> dict:
    """市场快照：总进口额 + 分主要供应国，供 planning 的「市场判断 + 竞争格局」。"""
    total_res = comtrade_get(reporter_code, cmd_code, period=period, partner_code="0")
    by_partner = {}
    for name, code in MAJOR_SUPPLIERS:
        r = comtrade_get(reporter_code, cmd_code, period=period, partner_code=code)
        by_partner[name] = r["total"]
    return {"reporter_code": reporter_code, "cmd_code": cmd_code, "period": period,
            "total": total_res["total"], "by_partner": by_partner}


def tag_collection(keyword: str) -> list:
    """datathink 类目标签（公开免鉴权）。返回 tag 列表（含 tagId）。"""
    body = {"keyword": keyword}
    req = urllib.request.Request(
        "https://supplier.datathink.com/category/getTagCollectionAli.do",
        method="POST", data=json.dumps(body, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            d = json.loads(resp.read().decode())
            return (d.get("data") or [])
    except Exception:
        return []


def main():
    _load_env()
    ap = argparse.ArgumentParser(description="dc_trade — 贸易宏观数据接口")
    sub = ap.add_subparsers(dest="cmd")

    c = sub.add_parser("comtrade", help="Comtrade 单次查询")
    c.add_argument("--reporter", required=True, help="报告国代码，如 484(MEX)/156(CHN)")
    c.add_argument("--hs", required=True, help="商品 HS 码，如 6907")
    c.add_argument("--flow", default="M", help="流向 M进口/X出口")
    c.add_argument("--period", default="2024", help="时期 年度如2024 / 月度如202401")
    c.add_argument("--partner", default="0", help="伙伴国，0=世界")
    c.add_argument("--freq", default="A", help="频率 A年度/M月度")

    s = sub.add_parser("snapshot", help="市场快照：总进口 + 分供应国")
    s.add_argument("--reporter", required=True)
    s.add_argument("--hs", required=True)
    s.add_argument("--period", default="2024")

    t = sub.add_parser("tag", help="类目标签 → tagId")
    t.add_argument("--keyword", required=True)

    args = ap.parse_args()

    if args.cmd == "comtrade":
        r = comtrade_get(args.reporter, args.hs, flow_code=args.flow,
                         period=args.period, partner_code=args.partner, freq_code=args.freq)
        print(json.dumps({"total": r["total"], "record_count": len(r["records"])},
                         ensure_ascii=False, indent=2))
    elif args.cmd == "snapshot":
        print(json.dumps(market_snapshot(args.reporter, args.hs, args.period),
                         ensure_ascii=False, indent=2))
    elif args.cmd == "tag":
        print(json.dumps(tag_collection(args.keyword), ensure_ascii=False, indent=2))
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
