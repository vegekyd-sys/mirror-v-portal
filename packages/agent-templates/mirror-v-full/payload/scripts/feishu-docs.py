#!/usr/bin/env python3
"""飞书文档库 → 记忆冷启动：用主人扫码绑定的那个 Mirror V 应用读他的文档，交给 Librarian。

对大多数主人来说，飞书文档库是最大的记忆来源。平台在沙箱启动时把主人扫码时
绑定的那个飞书应用交给 lark-cli（LARKSUITE_CLI_APP_ID / _APP_SECRET / _CONFIG_DIR），
所以这里不再新建应用：缺权限就在这个应用上补，主人授权一次，就能用他的身份读
他本来就能看到的文档。用户 token 存在 agent-data/lark-cli，不进记忆、不进 git。

子命令（都在工作区根目录跑）：
  connect      上手引导用的一步到位：装好、对权限、发起授权，告诉你该对主人说什么
  connect --finish  主人点完授权链接之后收尾
  read         上手引导用：盘点 + 读所有建议读的空间（有时间上限），并挑出写初稿该先看的几份
  picks        写初稿先看哪几份（已经读进来的资料里挑，官网和粘贴的也算）
  sync         每天一次：重新盘点，读新建的和改过的文档（最近改的先读）
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
# 可选的几项：应用开了就一起申请授权，没开也不挡路（只是那一处读不到）。
# 2026-11-21：多数人的个人文档在云空间「我的空间」，列目录要 space:document:retrieve。个人文档库（my_library）的页面树
# 要 wiki:wiki:readonly（2026-11-12 实测只开 node:retrieve 时报 99991679），扫码建应用时会一并申请。
OPTIONAL_SCOPES = {"drive:drive.metadata:readonly": "盘点个人云空间",
                   "space:document:retrieve": "列出云空间「我的空间」里的文档",
                   "wiki:wiki:readonly": "读个人文档库的页面树"}
# 默认不读的东西：飞书自带样例，以及标题一看就是凭据的页面。
EXCLUDE_SPACE = re.compile(r"示例知识库|Wiki samples", re.I)
EXCLUDE_TITLE = re.compile(r"凭证|密码|口令|账号清单|账号密码|身份证|银行卡|secret|token|api[_ -]?key|私钥", re.I)
FETCHABLE = {"docx", "doc"}
DRIVE = {"space_id": "my_drive", "name": "我的云空间", "space_type": "drive"}
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


# 在 agent 里跑时环境带着 OPENCLAW_HOME 等变量，lark-cli 会认定自己在 OpenClaw 里，
# 要求先 `config bind`，拒绝本地配置（实测：'openclaw context detected but lark-cli
# is not bound to it'）。这里用的是主人绑定的应用、本地配置，按独立工具运行即可。
AGENT_CONTEXT_PREFIXES = ("OPENCLAW_", "HERMES_")
AGENT_CONTEXT_KEYS = ("LARK_CHANNEL",)


def lark_env() -> dict:
    env = {k: v for k, v in os.environ.items()
           if k not in APP_ENV_KEYS and k not in AGENT_CONTEXT_KEYS and not k.startswith(AGENT_CONTEXT_PREFIXES)}
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
        return None, (p.stderr.strip()[:400] or f"rc={p.returncode}")
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


def cmd_setup_quiet() -> None:
    """connect 里用：没装就装，装不上直接带着原因退出。快照里通常已经预装。"""
    p = subprocess.run(["npm", "install", "-g", f"@larksuite/cli@{LARK_VERSION}"],
                       capture_output=True, text=True, timeout=400)
    if p.returncode != 0 or not shutil.which("lark-cli"):
        say({"ok": False, "do": "retry", "step": "npm install", "detail": (p.stderr or p.stdout)[-600:]})
        sys.exit(1)
    ensure_config_dir()


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
    """开放平台里这个应用的「用户身份权限」申请页，带上要开的几项。

    注意别用 page/scope-apply：那是飞书在「应用身份」报错（99991672）里给的链接，
    打开默认开的是应用身份权限。2026-10-23 实测主人照那个链接开完，机器人能读、
    主人身份仍然只有 offline_access。读主人能看到的文档要的是用户身份权限。
    """
    return f"https://open.feishu.cn/app/{app_id}/auth?q={','.join(scopes)}&op_from=openapi&token_type=user"


def check_scopes() -> dict:
    """对照 REQUIRED_SCOPES 看绑定应用开了哪些用户身份权限。扫码建应用时已经申请过，
    正常是齐的；企业要管理员审批、或者老应用没申请过时才会缺。"""
    if shutil.which("lark-cli"):
        ensure_bound_config()
    app_id = bound_app()
    if not app_id:
        return {**status(), "ok": False, "error": "no-app"}
    data, err = lark("auth", "scopes")
    if err:
        return {"ok": False, "error": "lark", "detail": err, "hint": "把 detail 用一句人话告诉主人，再重试一次"}
    enabled = set(data.get("userScopes") or [])
    missing = [k for k in REQUIRED_SCOPES if k not in enabled]
    out = {
        "ok": not missing,
        "appId": app_id,
        "optionalEnabled": [k for k in OPTIONAL_SCOPES if k in enabled],
        "missing": {k: REQUIRED_SCOPES[k] for k in missing},
        "optionalMissing": {k: v for k, v in OPTIONAL_SCOPES.items() if k not in enabled},
    }
    if missing or out["optionalMissing"]:
        # 连可选的一起开：主人点一次就把三处都打通。
        out["grantLinkAll"] = grant_link(app_id, [*missing, *out["optionalMissing"]])
    if missing:
        out["grantLink"] = grant_link(app_id, missing)
        out["tellOwner"] = (
            "读你的文档，需要给 Mirror V 这个应用再开几项只读的「用户身份权限」（就是你扫码时绑定的那个应用，不是新应用；注意是用户身份，不是应用身份）。"
            "打开下面的链接，要开的几项已经勾好了，点「开通」；然后在左边「版本管理与发布」里"
            "建一个新版本并发布。你是管理员的话一分钟就好，不是的话要等管理员审核。弄完回我「好了」。")
    else:
        out["next"] = "python3 scripts/feishu-docs.py login"
    return out


def cmd_scopes(_a) -> None:
    out = check_scopes()
    say(out)
    sys.exit(0 if out["ok"] else 2 if out.get("missing") else 1)


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


def finish_login() -> dict:
    if not AUTH.exists():
        return {"ok": False, "detail": "还没有发起授权", "hint": "先跑 login（或 connect）"}
    code = json.loads(AUTH.read_text(encoding="utf-8")).get("device_code")
    data, err = lark("auth", "login", "--device-code", code, "--json", timeout=60)
    if err:
        return {"ok": False, "detail": err,
                "hint": "主人还没点完、或者链接过期了。过期就重新 login 发一个新链接。"}
    AUTH.unlink(missing_ok=True)
    QR.unlink(missing_ok=True)
    return {"ok": True, "status": status()}


def start_login(optional: list[str] | None = None) -> dict:
    """optional：应用已经开通的可选权限，一起申请；不传就先查一次。"""
    if optional is None:
        optional = check_scopes().get("optionalEnabled", [])
    scope = " ".join([*REQUIRED_SCOPES, *optional])
    data, err = lark("auth", "login", "--no-wait", "--json", "--scope", scope, timeout=60)
    if err:
        return {"ok": False, "detail": err, "hint": "权限没开全会在这一步报错：先跑 scopes"}
    url = _find(data, "verification_uri_complete", "verification_url", "verification_uri", "url")
    code = _find(data, "device_code")
    if not url or not code:
        return {"ok": False, "detail": "没认出授权链接或设备码，原样输出给你看", "raw": data}
    AUTH.write_text(json.dumps({"device_code": code, "url": url, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                                "expires_in": _find(data, "expires_in")}, ensure_ascii=False), encoding="utf-8")
    os.chmod(AUTH, 0o600)
    qr_ok = subprocess.run(["lark-cli", "auth", "qrcode", url, "-o", QR.name], cwd=WS,
                           capture_output=True, text=True, env=lark_env()).returncode == 0
    return {"ok": True, "url": url, "qrcode": str(QR) if qr_ok and QR.exists() else None,
            "expiresIn": _find(data, "expires_in"),
            "tellOwner": "点这个链接（或者扫二维码），用你的飞书账号确认授权。我只申请了读文档的几项权限。点完回我「好了」。",
            "next": "主人回「好了」之后：python3 scripts/feishu-docs.py login --finish"}


def cmd_login(a) -> None:
    if shutil.which("lark-cli"):
        ensure_bound_config()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    out = finish_login() if a.finish else start_login()
    say(out)
    sys.exit(0 if out["ok"] else 1)


def cmd_connect(a) -> None:
    """上手引导的一步：能读了就说能读了，不能读就给出主人唯一要做的那件事。

    输出的 `do` 是下一步：read（已经能读）/ login（发授权链接）/ grant（缺权限，发开通链接）/
    skip（这台机器接不上飞书，改走官网和粘贴）/ retry（偶发错误，告诉主人原因后重试一次）。
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if a.finish:
        if shutil.which("lark-cli"):
            ensure_bound_config()
        out = finish_login()
        if out["ok"]:
            out["do"] = "read"
        else:
            out["do"] = "login"
        say(out)
        sys.exit(0 if out["ok"] else 1)
    if not shutil.which("lark-cli"):
        cmd_setup_quiet()
    st = status()
    if not st.get("boundApp"):
        say({**st, "do": "skip"}); sys.exit(3)
    if st.get("authorized") and not a.rescope:
        say({"ok": True, "do": "read", "user": st.get("user")}); return
    sc = check_scopes()
    if sc.get("missing"):
        say({**sc, "do": "grant"}); sys.exit(2)
    if not sc["ok"]:
        say({**sc, "do": "retry"}); sys.exit(1)
    out = start_login(sc.get("optionalEnabled", []))
    out["do"] = "login" if out["ok"] else "retry"
    say(out)
    sys.exit(0 if out["ok"] else 1)


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
    """一层页面。走原始接口：它带 obj_edit_time（+node-list 快捷命令把这个字段丢了），
    同步时靠它判断哪些页面改过。"""
    items, page = [], None
    while True:
        params = {"page_size": 50, **({"parent_node_token": parent} if parent else {}),
                  **({"page_token": page} if page else {})}
        data, err = lark("api", "GET", f"/open-apis/wiki/v2/spaces/{space_id}/nodes",
                         "--params", json.dumps(params), "--as", "user")
        if err:
            return items, err
        items += data.get("items") or []
        page = data.get("page_token")
        if not data.get("has_more") or not page:
            return items, None


