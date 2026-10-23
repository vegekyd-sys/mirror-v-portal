#!/usr/bin/env python3
"""飞书文档库 → 记忆冷启动：用主人扫码绑定的那个 Mirror V 应用读他的文档，交给 Librarian。

对大多数主人来说，飞书文档库是最大的记忆来源。平台在沙箱启动时把主人扫码时
绑定的那个飞书应用交给 lark-cli（LARKSUITE_CLI_APP_ID / _APP_SECRET / _CONFIG_DIR），
所以这里不再新建应用：缺权限就在这个应用上补，主人授权一次，就能用他的身份读
他本来就能看到的文档。用户 token 存在 agent-data/lark-cli，不进记忆、不进 git。

子命令（都在工作区根目录跑）：
  setup        装 lark-cli（已装就跳过），打印状态和下一步
  status       看状态：装没装、应用绑上没有、主人授权没有
  scopes       对照读文档要的用户身份权限，缺的给出一键开通链接（退出码 2）
  login        发起授权：输出给主人点的链接（和二维码图片），记下设备码
  login --finish   主人点完之后收尾，拿到主人身份
  inventory    盘点：所有知识空间 + 个人文档库的节点树，只读目录不读正文
  pull         按主人选的空间拉正文，逐份交给 onboard-collect.py（--source feishu）

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
AUTH = STATE_DIR / "feishu-auth.json"
QR = WS / "feishu-auth.png"


# 平台把绑定应用的 id / secret 放在这两个环境变量里。lark-cli 只要看到它们就把
# 凭据当成「外部提供」，禁用全部 auth 命令（实测：'"auth" is not supported:
# credentials are provided externally'），主人就没法授权。所以 setup 时把它们
# 写成 lark-cli 自己的配置，之后调用 lark-cli 一律不带这两个变量。
APP_ENV_KEYS = ("LARKSUITE_CLI_APP_ID", "LARKSUITE_CLI_APP_SECRET")


def lark_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k not in APP_ENV_KEYS}
    env.setdefault("LARKSUITE_CLI_NO_UPDATE_NOTIFIER", "1")
    env.setdefault("LARKSUITE_CLI_NO_SKILLS_NOTIFIER", "1")
    return env


def config_file() -> Path:
    return Path(os.environ.get("LARKSUITE_CLI_CONFIG_DIR") or Path.home() / ".lark-cli") / "config.json"


def configured_app() -> str | None:
    try:
        data = json.loads(config_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    apps = data.get("apps") or [data]  # 1.0.89 写成 {"apps":[{"appId":...}]}
    return next((a.get("appId") for a in apps if isinstance(a, dict) and a.get("appId")), None)


def ensure_bound_config() -> str:
    """把平台注入的绑定应用写成 lark-cli 的本地配置（secret 走 stdin，不进参数、不进日志）。"""
    app, secret = os.environ.get("LARKSUITE_CLI_APP_ID"), os.environ.get("LARKSUITE_CLI_APP_SECRET")
    if not app or not secret:
        return "环境里没有绑定应用"
    if configured_app() == app:
        return "绑定应用已写入 lark-cli 配置"
    p = subprocess.run(["lark-cli", "config", "init", "--app-id", app, "--app-secret-stdin",
                        "--brand", "feishu", "--force-init"],
                       input=secret, capture_output=True, text=True, timeout=60, env=lark_env())
    if p.returncode != 0 or configured_app() != app:
        raise SystemExit(json.dumps({"ok": False, "step": "config init",
                                     "detail": (p.stderr or p.stdout)[-400:]}, ensure_ascii=False))
    return "已把绑定应用写入 lark-cli 配置"


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

def ensure_config_dir() -> str:
    """平台把 LARKSUITE_CLI_CONFIG_DIR 指到 agent-data（休眠、备份都保留）；这里只保证目录在、权限收紧。"""
    d = os.environ.get("LARKSUITE_CLI_CONFIG_DIR")
    if not d:
        return "未设置 LARKSUITE_CLI_CONFIG_DIR，lark-cli 用默认 ~/.lark-cli"
    Path(d).mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    return f"lark-cli 配置目录 {d}"


def bound_app() -> str | None:
    return os.environ.get("LARKSUITE_CLI_APP_ID") or configured_app()


def status() -> dict:
    s: dict = {"installed": bool(shutil.which("lark-cli")), "boundApp": bound_app()}
    if not s["installed"]:
        s["next"] = "python3 scripts/feishu-docs.py setup"
        return s
    if not s["boundApp"]:
        s["next"] = ("这台机器没有拿到绑定的飞书应用（LARKSUITE_CLI_APP_ID 为空），读不了飞书。"
                     "如实告诉主人，改走粘正文 / 发截图，不要让他另建应用。")
        return s
    data, err = lark("whoami")
    if err:
        s.update(detail=err, next="python3 scripts/feishu-docs.py scopes")
        return s
    user = (data.get("onBehalfOf") or {}).get("userName")
    s.update(identity=data.get("identity"), tokenStatus=data.get("tokenStatus"), user=user)
    s["authorized"] = data.get("identity") == "user" and bool(user)
    s["next"] = ("python3 scripts/feishu-docs.py inventory" if s["authorized"]
                 else "python3 scripts/feishu-docs.py scopes，权限齐了再 login")
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
    steps.append(ensure_config_dir())
    steps.append(ensure_bound_config())
    say({"ok": True, "steps": steps, "status": status()})


def cmd_status(_a) -> None:
    say(status())


# ---------- scopes ----------

def grant_link(app_id: str, scopes: list[str]) -> str:
    """开放平台的权限申请页，带上要开的那几项。格式取自飞书 99991672 报错里官方给的链接（2026-10-23 实测）。"""
    from urllib.parse import quote
    return f"https://open.feishu.cn/page/scope-apply?clientID={app_id}&scopes={quote(','.join(scopes), safe='')}"


def cmd_scopes(_a) -> None:
    if shutil.which("lark-cli"):
        ensure_bound_config()
    app_id = bound_app()
    if not app_id:
        say(status()); sys.exit(1)
    data, err = lark("auth", "scopes")
    if err:
        say({"ok": False, "detail": err, "hint": "多半是网络抖动，过几秒重试一次"}); sys.exit(1)
    enabled = set(data.get("userScopes") or [])
    missing = [k for k in REQUIRED_SCOPES if k not in enabled]
    out = {
        "ok": not missing,
        "appId": app_id,
        "missing": {k: REQUIRED_SCOPES[k] for k in missing},
        "optionalMissing": {k: v for k, v in OPTIONAL_SCOPES.items() if k not in enabled},
    }
    if missing:
        out["grantLink"] = grant_link(app_id, missing)
        out["tellOwner"] = (
            "读你的文档，需要给 Mirror V 这个应用再开几项只读权限（就是你扫码时绑定的那个，不是新应用）。"
            "打开下面的链接，要开的几项已经勾好了，点「开通」；然后在左边「版本管理与发布」里"
            "建一个新版本并发布。你是管理员的话一分钟就好，不是的话要等管理员审核。弄完回我「好了」。")
    else:
        out["next"] = "python3 scripts/feishu-docs.py login"
    say(out)
    sys.exit(0 if not missing else 2)


# ---------- login (Device Flow) ----------

def _find(obj, *keys):
    """在 lark-cli 的输出里按标准字段名（RFC 8628）找值，找不到就扫一遍所有字符串。"""
    if isinstance(obj, dict):
        for k in keys:
            if obj.get(k):
                return obj[k]
        for v in obj.values():
            hit = _find(v, *keys)
            if hit:
                return hit
    return None


def cmd_login(a) -> None:
    if shutil.which("lark-cli"):
        ensure_bound_config()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if a.finish:
        if not AUTH.exists():
            raise SystemExit("还没有发起授权：先跑 login")
        code = json.loads(AUTH.read_text(encoding="utf-8")).get("device_code")
        data, err = lark("auth", "login", "--device-code", code, "--json", timeout=60)
        if err:
            say({"ok": False, "detail": err,
                 "hint": "主人还没点完、或者链接过期了。过期就重新 login 发一个新链接。"}); sys.exit(1)
        AUTH.unlink(missing_ok=True)
        QR.unlink(missing_ok=True)
        say({"ok": True, "status": status()})
        return
    scope = " ".join(REQUIRED_SCOPES)
    data, err = lark("auth", "login", "--no-wait", "--json", "--scope", scope, timeout=60)
    if err:
        say({"ok": False, "detail": err, "hint": "权限没开全会在这一步报错：先跑 scopes"}); sys.exit(1)
    url = _find(data, "verification_uri_complete", "verification_url", "verification_uri", "url")
    code = _find(data, "device_code")
    if not url or not code:
        say({"ok": False, "detail": "没认出授权链接或设备码，原样输出给你看", "raw": data}); sys.exit(1)
    AUTH.write_text(json.dumps({"device_code": code, "url": url, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                                "expires_in": _find(data, "expires_in")}, ensure_ascii=False), encoding="utf-8")
    os.chmod(AUTH, 0o600)
    qr_ok = subprocess.run(["lark-cli", "auth", "qrcode", url, "-o", QR.name], cwd=WS,
                           capture_output=True, text=True, env=lark_env()).returncode == 0
    say({"ok": True, "url": url, "qrcode": str(QR) if qr_ok and QR.exists() else None,
         "expiresIn": _find(data, "expires_in"),
         "tellOwner": "点这个链接（或者扫二维码），用你的飞书账号确认授权。我只申请了读文档的几项权限。点完回我「好了」。",
         "next": "主人回「好了」之后：python3 scripts/feishu-docs.py login --finish"})


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
    lg = sub.add_parser("login")
    lg.add_argument("--finish", action="store_true", help="主人点完授权链接之后收尾")
    lg.set_defaults(fn=cmd_login)
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
