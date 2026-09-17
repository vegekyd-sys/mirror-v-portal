"""发信附件：读盘、校验、编码（Resend API 与 SMTP 两条链路共用）。

为什么单独一个模块：两条发信链路对附件的要求完全一样（同一套大小上限、同一套
文件名/类型解析、同一套「宁可拒发也不静默丢」的口径），只有最后一步不同——
Resend 要 base64 塞进 JSON，SMTP 走 ``EmailMessage.add_attachment`` 的二进制。
分两处写必然漂移，所以校验统一在这里做，链路只负责最后那一步编码。

**fail closed**：任何一个附件有问题（找不到、是目录、空文件、超限）一律抛
``AttachmentError``，不发送。收信侧超限可以记一行 ``skipped: too_large`` 放过去
（信已经来了，记一笔总比丢了强），发信侧不行——静默少发一个附件，用户以为发了、
买家没收到，是比报错更糟的失败。

上限口径：默认按**原始字节总量** 15MB 卡。MIME/base64 编码会膨胀约 37%，
15MB 原始 ≈ 20.5MB 编码后，同时低于 Gmail 的 25MB 和 Resend 的 40MB 整封上限。
用 ``DC_ATTACHMENT_SEND_MAX_BYTES`` 覆盖（单位字节），但调高之前先确认收件方
服务商吃得下——SMTP 超限是发信时被服务器拒，Resend 超限是 API 返 4xx。
"""

from __future__ import annotations

import base64
import hashlib
import mimetypes
import os
from pathlib import Path
from typing import Any

# 原始字节总量上限（非编码后）。见模块 docstring 的口径说明。
DEFAULT_MAX_TOTAL_BYTES = 15 * 1024 * 1024

DEFAULT_CONTENT_TYPE = "application/octet-stream"


class AttachmentError(ValueError):
    """附件不合法：调用方应把它当作「没发出去」，不要吞掉。"""


def max_total_bytes() -> int:
    """每次读 env，方便测试与运行时调整；解析不了就退回默认值，不炸发信链路。"""
    raw = os.environ.get("DC_ATTACHMENT_SEND_MAX_BYTES") or ""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_TOTAL_BYTES
    return value if value > 0 else DEFAULT_MAX_TOTAL_BYTES


def guess_content_type(filename: str) -> str:
    """按扩展名猜 MIME；猜不出用 octet-stream（收件端会当普通文件下载，不会丢）。"""
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or DEFAULT_CONTENT_TYPE


def split_content_type(content_type: str) -> tuple[str, str]:
    """``image/png`` → ``("image", "png")``；形态不对就退回 octet-stream 的两段。"""
    base = (content_type or "").split(";", 1)[0].strip()
    if "/" in base:
        maintype, subtype = base.split("/", 1)
        if maintype.strip() and subtype.strip():
            return maintype.strip(), subtype.strip()
    return "application", "octet-stream"


def load_attachments(paths: list[str] | None) -> list[dict[str, Any]]:
    """读盘 + 校验，返回 ``[{filename, content_type, size, data, path}]``。

    ``data`` 是原始 bytes（未编码）。空列表/None 返回空列表——「没有附件」不是错误。
    任何一条不合法立即抛 ``AttachmentError``，一个都不发。
    """
    items: list[dict[str, Any]] = []
    total = 0
    limit = max_total_bytes()
    for raw_path in paths or []:
        candidate = str(raw_path or "").strip()
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if not path.exists():
            raise AttachmentError(f"attachment not found: {candidate}")
        if path.is_dir():
            raise AttachmentError(f"attachment is a directory, not a file: {candidate}")
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise AttachmentError(f"attachment unreadable: {candidate} ({exc})") from exc
        if not data:
            # 空文件多半是上一步生成/下载失败的残留，发出去等于发了个坏附件
            raise AttachmentError(f"attachment is empty: {candidate}")
        total += len(data)
        if total > limit:
            raise AttachmentError(
                f"attachments exceed the {limit} byte limit "
                f"(total {total} bytes; override with DC_ATTACHMENT_SEND_MAX_BYTES)"
            )
        content_type = guess_content_type(path.name)
        items.append({
            "filename": path.name,
            "content_type": content_type,
            "size": len(data),
            "data": data,
            "path": str(path),
        })
    return items


def digest(items: list[dict[str, Any]] | None) -> str:
    """附件集合的稳定指纹（文件名 + 内容哈希），给幂等键用。没有附件返回空串。

    必须参与幂等键：同一个买家、同一段正文、换个附件重发是**正常业务**
    （先发规格书再补报价单），不能被判成 duplicate 拦下来。
    """
    if not items:
        return ""
    parts = []
    for item in items:
        body = hashlib.sha256(item["data"]).hexdigest()
        parts.append(f"{item['filename']}:{body}")
    return hashlib.sha256("|".join(sorted(parts)).encode("utf-8")).hexdigest()


def to_resend_payload(items: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    """Resend API 的 ``attachments``：``[{filename, content(base64)}]``。"""
    payload = []
    for item in items or []:
        payload.append({
            "filename": item["filename"],
            "content": base64.b64encode(item["data"]).decode("ascii"),
            "content_type": item.get("content_type") or DEFAULT_CONTENT_TYPE,
        })
    return payload


def attach_to_message(msg, items: list[dict[str, Any]] | None) -> None:
    """把附件挂到 ``EmailMessage``（SMTP 链路）。就地修改，不返回。"""
    for item in items or []:
        maintype, subtype = split_content_type(item.get("content_type", ""))
        msg.add_attachment(item["data"], maintype=maintype, subtype=subtype,
                           filename=item["filename"])


def summarize(items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """去掉 ``data`` 的轻量视图：落事实/回显结果用，别把二进制塞进 JSON。"""
    return [{"filename": i["filename"], "content_type": i.get("content_type", ""),
             "size": i.get("size", 0)} for i in items or []]


def store_outbound(items: list[dict[str, Any]] | None, *, company_id: str,
                   message_id: str, ym: str = "") -> list[dict[str, Any]]:
    """把发出去的附件落进统一附件库，返回索引行（与入站同一套目录/索引约定）。

    **best-effort**：落盘失败不影响已经发出去的信，只是案卷里看不到原件。
    根目录不在 sys.path 时降级为只返回轻量摘要（不报错）。
    """
    if not items:
        return []
    try:
        from dc_resend_attachments import append_index, store_bytes, _month
    except Exception:  # noqa: BLE001 - 降级：拿不到附件库就只留摘要
        return summarize(items)
    month = ym or _month()
    rows: list[dict[str, Any]] = []
    for item in items:
        try:
            rows.append(store_bytes(
                company_id=company_id, message_id=message_id or "no-message-id",
                filename=item["filename"], content_type=item.get("content_type", ""),
                data=item["data"], ym=month,
            ))
        except Exception as exc:  # noqa: BLE001 - 单个附件失败不拖累其它
            rows.append({"message_id": message_id, "filename": item["filename"],
                         "stored": False, "error": str(exc)[:120]})
    try:
        append_index(rows, company_id=company_id, ym=month)
    except Exception:  # noqa: BLE001
        pass
    return rows
