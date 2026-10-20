#!/usr/bin/env python3
"""事前体积闸门：入库之前算一遍备份会变多大，超限就拦住。

backup.mjs 对 workspace 没有排除机制，而且 `.git` 整个目录每一轮都被重新打包 ——
**删文件不会让备份变小**。10/09 的 294 MB 备份把每轮排队拖到 83 秒就是这么来的。
E4 门禁和 H5 告警都是事后的，响的时候客户已经在排队，所以落盘前必须先问这里。

输出 JSON：
  workspace_bytes  工作区总字节（排除 .git，不跟软链接）
  git_bytes        `git count-objects -vH` 的 size-pack + size，和 workspace 并列的一等指标
  est_tgz_bytes    估算备份大小：纯文本按 3:1 压，二进制和 .git（已 zlib 压过）按原样计
  est_chunks       memory/ 下 md 总字符数 / 400（memory_search 的切块尺寸）
  pending_bytes    --pending 指定的待入库目录体积，计入估算
  binaries[]       任何非文本文件（扩展名 + 前 1024 字节嗅探 NUL），有就至少 warn
  verdict          ok | warn | stop

退出码：ok=0，warn=1，stop=2。**warn 和 stop 都非零，调用方必须停下问主人。**

Usage:
  onboard-budget.py                              # 例行体检
  onboard-budget.py --pending /tmp/batch-07      # 这批落盘前先算
  onboard-budget.py --ignore artifacts-out --json-compact
  （--workspace <dir> 可指定工作区根；不给就从脚本位置往上找含 AGENTS.md 的目录）
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

MiB = 1024 * 1024
WARN_TGZ = 20 * MiB      # 预估备份超过这个就得问主人
STOP_TGZ = 40 * MiB
WARN_BATCH = 20 * MiB    # 单批增量上限
CHUNK_CHARS = 400
TEXT_RATIO = 3           # 纯文本 tar.gz 约 3:1
BIN_EXT = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".key", ".pages",
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico", ".psd", ".heic",
    ".mp3", ".wav", ".flac", ".m4a", ".mp4", ".mov", ".avi", ".mkv", ".webm",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".wasm",
    ".db", ".sqlite", ".sqlite3", ".pyc", ".pack", ".idx", ".npy", ".parquet",
}


def find_workspace(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not p.is_dir():
            sys.exit(f"--workspace 不是目录：{p}")
        return p
    for d in Path(__file__).resolve().parents:
        if (d / "AGENTS.md").is_file():
            return d
    sys.exit("找不到工作区根（往上没有 AGENTS.md），请用 --workspace 指定")


def binary_reason(path: Path) -> str | None:
    if path.suffix.lower() in BIN_EXT:
        return "ext"
    try:
        with path.open("rb") as f:
            if b"\0" in f.read(1024):
                return "nul"
    except OSError:
        return None
    return None


def scan(root: Path, label: str, skip: set[str], ignore: list[Path]) -> dict:
    """走一遍目录：不跟软链接（memory/imports 是软链接，跟了会重复计数）。"""
    res = {"total": 0, "text": 0, "binary": 0, "files": 0, "binaries": []}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        d = Path(dirpath)
        dirnames[:] = sorted(x for x in dirnames
                             if x not in skip and not (d / x).is_symlink()
                             and (d / x).resolve() not in ignore)
        for fn in filenames:
            p = d / fn
            if p.is_symlink():
                continue
            try:
                size = p.stat().st_size
            except OSError:
                continue
            res["total"] += size
            res["files"] += 1
            why = binary_reason(p)
            if why:
                res["binary"] += size
                res["binaries"].append({"path": f"{label}:{p.relative_to(root).as_posix()}",
                                        "bytes": size, "why": why})
            else:
                res["text"] += size
    res["binaries"].sort(key=lambda b: -b["bytes"])
    return res


def git_bytes(root: Path) -> int:
    """count-objects 拿不到就退回数 .git 目录（worktree / 坏仓库时也别崩）。"""
    units = {"bytes": 1, "KiB": 1024, "MiB": MiB, "GiB": 1024 ** 3, "TiB": 1024 ** 4}
    try:
        r = subprocess.run(["git", "count-objects", "-vH"], cwd=root,
                           capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        r = None
    if r is not None and r.returncode == 0:
        total = 0
        for line in r.stdout.splitlines():
            key, _, val = line.partition(":")
            parts = val.split()
            if key.strip() in ("size", "size-pack") and len(parts) == 2:
                total += int(float(parts[0]) * units.get(parts[1], 1))
        return total
    gitdir = root / ".git"
    if not gitdir.is_dir():
        return 0
    return scan(gitdir, ".git", set(), [])["total"]


def memory_chars(root: Path) -> int:
    mem = root / "memory"
    if not mem.is_dir():
        return 0
    total = 0
    for dirpath, dirnames, filenames in os.walk(mem, followlinks=False):
        d = Path(dirpath)
        dirnames[:] = [x for x in dirnames if not (d / x).is_symlink()]
        for fn in filenames:
            p = d / fn
            if p.suffix.lower() != ".md" or p.is_symlink():
                continue
            try:
                total += len(p.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                continue
    return total


def human(n: int) -> str:
    for unit, div in (("GiB", 1024 ** 3), ("MiB", MiB), ("KiB", 1024)):
        if n >= div:
            return f"{n / div:.1f} {unit}"
    return f"{n} B"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__)
    ap.add_argument("--workspace", help="工作区根；默认往上找含 AGENTS.md 的目录")
    ap.add_argument("--pending", help="待入库目录，单独计体积并计入估算")
    ap.add_argument("--ignore", action="append", default=[],
                    help="跳过的相对目录（可重复），例如 artifacts-out")
    ap.add_argument("--max-binaries", type=int, default=20, help="binaries[] 最多列几条")
    a = ap.parse_args()

    root = find_workspace(a.workspace)
    pending = Path(a.pending).expanduser().resolve() if a.pending else None
    ignore = [(root / i).resolve() for i in a.ignore]
    if pending is not None:
        ignore.append(pending)  # pending 若在工作区内，别和 pending_bytes 重复计

    ws = scan(root, "workspace", {".git"}, ignore)
    pend = scan(pending, "pending", {".git"}, []) if pending and pending.is_dir() else None
    if a.pending and pend is None:
        sys.exit(f"--pending 不是目录：{pending}")

    gb = git_bytes(root)
    text = ws["text"] + (pend["text"] if pend else 0)
    binary = ws["binary"] + (pend["binary"] if pend else 0)
    est_tgz = round(text / TEXT_RATIO) + binary + gb
    bins = ws["binaries"] + (pend["binaries"] if pend else [])
    bins.sort(key=lambda b: -b["bytes"])
    pending_bytes = pend["total"] if pend else 0

    reasons = []
    verdict = "ok"
    if est_tgz > STOP_TGZ:
        verdict = "stop"
        reasons.append(f"预估备份 {human(est_tgz)} > {human(STOP_TGZ)}，停下别写")
    elif est_tgz > WARN_TGZ:
        verdict = "warn"
        reasons.append(f"预估备份 {human(est_tgz)} > {human(WARN_TGZ)}")
    if pending_bytes > WARN_BATCH:
        verdict = "stop" if verdict == "stop" else "warn"
        reasons.append(f"单批增量 {human(pending_bytes)} > {human(WARN_BATCH)}")
    if bins:
        if verdict == "ok":
            verdict = "warn"
        reasons.append(f"发现 {len(bins)} 个非文本文件；二进制进了 workspace 就永久计入每轮备份")

    report = {
        "workspace_bytes": ws["total"], "git_bytes": gb, "est_tgz_bytes": est_tgz,
        "est_chunks": -(-memory_chars(root) // CHUNK_CHARS), "pending_bytes": pending_bytes,
        "verdict": verdict, "reasons": reasons,
        "binaries": bins[: a.max_binaries], "binaries_total": len(bins),
        "files": ws["files"] + (pend["files"] if pend else 0),
        "workspace": str(root),
        "human": {"workspace": human(ws["total"]), "git": human(gb),
                  "est_tgz": human(est_tgz), "pending": human(pending_bytes)},
    }
    print(json.dumps(report, ensure_ascii=False, indent=1))
    sys.exit({"ok": 0, "warn": 1, "stop": 2}[verdict])


if __name__ == "__main__":
    main()
