"""email_gateway.send_entry — personal(SMTP) 账号发信的唯一实现。

发信入口已收敛到 `dc_email_send.py send`（按账号 provider 分派传输）：
  provider=resend            → Resend API 路径（scripts/resend/send.mjs）
  personal（netease_163 / tencent_exmail / aliyun_exmail / gmail）→ SmtpSender
`email_gateway.cli send` 只保留为兼容薄壳（deprecated），内部同样调用本模块。

为什么单独一层：两条入口必须共用同一份 SMTP 发信实现（含落 outbound 事实、
daily limit、幂等键、确认校验），否则又会长出第二套逻辑。
"""

from __future__ import annotations

from .smtp_send import SmtpSender
from .store import EmailStore


def find_account_by_address(store: EmailStore, from_addr: str,
                            enterprise_id: str = "") -> dict | None:
    """按发件地址反查账号（大小写不敏感，容忍 `V <v@x.com>` 形式）。找不到返回 None。"""
    target = (from_addr or "").split("<")[-1].strip(" <>").lower()
    if not target:
        return None
    accounts = store.list_accounts(enterprise_id=enterprise_id or None)
    for account in accounts:
        if str(account.get("email_address", "")).lower() == target:
            return account
    return None


def send_for_account(store: EmailStore, *, to: list[str], subject: str,
                     account: dict | None = None, account_id: str = "",
                     cc: list[str] | None = None, bcc: list[str] | None = None,
                     text: str = "", html: str | None = None,
                     reply_to: str | None = None, dry_run: bool = False,
                     confirmed_by: str = "") -> dict:
    """用 SmtpSender 发信（personal / SMTP 账号路径）。

    account 与 account_id 二选一：给 account 用其 account_id；只给 account_id 时原样透传给
    SmtpSender（保留「account_id 直接是邮箱地址 → Resend 兼容」的旧行为）。
    confirmed_by 缺省用账号 owner（个人邮箱归 owner 自己，无第二审核人）。
    异常原样抛出（ValueError / ConfirmationRequired / RuntimeError），由调用方决定报错口径。
    """
    target_id = str(account["account_id"]) if account else str(account_id or "")
    if not target_id:
        raise ValueError("account or account_id is required")
    confirmed = confirmed_by or str((account or {}).get("owner_open_id", ""))
    return SmtpSender(store).send(
        account_id=target_id,
        confirmed_by=confirmed,
        to=to,
        cc=cc,
        bcc=bcc,
        subject=subject,
        text=text,
        html=html,
        reply_to=reply_to,
        dry_run=dry_run,
    )
