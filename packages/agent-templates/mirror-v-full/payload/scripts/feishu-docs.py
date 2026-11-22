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
  sync         每天一次：重新盘点，读新建的和改过的文档，重写概览页
  get          当场读一份原文（没精读的也能读），不落盘
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
import collections
import importlib.util
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
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
EXCLUDE_TITLE = re.compile(r"凭证|密码|口令|账号清单|账号密码|账号.{0,2}邮箱|邮箱.{0,2}账号|登[录陆]信息|账号信息表|身份证|银行卡|secret|token|api[_ -]?key|私钥", re.I)
FETCHABLE = {"docx", "doc"}
DRIVE = {"space_id": "my_drive", "name": "我的云空间", "space_type": "drive"}
MAX_DEPTH = 6
# 写初稿时先看的文档：讲公司、产品、团队、方向的那几份，比会议纪要和流水更能说明「你是谁」。
DRAFT_HINT = re.compile(r"介绍|简介|关于|about|公司|产品|业务|战略|规划|愿景|使命|BP|商业计划|融资|团队|组织|手册|"
                        r"onboarding|入职|OKR|年度|总结|定位|方案|官网|品牌", re.I)


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


RATE_LIMITED = re.compile(r"99991400|frequency limit|rate.?limit|too many request", re.I)


def lark_retry(*args: str, timeout: int = 30) -> tuple[dict | None, str | None]:
    """并发读的时候飞书会限频：退避重试，别的错误原样返回。"""
    for pause in (1, 3, 0):
        data, err = lark(*args, timeout=timeout)
        if not err or not RATE_LIMITED.search(err) or not pause:
            return data, err
        time.sleep(pause)
    return data, err


