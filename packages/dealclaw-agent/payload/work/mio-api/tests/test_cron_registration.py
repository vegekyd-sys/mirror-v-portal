"""cron 注册链路测试（dc_cron_lib.sh / dc_cron_query.py / inject_*_cron.sh）。

为什么有这组测试：2026-09-16 晚 27 封定时开发信没发出去，根因是
inject_pending_send_cron.sh 往**系统 crontab** 写任务，而镜像里没有 crontab 命令，
注入静默失败、没人发现。这里把当时缺的每一道闸门都焊死：

  · 任何 inject_*_cron.sh 都不许再写系统 crontab
  · 注册必须带 --declaration-key（幂等）和 --no-deliver
  · 注册后必须回读复查；Gateway 里查不到就非零退出（当年正是这里静默了）
  · 读不到现状（gateway 不通 / 输出不是 JSON）必须报故障，不许降级成「未注册」
  · remove 走 disable 不走 rm（删掉的声明式 job 下次启动会被重建）
  · doctor 能发现「必需 job 没挂上」

跑法：
  cd <mio-api> && python3 -m unittest discover -s . -t . -p "test_cron_registration.py"
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_MIO = Path(__file__).resolve().parents[1]
if str(_MIO) not in sys.path:
    sys.path.insert(0, str(_MIO))

import dc_cron_query as q  # noqa: E402

INJECT_SCRIPTS = sorted(_MIO.glob("inject_*_cron.sh"))

FAKE_OPENCLAW = """#!/bin/bash
echo "openclaw $*" >> "${FAKE_CALLS:-/dev/null}"
case "$1 $2" in
  "cron list")
    [[ "${FAKE_LIST_FAIL:-0}" == "1" ]] && { echo "ECONNREFUSED" >&2; exit 1; }
    [[ "${FAKE_LIST_GARBAGE:-0}" == "1" ]] && { echo "not json"; exit 0; }
    cat "${FAKE_JOBS_FILE:?}" ;;
  "cron add")
    [[ "${FAKE_ADD_FAIL:-0}" == "1" ]] && { echo "boom" >&2; exit 1; }
    echo ok ;;
  *) echo ok ;;
