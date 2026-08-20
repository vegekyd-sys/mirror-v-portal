#!/usr/bin/env python3
"""
dealclaw-knowledge-base · 物料索引填充工具

把官网爬到的图片/文件填进资料层 bitable：建记录 + 上传附件 + 同步 KB materials。
资料层字段：类型 / 文件名称 / 状态 / 营销用途 / 附件(attachment)。

粒度铁律：一条记录 = 一个可独立调用的物料单元。
  产品主图 → 样品实拍（1 张/条）
  参数表   → 技术规格（N 页挂 1 条）
  证书     → 认证证书（1 张/条）

依赖：lark-cli（PATH 中可用）、dc_kb_engine（同目录 ../.. 下的 work/mio-api，仅 sync 时用）。

示例：
  python3 fill_material_index.py classify /tmp/imgs   # 识别主图 vs 参数表
  python3 fill_material_index.py create --enterprise testco \
      --base-token SwORbBLEFakCGysoJPFcSUnsnnf --table-id tblO2kAH4655zDip \
      --records records.json
  python3 fill_material_index.py attach \
      --base-token SwORbBLEFakCGysoJPFcSUnsnnf --table-id tblO2kAH4655zDip \
      --field-id fldQMB1a7P --mapping name_to_rid.json --manifest manifest.json
  python3 fill_material_index.py sync --enterprise testco --status status.json
"""

import json
import os
import subprocess
import sys
from pathlib import Path

MATERIAL_TYPES = ["产品目录", "报价单", "技术规格", "认证证书",
                  "样品实拍", "客户案例", "产品视频"]

# materials 键 → 物料类型中文名（KB 引擎 materials 键与资料层类型的映射）
MATERIAL_TYPE_TO_KEY = {
    "产品目录": "catalog",
    "报价单": "price",
    "技术规格": "spec",
    "认证证书": "certificate",
    "样品实拍": "sample",
    "客户案例": "case_study",
    "产品视频": "video",
}


def _run_lark(*args, timeout=90):
    """执行 lark-cli，返回解析后的 JSON dict。失败抛 RuntimeError。"""
    cmd = ["lark-cli"] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        raise RuntimeError("lark-cli 未安装或不在 PATH")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"lark-cli 超时({timeout}s): {' '.join(cmd)}")

    if r.returncode != 0:
        raise RuntimeError(f"lark-cli 失败 [exit={r.returncode}]: {(r.stderr or r.stdout)[:300]}")
    out = r.stdout.strip()
    if not out:
        raise RuntimeError("lark-cli 返回空输出")
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        raise RuntimeError(f"lark-cli 非 JSON 输出: {out[:200]}")
    if not data.get("ok"):
        raise RuntimeError(f"lark-cli API 错误: {data.get('error')}")
    return data


# ── 图片分类：主图 vs 参数表（尺寸启发式）─────────────────────────────

def _image_size(path):
    """读图片宽高。优先 PIL，退回 `file` 命令解析。返回 (w, h) 或 (0, 0)。"""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return im.size
    except Exception:
        pass
    # 退回 file 命令：JPEG image data ... 1056x800 ...
    try:
        r = subprocess.run(["file", "-b", str(path)], capture_output=True, text=True)
        import re
        m = re.search(r"(\d{2,5})x(\d{2,5})", r.stdout)
        if m:
            return int(m.group(1)), int(m.group(2))
    except Exception:
        pass
    return 0, 0


def classify_image(path):
    """
    判断图片是「主图」还是「参数表」（尺寸启发式，仅作兜底）。
    启发式：横向（宽>高）→ 主图；纵向且接近 A4 比例（高/宽 > 1.2）→ 参数表。
    返回 "main" | "param" | "unknown"。

    局限：参数表内部可能有横向页，会被误判为 main。
    因此**优先靠文件名语义**（-主图 / -参数表-NN），本函数只在文件名无语义时兜底。
    """
    w, h = _image_size(path)
    if w == 0 or h == 0:
        return "unknown"
    if w > h:
        return "main"
    if h / w > 1.2:
        return "param"
    return "unknown"


def classify_dir(img_dir):
    """对目录内图片分类，返回 {"main": [paths], "param": [paths], "unknown": [paths]}。"""
    result = {"main": [], "param": [], "unknown": []}
    for f in sorted(os.listdir(img_dir)):
        if not f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            continue
        kind = classify_image(os.path.join(img_dir, f))
        result[kind].append(os.path.join(img_dir, f))
    return result


# ── 记录创建 ──────────────────────────────────────────────────────

def create_records(base_token, table_id, records):
    """
    批量建记录。records = [{"类型":..., "文件名称":..., "状态":..., "营销用途":...}, ...]
    返回 record_id 列表（与 records 顺序一致）。
    """
    data = _run_lark("base", "+record-batch-create",
                     "--base-token", base_token, "--table-id", table_id,
                     "--json", json.dumps({"create_records": records}, ensure_ascii=False),
                     "--as", "bot", timeout=90)
    return data.get("data", {}).get("record_id_list", [])