def list_drive(folder: str | None) -> tuple[list[dict], str | None]:
    """云空间「我的空间」里一个文件夹的内容（不传就是根目录）。要 space:document:retrieve。"""
    items, page = [], None
    while True:
        params = {"page_size": 200, **({"folder_token": folder} if folder else {}),
                  **({"page_token": page} if page else {})}
        data, err = lark("drive", "files", "list", "--params", json.dumps(params), "--as", "user")
        if err:
            return items, err
        items += data.get("files") or []
        page = data.get("next_page_token")
        if not data.get("has_more") or not page:
            return items, None


def inventory(budget: int = 150) -> dict:
    """盘点主人能读的三处：所有知识空间、个人文档库、云空间「我的空间」。只读目录不读正文。
    每个页面记下最后编辑时间，同步时只读新的和改过的。超过 budget 秒就停，下次接着盘。"""
    started = time.time()
    spaces = list_spaces()
    spaces.append({"space_id": "my_library", "name": "我的文档库（个人）", "space_type": "personal"})
    rows, errors, partial = [], [], False

    def over() -> bool:
        nonlocal partial
        partial = partial or time.time() - started > budget
        return partial

    def walk(space, parent=None, path=(), depth=0):
        if depth >= MAX_DEPTH or over():
            return
        nodes, err = list_nodes(space["space_id"], parent)
        if err:
            errors.append({"space": space["name"], "error": err})
        for n in nodes:
            title = (n.get("title") or "").strip() or "(无标题)"
            here = (*path, title)
            excluded = space_exclusion(space) or ("标题像是凭据" if EXCLUDE_TITLE.search(title) else None)
            rows.append({
                "space_id": space["space_id"], "space": space["name"], "path": " / ".join(here),
                "depth": depth, "title": title, "node_token": n.get("node_token"),
                "obj_token": n.get("obj_token"), "obj_type": n.get("obj_type"),
                "edit": str(n.get("obj_edit_time") or ""),
                "url": f"https://feishu.cn/wiki/{n.get('node_token')}",
                "fetchable": n.get("obj_type") in FETCHABLE, "excluded": excluded,
            })
            if n.get("has_child"):
                walk(space, n.get("node_token"), here, depth + 1)

    def walk_drive(folder=None, path=(), depth=0):
        if depth >= MAX_DEPTH or over():
            return
        files, err = list_drive(folder)
        if err:
            errors.append({"space": DRIVE["name"], "error": err})
        for f in files:
            name = (f.get("name") or "").strip() or "(无标题)"
            here = (*path, name)
            if f.get("type") == "folder":
                walk_drive(f.get("token"), here, depth + 1)
                continue
            rows.append({
                "space_id": DRIVE["space_id"], "space": DRIVE["name"], "path": " / ".join(here),
                "depth": depth, "title": name, "node_token": f.get("token"),
                "obj_token": f.get("token"), "obj_type": f.get("type"),
                "edit": str(f.get("modified_time") or ""),
                "url": f.get("url") or f"https://feishu.cn/docx/{f.get('token')}",
                "fetchable": f.get("type") in FETCHABLE,
                "excluded": "标题像是凭据" if EXCLUDE_TITLE.search(name) else None,
            })

    for sp in spaces:
        walk(sp)
    walk_drive()
    spaces.append(DRIVE)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    INVENTORY.write_text(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "spaces": spaces,
                                     "nodes": rows, "errors": errors, "partial": partial},
                                    ensure_ascii=False, indent=1), encoding="utf-8")
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
    return {"ok": True, "elapsed_s": round(time.time() - started, 1), "spaces": summary,
            "total_nodes": len(rows), "errors": errors, "partial": partial,
            "saved": str(INVENTORY.relative_to(WS)),
            "next": "把空间清单给主人勾选，然后 pull --spaces <space_id,...>（或 --all）"}


