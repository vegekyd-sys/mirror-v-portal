#!/usr/bin/env python3
"""dc-cron-converge.py — 让镜像声明的 cron schedule 与用户手改共存。

背景
----
`openclaw cron add --declaration-key` 是声明式 converge：每次 entrypoint 重跑
dc-cron-*.sh，都会把 job 的 declarative 字段拉回镜像里写死的值。openclaw
2026.7.1 参与 converge 的字段见 src/cron/service/ops.ts:608-616：

    schedule / trigger / payload / delivery / displayName（+ enabled，仅当显式传）

payload 被覆盖是我们要的（command、env、timeoutSeconds 必须随版本走）。
enabled 已经天然安全：CLI 在带 --declaration-key 且没显式 --disabled 时不会把
enabled 发给 gateway（register.cron-add.ts:411-413），所以用户 `cron disable`
的结果扛得住升级。

真正会被无脑重置的只剩 **schedule**——用户让 agent 把早报从 9:30 改成 8:00，
下次滚动升级就被打回去。本脚本就是为这一个字段做三方合并（kubectl apply 的
思路）：

    declared_now   本次镜像声明的默认值（调用方传进来）
    declared_last  上次镜像推下去的默认值（持久化在状态文件里）
    actual         当前 job 的真实值（openclaw cron list --json 读）

    actual == declared_last                    → 用户没动过，用 declared_now（默认值推得动）
    actual != declared_last, now == last       → 只有用户动了，保留 actual
    actual != declared_last, now != last       → 两边都动了，保留 actual 并告警

用法
----
    eval "$(dc-cron-converge.py resolve --decl-key K --cron "30 9 * * *" --tz Asia/Shanghai)"
    # → 导出 DC_CRON_KIND / DC_CRON_EXPR / DC_CRON_TZ / DC_CRON_EVERY / DC_CRON_SOURCE

    openclaw cron add --cron "$DC_CRON_EXPR" --tz "$DC_CRON_TZ" ... && \
      dc-cron-converge.py record --decl-key K --cron "30 9 * * *" --tz Asia/Shanghai

record 必须在 add 成功之后调用：如果 add 失败却提前写了 declared_last，下次启动
会把 actual 误判成「用户改过」，默认值从此永远推不动。

状态文件默认 $DC_CRON_DECLARED_FILE，否则
$OPENCLAW_WORKSPACE_DIR/data/dealclaw/cron-declared.json。

路径选型有两个硬约束，别随手挪：
1. 必须在 entrypoint.sh 那条 `rsync -a --delete` 的 exclude 列表覆盖范围内，
   否则每次容器启动都会被删掉 —— 基线一丢就永远走 bootstrap 分支，
   镜像默认值再也推不下去，而且不报错。workspace 根下的 `data/` 已被
   `--exclude='/data/'` 保护（tenant-env.json 也存那儿）。
2. 不放 $OPENCLAW_STATE_DIR —— 那是 openclaw 自己的地盘（现在是 SQLite）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

STATE_VERSION = 1
_DURATION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$", re.IGNORECASE)
_UNIT_MS = {"ms": 1, "s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}


def log(msg: str) -> None:
    print(f"[dc-cron-converge] {msg}", file=sys.stderr)


# ── 状态文件 ────────────────────────────────────────────────────────────────


def state_path() -> Path:
    override = (os.environ.get("DC_CRON_DECLARED_FILE") or "").strip()
    if override:
        return Path(override)
    ws = (os.environ.get("OPENCLAW_WORKSPACE_DIR") or "/data/workspace").strip()
    # workspace 根下的 data/ 被 entrypoint 的 rsync --delete 排除，是租户可写的持久位置。
    # 放到 rsync 会清理的目录（如 workspace 根下自建的 .dealclaw/）会导致基线每次启动被删。
    return Path(ws) / "data" / "dealclaw" / "cron-declared.json"


def load_state() -> dict[str, Any]:
    path = state_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": STATE_VERSION, "declarations": {}}
    except Exception as err:  # 损坏时不能当成「用户没改过」，宁可退化成 bootstrap
        log(f"状态文件不可读（{path}）：{err}；按首次运行处理")
        return {"version": STATE_VERSION, "declarations": {}}
    if not isinstance(data, dict) or not isinstance(data.get("declarations"), dict):
        log(f"状态文件结构异常（{path}）；按首次运行处理")
        return {"version": STATE_VERSION, "declarations": {}}
    return data


def save_state(state: dict[str, Any]) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # 原子写：升级过程中被 SIGKILL 不会留下半个 JSON
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".cron-declared.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── schedule 归一化 ─────────────────────────────────────────────────────────


def parse_duration_ms(raw: str) -> int:
    m = _DURATION_RE.match(raw)
    if not m:
        raise ValueError(f"无法解析周期: {raw!r}")
    value, unit = float(m.group(1)), (m.group(2) or "ms").lower()
    return int(value * _UNIT_MS[unit])


def schedule_from_args(args: argparse.Namespace) -> dict[str, Any]:
    """调用方声明的 declared_now。"""
    if args.cron:
        out: dict[str, Any] = {"kind": "cron", "expr": args.cron.strip()}
        if args.tz and args.tz.strip():
            out["tz"] = args.tz.strip()
        return out
    return {"kind": "every", "everyMs": parse_duration_ms(args.every)}


def normalize(schedule: Any) -> dict[str, Any] | None:
    """只保留参与比较的字段。

    staggerMs / anchorMs 是 openclaw 自己派生的运行时值（cron 整点会被自动
    stagger，every 会被打 anchor），把它们纳入比较会让每条 job 都被误判成
    「用户改过」。
    """
    if not isinstance(schedule, dict):
        return None
    kind = schedule.get("kind")
    if kind == "cron":
        expr = schedule.get("expr")
        if not isinstance(expr, str):
            return None
        tz = schedule.get("tz")
        out: dict[str, Any] = {"kind": "cron", "expr": expr.strip()}
        if isinstance(tz, str) and tz.strip():
            out["tz"] = tz.strip()
        return out
    if kind == "every":
        every = schedule.get("everyMs")
        if not isinstance(every, (int, float)):
            return None
        return {"kind": "every", "everyMs": int(every)}
    if kind == "at":
        at = schedule.get("at")
        return {"kind": "at", "at": at} if isinstance(at, str) else None
    return None


# ── 读取 actual ─────────────────────────────────────────────────────────────


def read_actual(decl_key: str) -> dict[str, Any] | None:
    """从 gateway 读当前 job 的 schedule；job 不存在返回 None。

    读不到（gateway 不通、CLI 报错）会抛异常 —— 调用方据此中止本条注册，
    而不是拿默认值去覆盖用户的修改。
    """
    proc = subprocess.run(
        ["openclaw", "cron", "list", "--all", "--json"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"openclaw cron list 失败（exit {proc.returncode}）: {proc.stderr.strip()}")
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"openclaw cron list 输出不是合法 JSON: {err}") from err

    jobs = payload
    for key in ("result", "jobs"):
        if isinstance(jobs, dict) and key in jobs:
            jobs = jobs[key]
    if isinstance(jobs, dict):
        jobs = jobs.get("jobs", [])
    if not isinstance(jobs, list):
        raise RuntimeError("openclaw cron list 输出里找不到 jobs 数组")

    for job in jobs:
        if isinstance(job, dict) and job.get("declarationKey") == decl_key:
            return normalize(job.get("schedule"))
    return None


# ── 三方合并 ────────────────────────────────────────────────────────────────


def resolve(args: argparse.Namespace) -> int:
    decl_key = args.decl_key
    declared_now = normalize(schedule_from_args(args))
    if declared_now is None:
        log(f"{decl_key}: 声明的 schedule 非法，中止")
        return 2

    try:
        actual = read_actual(decl_key)
    except Exception as err:
        log(f"{decl_key}: 读取现状失败：{err}")
        if not args.fallback_to_default:
            # 默认宁可不注册，也不拿默认值盖掉用户的修改；下次启动会重试
            return 3
        log(f"{decl_key}: --fallback-to-default 生效，改用镜像默认值")
        emit(declared_now, "default-fallback")
        return 0

    declared_last = normalize((load_state()["declarations"].get(decl_key) or {}).get("schedule"))

    if actual is None:
        # job 还不存在：全新租户，或用户把它删了。两种都按默认值重建。
        emit(declared_now, "default-new")
        return 0

    if declared_last is None:
        # 本功能首次上线，没有历史基线。此时无法区分「用户改过」和「镜像默认值变过」，
        # 保守保留 actual：宁可少推一次默认值，也不要冲掉用户已有的自定义。
        # record 之后第二次升级起就走正常三方比较。
        if actual != declared_now:
            log(f"{decl_key}: 无历史基线且现状与默认值不同，保留现状（首次上线的保守策略）")
            emit(actual, "user-bootstrap")
        else:
            emit(declared_now, "default")
        return 0

    if actual == declared_last:
        emit(declared_now, "default")
        return 0

    if declared_now == declared_last:
        emit(actual, "user")
        return 0

    log(
        f"{decl_key}: 冲突 —— 用户改过 schedule，同时镜像默认值也变了"
        f"（默认 {json.dumps(declared_last, ensure_ascii=False)} → "
        f"{json.dumps(declared_now, ensure_ascii=False)}，现状 "
        f"{json.dumps(actual, ensure_ascii=False)}）；保留用户的"
    )
    emit(actual, "user-conflict")
    return 0


def emit(schedule: dict[str, Any], source: str) -> None:
    """输出给 shell eval 的赋值语句。"""
    lines = [f"DC_CRON_KIND={shlex.quote(schedule['kind'])}", f"DC_CRON_SOURCE={shlex.quote(source)}"]
    if schedule["kind"] == "cron":
        lines.append(f"DC_CRON_EXPR={shlex.quote(schedule['expr'])}")
        lines.append(f"DC_CRON_TZ={shlex.quote(schedule.get('tz', ''))}")
        lines.append("DC_CRON_EVERY=''")
    elif schedule["kind"] == "every":
        every_ms = int(schedule["everyMs"])
        lines.append("DC_CRON_EXPR=''")
        lines.append("DC_CRON_TZ=''")
        # openclaw 的 --every 接受 ms 数字
        lines.append(f"DC_CRON_EVERY={shlex.quote(str(every_ms))}")
    print("\n".join(f"export {line}" for line in lines))


def record(args: argparse.Namespace) -> int:
    declared_now = normalize(schedule_from_args(args))
    if declared_now is None:
        log(f"{args.decl_key}: 声明的 schedule 非法，不记录")
        return 2
    state = load_state()
    state["version"] = STATE_VERSION
    state["declarations"][args.decl_key] = {"schedule": declared_now}
    save_state(state)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    for name in ("resolve", "record"):
        p = sub.add_parser(name)
        p.add_argument("--decl-key", required=True)
        group = p.add_mutually_exclusive_group(required=True)
        group.add_argument("--cron", help="镜像声明的 cron 表达式")
        group.add_argument("--every", help="镜像声明的周期，如 6h / 300000")
        p.add_argument("--tz", default="", help="cron 表达式的时区（IANA）")
        if name == "resolve":
            p.add_argument(
                "--fallback-to-default",
                action="store_true",
                help="读不到现状时改用镜像默认值（有覆盖用户修改的风险，默认关闭）",
            )

    args = parser.parse_args()
    try:
        return resolve(args) if args.cmd == "resolve" else record(args)
    except Exception as err:
        log(f"未预期错误：{err}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
