#!/usr/bin/env python3
# -- coding: UTF-8 --
"""企业信息接口：POST /blade-agent-adapter/agent/company/*

独立脚本（不依赖 skills/_client.py）。支持两个接口：
  basic      —— getBasicInfo.json       获取企业基本信息（默认）
  invitation —— getInvitationByPage.json 分页获取企业邀约记录
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"


def _load_env() -> None:
    """从当前目录及上级目录加载 .env（不覆盖已有环境变量）。"""
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
        url,
        method="POST",
        data=payload,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "X-Feishu-Open-Id": open_id.strip(),
            "X-Supplier-Id": supplier_id.strip(),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        return {
            "success": False,
            "code": e.code,
            "msg": f"HTTP {e.code}",
            "data": None,
            "errorBody": e.read().decode("utf-8", errors="replace")[:500],
        }
    except urllib.error.URLError as e:
        return {"success": False, "code": -1, "msg": f"网络错误: {e.reason}", "data": None}


def run_basic(args) -> dict:
    body: dict = {}
    if args.company_id.strip():
        body["companyId"] = args.company_id.strip()
    resp = post_json(args.base_url, "/agent/company/getBasicInfo.json", body,
                     args.open_id, args.supplier_id, args.timeout)
    return {"tool": "getBasicInfo", "request": body, "response": resp}


def run_invitation(args) -> dict:
    """分页获取邀约记录：POST /agent/company/getInvitationByPage.json。

    BaseRequest 包装：appVersion/time 必填，data 里 pageNum/pageSize 必填。
    业务筛选字段（exhibitionId/inviationState/inviationType/isCheckIn/isConnect/isMeeting）
    按传入情况加入 data。
    """
    data: dict = {
        "pageNum": args.page_num,
        "pageSize": args.page_size,
    }
    if args.exhibition_id:
        data["exhibitionId"] = args.exhibition_id
    if args.create_user:
        data["createUser"] = args.create_user
    if args.inviation_state is not None:
        data["inviationState"] = args.inviation_state
    if args.inviation_type is not None:
        data["inviationType"] = args.inviation_type
    if args.is_checkin is not None:
        data["isCheckIn"] = args.is_checkin
    if args.is_connect is not None:
        data["isConnect"] = args.is_connect
    if args.is_meeting is not None:
        data["isMeeting"] = args.is_meeting

    body: dict = {
        "appVersion": args.app_version,
        "time": int(time.time()),
        "data": data,
        "lang": args.lang,
    }
    if args.exhibition_id:
        body["exhibitionId"] = args.exhibition_id
    if args.website_id:
        body["websiteId"] = args.website_id

    resp = post_json(args.base_url, "/agent/company/getInvitationByPage.json", body,
                     args.open_id, args.supplier_id, args.timeout)
    return {"tool": "getInvitationByPage", "request": body, "response": resp}


def main() -> None:
    _load_env()
    p = argparse.ArgumentParser(description="小元-企业信息接口（getBasicInfo / getInvitationByPage）")
    p.add_argument("--open-id", default=env("MIO_V_OPEN_ID"), help="X-Feishu-Open-Id（默认 MIO_V_OPEN_ID）")
    p.add_argument("--supplier-id", default=env("MIO_CDP_SUPPLIER_ID"), help="X-Supplier-Id（默认 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--base-url", default=env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL),
                   help=f"adapter Base URL，默认 {DEFAULT_BASE_URL}")
    p.add_argument("--timeout", type=int, default=60, help="HTTP 超时秒数")

    p.add_argument("--action", default="basic", choices=["basic", "invitation"],
                   help="接口：basic=getBasicInfo（默认），invitation=getInvitationByPage")
    # basic
    p.add_argument("--company-id", default="", help="[basic] 企业ID（supplierId），缺省靠 X-Supplier-Id 头")
    # invitation
    p.add_argument("--exhibition-id", default="", help="[invitation] 展会ID")
    p.add_argument("--page-num", type=int, default=1, help="[invitation] 页码")
    p.add_argument("--page-size", type=int, default=20, help="[invitation] 每页大小")
    p.add_argument("--create-user", default="", help="[invitation] 发起人")
    p.add_argument("--inviation-state", type=int, default=None,
                   help="[invitation] 邀约状态 1联系中 2联系不上 3已拒绝 4已接受 5已联系")
    p.add_argument("--inviation-type", type=int, default=None,
                   help="[invitation] 类型 1展会报名搜索 2全球买家搜索 3自提买家 4展商自邀 5问答式搜索 6情报搜索 7RFQ 9商机样品 10AI智能客服 11线下会面 12展前推广 31AI搜索 36同行买家 37展后报告 38慧客 39大买家对接 40行业优质买家搜索")
    p.add_argument("--is-checkin", type=int, default=None, help="[invitation] 是否到展 1到展 2暂未到展 3未到展")
    p.add_argument("--is-connect", type=int, default=None, help="[invitation] 是否对接 1已对接 2暂未对接 3未对接")
    p.add_argument("--is-meeting", type=int, default=None, help="[invitation] 是否商洽 1商洽 2暂未商洽 3未商洽")
    p.add_argument("--app-version", default="1.0.0", help="[invitation] APP版本号")
    p.add_argument("--lang", default="zh", help="[invitation] 语言")
    p.add_argument("--website-id", default="", help="[invitation] 站点ID")
    args = p.parse_args()

    result = run_basic(args) if args.action == "basic" else run_invitation(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
