#!/usr/bin/env python3
# -- coding: UTF-8 --
"""小元-百炼生图接口：POST /blade-agent-adapter/agent/image/*

独立脚本（参考 company_info.py / dc_buyer_adapter.py）。走 blade-agent-adapter 网关，
鉴权用 X-Feishu-Open-Id + X-Supplier-Id header。

两个接口：
  text2img   —— /agent/image/textToImage.json   （Qwen-Image-3.0 文生图）
  img2img    —— /agent/image/imageToImage.json  （图生图，公网图 URL，不走本地上传）

请求体 = 参数对象本身（**不要**包 req 字段；实测包 req 会报「prompt 不能为空」）。

响应 data：
  images[].url        我方图床地址（持久）
  images[].originUrl  百炼临时地址（约 24h 失效）
  inputImageUrls      图生图时实际使用的输入图 URL
  requestId           百炼 request_id
  usage               用量（含 output_width/height、image_count）
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from typing import Any, Optional

DEFAULT_BASE_URL = "https://micro.tradechina.com/blade-agent-adapter"


def _load_env() -> None:
    """从当前目录及上级目录加载 .env（不覆盖已有环境变量）。"""
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


def post_json(base_url: str, path: str, body: Any, open_id: str, supplier_id: str,
              timeout: int = 120) -> dict:
    url = base_url.rstrip("/") + path
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
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


def _build_req(
    prompt: str,
    *,
    image_urls: Optional[str] = None,
    n: int = 1,
    size: Optional[str] = None,
    seed: Optional[int] = None,
    negative_prompt: Optional[str] = None,
    model: Optional[str] = None,
    enable_thinking: Optional[bool] = None,
    prompt_extend: Optional[bool] = None,
    prompt_extend_mode: Optional[str] = None,
    watermark: Optional[bool] = None,
) -> dict:
    """组装「小元-百炼生图参数」。只带非空字段。"""
    req: dict[str, Any] = {"prompt": prompt}
    if image_urls:
        req["imageUrls"] = image_urls
    if n is not None and n != 1:
        req["n"] = n
    if size:
        req["size"] = size
    if seed is not None:
        req["seed"] = seed
    if negative_prompt:
        req["negativePrompt"] = negative_prompt
    if model:
        req["model"] = model
    if enable_thinking is not None:
        req["enableThinking"] = enable_thinking
    if prompt_extend is not None:
        req["promptExtend"] = prompt_extend
    if prompt_extend_mode:
        req["promptExtendMode"] = prompt_extend_mode
    if watermark is not None:
        req["watermark"] = watermark
    return req


def _generate(path: str, req: dict, open_id: str, supplier_id: str,
              base_url: str, timeout: int) -> dict:
    resp = post_json(base_url, path, req, open_id, supplier_id, timeout)
    return {"tool": path.rsplit("/", 1)[-1], "request": req, "response": resp}


def text_to_image(
    prompt: str,
    *,
    n: int = 1,
    size: Optional[str] = None,
    seed: Optional[int] = None,
    negative_prompt: Optional[str] = None,
    model: Optional[str] = None,
    enable_thinking: Optional[bool] = None,
    prompt_extend: Optional[bool] = None,
    prompt_extend_mode: Optional[str] = None,
    watermark: Optional[bool] = None,
    open_id: Optional[str] = None,
    supplier_id: Optional[str] = None,
    base_url: Optional[str] = None,
    timeout: int = 120,
) -> dict:
    """文生图：/agent/image/textToImage.json"""
    _load_env()
    req = _build_req(
        prompt, n=n, size=size, seed=seed, negative_prompt=negative_prompt,
        model=model, enable_thinking=enable_thinking, prompt_extend=prompt_extend,
        prompt_extend_mode=prompt_extend_mode, watermark=watermark,
    )
    return _generate(
        "/agent/image/textToImage.json", req,
        open_id or env("MIO_V_OPEN_ID"), supplier_id or env("MIO_CDP_SUPPLIER_ID"),
        base_url or env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL), timeout,
    )


def image_to_image(
    prompt: str,
    image_urls: str,
    *,
    n: int = 1,
    size: Optional[str] = None,
    seed: Optional[int] = None,
    negative_prompt: Optional[str] = None,
    model: Optional[str] = None,
    enable_thinking: Optional[bool] = None,
    prompt_extend: Optional[bool] = None,
    prompt_extend_mode: Optional[str] = None,
    watermark: Optional[bool] = None,
    open_id: Optional[str] = None,
    supplier_id: Optional[str] = None,
    base_url: Optional[str] = None,
    timeout: int = 120,
) -> dict:
    """图生图：/agent/image/imageToImage.json

    image_urls: 公网图 URL，逗号分隔（1-3 张）。不走本地上传。
    """
    _load_env()
    req = _build_req(
        prompt, image_urls=image_urls, n=n, size=size, seed=seed,
        negative_prompt=negative_prompt, model=model, enable_thinking=enable_thinking,
        prompt_extend=prompt_extend, prompt_extend_mode=prompt_extend_mode,
        watermark=watermark,
    )
    return _generate(
        "/agent/image/imageToImage.json", req,
        open_id or env("MIO_V_OPEN_ID"), supplier_id or env("MIO_CDP_SUPPLIER_ID"),
        base_url or env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL), timeout,
    )


def main() -> None:
    _load_env()
    p = argparse.ArgumentParser(description="小元-百炼生图（textToImage / imageToImage）")
    p.add_argument("--open-id", default=env("MIO_V_OPEN_ID"), help="X-Feishu-Open-Id（默认 MIO_V_OPEN_ID）")
    p.add_argument("--supplier-id", default=env("MIO_CDP_SUPPLIER_ID"), help="X-Supplier-Id（默认 MIO_CDP_SUPPLIER_ID）")
    p.add_argument("--base-url", default=env("MEO_ADAPTER_BASE_URL", DEFAULT_BASE_URL),
                   help=f"adapter Base URL，默认 {DEFAULT_BASE_URL}")
    p.add_argument("--timeout", type=int, default=120, help="HTTP 超时秒数")

    p.add_argument("--mode", default="text2img", choices=["text2img", "img2img"],
                   help="text2img=文生图（默认），img2img=图生图")
    p.add_argument("--prompt", required=True, help="正向提示词（必填）")
    p.add_argument("--image-urls", default="", help="[img2img] 公网图 URL，逗号分隔 1-3 张")
    p.add_argument("--n", type=int, default=1, help="出图数量 1-6")
    p.add_argument("--size", default="", help="分辨率 宽*高，如 1024*1024")
    p.add_argument("--seed", type=int, default=None, help="随机种子 0~2147483647")
    p.add_argument("--negative-prompt", default="", help="反向提示词")
    p.add_argument("--model", default="", help="覆盖默认模型")
    p.add_argument("--enable-thinking", type=lambda s: s.lower() in ("1", "true", "yes"), default=None, help="思考模式")
    p.add_argument("--prompt-extend", type=lambda s: s.lower() in ("1", "true", "yes"), default=None, help="是否智能改写提示词")
    p.add_argument("--prompt-extend-mode", default="", help="改写方式 direct/agent")
    p.add_argument("--watermark", type=lambda s: s.lower() in ("1", "true", "yes"), default=None, help="是否加水印")
    args = p.parse_args()

    common = dict(
        n=args.n,
        size=args.size or None,
        seed=args.seed,
        negative_prompt=args.negative_prompt or None,
        model=args.model or None,
        enable_thinking=args.enable_thinking,
        prompt_extend=args.prompt_extend,
        prompt_extend_mode=args.prompt_extend_mode or None,
        watermark=args.watermark,
        open_id=args.open_id,
        supplier_id=args.supplier_id,
        base_url=args.base_url,
        timeout=args.timeout,
    )

    if args.mode == "img2img":
        result = image_to_image(args.prompt, args.image_urls, **common)
    else:
        result = text_to_image(args.prompt, **common)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