def save_json(path: Path, obj) -> None:
    """先写临时文件再换上去：命令随时可能被平台切断，不能留半截文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def hard_stop(seconds: int) -> None:
    """到点一定结束。对话里的一轮只有 10 分钟，命令挂住就是整轮作废（2026-11-22 发生过）。"""
    def stop() -> None:
        print(json.dumps({"ok": False, "timedOut": True, "remaining": 1,
                          "next": "到时间了，已读的都存下了；剩下的下次接着，不要马上重跑"}, ensure_ascii=False), flush=True)
        os._exit(3)
    t = threading.Timer(seconds, stop)
    t.daemon = True
    t.start()


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
        data, err = lark_retry("api", "GET", f"/open-apis/wiki/v2/spaces/{space_id}/nodes",
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
        data, err = lark_retry("drive", "files", "list", "--params", json.dumps(params), "--as", "user")
        if err:
            return items, err
        items += data.get("files") or []
        page = data.get("next_page_token")
        if not data.get("has_more") or not page:
            return items, None


WORKERS = 8


def inventory(budget: int = 60) -> dict:
    """盘点主人能读的三处：所有知识空间、个人文档库、云空间「我的空间」。只读目录不读正文。
    并发盘，超过 budget 秒就停，没盘到的沿用上一次的结果。"""
    started = time.time()
    spaces = list_spaces()
    spaces.append({"space_id": "my_library", "name": "我的文档库（个人）", "space_type": "personal"})
    rows, errors, partial = [], [], False

    def wiki_level(space, parent, path, depth):
        nodes, err = list_nodes(space["space_id"], parent)
        out, more = [], []
        for n in nodes:
            title = (n.get("title") or "").strip() or "(无标题)"
            here = (*path, title)
            out.append({
                "space_id": space["space_id"], "space": space["name"], "path": " / ".join(here),
                "depth": depth, "title": title, "node_token": n.get("node_token"),
                "obj_token": n.get("obj_token"), "obj_type": n.get("obj_type"),
                "edit": str(n.get("obj_edit_time") or ""),
                "url": n.get("url") or f"https://feishu.cn/wiki/{n.get('node_token')}",
                "fetchable": n.get("obj_type") in FETCHABLE,
                "excluded": space_exclusion(space) or ("标题像是凭据" if EXCLUDE_TITLE.search(title) else None),
            })
            if n.get("has_child") and depth + 1 < MAX_DEPTH:
                more.append((wiki_level, space, n.get("node_token"), here, depth + 1))
        return out, more, {"space": space["name"], "error": err} if err else None

    def drive_level(space, folder, path, depth):
        files, err = list_drive(folder)
        out, more = [], []
        for f in files:
            name = (f.get("name") or "").strip() or "(无标题)"
            here = (*path, name)
            if f.get("type") == "folder":
                if depth + 1 < MAX_DEPTH:
                    more.append((drive_level, space, f.get("token"), here, depth + 1))
                continue
            out.append({
                "space_id": space["space_id"], "space": space["name"], "path": " / ".join(here),
                "depth": depth, "title": name, "node_token": f.get("token"),
                "obj_token": f.get("token"), "obj_type": f.get("type"),
                "edit": str(f.get("modified_time") or ""),
                "url": f.get("url") or f"https://feishu.cn/docx/{f.get('token')}",
                "fetchable": f.get("type") in FETCHABLE,
                "excluded": "标题像是凭据" if EXCLUDE_TITLE.search(name) else None,
            })
        return out, more, {"space": space["name"], "error": err} if err else None

    pool = ThreadPoolExecutor(WORKERS)
    pending = {pool.submit(drive_level, DRIVE, None, (), 0)}
    pending |= {pool.submit(wiki_level, sp, None, (), 0) for sp in spaces}
    while pending:
        left = budget - (time.time() - started)
        if left <= 0:
            partial = True
            break
        finished, pending = wait(pending, timeout=left, return_when=FIRST_COMPLETED)
        for fut in finished:
            out, more, err = fut.result()
            rows += out
            if err:
                errors.append(err)
            pending |= {pool.submit(*job) for job in more}
    pool.shutdown(wait=False, cancel_futures=True)
    spaces.append(DRIVE)
    if partial and INVENTORY.exists():  # 没盘完：上次盘到的别丢
        known = {r["node_token"] for r in rows}
        rows += [r for r in json.loads(INVENTORY.read_text(encoding="utf-8"))["nodes"] if r["node_token"] not in known]
    rank(rows)
    save_json(INVENTORY, {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "spaces": spaces,
                          "nodes": rows, "errors": errors, "partial": partial})
    summary = []
    for sp in spaces:
        mine = [r for r in rows if r["space_id"] == sp["space_id"]]
        if not mine:
            continue
        summary.append({
            "space_id": sp["space_id"], "name": sp["name"], "nodes": len(mine),
            "fetchable": sum(1 for r in mine if r["fetchable"] and not r["excluded"]),
            "deep": sum(1 for r in mine if r["tier"] == "deep"),
            "excluded": sum(1 for r in mine if r["excluded"]),
            "default": f"跳过（{space_exclusion(sp)}）" if space_exclusion(sp) else "建议读",
        })
    return {"ok": True, "elapsed_s": round(time.time() - started, 1), "spaces": summary,
            "total_nodes": len(rows), "tiers": dict(collections.Counter(r["tier"] for r in rows)),
            "errors": errors, "partial": partial, "saved": str(INVENTORY.relative_to(WS)),
            "next": "把空间清单给主人勾选，然后 pull --spaces <space_id,...>（或 --all）"}


# ---------- 分层：哪些精读，哪些只进目录 ----------

# 一个用了几年的飞书账号有上千份文档（2026-11-22 实测 1414 份可读），其中大量是会议逐字稿、
# 一天批量生成的同类方案、系列周报的旧期。全部逐片编译要几个月，还会把真正重要的淹没。
# 所以：全部进目录（知道有、能当场去读原文），只精读下面挑出来的。
DEEP_LIMIT = 300        # 精读上限
SERIES_KEEP = 4         # 同一系列（标题去掉日期数字后相同）只精读最近几份
STALE_DAYS = 365        # 整个空间这么久没人改过，当旧资料：排在最后读，每个空间只精读几份
STALE_KEEP = 5
BATCH_DAY = 40          # 同一处同一天改动超过这么多份，视为批量生成
HANDED_OVER = re.compile(r"的(个人)?文档$")   # 同事离职交接过来的文件夹，飞书自动起名「XX的个人文档」
NOISE_TITLE = re.compile(r"^\(无标题\)$|^untitled|^未命名|快速启用，属于你的任务管理系统|^近期会议速递", re.I)


def stem(title: str) -> str:
    t = re.sub(r"\d{4}\s*[-./年]\s*\d{1,2}\s*[-./月]\s*\d{1,2}\s*日?", "", title)
    t = re.sub(r"[\d\W_]+", "", t)
    return re.sub(r"副本|copy", "", t, flags=re.I).lower()


def rank(rows: list[dict]) -> None:
    """给每一行定层：deep 精读 / catalog 只进目录 / skip 不碰，写明理由和排序分。"""
    now = time.time()
    edit = lambda r: int(r["edit"]) if r.get("edit", "").isdigit() else 0  # noqa: E731
    for r in rows:
        r["tier"], r["why"], r["score"] = "catalog", "", 0.0
        if r["excluded"]:
            r["tier"], r["why"] = "skip", r["excluded"]
        elif not r["fetchable"]:
            r["why"] = "表格、幻灯片、附件暂不读正文"
    live = [r for r in rows if r["fetchable"] and not r["excluded"]]
    minutes = {r["title"].split("智能纪要", 1)[1] for r in live if r["title"].startswith("智能纪要")}
    per_day = collections.Counter((r["space_id"], edit(r) // 86400) for r in live)
    series: dict = collections.defaultdict(list)
    # 2026-11-22 的新号首批 100 份里有 13 份是 2021 年的 OKR 教程：知识库加分没看新旧。
    newest: dict = collections.defaultdict(int)
    for r in live:
        newest[r["space_id"]] = max(newest[r["space_id"]], edit(r))
    stale = {s for s, at in newest.items() if s != DRIVE["space_id"] and at and (now - at) / 86400 > STALE_DAYS}
    candidates, old = [], collections.defaultdict(list)
    for r in sorted(live, key=edit, reverse=True):
        r["stale"] = r["space_id"] in stale
        age = (now - edit(r)) / 86400 if edit(r) else 9999
        if NOISE_TITLE.search(r["title"]):
            r["why"] = "空白或飞书自带模板"
        elif r["space_id"] == DRIVE["space_id"] and HANDED_OVER.search(r["path"].split(" / ")[0]):
            r["why"] = "别人交接过来的个人文档"
        elif r["title"].startswith("文字记录") and r["title"].split("文字记录", 1)[1] in minutes:
            r["why"] = "同一场会议已有智能纪要"
        elif r["space_id"] == DRIVE["space_id"] and per_day[(r["space_id"], edit(r) // 86400)] >= BATCH_DAY:
            r["why"] = f"同一天批量产生 {per_day[(r['space_id'], edit(r) // 86400)]} 份"
        elif len(series[stem(r["title"]) or r["title"]]) >= SERIES_KEEP:
            r["why"] = f"同系列只精读最近 {SERIES_KEEP} 份"
        else:
            series[stem(r["title"]) or r["title"]].append(r)
            # 知识库是公司自己整理过的，再旧也比云空间的散文档更能说明公司。
            r["score"] = ((6 if r["space_id"] != DRIVE["space_id"] else 0)
                          + (3 if age <= 90 else 1 if age <= 180 else 0 if age <= 365 else -1)
                          + (1 if DRAFT_HINT.search(r["title"]) else 0) - min(r["depth"], 3) * 0.2)
            (old[r["space_id"]] if r["stale"] else candidates).append(r)
    order = lambda r: (r["score"], edit(r))  # noqa: E731
    kept = []
    for rows_old in old.values():
        rows_old.sort(key=order, reverse=True)
        kept += rows_old[:STALE_KEEP]
        for r in rows_old[STALE_KEEP:]:
            r["why"] = f"一年没人改过的空间只精读 {STALE_KEEP} 份"
    kept = sorted(kept, key=order, reverse=True)[:DEEP_LIMIT // 5]
    candidates.sort(key=order, reverse=True)
    spare = [r for v in old.values() for r in v[STALE_KEEP:]]
    # 资料不多的人，旧知识库可能就是他的全部：名额没用完就接着读旧的。
    deep = (candidates[:DEEP_LIMIT - len(kept)] + kept + sorted(spare, key=order, reverse=True))[:DEEP_LIMIT]
    for r in deep:
        r["tier"], r["why"] = "deep", ""
    for r in candidates + [x for v in old.values() for x in v]:
        if r["tier"] != "deep" and not r["why"]:
            r["why"] = f"超出精读名额（{DEEP_LIMIT} 份）"


OVERVIEW = WS / "memory" / "research" / "feishu-overview.md"


def write_overview() -> dict:
    """概览页：主人的飞书里有哪些空间、哪些系列、各多少份，怎么找到具体一份。

    只写概览，不列两千行标题：全列进 memory_search 会把精编的页面挤掉。
    具体某一份用 get 在清单（onboarding/feishu-inventory.json）里找。"""
    inv = json.loads(INVENTORY.read_text(encoding="utf-8"))
    pulled = json.loads(PULLED.read_text(encoding="utf-8")) if PULLED.exists() else {}
    rows = [r for r in inv["nodes"] if r.get("tier") != "skip"]
    read = sum(1 for r in rows if pulled.get(r["node_token"], {}).get("status") == "imported")
    out = ["# 飞书文档概览", "",
           f"主人飞书里能看到的文档共 {len(rows)} 份，其中 {read} 份已读进记忆，其余没精读但随时能读原文。"
           "主人问到某份文档、客户或会议而记忆里没有细节时，跑 `python3 scripts/feishu-docs.py get <标题里的词>` 找到并读原文，不要说没有。",
           "关键词：飞书文档概览、文档清单、云空间、知识库、会议纪要、客户方案", "",
           "> `scripts/feishu-docs.py sync` 自动重写这一页，不要手改。", "", "## 各处有多少", ""]
    spaces = collections.Counter(r["space"] for r in rows)
    for name, n in sorted(spaces.items(), key=lambda x: (-x[1], x[0])):
        out.append(f"- {name}：{n} 份")
    folders = collections.Counter(r["path"].split(" / ")[0] for r in rows if r["space_id"] == DRIVE["space_id"] and r["depth"])
    if folders:
        out += ["", "## 云空间里的文件夹", ""]
        out += [f"- {f}：{n} 份" for f, n in sorted(folders.items(), key=lambda x: (-x[1], x[0]))[:30]]
    series: dict = collections.defaultdict(list)
    for r in rows:
        if r["fetchable"] and len(stem(r["title"])) >= 4:
            series[stem(r["title"])].append(r)
    top = sorted((v for v in series.values() if len(v) >= 4), key=lambda v: (-len(v), v[0]["title"]))[:30]
    if top:
        out += ["", "## 反复出现的系列", ""]
        for v in top:
            newest = max(v, key=lambda r: (r.get("edit") or "", r["title"]))
            out.append(f"- {newest['title']}（这一类 {len(v)} 份，最近改于 "
                       + (time.strftime("%Y-%m-%d", time.gmtime(int(newest["edit"]))) if newest.get("edit", "").isdigit() else "未知") + "）")
    why = collections.Counter(re.sub(r"\d+", "N", r["why"]) for r in rows if r["tier"] == "catalog" and r["why"])
    out += ["", "## 没精读的是哪些", ""] + [f"- {k}：{n} 份" for k, n in sorted(why.items(), key=lambda x: (-x[1], x[0]))] + [""]
    text = "\n".join(out)
    changed = not OVERVIEW.exists() or OVERVIEW.read_text(encoding="utf-8") != text
    if changed:
        OVERVIEW.parent.mkdir(parents=True, exist_ok=True)
        OVERVIEW.write_text(text, encoding="utf-8")
        index = WS / "memory" / "index.md"
        paths = [str(OVERVIEW.relative_to(WS))]
        if index.exists() and "research/feishu-overview.md" not in index.read_text(encoding="utf-8"):
            with index.open("a", encoding="utf-8") as fh:
                fh.write("\n## 资料\n\n- [飞书文档概览](research/feishu-overview.md) — 主人飞书里有什么、各多少份、怎么找到某一份\n")
            paths.append(str(index.relative_to(WS)))
        subprocess.run(["git", "add", "--", *paths], cwd=WS, capture_output=True)
        subprocess.run(["git", "commit", "-qm", f"chore(onboard): 飞书文档概览 {len(rows)} 份", "--", *paths], cwd=WS, capture_output=True)
    return {"total": len(rows), "imported": read, "changed": changed}


def drop_pending_transcripts() -> int:
    """早先读进来、还没编译、现在看不值得编的（同场已有智能纪要的逐字稿、旧空间名额外的），不编了，原文留着。"""
    manifest = WS / "memory-archive" / "imports" / "MANIFEST.json"
    if not manifest.exists():
        return 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    drop = {r["url"]: r["why"] for r in json.loads(INVENTORY.read_text(encoding="utf-8"))["nodes"]
            if r.get("why", "").startswith(("同一场会议", "一年没人改过"))}
    hit = [it for it in data.get("items", []) if it.get("disposition") == "pending" and it.get("url") in drop]
    for it in hit:
        it["disposition"], it["note"] = "skipped", drop[it["url"]]
    if hit:
        save_json(manifest, data)
        subprocess.run(["git", "add", "--", str(manifest.relative_to(WS))], cwd=WS, capture_output=True)
        subprocess.run(["git", "commit", "-qm", f"chore(onboard): 跳过 {len(hit)} 份不值得编译的", "--", str(manifest.relative_to(WS))], cwd=WS, capture_output=True)
    return len(hit)


def cmd_inventory(_a) -> None:
    say(inventory())


# ---------- pull ----------

def fetch(node: dict) -> tuple[str | None, str | None]:
    token = node["obj_token"]
    if node["obj_type"] == "docx":
        data, err = lark_retry("docs", "+fetch", "--doc", token, "--doc-format", "markdown", "--detail", "simple")
        return ((data or {}).get("document") or {}).get("content"), err
    data, err = lark_retry("api", "GET", f"/open-apis/doc/v2/{token}/raw_content")
    return (data or {}).get("content"), err


def cmd_pull(a) -> None:
    out = pull(a.all, a.spaces, a.limit, a.budget)
    say(out)
    sys.exit(4 if out.get("stopped") else 0)


MAX_CHARS = 30_000   # 单份最多收这么多字，再长的尾巴留在飞书里，要用时 get
BATCH = 20


def pull(all_spaces: bool, spaces: str | None, limit: int, budget: int) -> dict:
    """读正文，交给采集器。并发读、每 20 份落一次盘并存进度，随时被切断都能接着来。
    整读（--all、sync、read）只读精读那一层；主人点名空间（--spaces）就全读。"""
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
            and (n.get("tier") == "deep" if wanted is None else n["space_id"] in wanted)]
    # 分高的先读，同分的先读最近改的：主人眼下在忙的事比三年前的制度更值得先进记忆。
    todo.sort(key=lambda n: (n.get("score") or 0, n.get("edit") or ""), reverse=True)
    # 公司整理过的和主人手上正在写的交替着读：先读哪一类写出来的初稿都会偏。
    # 一年没人改过的空间放最后。
    a_side = [n for n in todo if n["space_id"] != DRIVE["space_id"] and not n.get("stale")]
    b_side = [n for n in todo if n["space_id"] == DRIVE["space_id"]]
    todo = ([n for pair in itertools.zip_longest(a_side, b_side) for n in pair if n]
            + [n for n in todo if n.get("stale")])
    started, done, failed, empty, updated, dup = time.time(), [], [], 0, 0, 0
    collector = WS / "scripts" / "onboard-collect.py"
    queue, stopped = todo[:limit], None
    pool = ThreadPoolExecutor(WORKERS - 2)
    for at in range(0, len(queue), BATCH):
        if time.time() - started > budget:
            break
        chunk = queue[at:at + BATCH]
        lines = []
        for n, (content, err) in zip(chunk, pool.map(fetch, chunk)):
            if err:
                failed.append({"title": n["title"], "error": err[:160]})
            elif not (content or "").strip():
                empty += 1
                pulled[n["node_token"]] = {"status": "empty", "at": time.strftime("%F"), "edit": n.get("edit", "")}
            else:
                again = n["node_token"] in pulled
                if len(content) > MAX_CHARS:
                    content = content[:MAX_CHARS] + "\n\n（原文更长，这里只收了前面的部分，全文在上面的链接里）"
                lines.append(json.dumps({
                    "key": n["node_token"], "url": n.get("url"), "content": content,
                    "title": f"[{n['space']}] {n['path']}" + (f"（更新版 {time.strftime('%F')}）" if again else ""),
                }, ensure_ascii=False))
        if lines:
            p = subprocess.run([sys.executable, str(collector), "add-batch", "--source", "feishu"],
                               input="\n".join(lines) + "\n", capture_output=True, text=True, cwd=WS)
            try:
                res = json.loads(p.stdout.strip().splitlines()[-1])
            except (ValueError, IndexError):
                failed += [{"title": n["title"], "error": (p.stderr or p.stdout)[-160:]} for n in chunk[:1]]
                break
            if res.get("blocked"):  # 体积闸门：停下来问主人，不要硬塞
                stopped = res["blocked"]
                save_json(PULLED, pulled)
                break
            by = {n["node_token"]: n for n in chunk}
            for d in res["done"]:
                n = by[d["key"]]
                updated += n["node_token"] in pulled
                dup += bool(d["duplicate"])
                pulled[n["node_token"]] = {"status": "imported", "at": time.strftime("%F"), "edit": n.get("edit", "")}
                done.append(n["title"])
            failed += res["failed"]
        save_json(PULLED, pulled)
    pool.shutdown(wait=False, cancel_futures=True)
    remaining = max(0, len(todo) - len(done) - len(failed) - empty)
    return {"ok": not failed and not stopped, "imported": len(done), "duplicate": dup, "updated": updated,
            "titles": done[:8], "failed": failed[:5], "failedCount": len(failed), "empty": empty,
            "remaining": remaining, "stopped": stopped, "elapsed_s": round(time.time() - started, 1),
            "next": ("还有没读完的，下一次接着" if remaining > 0 else "该精读的都读完了")}


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
    hard_stop(a.budget + 30)
    inv = inventory(budget=min(75, a.budget // 2))
    nodes = json.loads(INVENTORY.read_text(encoding="utf-8"))["nodes"]
    pulled = json.loads(PULLED.read_text(encoding="utf-8")) if PULLED.exists() else {}
    stamped = 0
    for n in nodes:
        seen = pulled.get(n["node_token"])
        if seen and not seen.get("edit") and n.get("edit"):
            seen["edit"] = n["edit"]; stamped += 1
    save_json(PULLED, pulled)
    out = pull(True, None, a.limit, max(20, a.budget - int(time.time() - started)))
    out["skippedTranscripts"] = drop_pending_transcripts()
    out["library"] = write_overview()
    out["tiers"] = inv["tiers"]
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

# 正在发生的事：会议纪要、周计划、OKR。只看公司介绍写不出「你手上有哪些事」。
ONGOING = re.compile(r"智能纪要|会议纪要|周报|周会|周.{0,4}(规划|计划|总结)|月报|复盘", re.I)
ABOUT_OTHERS = re.compile(r"有限公司|股份公司|集团公司")   # 多半是写给客户、关于客户的


def draft_picks(n: int = 10) -> list[dict]:
    """从已经读进来的原文里挑 n 份写初稿用，三类都要有：公司自己整理的（知识库、官网，
    每个空间最多两份）、正在发生的（纪要、周计划，最近的）、其余最近改过的。
    2026-11-22 只按标题关键词挑，十份全是写给客户的方案，初稿会把客户当成主人。"""
    manifest = WS / "memory-archive" / "imports" / "MANIFEST.json"
    try:
        items = json.loads(manifest.read_text(encoding="utf-8")).get("items", [])
    except (OSError, ValueError):
        return []
    docs = [it for it in items if it.get("path") and not it.get("duplicate_of")
            and not ABOUT_OTHERS.search(it.get("title", "")) and int(it.get("chars") or 0) >= 200]
    space = lambda it: (re.match(r"\[([^\]]*)\]", it.get("title", "")) or [None, it.get("source", "")])[1]  # noqa: E731
    hint = lambda it: (1 if DRAFT_HINT.search(it["title"]) else 0, min(int(it.get("chars") or 0), 8000))  # noqa: E731
    picked, per_space = [], collections.Counter()

    def take(pool, limit, cap=99):
        got = 0
        for it in pool:
            if got >= limit or len(picked) >= n:
                return
            if it in picked or per_space[space(it)] >= cap:
                continue
            picked.append(it)
            per_space[space(it)] += 1
            got += 1

    drive = [it for it in docs if space(it) == DRIVE["name"]]
    take(sorted((it for it in docs if space(it) != DRIVE["name"]), key=hint, reverse=True), 4, cap=1)
    take([it for it in drive if ONGOING.search(it["title"])], 3)    # 账本顺序就是读的顺序：最相关最近的在前
    take(drive, 2)
    take([it for it in docs if ONGOING.search(it["title"])], 1, cap=2)
    take(sorted(docs, key=hint, reverse=True), n, cap=2)
    take(drive, n)
    return [{"title": it["title"], "file": it["path"], "chars": it.get("chars")} for it in picked]


def cmd_read(a) -> None:
    """盘点 + 读所有建议读的空间，有时间上限；没读完就告诉调用方后台接着读。"""
    started = time.time()
    hard_stop(a.budget + 30)
    inv = inventory() if (a.reinventory or not INVENTORY.exists()) else None
    out = pull(True, None, a.limit, max(20, a.budget - int(time.time() - started)))
    out["library"] = write_overview()
    if inv:
        out["inventory_errors"] = inv["errors"][:5]
    # 报数的话由这里写好，原样发：只给一堆数字，模型会抄错（把「只进目录」的 1691 当成了总数 1991）。
    later = out.get("remaining") or 0
    out["headline"] = (f"你飞书里我能看到 {out['library']['total']} 份文档，先读了最近最相关的 {out['library']['imported']} 份，"
                       + (f"另外 {later} 份今晚接着读，" if later else "") + "其余的你问到我会当场去读。")
    out["forDraft"] = draft_picks()
    # 单轮硬上限 10 分钟，写初稿要两三分钟。资料多的时候不等读完：先读的就是最能说明主人的那些，
    # 够写初稿；剩下的后台接着读。
    out["draftNow"] = bool(out["forDraft"]) and time.time() - started <= 170
    out["next"] = (("这一轮接着写初稿" if out["draftNow"] else "加一次性任务写初稿")
                   + ("，再加一条一次性任务接着跑 read" if out.get("remaining") else ""))
    say(out)


def cmd_get(a) -> None:
    """当场读一份原文（不落盘）：给标题、标题里的词、链接或 token。"""
    if not INVENTORY.exists():
        say({"ok": False, "detail": "还没有盘点过飞书：先跑 sync"}); sys.exit(1)
    q = a.what.strip().strip("<>「」")
    nodes = json.loads(INVENTORY.read_text(encoding="utf-8"))["nodes"]
    hits = [n for n in nodes if q in (n["node_token"], n["obj_token"]) or (n.get("url") and q.split("?")[0] == n["url"].split("?")[0])
            or (len(q) >= 20 and n["node_token"] and n["node_token"] in q)]
    hits = hits or [n for n in nodes if n["title"] == q or n["path"] == q]
    if not hits:
        words = [w for w in re.split(r"\s+", q.lower()) if w]
        hits = [n for n in nodes if all(w in n["path"].lower() for w in words)]
    hits = [n for n in hits if not n["excluded"]]
    hits.sort(key=lambda n: n.get("edit") or "", reverse=True)
    if not hits:
        say({"ok": False, "detail": "飞书清单里没有这份文档（或标题像凭据，不读）"}); sys.exit(1)
    readable = [n for n in hits if n["fetchable"]]
    exact = readable and (len(readable) == 1 or readable[0]["title"] == q and sum(n["title"] == q for n in readable) == 1)
    if not exact and not a.first:
        say({"ok": True, "choose": [{"title": n["path"], "url": n["url"], "edit": n["edit"], "type": n["obj_type"]} for n in hits[:12]],
             "matches": len(hits), "next": "挑一份，用它的 url 再 get 一次（或 --first 读最近改过的那份）"}); return
    if not readable:
        say({"ok": False, "detail": f"这是{hits[0]['obj_type']}，暂时读不了正文", "url": hits[0]["url"]}); sys.exit(1)
    n = readable[0]
    content, err = fetch(n)
    if err:
        say({"ok": False, "title": n["path"], "detail": err}); sys.exit(1)
    spec = importlib.util.spec_from_file_location("onboard_collect", WS / "scripts" / "onboard-collect.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    body = mod.redact(content or "")[0]
    part = body[a.offset:a.offset + a.chars]
    print(f"标题：{n['path']}\n链接：{n['url']}\n第 {a.offset}–{a.offset + len(part)} 字，共 {len(body)} 字"
          + ("（后面还有，加 --offset 接着读）" if a.offset + len(part) < len(body) else "") + "\n\n" + part)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    cn = sub.add_parser("connect")
    cn.add_argument("--finish", action="store_true", help="主人点完授权链接之后收尾")
    cn.add_argument("--rescope", action="store_true", help="已经授权过、应用又开了新权限时，重新发授权链接把新权限带上")
    cn.set_defaults(fn=cmd_connect)
    rd = sub.add_parser("read")
    rd.add_argument("--limit", type=int, default=100, help="这一轮最多读几份（默认 100）")
    rd.add_argument("--budget", type=int, default=120, help="这一轮最多花多少秒，含盘点（默认 120，到点一定结束）")
    rd.add_argument("--reinventory", action="store_true", help="重新盘点空间（默认只在第一次盘点）")
    rd.set_defaults(fn=cmd_read)
    sub.add_parser("picks").set_defaults(fn=lambda _a: say({"forDraft": draft_picks()}))
    gt = sub.add_parser("get")
    gt.add_argument("what", help="标题、标题里的词（空格分开）、链接或 token")
    gt.add_argument("--first", action="store_true", help="有多份匹配时直接读最近改过的那份")
    gt.add_argument("--offset", type=int, default=0)
    gt.add_argument("--chars", type=int, default=12000)
    gt.set_defaults(fn=cmd_get)
    sy = sub.add_parser("sync")
    sy.add_argument("--limit", type=int, default=DEEP_LIMIT, help=f"这一次最多读几份（默认 {DEEP_LIMIT}）")
    sy.add_argument("--budget", type=int, default=150, help="这一次最多花多少秒，含盘点（默认 150，到点一定结束）")
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
