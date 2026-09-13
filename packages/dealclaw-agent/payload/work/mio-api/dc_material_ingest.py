#!/usr/bin/env python3
"""dc_material_ingest — 用户上传物料 → 写入物料库（补齐缺失的写入链路）。

背景（2026-09-13 田耕郡报障）：用户发 PDF，解析准确，但**没写进物料库**，后续调用不到。
根因：引擎侧只有物料**读**接口（check_materials / get_material_links）与一个
`set_material`，没有任何"上传文件 → 落库"的入口；且物料条目过去只存
name/description/link，**不留文件本体与解析文本**，所以即使标了 ready 也调不到内容。

本工具做四步（幂等）：
  ① 归档：文件复制到 data/memory/<企业>/materials/<type>/<文件名>
  ② 留存：解析文本（可选）落同名 .txt，条目记 file/content_file/sha256/size
  ③ 入库：KBEngine.set_material(...) 写 kb.json（status=ready）并镜像 materials.json
  ④ 回读：get_material_links() 必须能取到该条目，取不到即报错（不谎报成功）
可选：若给 --bitable-app-token/--table-id/--record-id，则用 lark-cli 把文件加入资料层
附件列；缺参数时**明确报告 skipped**，不假装已同步文档。

用法：
    python3 dc_material_ingest.py --file /path/产品目录.pdf --type catalog \
        --text-file /path/parsed.txt --description "2026 版产品目录"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from dc_kb_engine import KBEngine, KB_DIR, DEFAULT_MATERIAL_TYPES, MATERIAL_LABELS  # noqa: E402

# 物料表/资料层的下拉选项名（必须与建表时的 options 完全一致，否则接口报 not_found）
BITABLE_TYPE_NAMES = {
    "catalog": "产品目录", "price": "报价单", "spec": "技术规格",
    "certificate": "认证证书", "sample": "样品实拍",
    "case_study": "客户案例", "video": "产品视频",
}

TYPE_HINTS = [
    ("certificate", r"证书|cert|认证|资质|iso|ce\b"),
    ("price", r"报价|price|quotation|quote"),
    ("spec", r"规格|spec|参数|datasheet|技术|参数表"),
    ("catalog", r"目录|catalog|画册|brochure|手册|介绍|ppt|演示"),
    ("case_study", r"案例|case|项目|project"),
    ("video", r"视频|video|\.(mp4|mov|avi|mkv)$"),
    ("sample", r"样品|sample|实拍|photo|主图|实景"),
]
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
DOC_EXT = {".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".md"}
VIDEO_EXT = {".mp4", ".mov", ".avi", ".mkv"}
SUPPORTED_EXT = IMAGE_EXT | DOC_EXT | VIDEO_EXT


def infer_type(filename: str, text: str = "") -> str:
    ext = Path(filename).suffix.lower()
    if ext in VIDEO_EXT:
        return "video"
    blob = f"{filename}\n{text[:500]}".lower()
    if ext in IMAGE_EXT and not any(k in blob for k in ("参数", "规格", "spec", "证书", "cert")):
        return "sample"          # 产品图片默认 = 样品实拍
    for mtype, pattern in TYPE_HINTS:
        if re.search(pattern, blob):
            return mtype
    return "catalog"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def publish_to_layer(*, files: dict, base_token: str, table_id: str,
                     field_id: str) -> dict:
    """把物料写进资料层/物料表（复用 dealclaw-knowledge-base 的 fill_material_index）。

    files: {物料类型中文名: [本地文件路径, ...]}
    一条记录 = 一个可独立调用的物料单元（沿用该脚本的粒度铁律）。
    """
    if not (base_token and table_id and field_id):
        return {"skipped": True, "reason": "未提供 base_token/table_id/field_id"}
    script_dir = next((p for p in Path(__file__).resolve().parents
                       if (p / "skills" / "dealclaw-knowledge-base" / "scripts"
                           / "fill_material_index.py").exists()), None)
    if script_dir is None:
        return {"skipped": True, "reason": "未找到 fill_material_index.py"}
    sys.path.insert(0, str(script_dir / "skills" / "dealclaw-knowledge-base" / "scripts"))
    try:
        import fill_material_index as fmi
    except Exception as e:
        return {"skipped": True, "reason": f"导入失败: {e}"}
    records, manifest = [], {}
    for cn_type, paths in files.items():
        for p in paths:
            name = Path(p).stem
            # select 字段用数组值；类型名必须命中建表时的 options
            records.append({"文件名称": name, "类型": [cn_type], "状态": ["✅"],
                            "营销用途": ""})
            manifest[name] = [str(p)]
    try:
        rids = fmi.create_records(base_token, table_id, records)
        mapping = {r["文件名称"]: rid for r, rid in zip(records, rids or [])}
        for name, paths in manifest.items():
            rid = mapping.get(name)
            if rid:
                fmi.attach_files(base_token, table_id, field_id, rid, paths)
        return {"skipped": False, "ok": True, "records": len(records),
                "attached": sum(1 for n in manifest if mapping.get(n))}
    except Exception as e:
        return {"skipped": False, "ok": False, "error": str(e)[:200]}


def _maybe_upload_bitable(file_path: Path, *, app_token: str, table_id: str,
                          record_id: str) -> dict:
    """把文件加入资料层 bitable 附件列（lark-cli）。参数不全时不执行。"""
    if not (app_token and table_id and record_id):
        return {"skipped": True, "reason": "未提供 bitable app_token/table_id/record_id"}
    cmd = ["lark-cli", "base", "+record-upload-attachment",
           "--base-token", app_token, "--table-id", table_id,
           "--record-id", record_id, "--file", str(file_path), "--as", "bot"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        return {"skipped": False, "ok": out.returncode == 0,
                "stderr": out.stderr[-200:] if out.returncode else ""}
    except Exception as e:  # 上传失败不影响本地入库
        return {"skipped": False, "ok": False, "stderr": str(e)[:200]}


def ingest(*, enterprise: str, file_path: Path, mtype: str = "", name: str = "",
           description: str = "", text: str = "", link: str = "",
           bitable: tuple[str, str, str, str] = ("", "", "", ""),
           auto_target: bool = True) -> dict:
    if not file_path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")
    if file_path.suffix.lower() not in SUPPORTED_EXT:
        raise ValueError(f"不支持的文件类型 {file_path.suffix}（支持：{', '.join(sorted(SUPPORTED_EXT))}）")
    digest = sha256_of(file_path)
    if not mtype:
        mtype = infer_type(file_path.name, text)
    if mtype not in DEFAULT_MATERIAL_TYPES:
        raise ValueError(f"未知物料类型 {mtype}（可选：{', '.join(DEFAULT_MATERIAL_TYPES)}）")

    key = KBEngine()._key(enterprise) if hasattr(KBEngine(), "_key") else enterprise
    dest_dir = KB_DIR / key / "materials" / mtype
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / file_path.name
    if file_path.resolve() != dest.resolve():
        shutil.copy2(file_path, dest)
    content_file = ""
    if text:
        cpath = dest.with_suffix(dest.suffix + ".txt")
        cpath.write_text(text, encoding="utf-8")
        content_file = str(cpath)

    kb = KBEngine()
    before = kb.ensure(enterprise).get("materials", {}).get(mtype, {})
    kb.set_material(enterprise, mtype, name=name or file_path.stem,
                    description=description or before.get("description", ""),
                    link=link)
    # 扩展字段（文件本体/解析文本/指纹）——让"后续调用得到"成立
    cur = kb.ensure(enterprise)
    cur.setdefault("materials", {})[mtype].update({
        "file": str(dest), "content_file": content_file, "sha256": digest,
        "size": dest.stat().st_size, "source": "user_upload",
        "updated_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).isoformat(),
    })
    kb._save(enterprise, cur)

    # 资料层/物料表：未传坐标时自动解析（找不到就建），不再向人要 token
    cn_type = BITABLE_TYPE_NAMES.get(mtype, MATERIAL_LABELS.get(mtype, mtype))
    base_token, table_id, field_id = bitable[0], bitable[1], (bitable[3] or bitable[2])
    target_info: dict = {}
    if not (base_token and table_id and field_id) and auto_target:
        try:
            import dc_material_target as dmt
            tgt = dmt.resolve_target(enterprise, company_name=name or "")
            base_token = tgt["base_token"]; table_id = tgt["table_id"]
            field_id = tgt["attachment_field_id"]
            target_info = {"resolved": True, "source": tgt.get("source"),
                           "created": tgt.get("created")}
        except Exception as e:
            target_info = {"resolved": False, "error": str(e)[:160]}
    bitable_result = publish_to_layer(files={cn_type: [dest]},
                                      base_token=base_token, table_id=table_id,
                                      field_id=field_id)
    if target_info:
        bitable_result["target"] = target_info
    # 回读验证：必须能通过下游读接口取到
    links = {m["type"]: m for m in kb.get_material_links(enterprise)}
    ok = mtype in links
    return {
        "enterprise": enterprise, "type": mtype, "file": str(dest),
        "content_file": content_file, "sha256": digest,
        "size": dest.stat().st_size, "idempotent_update": bool(before),
        "bitable": bitable_result,
        "verified_readable": ok,
        "readback": links.get(mtype, {}),
    }


def main(argv=None) -> int:  # pragma: no cover
    ap = argparse.ArgumentParser(description="用户上传物料 → 写入物料库")
    ap.add_argument("--file", required=True, help="物料文件路径")
    ap.add_argument("--type", default="", help=f"物料类型（{', '.join(DEFAULT_MATERIAL_TYPES)}）")
    ap.add_argument("--name", default="")
    ap.add_argument("--description", default="")
    ap.add_argument("--text-file", default="", help="解析出的文本（可选，会留存）")
    ap.add_argument("--link", default="", help="外部链接（如飞书文档）")
    ap.add_argument("--enterprise", default=os.environ.get("MIO_CDP_SUPPLIER_ID", ""))
    ap.add_argument("--bitable-app-token", default="", help="资料层/物料表 base token")
    ap.add_argument("--table-id", default="")
    ap.add_argument("--field-id", default="", help="附件列 field id")
    ap.add_argument("--record-id", default="", help="（兼容旧参，等同 field-id 缺省时的占位）")
    ap.add_argument("--no-auto-target", action="store_true", help="不自动解析物料表坐标")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if not args.enterprise:
        print("缺少 enterprise（可用 --enterprise 或 MIO_CDP_SUPPLIER_ID）", file=sys.stderr)
        return 2
    text = Path(args.text_file).read_text(encoding="utf-8") if args.text_file else ""
    try:
        r = ingest(enterprise=args.enterprise, file_path=Path(args.file), mtype=args.type,
                   name=args.name, description=args.description, text=text, link=args.link,
                   bitable=(args.bitable_app_token, args.table_id, args.record_id,
                            args.field_id),
                   auto_target=not args.no_auto_target)
    except Exception as e:
        print(f"入库失败: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(f"✅ 已入库：{MATERIAL_LABELS.get(r['type'], r['type'])} · {r['file']}")
        print(f"   可被下游调用：{r['verified_readable']} | 附件同步：{r['bitable']}")
    return 0 if r["verified_readable"] else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
