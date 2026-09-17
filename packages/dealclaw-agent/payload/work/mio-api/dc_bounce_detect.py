"""dc_bounce_detect.py — 个人邮箱 IMAP 退信（NDR）识别 + 解析 + 分类。

为什么需要：个人邮箱走 SMTP 直发，发信成功即乐观记 delivered（无投递回执）。
买家地址不存在/邮箱满时，退信会回到发件箱；不识别就会被当成「买家回复」，
污染回复口径与通知。这里只做纯函数判定，落库由 store.mark_bounced_by_contact 负责。

部署位置要求：本文件必须放在 `work/mio-api/` 根目录（imap_sync.py 按根目录模块导入）。
"""
from __future__ import annotations

import re
from email.message import Message

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

_BOUNCE_SENDER_HINTS = ("mailer-daemon", "postmaster", "mail-delivery", "mailer")

_BOUNCE_SUBJECT_HINTS = (
    "退信", "退件", "undeliverable", "delivery status notification",
    "mail delivery failed", "returned mail", "failure notice",
    "投递失败", "无法投递", "delivery failure", "undelivered mail",
    "could not be delivered", "mail system error",
)

_HARD_HINTS = (
    "does not exist", "not exist", "no such user", "user unknown",
    "invalid recipient", "recipient rejected", "account disabled",
    "no mailbox", "address rejected", "recipient not found",
    "无法送达", "邮箱不存在", "收件人不存在", "地址无效", "永久",
)

_SOFT_HINTS = (
    "quota", "over quota", "mailbox full", "temporarily", "try again",
    "later", "greylist", "邮箱已满", "容量已满", "暂时", "稍后",
)

_CONTENT_HINTS = (
    "spam", "content rejected", "blocked", "rejected due to",
    "反垃圾", "垃圾邮件",
)


def body_text(msg: Message, limit: int = 4000) -> str:
    """把 email.message 摊平成文本（text/plain 优先，html 兜底）。"""
    plain: list[str] = []
    html: list[str] = []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        if "attachment" in (part.get("Content-Disposition") or "").lower():
            continue
        try:
            payload = part.get_payload(decode=True)
            text = (payload.decode(part.get_content_charset() or "utf-8", "replace")
                    if isinstance(payload, bytes) else str(part.get_payload() or ""))
        except Exception:  # noqa: BLE001
            text = ""
        if part.get_content_type() == "text/plain":
            plain.append(text)
        elif part.get_content_type() == "text/html":
            html.append(text)
    body = "\n".join(plain) or "\n".join(html)
    return body[:limit]


def is_bounce(msg: Message, sender: str = "", subject: str = "") -> bool:
    """判断一封入站邮件是不是退信（NDR）。"""
    ct = (msg.get("Content-Type") or "").lower()
    if "multipart/report" in ct and "delivery-status" in ct:
        return True
    s = (sender or "").lower()
    if any(h in s for h in _BOUNCE_SENDER_HINTS):
        return True
    subj = (subject or "").lower()
    return any(h in subj for h in _BOUNCE_SUBJECT_HINTS)


def classify_bounce(text: str) -> str:
    """退信类型：hard / soft / content / unknown。"""
    t = (text or "").lower()
    if any(k in t for k in _HARD_HINTS):
        return "hard"
    if any(k in t for k in _SOFT_HINTS):
        return "soft"
    if any(k in t for k in _CONTENT_HINTS):
        return "content"
    return "unknown"


def extract_bounced_recipient(msg: Message) -> str:
    """从退信里提取「被退的原始收件人」邮箱。"""
    xfr = msg.get("X-Failed-Recipients")
    if xfr:
        for addr in _EMAIL_RE.findall(xfr):
            return addr
    body = body_text(msg)
    m = re.search(r"final-recipient\s*:\s*rfc822\s*;\s*([^\s;<>]+)", body, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    for addr in _EMAIL_RE.findall(body):
        a = addr.lower()
        if any(h in a for h in _BOUNCE_SENDER_HINTS):
            continue
        return addr
    return ""
