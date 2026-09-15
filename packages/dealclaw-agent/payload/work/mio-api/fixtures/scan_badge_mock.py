"""展证扫码 / 邀约的联调 mock 数据（2026-09-15 从 dc_scan_badge.py 外移）。

只为联调与演示用，**不进主逻辑**：`dc_scan_badge.py --mock` 才导入本模块。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def mock_records(n: int = 3) -> list[dict]:
    """造几条形状合理的扫码记录（字段名对齐接口常见命名）。"""
    base = datetime(2026, 9, 12, 10, 30, tzinfo=timezone.utc)
    samples = [
        ("Grupo Pantalonero S.A. de C.V.", "https://grupopantalonero.mx", "Mexico", "Óscar Montoya",
         "Gerente de Compras", "oscar.montoya@grupopantalonero.mx", "+52 55 1234 5678",
         "B9000", "2026年墨西哥中国出口品牌联展"),
        ("Coyote Trading Ltda.", "https://coyotrading.com.br", "Brazil", "Daniela Berkenbrock",
         "Diretora de Suprimentos", "daniela@coyotrading.com.br", "+55 11 98888 7777",
         "B9001", "2026年巴西中国出口品牌联展"),
        ("First Technology (Pty) Ltd", "https://firsttechnology.co.za", "South Africa", "Nicole Kekana",
         "Procurement Lead", "nicolek@firsttechnology.co.za", "+27 11 555 0100",
         "B9002", "2026年南非中国出口品牌联展"),
    ]
    out = []
    for i, s in enumerate(samples[:n]):
        out.append({
            "companyName": s[0], "website": s[1], "countryName": s[2], "contactName": s[3],
            "position": s[4], "email": s[5], "phone": s[6],
            "customerId": f"cust_{1000 + i}", "cdpId": f"cdp_{2000 + i}",
            "badgeNo": s[7], "scanTime": (base + timedelta(minutes=17 * i)).isoformat(),
            "exhibitionId": f"15307236970{i}", "exhibitionName": s[8],
        })
    return out


def mock_invitations() -> list[dict]:
    """邀约 mock：故意包含①与扫码命中（Coyote）②未到场且未扫码（Staubli）。"""
    return [
        {"companyName": "Coyote Trading Ltda.", "website": "https://coyotrading.com.br",
         "email": "daniela@coyotrading.com.br", "contactName": "Daniela Berkenbrock",
         "exhibitionId": "153072369701", "exhibitionName": "2026年巴西中国出口品牌联展",
         "invitationState": 2, "invitationType": 1, "isCheckIn": 1, "isMeeting": 1,
         "createUser": "田耕郡", "createTime": "2026-09-01T09:00:00+08:00"},
        {"companyName": "Staubli Components GmbH", "website": "https://staubli-components.de",
         "email": "einkauf@staubli-components.de", "contactName": "Martin Weber",
         "exhibitionId": "153072369700", "exhibitionName": "2026年墨西哥中国出口品牌联展",
         "invitationState": 3, "invitationType": 1, "isCheckIn": 0, "isMeeting": 0,
         "createUser": "田耕郡", "createTime": "2026-09-02T09:00:00+08:00"},
    ]