def cmd_inventory(_a) -> None:
    say(inventory())


# ---------- pull ----------

def fetch(node: dict) -> tuple[str | None, str | None]:
    token = node["obj_token"]
    if node["obj_type"] == "docx":
        data, err = lark("docs", "+fetch", "--doc", token, "--doc-format", "markdown", "--detail", "simple")
        return ((data or {}).get("document") or {}).get("content"), err
    data, err = lark("api", "GET", f"/open-apis/doc/v2/{token}/raw_content")
    return (data or {}).get("content"), err


def cmd_pull(a) -> None:
    out = pull(a.all, a.spaces, a.limit, a.budget)
    say(out)
    sys.exit(4 if out.get("stopped") else 0)


def pull(all_spaces: bool, spaces: str | None, limit: int, budget: int) -> dict:
    if not INVENTORY.exists():
        raise SystemExit("还没有盘点：先跑 inventory")
    inv = json.loads(INVENTORY.read_text(encoding="utf-8"))
    wanted = None if all_spaces else set((spaces or "").split(","))
    if wanted is not None and not any(wanted):
        raise SystemExit("用 --spaces <space_id,...> 指定要读的空间，或者 --all")
    pulled = json.loads(PULLED.read_text(encoding="utf-8")) if PULLED.exists() else {}
    def changed(n: dict) -> bool:
        seen = pulled.get(n["node_token"])
        # 读过之后又改过的再读一遍；旧记录没有编辑时间，当作没改过。
        return not seen or bool(n.get("edit") and seen.get("edit") and n["edit"] > seen["edit"])

    todo = [n for n in inv["nodes"]
            if n["fetchable"] and not n["excluded"] and changed(n)
            and (wanted is None or n["space_id"] in wanted)]
    # 最近改过的先读：主人眼下在忙的事比三年前的制度更值得先进记忆。
    todo.sort(key=lambda n: n.get("edit") or "", reverse=True)
    started, done, failed, skipped_empty, updated = time.time(), [], [], 0, 0
    collector = WS / "scripts" / "onboard-collect.py"
    for n in todo:
        if len(done) >= limit or time.time() - started > budget:
            break
        content, err = fetch(n)
        if err or not (content or "").strip():
            if not err:
                skipped_empty += 1
                pulled[n["node_token"]] = {"status": "empty", "at": time.strftime("%F"), "edit": n.get("edit", "")}
                continue
            failed.append({"title": n["title"], "error": err})
            continue
        again = n["node_token"] in pulled
        title = f"[{n['space']}] {n['path']}" + (f"（更新版 {time.strftime('%F')}）" if again else "")
        p = subprocess.run(
            [sys.executable, str(collector), "add", "--source", "feishu",
             "--url", n.get("url") or f"https://feishu.cn/wiki/{n['node_token']}",
             "--title", title, "--stdin"],
            input=content, capture_output=True, text=True, cwd=WS)
        if p.returncode == 4:  # 体积闸门：停下来问主人，不要硬塞
            PULLED.write_text(json.dumps(pulled, ensure_ascii=False, indent=1), encoding="utf-8")
            return {"ok": False, "stopped": "体积闸门拦下", "detail": p.stdout[-400:], "pulled_this_run": len(done)}
        if p.returncode != 0:
            failed.append({"title": n["title"], "error": (p.stdout or p.stderr)[-200:]})
            continue
        pulled[n["node_token"]] = {"status": "imported", "at": time.strftime("%F"), "edit": n.get("edit", "")}
        updated += again
        done.append(n["title"])
    PULLED.write_text(json.dumps(pulled, ensure_ascii=False, indent=1), encoding="utf-8")
    remaining = len(todo) - len(done) - len(failed) - skipped_empty
    return {"ok": not failed, "imported": len(done), "updated": updated, "titles": done[:8],
            "failed": failed, "empty": skipped_empty,
            "remaining": max(0, remaining), "elapsed_s": round(time.time() - started, 1),
            "next": ("还有没拉完的，下一轮继续跑同一条 pull" if remaining > 0 else
                     "拉完了。python3 scripts/librarian-daily-queue.py stats 看要整理几晚")}


