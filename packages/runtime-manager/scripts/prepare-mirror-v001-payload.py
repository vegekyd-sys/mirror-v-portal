#!/usr/bin/env python3
"""Build a private, text-only Mirror V seed from the live V001 workspace.

The resulting tar stays outside Git. It carries the V001 company knowledge and
skill instructions, but never credentials, raw logs, media, or runtime state.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path

VERSION = "mirror-v.v001-full.v1"
CORE = ("AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "PROJECTS.md", "HEARTBEAT.md", "TOOLS.md")
TEXT_SUFFIXES = {".md", ".json", ".jsonl", ".txt"}
BLOCKED_PARTS = {".dreams", "backups", "credentials", "imports", "logs", "raw", ".openclaw"}
BLOCKED_NAMES = {".env", ".dashboard-token"}
MAX_FILE_BYTES = 1_000_000
ASSIGNMENT = re.compile(r"(?i)\b((?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*)([^\s`]+)")
BEARER = re.compile(r"(?i)(Bearer\s+)[A-Za-z0-9_.-]{20,}")
PRIVATE_KEY = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
TOKEN_LITERAL = re.compile(r"(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9])")


def allowed(path: Path, root: Path) -> bool:
    rel = path.relative_to(root)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
        return False
    if rel.name in BLOCKED_NAMES or rel.name.startswith(".env") or any(part.startswith(".") for part in rel.parts):
        return False
    if any(part.lower() in BLOCKED_PARTS or "backup" in part.lower() for part in rel.parts):
        return False
    if rel.parts[0] == "memory":
        if "daily-session-review" in rel.parts and rel.suffix != ".md":
            return False
        if "references" in rel.parts and "raw" in rel.stem.lower():
            return False
    elif rel.parts[0] != "skills":
        return False
    return rel.suffix.lower() in TEXT_SUFFIXES


def clean_text(data: bytes) -> tuple[str, int]:
    if b"\0" in data:
        raise ValueError("binary content")
    text = data.decode("utf-8")
    text, assignments = ASSIGNMENT.subn(r"\1<redacted>", text)
    text, bearers = BEARER.subn(r"\1<redacted>", text)
    if PRIVATE_KEY.search(text) or TOKEN_LITERAL.search(text):
        raise ValueError("unredacted credential pattern")
    return text, assignments + bearers


def identity_docs(source: dict[str, str]) -> dict[str, str]:
    source_memory = source["MEMORY.md"]
    source_soul = source["SOUL.md"]
    source_identity = source["IDENTITY.md"]
    header = (
        "# Mirror V · V001 基线\n\n"
        "你是 Mirror V，是从旧 mirror-v-001 公司基线创建的独立分身。"
        "每个扫码用户有独立运行环境、会话和后续记忆。"
        "V001 文件中提到的 V from Versa 是来源，不是你当前的身份；"
        "私人源 V 也不是你的运行环境。不要假定当前用户就是 Tianyi。\n\n"
        "保留 V001 的工作风格与可检索的公司知识。回答人物、项目和历史问题时，"
        "先读 MEMORY.md 与 memory/；不确定就说明资料日期和局限。"
        "TOOLS.md 和旧技能是能力说明，不代表本沙箱装有相同工具或凭据。"
        "调用前检查实际可用工具；不要声称已完成未执行的操作。\n\n"
    )
    return {
        "AGENTS.md": header + source["AGENTS.md"],
        "SOUL.md": (
            "# Mirror V\n\n继承旧 V001 的公司级工作风格：清楚、主动、以证据为准，"
            "帮助用户把上下文变成可交付的工作。你是独立 Mirror V 分身；"
            "不冒充私人 V 或仍在运行的 V from Versa。\n\n"
            "旧 SOUL 仅作为来源记录：见 memory/v001-source-soul.md。\n"
        ),
        "IDENTITY.md": (
            "# Mirror V 身份\n\n来源：旧 mirror-v-001 / V from Versa 公司基线。"
            "实例：当前扫码用户的独立 Agent。Tianyi 是来源基线的创建者和 Versa 负责人；"
            "当前对话者的身份需要在本实例中单独确认。\n\n"
            "旧身份文件见 memory/v001-source-identity.md。\n"
        ),
        "USER.md": (
            "# 当前用户\n\n这是独立扫码实例。不要根据 V001 来源资料认定当前用户就是 Tianyi。"
            "用户可以在对话中介绍自己的身份、项目和偏好；在本实例中记录。\n"
        ),
        "MEMORY.md": (
            "# Mirror V 记忆入口\n\n本实例继承旧 V001 的公司知识快照，不继承旧会话或凭据。"
            "Tianyi 是 Versa 的负责人；Makaron 是其 AI 创作产品。"
            "项目细节、决策和日期请检索 `memory/`，勿只凭这两句推断。\n\n"
            "- 完整来源记忆索引：`memory/v001-source-memory.md` 与 `memory/index.md`。\n"
            "- 项目资料：`memory/projects/`。\n"
            "- 源文件中对 V from Versa 的第一人称表述是历史来源，当前身份是 Mirror V。\n"
        ),
        "TOOLS.md": (
            "# 工具边界\n\n下文来自旧 V001，可作为工作方法参考。"
            "当前沙箱只可使用实际暴露的工具与凭据；旧主机路径、Feishu CLI、"
            "Makaron CLI 或浏览器能力不可直接假定存在。\n\n"
            + source["TOOLS.md"]
        ),
        "PROJECTS.md": source["PROJECTS.md"],
        "HEARTBEAT.md": source["HEARTBEAT.md"],
        "memory/v001-source-memory.md": source_memory,
        "memory/v001-source-soul.md": source_soul,
        "memory/v001-source-identity.md": source_identity,
    }


def prepare(root: Path, output: Path) -> dict:
    source: dict[str, str] = {}
    redactions = 0
    for name in CORE:
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"missing core document: {name}")
        source[name], count = clean_text(path.read_bytes())
        redactions += count
    files = identity_docs(source)
    skipped: list[str] = []
    for folder in ("memory", "skills"):
        for path in sorted((root / folder).rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            if not allowed(path, root):
                skipped.append(rel)
                continue
            try:
                files[rel], count = clean_text(path.read_bytes())
                redactions += count
            except (UnicodeDecodeError, ValueError):
                skipped.append(rel)
    manifest = {
        "name": "mirror-v", "version": VERSION,
        "source": "mirror-v-001 live company workspace",
        "source_file_count": len(files),
        "skipped_file_count": len(skipped), "redaction_count": redactions,
        "memory_files": sum(name.startswith("memory/") for name in files),
        "skill_files": sum(name.startswith("skills/") for name in files),
    }
    files["payload-manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, "w") as tar:
        for name, content in sorted(files.items()):
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o600
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    output.chmod(0o600)
    h = hashlib.sha256(output.read_bytes()).hexdigest()
    return {**manifest, "archive_bytes": output.stat().st_size, "sha256": h}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source.resolve(), args.output.resolve()), ensure_ascii=False))
