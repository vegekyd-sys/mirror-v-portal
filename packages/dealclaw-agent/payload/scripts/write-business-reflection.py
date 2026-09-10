#!/usr/bin/env python3
"""write-reflection.py — 自进化反思落库

把 agent 学到的「可复用经验」写进 reflections.jsonl，供日报「最近更懂你了」和后续任务读取。

用法:
  python3 write-reflection.py --type preference --what "东南亚只做印尼越南" --how "推荐自动过滤泰国"
  python3 write-reflection.py --type pattern --what "CDP getBasicInfo 返回测试号名" --how "公司名走绑定/画像解析"

type 枚举:
  preference  用户稳定偏好（跨会话生效）
  fact        用户提供的事实（企业/产品/市场等）
  pattern     发现的规律/技术经验（可复用）
  correction  用户纠正（口径/认知校准）

⚠️ 口径：reflection 只存「业务层学习」（用户偏好/业务事实/业务纠偏/业务规律），
这是会给用户看的（日报「最近更懂你了」/对话表达）。
技术内部经验（接口坑/授权边界/系统实现）不走 reflection，走每日 memory 的「关键坑与经验」。
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

# reflections 存储路径：memory/projects/dealclaw/reflections.jsonl
REFLECTIONS_PATH = (
    Path(__file__).resolve().parents[1] / "memory" / "projects" / "dealclaw" / "reflections.jsonl"
)

VALID_TYPES = {"preference", "fact", "pattern", "correction"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_reflection(what: str, how: str, rtype: str = "pattern", user: str = "", ts: str = "") -> dict:
    """追加一条反思。返回 {ok, entry, path} 或 {ok:False, error}。"""
    if rtype not in VALID_TYPES:
        return {"ok": False, "error": f"type 必须是 {sorted(VALID_TYPES)}"}
    what = (what or "").strip()
    how = (how or "").strip()
    if not what:
        return {"ok": False, "error": "what（学到了什么）不能为空"}
    entry = {
        "ts": (ts or _now_iso()).strip(),
        "type": rtype,
        "what": what,
        "how": how,
        "user": (user or "").strip(),
    }
    REFLECTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(REFLECTIONS_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return {"ok": True, "entry": entry, "path": str(REFLECTIONS_PATH)}


def main() -> int:
    ap = argparse.ArgumentParser(description="写一条自进化反思到 reflections.jsonl")
    ap.add_argument("--type", default="pattern", choices=sorted(VALID_TYPES))
    ap.add_argument("--what", required=True, help="学到了什么")
    ap.add_argument("--how", default="", help="后面怎么用")
    ap.add_argument("--user", default="", help="关联用户 open_id（可选）")
    ap.add_argument("--ts", default="", help="时间戳（可选，默认当前 UTC）")
    args = ap.parse_args()
    result = write_reflection(args.what, args.how, args.type, args.user, args.ts)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
