#!/usr/bin/env python3
"""Upload an image to Feishu and set it as a group chat avatar.

Usage:
  python3 scripts/upload-and-set-avatar.py <image_path> <chat_id>

Requirements:
  - lark-cli installed and configured
  - strict-mode off (bot identity needed for image upload)
  - Image recommended: 512x512 PNG, <1MB
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def run_lark(cmd: list[str], cwd: str = None) -> dict:
    """Run a lark-cli command and return parsed JSON."""
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=30,
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": {"message": result.stderr or result.stdout}}


def compress_image(src: str, max_size: int = 768) -> str:
    """Ensure image is within Feishu limits, return path to safe copy."""
    try:
        from PIL import Image
        img = Image.open(src)
        w, h = img.size
        if max(w, h) <= max_size:
            return src  # Already fine
        ratio = max_size / max(w, h)
        new_size = (int(w * ratio), int(h * ratio))
        img = img.resize(new_size, Image.LANCZOS)
        out = tempfile.mktemp(suffix=".png")
        img.save(out, "PNG", optimize=True)
        return out
    except ImportError:
        return src  # PIL not available, use as-is


def upload_avatar(image_path: str) -> str:
    """Upload image as avatar type, return image_key."""
    safe_path = compress_image(image_path)

    # lark-cli --file requires relative path from cwd
    abs_path = os.path.abspath(safe_path)
    cwd = os.path.dirname(abs_path)
    rel_path = os.path.basename(abs_path)

    result = run_lark(
        [
            "lark-cli", "im", "images", "create",
            "--as", "bot",
            "--data", '{"image_type":"avatar"}',
            "--file", f"image=./{rel_path}",
        ],
        cwd=cwd,
    )

    if result.get("code") != 0:
        raise RuntimeError(f"Image upload failed: {result}")

    image_key = result.get("data", {}).get("image_key")
    if not image_key:
        raise RuntimeError(f"No image_key in response: {result}")

    print(f"  ✅ Uploaded: {image_key}")
    return image_key


def set_chat_avatar(chat_id: str, image_key: str) -> dict:
    """Set the group chat avatar."""
    result = run_lark(
        [
            "lark-cli", "im", "chats", "update",
            "--as", "user",
            "--yes",
            "--params", json.dumps({"chat_id": chat_id}),
            "--data", json.dumps({"avatar": image_key}),
        ],
    )

    if result.get("code") != 0:
        raise RuntimeError(f"Chat update failed: {result}")

    return result


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 upload-and-set-avatar.py <image_path> <chat_id>")
        sys.exit(1)

    image_path = sys.argv[1]
    chat_id = sys.argv[2]

    if not os.path.exists(image_path):
        print(f"❌ Image not found: {image_path}")
        sys.exit(1)

    print(f"🎨 Uploading: {image_path}")
    print(f"💬 Chat: {chat_id}")

    try:
        image_key = upload_avatar(image_path)
        result = set_chat_avatar(chat_id, image_key)
        print(f"  ✅ Avatar set!")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except RuntimeError as e:
        print(f"❌ {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