esac
"""


def _job(decl_key: str, *, enabled: bool = True, command: str = "python3 dc_pending_send.py run",
         last: int | None = 1_758_074_403_000, nxt: int | None = 1_758_076_200_000) -> dict:
    return {
        "id": "cron_" + decl_key[-6:],
        "declarationKey": decl_key,
        "displayName": decl_key,
        "enabled": enabled,
        "lastRunAtMs": last,
        "lastStatus": "ok",
        "nextRunAtMs": nxt,
        "schedule": {"kind": "cron", "expr": "*/30 * * * *", "tz": "Asia/Shanghai"},
        "payload": {"kind": "command", "argv": ["sh", "-lc", command],
                    "cwd": "/data/workspace/work/mio-api"},
    }


class SourceGuard(unittest.TestCase):
    """静态检查：payload 里不许再出现写系统 crontab 的代码路径。"""

    def test_有_inject_脚本(self):
        self.assertGreaterEqual(len(INJECT_SCRIPTS), 6, "inject_*_cron.sh 不该消失")

    def test_不再写系统_crontab(self):
        # 镜像里没有 cron 守护进程，`crontab -` 写进去也不会跑 —— 这是事故根因
        for path in INJECT_SCRIPTS:
            body = path.read_text(encoding="utf-8")
            code = "\n".join(l for l in body.splitlines() if not l.lstrip().startswith("#"))
            self.assertNotIn("crontab -", code, f"{path.name} 仍在写系统 crontab")

    def test_都走公共库(self):
        for path in INJECT_SCRIPTS:
            body = path.read_text(encoding="utf-8")
            self.assertIn("dc_cron_lib.sh", body, f"{path.name} 没走 dc_cron_lib.sh")
            self.assertIn("dc_cron::main", body, f"{path.name} 没调 dc_cron::main")
            self.assertIn("DC_CRON_DECL_KEY", body, f"{path.name} 没声明 declaration-key")

    def test_declaration_key_不重复(self):
        keys = []
        for path in INJECT_SCRIPTS:
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.startswith("DC_CRON_DECL_KEY="):
                    keys.append(line.split("=", 1)[1].strip().strip('"'))
        self.assertEqual(len(keys), len(set(keys)), f"declaration-key 撞车: {keys}")


class QueryUnit(unittest.TestCase):
    """dc_cron_query.py 的解析逻辑。"""

    def test_解包三种包装(self):
        jobs = [_job("dealclaw-pending-send")]
        for payload in ({"jobs": jobs}, {"result": {"jobs": jobs}}, jobs):
            self.assertEqual(len(q.unwrap(payload)), 1)

    def test_解包失败要报错(self):
        with self.assertRaises(ValueError):
            q.unwrap({"nothing": "here"})

    def test_缺_enabled_字段按启用处理(self):
        job = _job("k")
        del job["enabled"]
        self.assertTrue(q.is_enabled(job))
        self.assertFalse(q.is_enabled(_job("k", enabled=False)))

    def test_从未运行的提示不被当成正常(self):
        text = q.summary(_job("k", last=None))
        self.assertIn("从未运行", text)


class ScriptIntegration(unittest.TestCase):
    """拿假 openclaw 跑真脚本（参考 runtime/README.md 第九节的做法）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        bindir = root / "bin"
        bindir.mkdir()
        fake = bindir / "openclaw"
        fake.write_text(FAKE_OPENCLAW, encoding="utf-8")
        fake.chmod(0o755)
        self.calls = root / "calls.log"
        self.jobs_file = root / "jobs.json"
        self.env = {
            **os.environ,
            "PATH": f"{bindir}:{os.environ['PATH']}",
            # 指到不存在的 runtime 目录，强制脚本走「本地自注册」分支
            "DEALCLAW_RUNTIME_DIR": str(root / "no-runtime"),
            "DEALCLAW_MIO_DIR": str(_MIO),
            "MIO_CDP_SUPPLIER_ID": "151897148668",
            "FAKE_CALLS": str(self.calls),
            "FAKE_JOBS_FILE": str(self.jobs_file),
        }
        self.addCleanup(self.tmp.cleanup)

    def _set_jobs(self, jobs: list[dict]) -> None:
        self.jobs_file.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")

    def _run(self, script: str, *args: str, **envover: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(_MIO / script), *args],
            cwd=str(_MIO), env={**self.env, **envover},
            capture_output=True, text=True, timeout=120,
        )

    def test_inject_带上幂等与不投递开关(self):
        self._set_jobs([_job("dealclaw-pending-send")])
        res = self._run("inject_pending_send_cron.sh", "inject")
        self.assertEqual(res.returncode, 0, res.stderr)
        add = [l for l in self.calls.read_text().splitlines() if "cron add" in l]
        self.assertEqual(len(add), 1, "应当只发一次 cron add")
        self.assertIn("--declaration-key dealclaw-pending-send", add[0])
        self.assertIn("--no-deliver", add[0])
        self.assertIn("--command-cwd", add[0])

    def test_add_成功但_gateway_查不到要非零退出(self):
        # 事故当天的形态：注入脚本「跑完没报错」，实际一条都没挂上
        self._set_jobs([])
        res = self._run("inject_pending_send_cron.sh", "inject")
        self.assertNotEqual(res.returncode, 0, "查不到 job 却退出 0，等于重演事故")
        self.assertIn("任务没挂上", res.stderr)

    def test_gateway_不通不能说成未注册(self):
        self._set_jobs([_job("dealclaw-pending-send")])
        res = self._run("inject_pending_send_cron.sh", "status", FAKE_LIST_FAIL="1")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("cron list 失败", res.stderr)
        self.assertNotIn("未注册", res.stderr)

    def test_列表不是_json_要报故障(self):
        self._set_jobs([])
        res = self._run("inject_pending_send_cron.sh", "status", FAKE_LIST_GARBAGE="1")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("不是合法 JSON", res.stderr)

    def test_形状不对的列表也算读失败(self):
        # 合法 JSON 但没有 jobs 数组（比如 gateway 回了 {"error": ...}）
        self.jobs_file.write_text('{"error":"forbidden"}', encoding="utf-8")
        res = self._run("inject_pending_send_cron.sh", "status")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("看不懂", res.stderr)
        self.assertNotIn("未注册", res.stderr)

    def test_cron_add_失败要非零退出(self):
        self._set_jobs([])
        res = self._run("inject_pending_send_cron.sh", "inject", FAKE_ADD_FAIL="1")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("cron add 失败", res.stderr)

    def test_status_区分未注册与已停用(self):
        self._set_jobs([])
        self.assertEqual(self._run("inject_pending_send_cron.sh", "status").returncode, 1)
        self._set_jobs([_job("dealclaw-pending-send", enabled=False)])
        self.assertEqual(self._run("inject_pending_send_cron.sh", "status").returncode, 2)
        self._set_jobs([_job("dealclaw-pending-send")])
        self.assertEqual(self._run("inject_pending_send_cron.sh", "status").returncode, 0)

    def test_remove_走_disable_不走_rm(self):
        # 删掉的声明式 job 下次容器启动会被重建，disable 才扛得住升级
        self._set_jobs([_job("dealclaw-pending-send")])
        res = self._run("inject_pending_send_cron.sh", "remove")
        self.assertEqual(res.returncode, 0, res.stderr)
        calls = self.calls.read_text()
        self.assertIn("cron disable", calls)
        self.assertNotIn("cron rm", calls)

    def test_抓出没有_declaration_key_的重复调度器(self):
        manual = _job("dealclaw-pending-send")
        manual["id"] = "cron_manual"
        del manual["declarationKey"]
        self._set_jobs([_job("dealclaw-pending-send"), manual])
        res = self._run("inject_pending_send_cron.sh", "status")
        self.assertIn("cron_manual", res.stderr)
        self.assertIn("重复调度器", res.stderr)

    def test_取不到租户号就拒绝注册(self):
        self._set_jobs([])
        env = {k: v for k, v in self.env.items() if k != "MIO_CDP_SUPPLIER_ID"}
        res = subprocess.run(
            ["bash", str(_MIO / "inject_marketing_automation_cron.sh"), "inject"],
            cwd=str(_MIO), env=env, capture_output=True, text=True, timeout=120,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("MIO_CDP_SUPPLIER_ID", res.stderr)
        self.assertNotIn("cron add", self.calls.read_text() if self.calls.exists() else "")

    def test_doctor_发现必需_job_没挂上(self):
        # 只缺 pending-send，正是事故当晚的状态
        required = ["dealclaw-morning", "dealclaw-evening", "dealclaw-resend-poll",
                    "dealclaw-email-reply-poll", "dealclaw-buyer-onsite-monitor",
                    "dealclaw-onsite-recommend", "dealclaw-reflection-heartbeat"]
        self._set_jobs([_job(k) for k in required])
        res = self._run("dc_cron_doctor.sh")
        self.assertEqual(res.returncode, 1, res.stdout)
        self.assertIn("dealclaw-pending-send", res.stdout)
        self.assertIn("未注册", res.stdout)

        self._set_jobs([_job(k) for k in required + ["dealclaw-pending-send"]])
        ok = self._run("dc_cron_doctor.sh")
        self.assertEqual(ok.returncode, 0, ok.stdout)


if __name__ == "__main__":
    unittest.main()
