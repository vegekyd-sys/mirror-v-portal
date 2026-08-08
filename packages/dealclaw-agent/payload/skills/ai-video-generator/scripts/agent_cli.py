#!/usr/bin/env python3
"""
Agent 任务管理系统 CLI
=======================
完全替代 Web 前端的命令行工具。

功能：
  - 提交 Agent 视频生成任务（交互式 / 命令行）
  - 查看任务列表（实时进度条）
  - 实时监控任务进度（进度条刷新 + 日志增量显示）
  - 查看任务详情（已完成视频、统计信息、日志、总结）
  - 下载结果 ZIP
  - 清理任务文件
  - 删除任务
  - 服务器性能监控

使用方式：
  python3 agent-cli.py <command> [options]

配置文件：
  config.yaml — 编辑其中的 java_server_url 和 python_server_url 即可适配不同的后端环境。

依赖：Python 3.8+，无需第三方包（仅使用标准库）。
"""

import os
import sys
import json
import time
import argparse
import urllib.request
import urllib.error
import urllib.parse
import shutil
import textwrap
from datetime import datetime
from pathlib import Path

# ─────────────────────────────────────────────────────────────
# 简易 YAML 解析（避免依赖 PyYAML）
# ─────────────────────────────────────────────────────────────

def _parse_simple_yaml(text):
    result = {}
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if val.lower() == "true":
                val = True
            elif val.lower() == "false":
                val = False
            else:
                try:
                    val = int(val)
                except ValueError:
                    try:
                        val = float(val)
                    except ValueError:
                        pass
            result[key] = val
    return result

# ─────────────────────────────────────────────────────────────
# 全局配置
# ─────────────────────────────────────────────────────────────

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml")

DEFAULT_CONFIG = {
    "java_server_url": "https://d12.ultronx.tech/api",
    "python_server_url": "https://template-api-test.ultronx.tech",
    "default_account": "admin",
    "default_language": "中文",
    "default_video_count": 2,
}

def load_config():
    config = DEFAULT_CONFIG.copy()
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                loaded = _parse_simple_yaml(f.read())
            if loaded:
                config.update(loaded)
        except Exception as e:
            print(f"⚠️  配置文件加载失败: {e}，使用默认配置", file=sys.stderr)
    return config

CONFIG = load_config()

TEMPLATES = [
    {"id": "mix_template_v2", "name": "沉浸混剪v2", "desc": "无配音，DAM搜索匹配，无过渡处理"},
    {"id": "dubbing_generator", "name": "AI配音生成", "desc": "配音混剪，AI生成视频优先，DAM兜底"},
    {"id": "origin_sound_mix", "name": "原声混剪", "desc": "无配音，保留素材原生音频"},
    {"id": "dubbing_mix", "name": "配音混剪", "desc": "标准配音混剪，LLM动态分段，DAM匹配素材"},
    {"id": "dubbing_script_range_mix", "name": "脚本配音", "desc": "配音混剪，按字幕时间点固定素材区间"},
    {"id": "opening_human_generator", "name": "数字人开场", "desc": "数字人形象口播开场+素材混剪"},
    {"id": "mix_template", "name": "沉浸混剪v1", "desc": "无配音沉浸式混剪，随机区间，含转场过渡效果"},
]

# ─────────────────────────────────────────────────────────────
# HTTP 工具函数
# ─────────────────────────────────────────────────────────────

def _http_get(url, timeout=15):
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise Exception(f"HTTP {e.code}: {e.reason} | {body[:200]}")
    except urllib.error.URLError as e:
        raise Exception(f"网络错误: {e.reason}")
    except json.JSONDecodeError as e:
        raise Exception(f"JSON 解析错误: {e}")

def _http_post(url, data=None, timeout=15):
    body = json.dumps(data).encode("utf-8") if data else b""
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise Exception(f"HTTP {e.code}: {e.reason} | {body[:200]}")
    except urllib.error.URLError as e:
        raise Exception(f"网络错误: {e.reason}")

def _http_delete(url, timeout=15):
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise Exception(f"HTTP {e.code}: {e.reason} | {body[:200]}")
    except urllib.error.URLError as e:
        raise Exception(f"网络错误: {e.reason}")

# ─────────────────────────────────────────────────────────────
# API 调用层
# ─────────────────────────────────────────────────────────────

