#!/usr/bin/env python3
"""memory/index.md 的水位与格式守护：行数水位 / 格式 / 死链 / 三级标题分组折叠。

SCHEMA.md：index 是目录，每页一行 `- [标题](路径) — 一句话`，按类别分组，目标 ≤300 行。
index 一旦超长或者格式乱掉，Librarian 的自动 reindex 和可达性检查都会跟着失真。

- `--check`：只报告不改，输出 JSON；水位 >50% 或有 malformed / 死链时非零退出。
- 默认模式：某个 `## ` 分节条目超过阈值（默认 25）时，按子类插入 `### ` 分组。
  **只重排不删行**，条目数对不上就中止；写回前先打 diff。
- malformed 口径：`- ` / `* ` 开头的行必须匹配 `- [x](y) — z`；标题、空行、表格、引言块、
  纯说明文字都放过；但不以 `- ` 开头却带 markdown 链接的行算漏了列表前缀。
- 死链：markdown 链接相对 `memory/` 解析，文件不存在即死链（软链接本身存在就算数）。

Usage:
  index-compact.py --check [--workspace DIR]
  index-compact.py [--threshold 25] [--rules rules.json] [--dry-run]
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

TARGET_LINES = 300
WATERMARK_CEIL = 0.5
OTHER = "其他"
ENTRY = re.compile(r"^[-*] \[[^\]]+\]\([^)\s]+\)\s+—\s+\S")
LOOSE = re.compile(r"^[-*]\s")
LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
CODE = re.compile(r"`[^`]*`")      # 行内代码里的格式示例不是真链接
SKIP_LINK = ("http://", "https://", "mailto:", "#")
# 子类关键词表：命中即归组，都不命中进「其他」。客户不一样时用 --rules 覆盖。
DEFAULT_RULES = {
    "Concepts": [
        ["公司与产品", ["公司", "产品", "品牌", "官网", "组织架构", "业务线", "黑话", "glossary"]],
        ["销售", ["销售", "客户", "线索", "商机", "报价", "定价", "合同", "渠道", "转化"]],
        ["交付", ["交付", "实施", "上线", "运维", "排期", "验收", "SOP", "流程", "工单"]],
        ["合规", ["合规", "安全", "隐私", "红线", "审批", "权限", "授权", "数据主权", "法务", "资质"]],
    ],
    "Projects": [
        ["在跑的", ["进行中", "在跑", "current", "active"]],
        ["已交付", ["已交付", "已上线", "结项", "归档"]],
    ],
}


def find_workspace(explicit: str | None) -> Path:
    """任意 cwd 下可跑：--workspace 优先，否则从脚本位置和 cwd 往上找 AGENTS.md。"""
    if explicit:
        d = Path(explicit).expanduser().resolve()
        if not (d / "AGENTS.md").is_file():
            sys.exit(f"--workspace {d} 下没有 AGENTS.md")
        return d
    for base in (Path(__file__).resolve().parent, Path.cwd().resolve()):
        for d in (base, *base.parents):
            if (d / "AGENTS.md").is_file():
                return d
    sys.exit("找不到工作区（向上没找到 AGENTS.md），用 --workspace 指定")


def split_sections(lines: list[str]) -> list[tuple[str | None, list[str]]]:
    out: list[tuple[str | None, list[str]]] = [(None, [])]
    for l in lines:
        if l.startswith("## ") and not l.startswith("###"):
            out.append((l, []))
        else:
            out[-1][1].append(l)
    return out


def check(path: Path, lines: list[str]) -> dict:
    malformed, broken = [], []
    for n, l in enumerate(lines, 1):
        s = CODE.sub("", l).strip()
        if not s:
            continue
        # 标题 / 表格 / 引言块 / HTML 注释不参与格式校验，但里面的链接照查
        if not s.startswith(("#", "|", ">", "<!--", "---")):
            if LOOSE.match(s):
                if not ENTRY.match(l.strip()):
                    malformed.append({"line": n, "text": l.strip()[:120]})
            elif LINK.search(s):
                malformed.append({"line": n, "text": l.strip()[:120]})
        for href in LINK.findall(s):
            if href.startswith(SKIP_LINK):
                continue
            t = href.split("#")[0]
            p = path.parent / t
            if t and not (p.exists() or p.is_symlink()):
                broken.append({"line": n, "href": href})
    sections = OrderedDict()
    for head, body in split_sections(lines):
        if head is None:
            continue
        sections[head[3:].strip()] = {
            "lines": len([x for x in body if x.strip()]),
            "entries": len([x for x in body if LOOSE.match(x.strip())]),
        }
    return {"lines": len(lines), "watermark": round(len(lines) / TARGET_LINES, 3),
            "malformed": malformed, "broken_links": broken, "sections": sections}


def classify(line: str, table: list) -> str:
    low = line.lower()
    for name, kws in table:
        if any(k.lower() in low for k in kws):
            return name
    return OTHER


def regroup(head: str, body: list[str], rules: dict, threshold: int) -> tuple[list[str], str | None]:
    """把一个超阈值的 `## ` 分节折成 `### ` 子组；返回 (新行, 提示)。"""
    name = head[3:].strip()
    entries = [l for l in body if LOOSE.match(l.strip())]
    if len(entries) <= threshold:
        return [head] + body, None
    table = rules.get(name)
    if not table:
        return [head] + body, f"{name} 有 {len(entries)} 条超过 {threshold}，但没有分组规则（--rules 提供）"
    groups: OrderedDict[str, list[str]] = OrderedDict((g, []) for g, _ in table)
    notes, cur, seen, declared = [], None, False, set()
    for l in body:
        s = l.strip()
        if s.startswith("### "):
            cur = s[4:].strip()
            declared.add(cur)
            groups.setdefault(cur, [])
        elif LOOSE.match(s):
            seen = True
            # 关键词优先；没命中规则的留在它当前所在的 `### ` 里（保住人工归类），再不行进「其他」
            g = classify(l, table)
            if g == OTHER and cur:
                g = cur
            groups.setdefault(g, []).append(l)
        elif s:
            if not seen and cur is None:
                notes.append(l)          # 分节开头的说明文字留在原位
            else:
                groups.setdefault(cur or OTHER, []).append(l)   # 夹在条目间的行跟着当前组走
    out = [head, ""]
    if notes:
        out += notes + [""]
    # 已经手写在文件里的 `### ` 即使暂时为空也保留，只有新造的空分组不输出
    ordered = [(g, v) for g, v in groups.items() if (v or g in declared) and g != OTHER]
    if groups.get(OTHER) or OTHER in declared:
        ordered.append((OTHER, groups.get(OTHER, [])))      # 「其他」永远排最后
    for g, items in ordered:
        out += [f"### {g}", ""] + (items + [""] if items else [])
    if out == [head] + body:
        return out, None                      # 已经是分好组的样子，不刷屏
    return out, f"{name}：{len(entries)} 条 → {len(ordered)} 个 ### 分组"


def main() -> int:
    ap = argparse.ArgumentParser(description="index.md 水位守护 + 三级标题分组折叠")
    ap.add_argument("--workspace")
    ap.add_argument("--check", action="store_true", help="只报告不改")
    ap.add_argument("--threshold", type=int, default=25, help="`## ` 分节超过多少条就折叠")
    ap.add_argument("--rules", help='子类关键词表 JSON，按分节名覆盖内置默认，形如 {"Concepts": [["销售", ["客户","报价"]]]}')
    ap.add_argument("--dry-run", action="store_true", help="只打 diff 不写回")
    a = ap.parse_args()

    ws = find_workspace(a.workspace)
    path = ws / "memory" / "index.md"
    if not path.is_file():
        sys.exit(f"没有 {path}")
    old = path.read_text(encoding="utf-8").splitlines()
    rules = dict(DEFAULT_RULES)
    if a.rules:   # 按分节名覆盖，没提到的分节继续用内置规则
        rules.update(json.loads(Path(a.rules).read_text(encoding="utf-8")))

    rep = check(path, old)
    if a.check:
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        bad = rep["watermark"] > WATERMARK_CEIL or rep["malformed"] or rep["broken_links"]
        if bad:
            print(f"水位 {rep['watermark']} / malformed {len(rep['malformed'])} / "
                  f"死链 {len(rep['broken_links'])}", file=sys.stderr)
        return 1 if bad else 0

    new: list[str] = []
    for head, body in split_sections(old):
        if head is None:
            new += body
            continue
        lines, note = regroup(head, body, rules, a.threshold)
        new += lines
        if note:
            print(f"[fold] {note}")
    while new and not new[-1].strip():
        new.pop()
    before = sorted(l for l in old if LOOSE.match(l.strip()))
    after = sorted(l for l in new if LOOSE.match(l.strip()))
    if before != after:
        sys.exit("中止：折叠前后条目对不上（只允许重排，不允许增删）")
    if new == old:
        print("无需改动")
    else:
        print("\n".join(difflib.unified_diff(old, new, "index.md (before)", "index.md (after)", lineterm="")))
        if a.dry_run:
            print("[dry-run] 没写回")
        else:
            path.write_text("\n".join(new) + "\n", encoding="utf-8")
            print(f"已写回 {path}")
    print(json.dumps(check(path, path.read_text(encoding="utf-8").splitlines()), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
