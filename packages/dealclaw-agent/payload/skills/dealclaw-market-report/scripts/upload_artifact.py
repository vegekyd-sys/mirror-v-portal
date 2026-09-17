#!/usr/bin/env python3
"""报告 HTML 交付物后处理：上传米奥文件服务 → 输出公网直链标记行。

对话式对接链路（米奥 TradeChina「AI猎客」试用页）专用：
外部集成方通过 POST /api/external/chat/stream 发自然语言指令，聚合回复文本，
从回复**末尾单行**解析产物标记。

用法:
  python3 upload_artifact.py \
      --html  <report.html> \
      --product <产品> \
      --market  <市场> \
      [--marker HTML_ARTIFACT] \
      [--out-urlfile <文件>]

可选环境变量:
  MIAO_FILE_HOST        米奥文件服务 base，默认 https://img.tradechina.com/image/
  MIAO_UPLOAD_TIMEOUT   上传超时秒数，默认 120

标准输出契约（最后一行，机器可读，供集成方解析）:
  HTML_ARTIFACT={"html_url":"<直链>","file_id":"<32位id>","bytes":12345}

退出码:
  0 成功
  2 参数错误（文件不存在等）
  4 上传/校验失败
  5 交付物体检未通过（疑似登录页/抓取页冒充报告）

质检规则（默认开启，不得绕过）：
  - 文件 < 8KB 直接拒绝
  - 命中登录/SSO 特征（suite-passport / passport-compile-at / 请登录 …）拒绝
  - 正文既无产品名也无市场名 → 拒绝
  报告必须是**本地生成的 HTML**；绝不允许把 web_fetch 抓到的页面当交付物。

设计要点:
  - 不依赖任何渲染器：直接上传既有 HTML，无需 Chrome/Chromium。
  - 直链为永久链接（302 → COS），不带有效期，因此不返回 expires_at。
  - getDocumentUrl 返回 302 且响应体为空；必须跟随重定向后再校验 200 与字节数，
    否则会拿到 0 字节并误判成功。
  - 上传响应的 code 是字符串 "0"，只取 data 字段作为 fileId。
  - 上传时的中文文件名仅用于本方对账/日志；浏览器最终落地文件名由米奥侧决定。
"""

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_FILE_HOST = "https://img.tradechina.com/image/"


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def file_host() -> str:
    host = os.environ.get("MIAO_FILE_HOST") or DEFAULT_FILE_HOST
    return host if host.endswith("/") else host + "/"


def upload_file(path: Path, filename: str, mime: str, timeout: int) -> str:
    import requests  # 镜像内已安装 python3-requests

    with path.open("rb") as fh:
        resp = requests.post(
            file_host() + "tencentFile/fileUpload",
            files={"file": (filename, fh, mime)},
            timeout=timeout,
        )
    resp.raise_for_status()
    body = resp.json()
    # 注意: 米奥文件服务返回的 code 是字符串 "0"，不是数字
    if str(body.get("code")) != "0" or not body.get("data"):
        raise RuntimeError(f"上传响应异常: {json.dumps(body, ensure_ascii=False)[:300]}")
    return str(body["data"])


def verify_link(file_id: str, expected_bytes: int, timeout: int = 60) -> str:
    """跟随 302 后校验真实对象可用，返回最终直链。"""
    import requests

    url = file_host() + "getDocumentUrl/" + file_id
    resp = requests.get(url, timeout=timeout, allow_redirects=True)
    if resp.status_code != 200:
        raise RuntimeError(f"直链不可用: HTTP {resp.status_code}")
    got = len(resp.content)
    if got != expected_bytes:
        raise RuntimeError(f"直链字节数不符: 期望 {expected_bytes} 实际 {got}")
    return url


MIME_BY_SUFFIX = {
    ".html": "text/html",
    ".htm": "text/html",
    ".pdf": "application/pdf",
}

# 登录/SSO 页特征：交付物里出现任一个即拒绝上传。
# 实测事故：agent 把一个 TradeChina SSO 登录页（92201B）当成报告上传。
LOGIN_MARKERS = (
    "suite-passport",
    "passport-compile-at",
    "release_train_",
    'id="login"',
    "name=\"password\"",
    "请登录",
    "立即登录",
    "登录后继续",
    "sign in to continue",
)

MIN_REPORT_BYTES = 8 * 1024


def validate_report_html(text: str, product: str, market: str) -> list:
    """交付物体检。返回问题列表，空列表代表通过。

    目的：不让「抓取到的登录页」冒充「本地生成的报告」进入交付链路。
    """
    problems = []
    low = text.lower()

    for marker in LOGIN_MARKERS:
        if marker.lower() in low:
            problems.append(f"命中登录/SSO 页特征「{marker}」")

    if "<html" not in low:
        problems.append("不是完整 HTML 文档（缺 <html）")

    if product and market and product not in text and market not in text:
        problems.append(f"正文既无产品名「{product}」也无市场名「{market}」，不像本次报告")

    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", required=True, help="待上传的报告文件（HTML）")
    ap.add_argument("--product", required=True)
    ap.add_argument("--market", required=True)
    ap.add_argument("--marker", default="HTML_ARTIFACT", help="输出标记名前缀")
    ap.add_argument("--out-urlfile", help="可选：把直链写入该文件")
    ap.add_argument(
        "--allow-non-report",
        action="store_true",
        help="仅调试用：跳过硬校验。默认禁止。",
    )
    args = ap.parse_args()

    path = Path(args.html)
    if not path.exists():
        log(f"错误: 文件不存在: {path}")
        return 2

    size = path.stat().st_size
    if size < MIN_REPORT_BYTES:
        log(f"错误: 文件过小（{size}B < {MIN_REPORT_BYTES}B），不像完整报告")
        return 5

    # 上传前体检：拒绝登录页/抓取页冒充报告
    if not args.allow_non_report:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            log(f"错误: 读取文件失败: {exc}")
            return 2
        problems = validate_report_html(text, args.product, args.market)
        if problems:
            log("错误: 交付物体检未通过，拒绝上传：")
            for p in problems:
                log(f"  - {p}")
            log("提示: 报告必须是本地生成的 HTML，不得上传抓取到的页面；"
                "确认无误后可用 --allow-non-report 临时跳过（仅调试）。")
            return 5

    mime = MIME_BY_SUFFIX.get(path.suffix.lower(), "application/octet-stream")
    # 中文文件名仅用于本方对账/日志
    filename = f"市场分析报告-{args.product}-{args.market}{path.suffix.lower() or '.html'}"

    try:
        file_id = upload_file(
            path, filename, mime, int(os.environ.get("MIAO_UPLOAD_TIMEOUT", "120"))
        )
        url = verify_link(file_id, size)
    except Exception as exc:  # noqa: BLE001
        log(f"错误: 上传/校验失败: {exc}")
        return 4

    artifact = {"html_url": url, "file_id": file_id, "bytes": size}
    if args.out_urlfile:
        Path(args.out_urlfile).write_text(url, encoding="utf-8")
    print(f"{args.marker}=" + json.dumps(artifact, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