class AgentAPI:
    def __init__(self, base_url=None):
        self.base_url = (base_url or CONFIG["python_server_url"]).rstrip("/")
        self.java_url = CONFIG["java_server_url"].rstrip("/")

    def submit_task(self, data):
        return _http_post(self.base_url + "/api/agent/submit", data)

    def get_tasks(self):
        return _http_get(self.base_url + "/api/agent/tasks")

    def get_progress(self, taskid, last_lines=50, offset=0, return_zip=False, clear_files=False):
        params = {"last_lines": last_lines, "offset": offset}
        if return_zip:
            params["return_zip"] = "true"
        if clear_files:
            params["isclearfile"] = "true"
        url = f"{self.base_url}/api/agent/progress/{taskid}?" + urllib.parse.urlencode(params)
        return _http_get(url)

    def delete_task(self, taskid):
        return _http_delete(f"{self.base_url}/api/agent/tasks/{taskid}")

    def get_libraries(self, account="admin"):
        return _http_get(f"{self.base_url}/api/agent/libraries", {"account": account})

    def get_languages(self):
        return _http_get(f"{self.base_url}/api/agent/languages")

    def get_system_stats(self):
        try:
            return _http_get(f"{self.base_url}/api/system/stats")
        except Exception:
            return None

# ─────────────────────────────────────────────────────────────
# 终端 UI 渲染
# ─────────────────────────────────────────────────────────────

