#!/usr/bin/env python3
"""dc_thread_dossier — 按「线程键」把邮件两侧（出站+入站）并成一份买家案卷。

线程键（田耕郡 2026-09-13 定）：**归一化主题 + 参与人集合**
  · 主题：去掉 Re:/Fwd:/回复/答复 前缀、去空白、小写、去掉尾部 (Sep 23-25, South Africa) 类尾巴（保留主体即可）
  · 参与人：sender + recipients 全量小写，排序后拼接（顺序无关）
键 = sha1(主题 + 参与人集合) 的前 12 位；同一线程里的邮件（无论收发、无论顺序）都归到一份案卷。

能力：
  · build_threads()   读事实层（outbound+inbound）→ {thread_key: [记录按时间正序]}
  · render_dossier()  生成案卷 md：买家信息 + 两侧原文（入站自动剥引用段）+ 分析占位
  · find_by_buyer()   按邮箱或域名反查该买家的所有线程键（正确调用用）

用法：
    python3 dc_thread_dossier.py --company-id <sid> --buyer khumalonk@hotmail.com --out x.md
    python3 dc_thread_dossier.py --subject Mosle --json
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

PREFIX = re.compile(r"^\s*(re|fwd|fw|回复|答复|转发)\s*[:：]\s*", re.I)
TAIL_PAREN = re.compile(r"\s*\([^)]{0,60}\)\s*$")


def normalize_subject(subject: str) -> str:
    s = str(subject or "")
    prev = None
    while prev != s:                      # 多次 Re: Re: 也要剥掉
        prev = s
        s = PREFIX.sub("", s)
    s = TAIL_PAREN.sub("", s).strip().lower()
    return re.sub(r"\s+", " ", s)


def participants(rec: dict) -> list[str]:
    emails = []
    frm = rec.get("sender") or ""
    if isinstance(frm, dict):
        frm = frm.get("email") or ""
    emails.append(str(frm))
    for r in (rec.get("recipients") or []):
        emails.append(str(r))
    return sorted({e.strip().lower() for e in emails if e and "@" in str(e)})


def thread_key(rec: dict) -> str:
    raw = normalize_subject(rec.get("subject")) + "|" + ",".join(participants(rec))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


QUOTE_MARKERS = (
    re.compile(r"^\s*On .{0,80}wrote:\s*$", re.I),
    re.compile(r"^\s*-{2,}\s*原始邮件\s*-{2,}", re.I),
    re.compile(r"^\s*From:\s", re.I),
    re.compile(r"^\s*发件人[:：]\s"),
    re.compile(r"^\s*_{5,}\s*$"),
)


def strip_quoted(text: str) -> str:
    """剥掉回信里引用的上一封（> 引用块、'On ... wrote:'、'发件人:' 之后的整段）。"""
    out = []
    for line in str(text or "").splitlines():
        if line.lstrip().startswith(">"):
            continue
        if any(p.match(line) for p in QUOTE_MARKERS):
            break
        out.append(line)
    cleaned = "\n".join(out).strip()
    return cleaned or str(text or "").strip()


def _rec_time(rec: dict) -> str:
    return str(rec.get("created_at") or rec.get("received_at") or rec.get("sent_at") or "")


def load_facts(data_dir=None, company_id: str = "") -> list[dict]:
    base = Path(data_dir) if data_dir else Path(os.environ.get("DC_DATA_DIR")
                                                or (HERE.parent.parent / "data"))
    out: list[dict] = []
    for direction in ("outbound", "inbound"):
        pat = str(base / f"email-facts/{direction}/{company_id}/**/*.md") if company_id \
            else str(base / f"email-facts/{direction}/**/*.md")
        for p in glob.glob(pat, recursive=True):
            t = Path(p).read_text(encoding="utf-8", errors="ignore")
            m = re.search(r"\{.*\}", t, re.S)
            if not m:
                continue
            try:
                rec = json.loads(m.group(0))
            except json.JSONDecodeError:
                continue
            rec["_direction"] = direction
            out.append(rec)
    # 租户收口：只并本租户绑定邮箱的往来（不串租户）
    if company_id:
        try:
            from dc_tenant_mailboxes import belongs_to_tenant, tenant_mailboxes
            boxes = tenant_mailboxes(company_id, base)
            if boxes:
                out = [r for r in out if belongs_to_tenant(r, boxes)]
        except Exception:
            pass
    return out


def build_threads(facts: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for rec in facts:
        groups.setdefault(thread_key(rec), []).append(rec)
    for k in groups:
        groups[k].sort(key=_rec_time)
    return groups


def find_by_buyer(facts: list[dict], buyer: str) -> list[str]:
    """按邮箱或域名反查该买家的线程键。"""
    needle = str(buyer or "").strip().lower()
    if not needle:
        return []
    keys = []
    for rec in facts:
        people = participants(rec)
        if any(needle == e or (needle.startswith("@") and e.endswith(needle))
               or (("@" in needle) and e == needle) for e in people) \
           or any(needle in e for e in people if needle and not needle.startswith("@")):
            k = thread_key(rec)
            if k not in keys:
                keys.append(k)
    return keys


def _human_size(n: object) -> str:
    try:
        n = float(n or 0)
    except (TypeError, ValueError):
        return ""
    if n <= 0:
        return ""
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024.0
    return ""


def attachment_lines(rec: dict, *, with_paths: bool = False) -> list[str]:
    """案卷里的附件段。

    默认只给文件名/大小/类型——案卷会作为飞书文档交付给客户，本地盘路径属于
    后台实现，不对外露（REDLINES 四·4）。Agent 需要真路径去喂 pdf/image 工具时，
    用 --with-paths（或直接读事实层记录的 attachments[].path）。
    """
    rows = rec.get("attachments")
    if not isinstance(rows, list) or not rows:
        return []
    out = ["**附件**"]
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("filename") or "attachment")
        bits = [b for b in (_human_size(row.get("size")), str(row.get("content_type") or "")) if b]
        line = f"- {name}" + (f"（{' · '.join(bits)}）" if bits else "")
        if not row.get("stored"):
            line += f" ⚠️未保存：{str(row.get('skipped') or row.get('error') or '原因未知')[:40]}"
        elif with_paths and row.get("path"):
            line += f"\n  - 本地路径：`{row['path']}`"
        out.append(line)
    return out + [""] if len(out) > 1 else []


def render_dossier(key: str, records: list[dict], *, analysis: str = "",
                   with_paths: bool = False) -> str:
    people = sorted({e for r in records for e in participants(r)
                     if "@" not in e or True})
    subjects = sorted({str(r.get("subject") or "") for r in records})
    L = ["# 一客一案 · 线程案卷", "",
         "- 线程键：`" + key + "`",
         "- 主题：" + " / ".join(subjects[:2]),
         "- 参与人：" + ", ".join(people),
         "- 邮件数：出站 " + str(sum(1 for r in records if r["_direction"] == "outbound"))
         + " / 入站 " + str(sum(1 for r in records if r["_direction"] == "inbound")),
         ]
    n_att = sum(len(r.get("attachments") or []) for r in records
                if isinstance(r.get("attachments"), list))
    if n_att:
        L.append("- 附件：" + str(n_att) + " 个")
    L += ["", "## 沟通记录 · 原文（时间正序，两侧合并）", ""]
    for r in records:
        tag = "邮件(出)" if r["_direction"] == "outbound" else "邮件(入)"
        L += [f"### [{_rec_time(r)[:16]}] {tag} · {str(r.get('subject') or '(无主题)')}", "",
              "- " + str(r.get("sender") or "") + " → " + ", ".join(r.get("recipients") or []), "",
              "```"]
        body = (r.get("text") or "").strip()
        if r["_direction"] == "inbound":
            body = strip_quoted(body)
        L += [body[:2000] if body else "(正文为空)", "```", ""]
        L += attachment_lines(r, with_paths=with_paths)
    L += ["## 我的分析", "", analysis or "- （待生成）", ""]
    return "\n".join(L)


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="按线程键合并邮件两侧成案卷")
    ap.add_argument("--company-id", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--data-dir", default="")
    ap.add_argument("--buyer", default="", help="按买家邮箱/域名反查")
    ap.add_argument("--subject", default="", help="按主题关键字筛")
    ap.add_argument("--key", default="", help="直接给线程键")
    ap.add_argument("--out", default="")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--with-paths", action="store_true",
                    help="附件附带本地盘路径（供 agent 喂 pdf/image 工具；对客户交付时勿开）")
    args = ap.parse_args(argv)

    facts = load_facts(args.data_dir or None, args.company_id)
    threads = build_threads(facts)
    picked: list[str] = []
    if args.key:
        picked = [args.key] if args.key in threads else []
    elif args.buyer:
        picked = find_by_buyer(facts, args.buyer)
    elif args.subject:
        needle = args.subject.lower()
        picked = [k for k, rs in threads.items()
                  if any(needle in str(r.get("subject") or "").lower() for r in rs)]
    if args.json:
        print(json.dumps({k: len(threads[k]) for k in (picked or threads)}, ensure_ascii=False, indent=2))
        return 0
    if not picked:
        print("没有匹配的线程")
        return 1
    md = "\n\n---\n\n".join(
        render_dossier(k, threads[k], with_paths=args.with_paths) for k in picked)
    if args.out:
        Path(args.out).write_text(md, encoding="utf-8")
        print("已写出:", args.out, "| 线程数:", len(picked))
    else:
        print(md)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
