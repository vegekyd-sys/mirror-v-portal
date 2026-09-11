#!/usr/bin/env python3
"""scan_git_secrets.py — 扫描 Git 提交内容里的敏感信息（分发前安全检查）

扫描 git 跟踪的文件，检出：企业名 / 邮箱 / 电话 / 域名 / 客户ID(长数字) / open_id /
API Key / Token。**报告只输出计数、文件路径与掩码样例，不落原文。**

用法：
  python3 tools/reflection-review/scan_git_secrets.py [--repo DIR] [--out DIR] [--json]
输出：
  {out}/security-scan-<YYYY-MM-DD>.md   （默认 out=<repo>/data/reflection-review）
  掩码报告可直接提交；原始命中不写盘。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

PATTERNS = {
    "api_key": re.compile(r"(?i)sk-[A-Za-z0-9_\-]{12,}|AIza[0-9A-Za-z_\-]{20,}|xai-[A-Za-z0-9]{16,}"
                          r"|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}"),
    "token_header": re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{10,}"),
    "email": re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
    "phone": re.compile(r"(?<!\d)(?:\+?\d[\d\s-]{7,}\d)(?!\d)"),
    "open_id": re.compile(r"\bou_[0-9a-f]{16,}\b"),
    "domain": re.compile(r"\b(?:[a-z0-9-]+\.)+(?:com|cn|io|net|org|co|br|de|uk|jp|in|vn|id|mx|za|ae|sa|pl|tr|eg|ru)\b"),
    "long_id": re.compile(r"\b\d{9,}\b"),
    "company_name": re.compile(r"[^\s，。]{2,20}(?:有限公司|股份有限公司|集团|科技有限|Co\.,?\s?Ltd)"),
}
TEXT_EXT = {".md", ".py", ".json", ".jsonl", ".txt", ".yaml", ".yml", ".mjs", ".js", ".ts",
            ".sh", ".csv", ".xml", ".html", ".env", ""}
SKIP_DIRS = ("node_modules/", ".git/", "dist/", "backups/", "trash/")
MASK = {"api_key": "sk-****", "token_header": "Bearer ****", "email": "u***@***",
        "phone": "+**-****", "open_id": "ou_****", "domain": "***.com",
        "long_id": "*********", "company_name": "***公司"}


def _files(repo: Path) -> list[str]:
    out = subprocess.check_output(["git", "-C", str(repo), "ls-files"], text=True)
    return [l.strip() for l in out.splitlines() if l.strip()]


def scan(repo: Path) -> dict:
    counts = {k: 0 for k in PATTERNS}
    by_file: dict[str, dict] = {}
    for rel in _files(repo):
        if any(s in rel + "/" for s in SKIP_DIRS):
            continue
        p = repo / rel
        if not p.is_file() or p.suffix.lower() not in TEXT_EXT:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        hits = {}
        for kind, pat in PATTERNS.items():
            n = len(pat.findall(text))
            if n:
                hits[kind] = n
                counts[kind] += n
        if hits:
            by_file[rel] = hits
    return {"counts": counts, "by_file": by_file,
            "total": sum(counts.values()), "files_with_hits": len(by_file)}


def render_md(res: dict, generated_at: str) -> str:
    lines = ["# Git 敏感信息扫描报告（掩码）", "",
             f"> 生成：{generated_at} · 扫描范围：git 跟踪文件 · **报告不含原文，仅计数与文件路径**", "",
             "## 汇总", ""]
    for k, v in res["counts"].items():
        lines.append(f"- {k}: {v}")
    lines += ["", f"命中文件数：{res['files_with_hits']} · 命中总数：{res['total']}", "",
              "## 命中文件（前 40）", ""]
    for rel, hits in list(res["by_file"].items())[:40]:
        detail = ", ".join(f"{k}×{v}" for k, v in hits.items())
        lines.append(f"- `{rel}` → {detail}")
    lines += ["", "> 说明：本报告只用于分发前安全检查；如需处置具体命中，请在受控环境中查看原文件。"]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="扫描 Git 提交中的敏感信息（掩码报告）")
    ap.add_argument("--repo", default="", help="仓库根（默认脚本上两级）")
    ap.add_argument("--out", default="", help="报告输出目录（默认 {repo}/data/reflection-review）")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    repo = Path(args.repo).expanduser() if args.repo else Path(__file__).resolve().parents[2]
    out = Path(args.out).expanduser() if args.out else repo / "data" / "reflection-review"
    out.mkdir(parents=True, exist_ok=True)

    res = scan(repo)
    today = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
    generated_at = datetime.now(timezone.utc).isoformat()
    md = out / f"security-scan-{today}.md"
    md.write_text(render_md(res, generated_at), encoding="utf-8")
    (out / f"security-scan-{today}.json").write_text(
        json.dumps({"generated_at": generated_at, **res}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"[scan_git_secrets] 命中 {res['total']} 处 / {res['files_with_hits']} 文件 → {md}")
    print(f"[scan_git_secrets] 分类计数：{res['counts']}")
    if args.json:
        print(json.dumps(res["counts"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