class UI:
    _COLOR = bool(os.environ.get("TERM") and "color" in os.environ.get("TERM", "").lower()
                  or os.name == "nt" and "WT_SESSION" in os.environ)

    @staticmethod
    def _c(code, text):
        return f"\033[{code}m{text}\033[0m" if UI._COLOR else text

    @staticmethod
    def red(t): return UI._c("31", t)
    @staticmethod
    def green(t): return UI._c("32", t)
    @staticmethod
    def yellow(t): return UI._c("33", t)
    @staticmethod
    def blue(t): return UI._c("34", t)
    @staticmethod
    def bold(t): return UI._c("1", t)
    @staticmethod
    def dim(t): return UI._c("2", t)
    @staticmethod
    def cyan(t): return UI._c("36", t)

    @staticmethod
    def dot(status):
        m = {"pending": UI.yellow("\u25cf"), "running": UI.blue("\u25cf"),
             "completed": UI.green("\u25cf"), "failed": UI.red("\u25cf"), "not_found": UI.red("\u25cf")}
        return m.get(status, "\u25cb")

    @staticmethod
    def pbar(pct, width=30):
        filled = int(width * pct / 100)
        bar = "\u2588" * filled + "\u2591" * (width - filled)
        if pct >= 100:
            return UI.green(bar)
        return UI.cyan(bar) if pct > 0 else UI.dim(bar)

    @staticmethod
    def truncate(text, n=40):
        return text if len(text) <= n else text[:n-3] + "..."

    @staticmethod
    def header(text):
        w = min(shutil.get_terminal_size().columns, 80)
        print(f"\n{UI.bold('\u2554' + '\u2550' * (w - 2) + '\u2557')}")
        for line in textwrap.wrap(text, w - 6):
            print(f"{UI.bold('\u2551 ')}{line.center(w - 6)}{UI.bold(' \u2551')}")
        print(f"{UI.bold('\u255a' + '\u2550' * (w - 2) + '\u2557')}\n")

    @staticmethod
    def info(label, value):
        print(f"  {UI.bold(label)}: {value}")

    @staticmethod
    def ok(msg):
        print(f"  {UI.green('\u2713')} {msg}")

    @staticmethod
    def err(msg):
        print(f"  {UI.red('\u2717')} {msg}")

    @staticmethod
    def warn(msg):
        print(f"  {UI.yellow('\u26a0')} {msg}")

    @staticmethod
    def log_line(line):
        l = line.lower()
        if any(k in l for k in ["error", "exception", "traceback"]):
            print(f"  {UI.red(line)}")
        elif "warn" in l:
            print(f"  {UI.yellow(line)}")
        elif "info" in l:
            print(f"  {UI.cyan(line)}")
        else:
            print(f"  {line}")

    @staticmethod
    def table(headers, rows, max_w=120):
        tw = min(shutil.get_terminal_size().columns, max_w)
        nc = len(headers)
        cw = [len(h) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                cw[i] = max(cw[i], len(str(cell or "")))
        total = sum(cw) + (nc - 1) * 3 + 4
        if total > tw:
            ratio = (tw - (nc - 1) * 3 - 4) / max(total - (nc - 1) * 3 - 4, 1)
            cw = [max(8, int(w * ratio)) for w in cw]
        print("\u250c" + "\u252c".join("\u2500" * (w + 2) for w in cw) + "\u2510")
        print("\u2502" + "\u2502".join(" " + UI.bold(h.ljust(cw[i])) + " " for i, h in enumerate(headers)) + "\u2502")
        print("\u251c" + "\u253c".join("\u2500" * (w + 2) for w in cw) + "\u2524")
        for row in rows:
            print("\u2502" + "\u2502".join(" " + str(c or "").ljust(cw[i]) + " " for i, c in enumerate(row)) + "\u2502")
        print("\u2514" + "\u2534".join("\u2500" * (w + 2) for w in cw) + "\u2518")

# ─────────────────────────────────────────────────────────────
# 任务监控器
# ─────────────────────────────────────────────────────────────

class TaskMonitor:
    def __init__(self, api, taskid, interval=3):
        self.api = api
        self.taskid = taskid
        self.interval = interval
        self._offset = 0
        self._last_pct = -1
        self._videos = []

    def run(self):
        UI.header(f"\U0001f4ca 监控任务: {self.taskid}")
        try:
            while True:
                data = self.api.get_progress(self.taskid, last_lines=50, offset=self._offset)
                self._render(data)
                s = data.get("status", "")
                if s in ("completed", "failed", "not_found"):
                    self._final(data)
                    return
                time.sleep(self.interval)
        except KeyboardInterrupt:
            print()
            UI.warn("监控已停止 (Ctrl+C)")
        except Exception as e:
            UI.err(f"监控异常: {e}")

    def _render(self, data):
        pct = data.get("percent", 0) or 0
        done = data.get("completed_count", 0) or 0
        total = data.get("total_count", 0) or 0
        st = data.get("status", "??")
        if pct != self._last_pct:
            bar = UI.pbar(pct)
            print(f"\r  {UI.bold('进度')}: {bar} {done}/{total} {pct}%  [{UI.dot(st)} {st}]",
                  end="", flush=True)
            self._last_pct = pct
        logs = data.get("log_lines", [])
        if logs:
            new = logs[self._offset:]
            if new:
                print()
                for line in new:
                    UI.log_line(line)
            self._offset = len(logs)
        vids = data.get("completed_videos", [])
        if vids and len(vids) > len(self._videos):
            for v in vids[len(self._videos):]:
                print(f"\n  {UI.green('\u2713')} 视频: {v.get('title', '?')} [{v.get('template_id', '\u2014')}]")
                if v.get("mp4_url"):
                    print(f"    {UI.dim(v['mp4_url'])}")
            self._videos = vids

    def _final(self, data):
        print()
        s = data.get("status", "unknown")
        if s == "completed":
            UI.header("\u2705 任务完成")
        elif s == "failed":
            UI.header("\u274c 任务失败")
        else:
            UI.header("\u26a0\ufe0f  任务不存在")
        UI.info("状态", f"{UI.dot(s)} {s}")
        done = data.get("completed_count", 0) or 0
        total = data.get("total_count", 0) or 0
        UI.info("完成数", f"{done}/{total}")
        url = data.get("result_zip_url", "")
        if url:
            print()
            UI.ok("\U0001f4e6 结果下载:")
            print(f"     {url}")
        sm = data.get("summary", "")
        if sm:
            print(f"\n  {UI.bold('\U0001f4cb 执行总结')}:")
            for line in sm.split("\n"):
                if line.strip():
                    print(f"    {line}")
        err = data.get("error", "")
        if err:
            print(f"\n  {UI.err(UI.bold('错误信息'))}:")
            print(f"    {err}")
# ═════════════════════════════════════════════════════════════
# 命令实现
# ═════════════════════════════════════════════════════════════

def cmd_submit(args):
    api = AgentAPI()
    if args.requirement:
        # 命令行模式
        account = args.account or CONFIG["default_account"]
        req = args.requirement
        vc = args.video_count or CONFIG["default_video_count"]
        lang = args.language or CONFIG["default_language"]
        video_lib = args.video_lib or ""
        audio_lib = args.audio_lib or ""
        tpls = args.templates or []
        tid = args.taskid or ""
    else:
        # 交互模式
        UI.header("📝 提交新任务")
        account = input(f"  Account [{CONFIG['default_account']}]: ").strip() or CONFIG["default_account"]
        print(f"  {UI.dim('正在加载素材库...')}")
        try:
            ld = api.get_libraries(account)
            if ld.get("success"):
                video_libs = ld.get("video_libraries", [])
                audio_libs = ld.get("audio_libraries", [])
                print(f"  {UI.dim(f'已加载 {len(video_libs)} 个视频库, {len(audio_libs)} 个音频库')}")
            else:
                video_libs, audio_libs = [], []
                UI.warn(f"加载素材库失败: {ld.get('error', '?')}")
        except Exception as e:
            video_libs, audio_libs = [], []
            UI.warn(f"加载素材库失败: {e}")
        if video_libs:
            print(f"\n  {UI.bold('视频素材库')}:")
            for i, lib in enumerate(video_libs):
                print(f"    [{i+1}] [{lib.get('id','')}] {lib.get('projectName','')} (素材: {lib.get('totalCount',0)})")
            sel = input(f"  选择 [1-{len(video_libs)}]: ").strip()
            try:
                video_lib = str(video_libs[int(sel)-1].get("id",""))
            except (ValueError, IndexError):
                video_lib = ""
        else:
            video_lib = input("  视频素材库 ID: ").strip()
        if audio_libs:
            print(f"\n  {UI.bold('音频素材库')}:")
            for i, lib in enumerate(audio_libs):
                print(f"    [{i+1}] [{lib.get('id','')}] {lib.get('projectName','')} (素材: {lib.get('totalCount',0)})")
            sel = input(f"  选择 [1-{len(audio_libs)}]: ").strip()
            try:
                audio_lib = str(audio_libs[int(sel)-1].get("id",""))
            except (ValueError, IndexError):
                audio_lib = ""
        else:
            audio_lib = input("  音频素材库 ID: ").strip()
        try:
            lg = api.get_languages()
            if lg.get("success"):
                langs = lg.get("languages", [])
                if langs:
                    print(f"\n  {UI.bold('语言')}:")
                    for i, ln in enumerate(langs):
                        mark = " (默认)" if ln == CONFIG["default_language"] else ""
                        print(f"    [{i+1}] {ln}{mark}")
                    sel = input(f"  选择 [1-{len(langs)}]: ").strip()
                    try:
                        lang = langs[int(sel)-1]
                    except (ValueError, IndexError):
                        lang = CONFIG["default_language"]
                else:
                    lang = input(f"  语言 [{CONFIG['default_language']}]: ").strip() or CONFIG["default_language"]
            else:
                lang = input(f"  语言 [{CONFIG['default_language']}]: ").strip() or CONFIG["default_language"]
        except Exception:
            lang = input(f"  语言 [{CONFIG['default_language']}]: ").strip() or CONFIG["default_language"]
        cnt = input(f"  目标视频数 [{CONFIG['default_video_count']}]: ").strip()
        try:
            vc = int(cnt) if cnt else CONFIG["default_video_count"]
        except ValueError:
            vc = CONFIG["default_video_count"]
        print()
        req = input(f"  {UI.bold('用户需求')}: ").strip()
        while not req:
            UI.warn("用户需求不能为空")
            req = input("  用户需求: ").strip()
        print(f"\n  {UI.bold('启用模板 (留空=全部)')}:")
        for i, t in enumerate(TEMPLATES):
            print(f"    [{i+1}] {t['name']} — {UI.dim(t['desc'])}")
        t_in = input("  选择（逗号分隔，如 1,3,5）: ").strip()
        tpls = []
        if t_in:
            for p in t_in.split(","):
                try:
                    idx = int(p.strip()) - 1
                    if 0 <= idx < len(TEMPLATES):
                        tpls.append(TEMPLATES[idx]["id"])
                except ValueError:
                    pass
        tid = ""

    data = {
        "user_name": account, "dam_video_library_id": video_lib,
        "dam_audio_library_id": audio_lib, "language": lang,
        "video_count": vc, "user_requirement": req,
        "enabled_templates": tpls if tpls else None,
    }
    if tid:
        data["taskid"] = tid

    print()
    UI.info("Account", account)
    UI.info("视频库", video_lib)
    UI.info("音频库", audio_lib)
    UI.info("语言", lang)
    UI.info("视频数", str(vc))
    print(f"  {UI.bold('需求')}: {req[:80]}{'...' if len(req) > 80 else ''}")
    if tpls:
        UI.info("模板", ", ".join(tpls))
    else:
        UI.info("模板", "全部")

    if not args.yes:
        c = input(f"\n  {UI.yellow('确认提交? [Y/n]')}: ").strip().lower()
        if c not in ("", "y", "yes"):
            print("  已取消")
            return

    print(f"  {UI.dim('正在提交...')}")
    try:
        r = api.submit_task(data)
        taskid = r.get("taskid", "")
        state = r.get("state", "")
        if state == "queued":
            UI.ok(f"任务提交成功！taskid: {taskid}")
            if r.get("queued_count", 0) > 0:
                UI.info("排队中", str(r["queued_count"]))
            if args.monitor:
                TaskMonitor(api, taskid).run()
        elif state == "duplicate":
            UI.warn(f"任务已存在: {taskid}")
            if args.monitor:
                TaskMonitor(api, taskid).run()
    except Exception as e:
        UI.err(f"提交失败: {e}")


def cmd_list(args):
    """查看任务列表"""
    api = AgentAPI()
    try:
        data = api.get_tasks()
        tasks = data.get("tasks", [])
    except Exception as e:
        UI.err(f"获取任务列表失败: {e}")
        return
    if not tasks:
        UI.header("📋 任务列表")
        print("  (暂无任务)")
        return
    UI.header(f"📋 任务列表 (共 {len(tasks)} 个)")
    sw = {"running": 4, "pending": 3, "completed": 2, "failed": 1}
    tasks.sort(key=lambda t: (-sw.get(t.get("status",""), 0), t.get("submit_time","") or ""))
    rows = []
    for t in tasks:
        tid = UI.truncate(t.get("taskid",""), 50)
        s = t.get("status","?")
        pct = t.get("percent",0) or 0
        bar = UI.pbar(pct, 20)
        done = t.get("completed_count",0) or 0
        tot = t.get("total_count",0) or 0
        st = t.get("submit_time","") or "--"
        rows.append([f"{UI.dot(s)} {s}", tid, f"{bar} {done}/{tot} {pct}%", st])
    UI.table(["状态", "任务ID", "进度", "提交时间"], rows)


def cmd_monitor(args):
    """实时监控任务进度"""
    api = AgentAPI()
    taskid = args.taskid
    if not taskid:
        try:
            data = api.get_tasks()
            tasks = data.get("tasks", [])
        except Exception as e:
            UI.err(f"获取任务列表失败: {e}")
            return
        if not tasks:
            UI.warn("没有任务")
            return
        active = [t for t in tasks if t.get("status") in ("pending","running")] or tasks
        print(f"  {UI.bold('选择要监控的任务')}:")
        for i, t in enumerate(active):
            print(f"    [{i+1}] {UI.dot(t.get('status','?'))} {UI.truncate(t.get('taskid',''),60)} ({t.get('status','?')})")
        sel = input("\n  选择: ").strip()
        try:
            taskid = active[int(sel)-1].get("taskid","")
        except (ValueError, IndexError):
            UI.err("无效选择")
            return
    TaskMonitor(api, taskid, interval=args.interval or 3).run()


def cmd_detail(args):
    """查看任务详情"""
    api = AgentAPI()
    taskid = args.taskid
    if not taskid:
        try:
            data = api.get_tasks()
            tasks = data.get("tasks", [])
        except Exception as e:
            UI.err(f"获取任务列表失败: {e}")
            return
        if not tasks:
            UI.warn("没有任务")
            return
        print(f"  {UI.bold('选择任务')}:")
        for i, t in enumerate(tasks[:10]):
            print(f"    [{i+1}] {UI.dot(t.get('status','?'))} {UI.truncate(t.get('taskid',''),60)} ({t.get('status','?')})")
        sel = input("\n  选择: ").strip()
        try:
            taskid = tasks[int(sel)-1].get("taskid","")
        except (ValueError, IndexError):
            UI.err("无效选择")
            return
    try:
        data = api.get_progress(taskid, last_lines=args.lines or 50)
    except Exception as e:
        UI.err(f"获取详情失败: {e}")
        return
    s = data.get("status", "unknown")
    UI.header(f"📋 任务详情: {taskid}")
    UI.info("状态", f"{UI.dot(s)} {s}")
    pct = data.get("percent",0) or 0
    done = data.get("completed_count",0) or 0
    total = data.get("total_count",0) or 0
    UI.info("进度", f"{UI.pbar(pct)} {done}/{total} {pct}%")
    try:
        for t in api.get_tasks().get("tasks", []):
            if t.get("taskid") == taskid:
                UI.info("提交时间", t.get("submit_time","--"))
                UI.info("开始时间", t.get("start_time","--"))
                UI.info("结束时间", t.get("finish_time","--"))
                break
    except Exception:
        pass
    url = data.get("result_zip_url","")
    if url:
        print()
        UI.ok("📦 结果下载:")
        print(f"     {url}")
    vids = data.get("completed_videos", [])
    if vids:
        print(f"\n  {UI.bold('🎬 已完成视频')}:")
        for v in vids:
            print(f"    {UI.green('✓')} {v.get('title','?')} [{v.get('template_id','—')}]")
            if v.get("mp4_url"):
                print(f"      {UI.dim(v['mp4_url'])}")
    logs = data.get("log_lines", [])
    if logs:
        print(f"\n  {UI.bold('📝 日志')} ({len(logs)} 行):")
        for line in logs:
            print(f"    {line}")
    sm = data.get("summary", "")
    if sm:
        print(f"\n  {UI.bold('📋 执行总结')}:")
        for line in sm.split("\n"):
            if line.strip():
                print(f"    {line}")
    err = data.get("error", "")
    if err:
        print(f"\n  {UI.err(UI.bold('错误信息'))}:")
        print(f"    {err}")


def cmd_download(args):
    """下载任务结果 ZIP"""
    api = AgentAPI()
    taskid = args.taskid
    if not taskid:
        try:
            data = api.get_tasks()
            tasks = data.get("tasks", [])
        except Exception as e:
            UI.err(f"获取任务列表失败: {e}")
            return
        completed = [t for t in tasks if t.get("status") == "completed" and t.get("taskid","")]
        if not completed:
            UI.warn("没有已完成的任务")
            return
        print(f"  {UI.bold('选择要下载的任务')}:")
        for i, t in enumerate(completed[:10]):
            print(f"    [{i+1}] {UI.truncate(t.get('taskid',''),60)}")
        sel = input("\n  选择: ").strip()
        try:
            taskid = completed[int(sel)-1].get("taskid","")
        except (ValueError, IndexError):
            UI.err("无效选择")
            return
    try:
        data = api.get_progress(taskid, last_lines=0)
    except Exception as e:
        UI.err(f"获取进度失败: {e}")
        return
    url = data.get("result_zip_url","")
    if not url:
        UI.warn("该任务没有可下载的结果")
        return
    out = args.output or f"{taskid}.zip"
    print(f"  {UI.dim(f'正在下载: {url}')}")
    print(f"  {UI.dim(f'保存到: {out}')}")
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            dl = 0
            with open(out, "wb") as f:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)
                    dl += len(chunk)
                    if total:
                        pct = int(dl * 100 / total)
                        bar = UI.pbar(pct, 20)
                        print(f"\r  {UI.bold('下载')}: {bar} {pct}% ({dl/1024/1024:.1f}MB)", end="", flush=True)
        print()
        UI.ok(f"下载完成: {out} ({dl/1024/1024:.1f}MB)")
    except Exception as e:
        UI.err(f"下载失败: {e}")


