#!/usr/bin/env python3
"""飞书文档库 → 记忆冷启动：装 lark-cli、查权限、盘点、拉正文，交给 Librarian。

对大多数主人来说，飞书文档库是最大的记忆来源。这台机器可以自己装 npm 包
（全局前缀在 agent-data/npm，休眠和备份都保留），所以读飞书的办法就是装上
官方的 lark-cli，让主人自己授权，然后用主人的身份去读他本来就能看到的文档。
凭据只在 lark-cli 自己的目录里（agent-data/lark-cli），不经过记忆、不进 git。

子命令（都在工作区根目录跑）：
  setup        装 lark-cli（已装就跳过），把它的配置目录放进 agent-data，打印当前状态
  status       只看状态：装没装、有没有绑定应用、是不是用户身份、token 是否有效
  scopes       对照拉文档需要的权限，列出应用还缺哪几项
  inventory    盘点：所有知识空间 + 个人文档库的节点树，只读目录不读正文
  pull         按盘点结果拉正文，逐份交给 onboard-collect.py（--source feishu）

授权本身不在这个脚本里做，因为要主人在手机上点链接，跨好几轮对话，
步骤见 skills/memory-cold-start/SKILL.md 的「飞书文档库」一节。

实测（2026-10-20，一个真实企业飞书）：13 个空间 / 117 个节点，盘点 41 秒；
81 篇正文 199k 字，拉取 84 秒、零失败。117 个节点里 70 个是老版 doc，
`docs +fetch` 读不了它（报 3380002），必须走 /open-apis/doc/v2/<token>/raw_content。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

LARK_VERSION = "1.0.89"
SANDBOX_DATA = Path("/vercel/sandbox/agent-data")
# 拉文档实际用到的用户身份只读权限。老版 doc 那一项是按本机实测推的，
# 以 `lark-cli auth check` 在真实租户上的结果为准。
REQUIRED_SCOPES = {
    "wiki:space:retrieve": "列出知识空间",
    "wiki:node:retrieve": "列出知识空间里的页面树",
    "docx:document:readonly": "读新版文档",
    "docs:document.content:read": "读老版文档（企业知识库里常常占一大半）",
}
OPTIONAL_SCOPES = {"drive:drive.metadata:readonly": "盘点个人云空间"}
# 默认不读的东西：飞书自带样例，以及标题一看就是凭据的页面。
EXCLUDE_SPACE = re.compile(r"示例知识库|Wiki samples", re.I)
EXCLUDE_TITLE = re.compile(r"凭证|密码|口令|账号清单|账号密码|身份证|银行卡|secret|token|api[_ -]?key|私钥", re.I)
FETCHABLE = {"docx", "doc"}
MAX_DEPTH = 6


def workspace() -> Path:
    here = Path(__file__).resolve().parent
    for p in (here, *here.parents):
        if (p / "AGENTS.md").exists():
            return p
    return Path.cwd()


WS = workspace()
STATE_DIR = WS / "onboarding"
INVENTORY = STATE_DIR / "feishu-inventory.json"
PULLED = STATE_DIR / "feishu-pulled.json"


def lark_env() -> dict:
    env = dict(os.environ)
    env.setdefault("LARKSUITE_CLI_NO_UPDATE_NOTIFIER", "1")
    env.setdefault("LARKSUITE_CLI_NO_SKILLS_NOTIFIER", "1")
    return env


def lark(*args: str, timeout: int = 120) -> tuple[dict | None, str | None]:
    """跑一条 lark-cli，返回 (data, error)。人看的提示行在 stderr，不影响解析。"""
    try:
        p = subprocess.run(["lark-cli", *args], capture_output=True, text=True,
                           timeout=timeout, env=lark_env())
    except FileNotFoundError:
        return None, "lark-cli 没装：先跑 python3 scripts/feishu-docs.py setup"
    except subprocess.TimeoutExpired:
        return None, f"超时（{timeout}s）"
    out = p.stdout.strip()
    if not out:
        return None, (p.stderr.strip()[-300:] or f"rc={p.returncode}")
    try:
        payload = json.loads(out[out.index("{"):])
    except (ValueError, json.JSONDecodeError):
        return None, out[:300]
    if payload.get("ok") is False:
        err = payload.get("error") or {}
        return None, f"{err.get('code', '')} {err.get('subtype', '')} {err.get('message', '')}".strip()
    return payload.get("data", payload), None


def say(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=1))


# ---------- setup / status ----------

def link_config_dir() -> str:
    """lark-cli 的配置和 token 默认在 ~/.lark-cli。挪进 agent-data，备份恢复后也还在。"""
    if not SANDBOX_DATA.exists():
        return "不在沙箱里，保持默认 ~/.lark-cli"
    target = SANDBOX_DATA / "lark-cli"
    target.mkdir(parents=True, exist_ok=True)
    os.chmod(target, 0o700)
    home = Path.home() / ".lark-cli"
    if home.is_symlink() and os.readlink(home) == str(target):
        return f"~/.lark-cli -> {target}"
    if home.exists() and not home.is_symlink():
        for item in home.iterdir():  # 已经有配置就搬过去，不丢授权
            dest = target / item.name
            if not dest.exists():
                shutil.move(str(item), str(dest))
        shutil.rmtree(home, ignore_errors=True)
    elif home.is_symlink():
        home.unlink()
    home.symlink_to(target)
    return f"~/.lark-cli -> {target}"


def status() -> dict:
    s: dict = {"installed": bool(shutil.which("lark-cli"))}
    if not s["installed"]:
        s["next"] = "python3 scripts/feishu-docs.py setup"
        return s
    data, err = lark("whoami")
    if err:
        s.update(configured=False, detail=err,
                 next="还没有绑定应用：按 SKILL.md 跑 lark-cli config init --new --force-init（后台跑，把链接发给主人）")
        return s
    s.update(configured=True, appId=data.get("appId"), identity=data.get("identity"),
             tokenStatus=data.get("tokenStatus"), user=(data.get("onBehalfOf") or {}).get("userName"))
    if data.get("identity") != "user" or not s["user"]:
        s["next"] = "应用已绑定，但主人还没授权：lark-cli auth login --no-wait --json --domain wiki,docs,drive"
    else:
        s["next"] = "python3 scripts/feishu-docs.py scopes"
    return s


def cmd_setup(_a) -> None:
    steps = []
    if shutil.which("lark-cli"):
        steps.append("lark-cli 已安装")
    else:
        p = subprocess.run(["npm", "install", "-g", f"@larksuite/cli@{LARK_VERSION}"],
                           capture_output=True, text=True, timeout=400)
        if p.returncode != 0 or not shutil.which("lark-cli"):
            say({"ok": False, "step": "npm install", "detail": (p.stderr or p.stdout)[-600:],
                 "hint": "确认 npm prefix 可写（应为 /vercel/sandbox/agent-data/npm）且允许安装脚本"})
            sys.exit(1)
        steps.append(f"已安装 @larksuite/cli@{LARK_VERSION}")
    steps.append(link_config_dir())
    say({"ok": True, "steps": steps, "status": status()})


def cmd_status(_a) -> None:
    say(status())


# ---------- scopes ----------

def cmd_scopes(_a) -> None:
    data, err = lark("auth", "scopes")
    if err:
        say({"ok": False, "detail": err}); sys.exit(1)
    enabled = set(data.get("userScopes") or [])
    missing = {k: v for k, v in REQUIRED_SCOPES.items() if k not in enabled}
    optional_missing = {k: v for k, v in OPTIONAL_SCOPES.items() if k not in enabled}
    say({
        "ok": not missing,
        "appId": data.get("appId"),
        "enabledUserScopes": len(enabled),
        "missing": missing,
        "optionalMissing": optional_missing,
        "fix": None if not missing else (
            f"请主人在飞书开放平台打开 https://open.feishu.cn/app/{data.get('appId')}/auth ，"
            "在「用户身份权限」里开通上面这几项，然后「版本管理与发布」发一个新版本"
            "（企业里可能要管理员审核）。开通后重新跑一次 scopes，"
            "再让主人重新授权一次：lark-cli auth login --no-wait --json --domain wiki,docs,drive"),
    })
    sys.exit(0 if not missing else 2)


# ---------- inventory ----------

def space_exclusion(space: dict) -> str | None:
    """整个空间默认跳过的理由。描述也要看：实测有个空间名字很普通，
    描述里却写着「账号清单、邮箱密码凭证」，只按页面标题排除会漏掉一半。"""
    if EXCLUDE_SPACE.search(space.get("name", "")):
        return "飞书自带样例"
    if EXCLUDE_TITLE.search(f"{space.get('name', '')} {space.get('description', '')}"):
        return "空间名或描述像是凭据库"
    return None


def list_spaces() -> list[dict]:
    data, err = lark("wiki", "+space-list", "--page-all", "--page-size", "50", "--format", "json")
    if err:
        raise SystemExit(f"列知识空间失败：{err}")
    return data.get("spaces") or data.get("items") or []


def list_nodes(space_id: str, parent: str | None) -> tuple[list[dict], str | None]:
    args = ["wiki", "+node-list", "--space-id", space_id, "--page-all", "--page-size", "50", "--format", "json"]
    if space_id == "my_library":
        args += ["--as", "user"]
    if parent:
        args += ["--parent-node-token", parent]
    data, err = lark(*args)
    if err:
        return [], err
    return data.get("nodes") or data.get("items") or [], None


def cmd_inventory(a) -> None:
    started = time.time()
    spaces = list_spaces()
    spaces.append({"space_id": "my_library", "name": "我的文档库（个人）", "space_type": "personal"})
    rows, errors = [], []

    def walk(space, parent=None, path=(), depth=0):
        if depth >= MAX_DEPTH:
            return
        nodes, err = list_nodes(space["space_id"], parent)
        if err:
            errors.append({"space": space["name"], "error": err})
            return
        for n in nodes:
            title = (n.get("title") or "").strip() or "(无标题)"
            here = (*path, title)
            excluded = space_exclusion(space) or ("标题像是凭据" if EXCLUDE_TITLE.search(title) else None)
            rows.append({
                "space_id": space["space_id"], "space": space["name"], "path": " / ".join(here),
                "depth": depth, "title": title, "node_token": n.get("node_token"),
                "obj_token": n.get("obj_token"), "obj_type": n.get("obj_type"),
                "fetchable": n.get("obj_type") in FETCHABLE, "excluded": excluded,
            })
            if n.get("has_child"):
                walk(space, n.get("node_token"), here, depth + 1)

    for sp in spaces:
        walk(sp)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    INVENTORY.write_text(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "spaces": spaces,
                                     "nodes": rows, "errors": errors}, ensure_ascii=False, indent=1),
                         encoding="utf-8")
    summary = []
    for sp in spaces:
        mine = [r for r in rows if r["space_id"] == sp["space_id"]]
        if not mine:
            continue
        summary.append({
            "space_id": sp["space_id"], "name": sp["name"], "nodes": len(mine),
            "fetchable": sum(1 for r in mine if r["fetchable"] and not r["excluded"]),
            "excluded": sum(1 for r in mine if r["excluded"]),
            "default": f"跳过（{space_exclusion(sp)}）" if space_exclusion(sp) else "建议读",
        })
    say({"ok": True, "elapsed_s": round(time.time() - started, 1), "spaces": summary,
         "total_nodes": len(rows), "errors": errors, "saved": str(INVENTORY.relative_to(WS)),
         "next": "把空间清单给主人勾选，然后 pull --spaces <space_id,...>（或 --all）"})


# ---------- pull ----------

def fetch(node: dict) -> tuple[str | None, str | None]:
    token = node["obj_token"]
    if node["obj_type"] == "docx":
        data, err = lark("docs", "+fetch", "--doc", token, "--doc-format", "markdown", "--detail", "simple")
        return ((data or {}).get("document") or {}).get("content"), err
    data, err = lark("api", "GET", f"/open-apis/doc/v2/{token}/raw_content")
    return (data or {}).get("content"), err


def cmd_pull(a) -> None:
    if not INVENTORY.exists():
        raise SystemExit("还没有盘点：先跑 inventory")
    inv = json.loads(INVENTORY.read_text(encoding="utf-8"))
    wanted = None if a.all else set((a.spaces or "").split(","))
    if wanted is not None and not any(wanted):
        raise SystemExit("用 --spaces <space_id,...> 指定要读的空间，或者 --all")
    pulled = json.loads(PULLED.read_text(encoding="utf-8")) if PULLED.exists() else {}
    todo = [n for n in inv["nodes"]
            if n["fetchable"] and not n["excluded"] and n["node_token"] not in pulled
            and (wanted is None or n["space_id"] in wanted)]
    started, done, failed, skipped_empty = time.time(), [], [], 0
    collector = WS / "scripts" / "onboard-collect.py"
    for n in todo:
        if len(done) >= a.limit or time.time() - started > a.budget:
            break
        content, err = fetch(n)
        if err or not (content or "").strip():
            if not err:
                skipped_empty += 1
                pulled[n["node_token"]] = {"status": "empty", "at": time.strftime("%F")}
                continue
            failed.append({"title": n["title"], "error": err})
            continue
        p = subprocess.run(
            [sys.executable, str(collector), "add", "--source", "feishu",
             "--url", f"https://feishu.cn/wiki/{n['node_token']}",
             "--title", f"[{n['space']}] {n['path']}", "--stdin"],
            input=content, capture_output=True, text=True, cwd=WS)
        if p.returncode == 4:  # 体积闸门：停下来问主人，不要硬塞
            say({"ok": False, "stopped": "体积闸门拦下", "detail": p.stdout[-400:], "pulled_this_run": len(done)})
            PULLED.write_text(json.dumps(pulled, ensure_ascii=False, indent=1), encoding="utf-8")
            sys.exit(4)
        if p.returncode != 0:
            failed.append({"title": n["title"], "error": (p.stdout or p.stderr)[-200:]})
            continue
        pulled[n["node_token"]] = {"status": "imported", "at": time.strftime("%F")}
        done.append(n["title"])
    PULLED.write_text(json.dumps(pulled, ensure_ascii=False, indent=1), encoding="utf-8")
    remaining = len(todo) - len(done) - len(failed) - skipped_empty
    say({"ok": not failed, "imported": len(done), "failed": failed, "empty": skipped_empty,
         "remaining": max(0, remaining), "elapsed_s": round(time.time() - started, 1),
         "next": ("还有没拉完的，下一轮继续跑同一条 pull" if remaining > 0 else
                  "拉完了。python3 scripts/librarian-daily-queue.py stats 看要整理几晚")})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup").set_defaults(fn=cmd_setup)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sub.add_parser("scopes").set_defaults(fn=cmd_scopes)
    sub.add_parser("inventory").set_defaults(fn=cmd_inventory)
    p = sub.add_parser("pull")
    p.add_argument("--spaces", help="逗号分隔的 space_id（my_library 是个人文档库）")
    p.add_argument("--all", action="store_true", help="所有没被默认排除的空间")
    p.add_argument("--limit", type=int, default=40, help="这一轮最多拉几份（默认 40）")
    p.add_argument("--budget", type=int, default=240, help="这一轮最多拉多少秒（默认 240，留出回复时间）")
    p.set_defaults(fn=cmd_pull)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