def delete_records(base_token, table_id, record_ids):
    """批量删除记录。需 --yes（high-risk-write）。"""
    _run_lark("base", "+record-delete",
              "--base-token", base_token, "--table-id", table_id,
              "--json", json.dumps({"record_id_list": record_ids}, ensure_ascii=False),
              "--as", "bot", "--yes", timeout=90)


# ── 附件上传 ──────────────────────────────────────────────────────

def attach_files(base_token, table_id, field_id, record_id, file_paths):
    """
    上传本地文件到指定记录的附件列。
    file_paths 可以是绝对路径（内部会 cd 到文件所在目录用相对路径传，规避 lark-cli 安全限制）。
    """
    if not file_paths:
        return
    # lark-cli --file 要求相对路径（当前目录内），故统一用文件所在目录 + 相对名
    first = file_paths[0]
    cwd = os.path.dirname(os.path.abspath(first))
    rel = [os.path.basename(os.path.abspath(p)) for p in file_paths]

    args = ["lark-cli", "base", "+record-upload-attachment",
            "--base-token", base_token, "--table-id", table_id,
            "--record-id", record_id, "--field-id", field_id,
            "--as", "bot", "--format", "json"]
    for r in rel:
        args += ["--file", f"./{r}"]
    r = subprocess.run(args, capture_output=True, text=True, cwd=cwd, timeout=180)
    if '"ok": true' not in r.stdout and '"ok":true' not in r.stdout:
        raise RuntimeError(f"附件上传失败: {r.stdout[:200] or r.stderr[:200]}")
    return True


# ── materials 同步 ────────────────────────────────────────────────

def sync_materials(enterprise, status_map, kb_dir=None):
    """
    同步 dc_kb_engine 的 materials 字段，驱动 docx 物料清单状态。
    status_map = {"certificate": "ready", "sample": "ready", ...}
    键取值：catalog/price/spec/certificate/sample/case_study/video；值 ready/missing。
    kb_dir: 指向 work/mio-api（含 dc_kb_engine.py）的目录，默认自动探测。
    """
    if kb_dir is None:
        kb_dir = _find_kb_dir()
    sys.path.insert(0, kb_dir)
    from dc_kb_engine import KBEngine
    kb = KBEngine().ensure(enterprise)
    mats = kb.get("materials", {})
    for key, status in status_map.items():
        if key in mats:
            mats[key]["status"] = status
            if status == "ready" and not mats[key].get("name"):
                mats[key]["name"] = MATERIAL_TYPE_TO_KEY.get(key, key)
    kb["materials"] = mats
    KBEngine()._save(enterprise, kb)
    return {k: v.get("status") for k, v in mats.items()}


def _find_kb_dir():
    """从脚本位置向上探测 work/mio-api。"""
    here = Path(__file__).resolve()
    for up in [here.parents[0], here.parents[1], here.parents[2], here.parents[3]]:
        for cand in [up, up / "work" / "mio-api", up / ".." / "work" / "mio-api"]:
            if (cand / "dc_kb_engine.py").exists():
                return str(cand.resolve())
    raise RuntimeError("找不到 dc_kb_engine.py，请用 --kb-dir 指定 work/mio-api 目录")


# ── CLI ──────────────────────────────────────────────────────────

def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    def opt(name):
        if name in args:
            return args[args.index(name) + 1]
        return None

    if cmd == "classify":
        d = args[0] if args else "."
        res = classify_dir(d)
        print(json.dumps({k: [os.path.basename(p) for p in v] for k, v in res.items()},
                         ensure_ascii=False, indent=2))
    elif cmd == "create":
        base_token = opt("--base-token")
        table_id = opt("--table-id")
        records = _load_json(opt("--records"))
        rids = create_records(base_token, table_id, records)
        print(json.dumps({"record_id_list": rids}, ensure_ascii=False))
    elif cmd == "attach":
        base_token = opt("--base-token")
        table_id = opt("--table-id")
        field_id = opt("--field-id")
        mapping = _load_json(opt("--mapping"))   # {文件名称: record_id}
        manifest = _load_json(opt("--manifest"))  # {文件名称: [文件路径]}
        for name, files in manifest.items():
            rid = mapping.get(name)
            if not rid:
                print(f"跳过（无 record_id）: {name}")
                continue
            attach_files(base_token, table_id, field_id, rid, files)
            print(f"已上传 {len(files)} 文件 → {name}")
    elif cmd == "sync":
        enterprise = opt("--enterprise")
        status = _load_json(opt("--status"))
        kb_dir = opt("--kb-dir")
        result = sync_materials(enterprise, status, kb_dir)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"未知命令: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