def cmd_delete(args):
    """删除任务"""
    api = AgentAPI()
    taskid = args.taskid
    if not taskid:
        try:
            data = api.get_tasks()
            tasks = data.get("tasks", [])
        except Exception as e:
            UI.err(f"获取任务列表失败: {e}")
            return
        if not tasks:
            UI.warn("没有任务")
            return
        print(f"  {UI.bold('选择要删除的任务')}:")
        for i, t in enumerate(tasks[:10]):
            print(f"    [{i+1}] {UI.dot(t.get('status','?'))} {UI.truncate(t.get('taskid',''),60)} ({t.get('status','?')})")
        sel = input("\n  选择: ").strip()
        try:
            taskid = tasks[int(sel)-1].get("taskid","")
        except (ValueError, IndexError):
            UI.err("无效选择")
            return
    if not args.yes:
        c = input(f"  {UI.yellow(f'确定删除任务 {taskid}? [y/N]')}: ").strip().lower()
        if c not in ("y", "yes"):
            print("  已取消")
            return
    try:
        r = api.delete_task(taskid)
        if r.get("success"):
            UI.ok(f"任务已删除: {taskid}")
        else:
            UI.err(f"删除失败: {r.get('error','?')}")
    except Exception as e:
        UI.err(f"删除失败: {e}")


