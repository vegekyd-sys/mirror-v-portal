#!/usr/bin/env python3
"""dc_cron_query.py — 从 ``openclaw cron list --all --json`` 里查一条声明式 job。

``dc_cron_lib.sh`` 的取数后端：shell 一行 JSON 都不解析，全部丢给这里。
输入走 stdin，就是 ``openclaw cron list --all --json`` 的原样输出：

    openclaw cron list --all --json | python3 dc_cron_query.py summary --decl-key dealclaw-pending-send

模式：

    id       打印 job id；找不到 exit 1
    state    打印 missing / enabled / disabled（永远 exit 0，给 doctor 用）
    summary  打印人读的多行摘要（调度 / 状态 / 上次 / 下次 / 命令）；找不到 exit 1
    dupes    打印「命令里含 --match 但 declarationKey 不是本条」的 job，用来抓手工
             注册出来的重复调度器（没有 declaration-key 的那种，converge 管不到它）
    doctor   对着 --required / --optional 两张清单逐条体检；有必需项缺失/停用/
             排不上期就 exit 1（给 dc_cron_doctor.sh 用）

列表解包方式与 ``runtime/dc-cron-converge.py`` 的 ``read_actual()`` 保持一致：
payload 可能被 ``{"result": ...}`` / ``{"jobs": [...]}`` 包一层。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime


def unwrap(payload: object) -> list[dict]:
    """剥掉 {"result": ...} / {"jobs": [...]} 的包装，拿到 job 数组。

    比 runtime/dc-cron-converge.py 的同名逻辑更严一点：那边认不出的结构会退化成
    空列表，这里一律抛错。「读不出来」和「一条都没有」是两回事 —— 把前者说成后者，
    正是 2026-09-16 那次故障没被及时发现的那种降级。
    """
    jobs: object = payload
    for key in ("result", "jobs"):
        if isinstance(jobs, dict) and key in jobs:
            jobs = jobs[key]
    if not isinstance(jobs, list):
        raise ValueError(f"openclaw cron list 输出里找不到 jobs 数组（拿到 {type(jobs).__name__}）")
    return [j for j in jobs if isinstance(j, dict)]


def fmt_ts(ms: object) -> str:
    if not isinstance(ms, (int, float)) or ms <= 0:
        return ""
    return datetime.fromtimestamp(ms / 1000).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def fmt_schedule(job: dict) -> str:
    sched = job.get("schedule")
    if not isinstance(sched, dict):
        return "(未知)"
    kind = sched.get("kind")
    if kind == "cron":
        return f"{sched.get('expr')} @ {sched.get('tz') or '(本地时区)'}"
    if kind == "every":
        every = sched.get("everyMs")
        if isinstance(every, (int, float)):
            return f"每 {int(every) // 1000}s"
        return "every(未知)"
    if kind == "at":
        return f"一次性 @ {sched.get('at')}"
    return str(kind)


def fmt_command(job: dict) -> str:
    payload = job.get("payload")
    if not isinstance(payload, dict):
        return "(未知)"
    if payload.get("kind") != "command":
        return f"(非 command 类型: {payload.get('kind')})"
    argv = payload.get("argv")
    cmd = " ".join(str(a) for a in argv) if isinstance(argv, list) else str(argv)
    return f"{cmd}  @ {payload.get('cwd') or '(继承 cwd)'}"


def is_enabled(job: dict) -> bool:
    # 缺字段按「启用」处理：gateway 只在显式停用时才写 enabled=false
    return job.get("enabled") is not False


def find(jobs: list[dict], decl_key: str) -> dict | None:
    for job in jobs:
        if job.get("declarationKey") == decl_key:
            return job
    return None


def summary(job: dict) -> str:
    last = fmt_ts(job.get("lastRunAtMs"))
    status = job.get("lastStatus")
    if last:
        last_line = f"{last}（{status or '无状态'}）"
    else:
        last_line = "从未运行 —— 刚注册属正常；长期为空说明调度器没触发它，要查"
    lines = [
        f"  job id   : {job.get('id')}",
        f"  名称     : {job.get('displayName') or job.get('name') or '(无)'}",
        f"  调度     : {fmt_schedule(job)}",
        f"  状态     : {'已启用' if is_enabled(job) else '已停用（openclaw cron enable <id> 恢复）'}",
        f"  上次运行 : {last_line}",
        f"  下次运行 : {fmt_ts(job.get('nextRunAtMs')) or '(未排期)'}",
        f"  命令     : {fmt_command(job)}",
    ]
    return "\n".join(lines)


def doctor(jobs: list[dict], required: list[str], optional: list[str]) -> int:
    """逐条体检两张清单。返回 0=必需项全都在且能跑，1=有必需项出问题。"""
    failed = 0
    warned = 0

    def check(decl_key: str, must: bool) -> None:
        nonlocal failed, warned
        job = find(jobs, decl_key)
        label = "必需" if must else "可选"
        if job is None:
            if must:
                print(f"  ✗ {decl_key}  未注册（{label}）")
                failed += 1
            else:
                print(f"  · {decl_key}  未注册（{label}，按需开启）")
            return
        if not is_enabled(job):
            print(f"  ✗ {decl_key}  已停用，不会被触发 —— openclaw cron enable {job.get('id')}")
            if must:
                failed += 1
            return
        nxt = fmt_ts(job.get("nextRunAtMs"))
        if not nxt:
            # 已启用却排不上期 = 调度器没接住它，和「没注册」等价
            print(f"  ✗ {decl_key}  已启用但没有下次运行时间（排不上期）")
            if must:
                failed += 1
            return
        last = fmt_ts(job.get("lastRunAtMs"))
        status = job.get("lastStatus")
        if not last:
            print(f"  ⚠ {decl_key}  从未运行过（刚注册属正常；否则要查）｜下次 {nxt}")
            warned += 1
        elif status not in (None, "", "ok", "success"):
            print(f"  ⚠ {decl_key}  上次运行 {last} 结果 {status}｜下次 {nxt}")
            warned += 1
        else:
            print(f"  ✓ {decl_key}  上次 {last}｜下次 {nxt}｜{fmt_schedule(job)}")

    if required:
        print("镜像层自动注册（entrypoint 每次启动都会 converge）：")
        for key in required:
            check(key, True)
    if optional:
        print("payload 层按需注册（不开就不会有）：")
        for key in optional:
            check(key, False)

    print("")
    if failed:
        print(f"结论：{failed} 条必需定时任务没挂上或跑不了 —— 队列型任务会静默堆积，赶紧修。")
    elif warned:
        print(f"结论：必需任务都在，但有 {warned} 条需要留意（见上面 ⚠）。")
    else:
        print("结论：必需定时任务全部已注册、已启用、已排期。")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode", choices=("id", "state", "summary", "dupes", "doctor"))
    ap.add_argument("--decl-key", default="", help="除 doctor 外必填")
    ap.add_argument("--match", default="", help="dupes 模式下要在命令里查找的子串")
    ap.add_argument("--required", default="", help="doctor 模式：必需的 declaration-key，逗号分隔")
    ap.add_argument("--optional", default="", help="doctor 模式：可选的 declaration-key，逗号分隔")
    args = ap.parse_args()

    if args.mode != "doctor" and not args.decl_key:
        ap.error("除 doctor 外都必须传 --decl-key")

    try:
        jobs = unwrap(json.load(sys.stdin))
    except Exception as err:
        print(f"[dc_cron_query] 解析 openclaw cron list 输出失败：{err}", file=sys.stderr)
        return 2

    if args.mode == "doctor":
        split = lambda raw: [k.strip() for k in raw.split(",") if k.strip()]
        return doctor(jobs, split(args.required), split(args.optional))

    if args.mode == "dupes":
        needle = args.match.strip()
        if not needle:
            return 0
        hits = [
            j for j in jobs
            if needle in fmt_command(j) and j.get("declarationKey") != args.decl_key
        ]
        for job in hits:
            decl = job.get("declarationKey") or "(无 declaration-key)"
            print(f"{job.get('id')}\t{job.get('displayName') or '(无名)'}\t{decl}\t{fmt_schedule(job)}")
        return 0

    job = find(jobs, args.decl_key)

    if args.mode == "state":
        print("missing" if job is None else ("enabled" if is_enabled(job) else "disabled"))
        return 0

    if job is None:
        return 1
    print(job.get("id") if args.mode == "id" else summary(job))
    return 0


if __name__ == "__main__":
    sys.exit(main())