# ---------- sync（每天一次） ----------

SYNC = STATE_DIR / "feishu-sync.json"


def cmd_sync(a) -> None:
    """重新盘点三处，把新建的和改过的文档读进来，交给夜里的整理。

    第一次同步时，之前读过、但没记编辑时间的页面只补记时间，不重读。
    缺权限、没授权这类问题只在第一次出现时报给主人，不天天念。"""
    started = time.time()
    st = status()
    state = json.loads(SYNC.read_text(encoding="utf-8")) if SYNC.exists() else {}
    def tell(problem: str | None) -> bool:
        # 新问题马上说；同一个问题一周最多提醒一次。
        if not problem:
            return False
        if problem != state.get("lastProblem"):
            return True
        return time.time() - float(state.get("lastToldAt") or 0) > 7 * 86400

    if not st.get("authorized"):
        problem = "飞书还没授权，或者授权过期了"
        out = {"ok": False, "problem": problem, "tellOwner": tell(problem),
               "next": "python3 scripts/feishu-docs.py connect，把授权链接发给主人"}
        state.update(lastProblem=problem, at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                     **({"lastToldAt": time.time()} if out["tellOwner"] else {}))
        SYNC.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
        say(out); sys.exit(2)
    inv = inventory(budget=max(60, a.budget // 2))
    nodes = json.loads(INVENTORY.read_text(encoding="utf-8"))["nodes"]
    pulled = json.loads(PULLED.read_text(encoding="utf-8")) if PULLED.exists() else {}
    stamped = 0
    for n in nodes:
        seen = pulled.get(n["node_token"])
        if seen and not seen.get("edit") and n.get("edit"):
            seen["edit"] = n["edit"]; stamped += 1
    PULLED.write_text(json.dumps(pulled, ensure_ascii=False, indent=1), encoding="utf-8")
    out = pull(True, None, a.limit, max(30, a.budget - int(time.time() - started)))
    scope_gaps = sorted({e["space"] for e in inv["errors"] if "scope" in str(e.get("error", ""))})
    problem = f"读不到：{'、'.join(scope_gaps)}（缺权限）" if scope_gaps else None
    out.update(spaces=len(inv["spaces"]), stamped=stamped, partialInventory=inv["partial"],
               problem=problem, tellOwner=tell(problem))
    if problem:
        sc = check_scopes()
        # 应用上已经开了、只是主人的授权里还没有：重新授权一次就行，不用再去开放平台。
        out["ownerAction"] = "开通权限" if sc.get("optionalMissing") or sc.get("missing") else "重新授权"
        out["grantLinkAll"] = sc.get("grantLinkAll")
    state.update(lastProblem=problem, at=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                 lastImported=out.get("imported", 0), **({"lastToldAt": time.time()} if out["tellOwner"] else {}))
    SYNC.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    say(out)


# ---------- read（上手引导） ----------

# 写初稿时先看的文档：讲公司、产品、团队、方向的那几份，比会议纪要和流水更能说明「你是谁」。
DRAFT_HINT = re.compile(r"介绍|简介|关于|about|公司|产品|业务|战略|规划|愿景|使命|BP|商业计划|融资|团队|组织|手册|"
                        r"onboarding|入职|OKR|年度|总结|定位|方案|官网|品牌", re.I)


def draft_picks(n: int = 10) -> list[dict]:
    """从已经读进来的原文里挑 n 份写初稿用：标题像总纲的、层级浅的、篇幅足的优先。
    飞书跳过时官网和粘贴的资料一样能用。"""
    manifest = WS / "memory-archive" / "imports" / "MANIFEST.json"
    try:
        items = json.loads(manifest.read_text(encoding="utf-8")).get("items", [])
    except (OSError, ValueError):
        return []
    docs = [it for it in items if it.get("path") and not it.get("duplicate_of")]

    def score(it: dict) -> float:
        title = it.get("title", "")
        depth = title.count(" / ")
        chars = int(it.get("chars") or 0)
        return (3 if DRAFT_HINT.search(title) else 0) - depth + min(chars, 8000) / 4000

    docs.sort(key=score, reverse=True)
    return [{"title": it["title"], "file": it["path"], "chars": it.get("chars")} for it in docs[:n]]


def cmd_read(a) -> None:
    """盘点 + 读所有建议读的空间，有时间上限；没读完就告诉调用方后台接着读。"""
    started = time.time()
    inv = inventory() if (a.reinventory or not INVENTORY.exists()) else None
    out = pull(True, None, a.limit, max(30, a.budget - int(time.time() - started)))
    if inv:
        out["spaces"] = [{"name": s["name"], "docs": s["fetchable"], "default": s["default"]} for s in inv["spaces"]]
        out["inventory_errors"] = inv["errors"][:5]
    out["forDraft"] = draft_picks()
    # 单轮硬上限 10 分钟，写初稿要两三分钟：读得快才在这一轮接着写，否则交给一次性任务。
    out["draftNow"] = not out.get("remaining") and time.time() - started <= 150
    out["next"] = ("这一轮接着写初稿" if out["draftNow"] else
                   "加一次性任务写初稿" + ("，再加一条接着跑 read" if out.get("remaining") else ""))
    say(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    cn = sub.add_parser("connect")
    cn.add_argument("--finish", action="store_true", help="主人点完授权链接之后收尾")
    cn.add_argument("--rescope", action="store_true", help="已经授权过、应用又开了新权限时，重新发授权链接把新权限带上")
    cn.set_defaults(fn=cmd_connect)
    rd = sub.add_parser("read")
    rd.add_argument("--limit", type=int, default=120, help="这一轮最多读几份（默认 120）")
    rd.add_argument("--budget", type=int, default=200, help="这一轮最多花多少秒，含盘点（默认 200）")
    rd.add_argument("--reinventory", action="store_true", help="重新盘点空间（默认只在第一次盘点）")
    rd.set_defaults(fn=cmd_read)
    sub.add_parser("picks").set_defaults(fn=lambda _a: say({"forDraft": draft_picks()}))
    sy = sub.add_parser("sync")
    sy.add_argument("--limit", type=int, default=80, help="这一次最多读几份（默认 80）")
    sy.add_argument("--budget", type=int, default=360, help="这一次最多花多少秒，含盘点（默认 360）")
    sy.set_defaults(fn=cmd_sync)
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