def cmd_clear(args):
    """清理任务文件"""
    api = AgentAPI()
    taskid = args.taskid
    if not taskid:
        try:
            data = api.get_tasks()
            tasks = [t for t in data.get("tasks", []) if t.get("status") in ("completed","failed")]
        except Exception as e:
            UI.err(f"获取任务列表失败: {e}")
            return
        if not tasks:
            UI.warn("没有可清理的任务")
            return
        print(f"  {UI.bold('选择要清理的任务')}:")
        for i, t in enumerate(tasks[:10]):
            print(f"    [{i+1}] {UI.dot(t.get('status','?'))} {UI.truncate(t.get('taskid',''),60)}")
        sel = input("\n  选择: ").strip()
        try:
            taskid = tasks[int(sel)-1].get("taskid","")
        except (ValueError, IndexError):
            UI.err("无效选择")
            return
    if not args.yes:
        c = input(f"  {UI.yellow(f'确定清理任务 {taskid} 的文件? [y/N]')}: ").strip().lower()
        if c not in ("y", "yes"):
            print("  已取消")
            return
    try:
        data = api.get_progress(taskid, last_lines=0, clear_files=True)
        if data.get("files_cleared"):
            UI.ok(f"文件已清理: {taskid}")
        else:
            UI.warn("清理失败或任务未结束")
    except Exception as e:
        UI.err(f"清理失败: {e}")


def cmd_progress_zip(args):
    """下载进度快照 ZIP"""
    api = AgentAPI()
    taskid = args.taskid
    if not taskid:
        try:
            data = api.get_tasks()
            tasks = data.get("tasks", [])
        except Exception as e:
            UI.err(f"获取任务列表失败: {e}")
            return
        if not tasks:
            UI.warn("没有任务")
            return
        print(f"  {UI.bold('选择任务')}:")
        for i, t in enumerate(tasks[:10]):
            print(f"    [{i+1}] {UI.dot(t.get('status','?'))} {UI.truncate(t.get('taskid',''),60)}")
        sel = input("\n  选择: ").strip()
        try:
            taskid = tasks[int(sel)-1].get("taskid","")
        except (ValueError, IndexError):
            UI.err("无效选择")
            return
    try:
        data = api.get_progress(taskid, last_lines=0, return_zip=True)
    except Exception as e:
        UI.err(f"获取进度快照失败: {e}")
        return
    url = data.get("progress_zip_url", "")
    if url:
        UI.ok("进度快照已就绪:")
        print(f"     {url}")
    else:
        UI.warn("进度快照打包失败")


def cmd_stats(args):
    """服务器性能监控"""
    api = AgentAPI()
    try:
        s = api.get_system_stats()
        if s is None:
            UI.warn("服务器统计不可用")
            return
    except Exception as e:
        UI.err(f"获取服务器统计失败: {e}")
        return
    UI.header("🖥️  服务器状态")
    UI.info("CPU 使用率", f"{s.get('cpu_percent', 'N/A')}%")
    UI.info("内存使用率", f"{s.get('memory_percent', 'N/A')}%")
    UI.info("磁盘使用率", f"{s.get('disk_percent', 'N/A')}%")
    uptime = s.get("uptime", "")
    if uptime:
        UI.info("运行时间", uptime)


# ═════════════════════════════════════════════════════════════
# 主入口：argparse 命令行解析
# ═════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        prog="agent-cli",
        description="Agent 任务管理系统 CLI — 完全替代 Web 前端",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            使用示例:
              # 交互式提交任务
              python3 agent-cli.py submit

              # 命令行提交任务（自动监控）
              python3 agent-cli.py submit -r "制作一个关于AI的短视频" -m

              # 查看所有任务
              python3 agent-cli.py list

              # 实时监控任务进度
              python3 agent-cli.py monitor -t <taskid>

              # 查看任务详情
              python3 agent-cli.py detail -t <taskid>

              # 下载任务结果
              python3 agent-cli.py download -t <taskid> -o result.zip

              # 删除任务
              python3 agent-cli.py delete -t <taskid>

              # 清理任务文件
              python3 agent-cli.py clear -t <taskid>

              # 服务器状态监控
              python3 agent-cli.py stats

              配置文件: config.yaml（与当前脚本同目录）
        """),
    )

    # 全局参数
    parser.add_argument("--config", "-c", help="配置文件路径（默认: ./config.yaml）")

    sub = parser.add_subparsers(dest="command", required=True, help="可用命令")

    # submit
    p_submit = sub.add_parser("submit", help="提交新任务")
    p_submit.add_argument("--requirement", "-r", help="用户需求描述（指定后无需交互）")
    p_submit.add_argument("--account", "-a", help="账号")
    p_submit.add_argument("--video-count", "-n", type=int, help="目标视频数量")
    p_submit.add_argument("--language", "-l", help="语言")
    p_submit.add_argument("--video-lib", help="视频素材库 ID")
    p_submit.add_argument("--audio-lib", help="音频素材库 ID")
    p_submit.add_argument("--templates", "-t", nargs="*", help="启用的模板ID列表")
    p_submit.add_argument("--taskid", help="自定义任务ID（可选）")
    p_submit.add_argument("--monitor", "-m", action="store_true", help="提交后自动监控进度")
    p_submit.add_argument("--yes", "-y", action="store_true", help="跳过确认")

    # list
    sub.add_parser("list", help="查看任务列表")

    # monitor
    p_monitor = sub.add_parser("monitor", help="实时监控任务进度")
    p_monitor.add_argument("--taskid", "-t", help="任务ID（留空则交互选择）")
    p_monitor.add_argument("--interval", "-i", type=int, default=3, help="轮询间隔秒数（默认: 3）")

    # detail
    p_detail = sub.add_parser("detail", help="查看任务详情")
    p_detail.add_argument("--taskid", "-t", help="任务ID（留空则交互选择）")
    p_detail.add_argument("--lines", "-l", type=int, default=50, help="日志行数（默认: 50）")

    # download
    p_download = sub.add_parser("download", help="下载任务结果 ZIP")
    p_download.add_argument("--taskid", "-t", help="任务ID（留空则交互选择）")
    p_download.add_argument("--output", "-o", help="保存路径（默认: <taskid>.zip）")

    # delete
    p_delete = sub.add_parser("delete", help="删除任务")
    p_delete.add_argument("--taskid", "-t", help="任务ID（留空则交互选择）")
    p_delete.add_argument("--yes", "-y", action="store_true", help="跳过确认")

    # clear
    p_clear = sub.add_parser("clear", help="清理任务文件")
    p_clear.add_argument("--taskid", "-t", help="任务ID（留空则交互选择）")
    p_clear.add_argument("--yes", "-y", action="store_true", help="跳过确认")

    # progress-zip
    p_pzip = sub.add_parser("progress-zip", help="下载进度快照")
    p_pzip.add_argument("--taskid", "-t", help="任务ID（留空则交互选择）")

    # stats
    sub.add_parser("stats", help="服务器性能监控")

    args = parser.parse_args()

    # 如果指定了配置文件，重新加载
    if args.config:
        global CONFIG
        CONFIG_PATH = args.config
        CONFIG = load_config()

    # 路由到命令函数
    {
        "submit": cmd_submit,
        "list": cmd_list,
        "monitor": cmd_monitor,
        "detail": cmd_detail,
        "download": cmd_download,
        "delete": cmd_delete,
        "clear": cmd_clear,
        "progress-zip": cmd_progress_zip,
        "stats": cmd_stats,
    }[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  已取消")
        sys.exit(0)
    except Exception as e:
        UI.err(f"程序异常: {e}")
        sys.exit(1)
