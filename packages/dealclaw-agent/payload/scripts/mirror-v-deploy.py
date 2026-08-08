#!/usr/bin/env python3
"""Deploy a Mirror V instance from a VSync golden snapshot.

Default mode is dry-run. Use --execute to modify a target host.
This script intentionally does not store secrets in profile/payload. When
--inject-runtime-keys is passed, it reads selected runtime keys from the current
shell or a local env file and writes them only to the target host's
/home/openclaw/.openclaw/.env plus systemd EnvironmentFile wiring.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "work" / "mirror-v"
DEFAULT_PROFILE = WORK / "mirror-v-001.profile.json"
DEFAULT_PAYLOAD_DIR = WORK / "dry-run-output" / "payload"
DEFAULT_PAYLOAD_ARCHIVE = WORK / "dry-run-output" / "mirror-v-001-payload.tar.zst"
DEFAULT_BASELINE_PROFILE = ROOT / "config" / "mirror-v" / "profiles" / "v001-full.json"
DEFAULT_KEY = WORK / "keys" / "mirror_v_deploy_ed25519"
NODE_PATH = "/opt/node-v22.23.1/bin:/home/openclaw/.local/share/pnpm:/home/openclaw/.local/bin:/usr/local/bin:/usr/bin:/bin"
DEFAULT_RUNTIME_KEYS = [
    "MAKARON_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "APIFY_API_KEY",
    "APIFY_TOKEN",
    "BROWSER_USE_API_KEY",
    "BROWSERUSE_API_KEY",
    "XAI_API_KEY",
    "FIRECRAWL_API_KEY",
    "EXA_API_KEY",
    "TAVILY_API_KEY",
    "BRAVE_API_KEY",
    "PERPLEXITY_API_KEY",
]


def run(cmd: list[str], *, cwd: Path | None = None, input_text: str | None = None, check: bool = True, quiet: bool = False) -> subprocess.CompletedProcess[str]:
    if not quiet:
        print("+", " ".join(shlex.quote(x) for x in cmd), file=sys.stderr)
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, input=input_text, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode != 0:
        raise SystemExit(f"Command failed ({p.returncode}): {' '.join(cmd)}\nSTDOUT:\n{p.stdout}\nSTDERR:\n{p.stderr}")
    return p


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ssh_base(key: Path, host: str) -> list[str]:
    return ["ssh", "-i", str(key), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", f"root@{host}"]


def scp_base(key: Path) -> list[str]:
    return ["scp", "-q", "-i", str(key), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"]


def remote(host: str, key: Path, script: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(ssh_base(key, host) + ["bash", "-s"], input_text=script, check=check)


def ensure_key(path: Path, comment: str, execute: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.chmod(0o600)
        return
    if not execute:
        print(f"DRY-RUN would create ssh deploy key: {path}")
        return
    run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", comment, "-f", str(path)], quiet=True)
    path.chmod(0o600)


def tat_add_ssh_key(region: str, instance_id: str, pubkey: str, marker: str, execute: bool) -> None:
    if not execute:
        print(f"DRY-RUN would add temporary SSH public key to {region}/{instance_id} via TAT marker={marker}")
        return
    tccli = shutil.which("tccli") or str(Path.home() / ".local/share/venvs/tccli/bin/tccli")
    script = f"""set -eu
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
sed -i.bak '/{marker}/d' /root/.ssh/authorized_keys
cat >> /root/.ssh/authorized_keys <<'KEY'
{pubkey}
KEY
echo ssh_key_added_marker={marker}
"""
    content = base64.b64encode(script.encode()).decode()
    p = run([tccli, "tat", "RunCommand", "--region", region, "--InstanceIds", json.dumps([instance_id]), "--Content", content, "--CommandType", "SHELL", "--Username", "root", "--Timeout", "30"], quiet=True)
    inv = json.loads(p.stdout)["InvocationId"]
    for _ in range(20):
        time.sleep(2)
        filt = json.dumps([{"Name": "invocation-id", "Values": [inv]}])
        q = run([tccli, "tat", "DescribeInvocationTasks", "--region", region, "--Filters", filt], quiet=True)
        task = (json.loads(q.stdout).get("InvocationTaskSet") or [{}])[0]
        status = task.get("TaskStatus")
        if status in {"SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"}:
            out = task.get("TaskResult", {}).get("Output", "")
            try:
                out = base64.b64decode(out).decode("utf-8", "replace")
            except Exception:
                pass
            print(out.strip())
            if status != "SUCCESS":
                raise SystemExit(f"TAT add ssh key failed: {status}")
            return
    raise SystemExit("TAT add ssh key timed out")


def build_payload(payload_dir: Path, archive: Path, execute: bool) -> None:
    if archive.exists():
        print(f"payload archive exists: {archive} ({archive.stat().st_size} bytes)")
        return
    if not payload_dir.exists():
        raise SystemExit(f"payload dir missing: {payload_dir}; run mirror_dry_run.py --materialize first")
    if not execute:
        print(f"DRY-RUN would create payload archive from {payload_dir} -> {archive}")
        return
    archive.parent.mkdir(parents=True, exist_ok=True)
    run(["tar", "--zstd", "-cf", str(archive), "."], cwd=payload_dir)


def build_selected_payload(instance_id: str, name: str, profile: Path, memory_bundle: str, skill_bundle: str, execute: bool) -> Path:
    archive = ROOT / "work" / "mirror-v" / "generated" / instance_id / f"{instance_id}-payload.tar.zst"
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "mirror-v-build-payload.py"),
        "--instance-id",
        instance_id,
        "--memory-bundle",
        memory_bundle,
        "--skill-bundle",
        skill_bundle,
        "--profile",
        str(profile),
        "--display-name",
        name,
    ]
    if not execute:
        cmd.append("--dry-run")
    run(cmd)
    return archive


def parse_env_file(env_file: Path | None) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_file or not env_file.exists():
        return values
    for raw in env_file.read_text(errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and val:
            values[key] = val
    return values


def read_runtime_keys(env_file: Path | None, wanted: list[str]) -> dict[str, str]:
    file_values = parse_env_file(env_file)
    result: dict[str, str] = {}
    for key in wanted:
        val = os.environ.get(key) or file_values.get(key)
        if val:
            result[key] = val
    if "APIFY_API_KEY" in result and "APIFY_TOKEN" not in result:
        result["APIFY_TOKEN"] = result["APIFY_API_KEY"]
    if "APIFY_TOKEN" in result and "APIFY_API_KEY" not in result:
        result["APIFY_API_KEY"] = result["APIFY_TOKEN"]
    if "BROWSER_USE_API_KEY" in result and "BROWSERUSE_API_KEY" not in result:
        result["BROWSERUSE_API_KEY"] = result["BROWSER_USE_API_KEY"]
    if "BROWSERUSE_API_KEY" in result and "BROWSER_USE_API_KEY" not in result:
        result["BROWSER_USE_API_KEY"] = result["BROWSERUSE_API_KEY"]
    return result


def backup_target(host: str, key: Path, execute: bool) -> None:
    script = """set -euo pipefail
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/mirror-v-backups
if [ -d /home/openclaw/.openclaw ]; then tar --exclude=/home/openclaw/.openclaw/browser-existing-session --exclude=/home/openclaw/.openclaw/logs -czf /root/mirror-v-backups/openclaw-dotdir-before-mirror-$TS.tar.gz -C /home/openclaw .openclaw; fi
if [ -d /home/openclaw/makaron-openclaw ]; then tar -czf /root/mirror-v-backups/makaron-openclaw-before-mirror-$TS.tar.gz -C /home/openclaw makaron-openclaw; fi
echo backup_ts=$TS
ls -lh /root/mirror-v-backups | tail -10
"""
    if not execute:
        print(f"DRY-RUN would backup target host {host}")
        return
    print(remote(host, key, script).stdout)


def upload_and_apply_payload(host: str, key: Path, archive: Path, profile: Path, instance_id: str, workspace: str, execute: bool) -> None:
    digest = sha256(archive) if archive.exists() else ""
    if not execute:
        print(f"DRY-RUN would upload {archive} sha256={digest} and extract to {workspace}")
        return
    remote_dir = f"/root/mirror-v-candidates/{instance_id}"
    remote(host, key, f"set -euo pipefail\nmkdir -p {shlex.quote(remote_dir)}\n")
    sumfile = archive.with_suffix(archive.suffix + ".sha256")
    sumfile.write_text(f"{digest}  {archive.name}\n")
    run(scp_base(key) + [str(archive), str(sumfile), str(profile), f"root@{host}:{remote_dir}/"])
    script = f"""set -euo pipefail
cd {shlex.quote(remote_dir)}
EXPECTED=$(cut -d ' ' -f1 {shlex.quote(sumfile.name)})
ACTUAL=$(sha256sum {shlex.quote(archive.name)} | cut -d ' ' -f1)
test "$EXPECTED" = "$ACTUAL"
rm -rf {shlex.quote(workspace)}
mkdir -p {shlex.quote(workspace)}
tar --zstd -xf {shlex.quote(archive.name)} -C {shlex.quote(workspace)}
chown -R openclaw:openclaw /home/openclaw/makaron-openclaw
printf 'payload_applied workspace=%s files=%s\n' {shlex.quote(workspace)} "$(find {shlex.quote(workspace)} -type f | wc -l)"
"""
    print(remote(host, key, script).stdout)


def patch_config(host: str, key: Path, instance_id: str, name: str, workspace: str, execute: bool) -> None:
    patch = f"""set -euo pipefail
python3 - <<'PY'
import json, pathlib, shutil, time
p=pathlib.Path('/home/openclaw/.openclaw/openclaw.json')
c=json.loads(p.read_text())
ts=time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(p, p.with_name(f'openclaw.json.bak-{instance_id}-{{ts}}'))
ag=c.setdefault('agents',{{}})
defs=ag.setdefault('defaults',{{}})
defs['workspace']={workspace!r}
defs['memorySearch']={{'provider':'none','fallback':'none'}}
lst=[x for x in ag.setdefault('list',[]) if x.get('id')!={instance_id!r}]
lst.append({{
  'id':{instance_id!r},
  'name':{name!r},
  'workspace':{workspace!r},
  'agentDir':f'/home/openclaw/.openclaw/agents/{instance_id}/agent',
  'identity':{{'name':{name!r},'emoji':'V'}},
  'model':defs.get('model',{{}}).get('primary','deepseek/deepseek-v4-pro'),
  'memorySearch':{{'provider':'none','fallback':'none'}}
}})
ag['list']=lst
p.write_text(json.dumps(c,ensure_ascii=False,indent=2)+'\n')
print('config_patched agents='+','.join(x.get('id','?') for x in lst))
PY
"""
    if not execute:
        print(f"DRY-RUN would patch /home/openclaw/.openclaw/openclaw.json for {instance_id}")
        return
    print(remote(host, key, patch).stdout)


def inject_runtime_keys(host: str, key: Path, runtime_keys: dict[str, str], execute: bool) -> None:
    if not runtime_keys:
        print("No runtime keys found to inject")
        return
    if not execute:
        print("DRY-RUN would inject runtime keys into target /home/openclaw/.openclaw/.env: " + ",".join(sorted(runtime_keys)))
        return
    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        for runtime_key, runtime_value in runtime_keys.items():
            f.write(runtime_key + "=" + runtime_value + "\n")
        temp = Path(f.name)
    temp.chmod(0o600)
    try:
        run(scp_base(key) + [str(temp), f"root@{host}:/tmp/mirror_runtime_env"])
    finally:
        temp.unlink(missing_ok=True)
    script = """set -euo pipefail
install -d -m 700 /home/openclaw/.openclaw
touch /home/openclaw/.openclaw/.env
chmod 600 /home/openclaw/.openclaw/.env
python3 - <<'PY'
from pathlib import Path
p=Path('/home/openclaw/.openclaw/.env')
snippet=Path('/tmp/mirror_runtime_env').read_text().splitlines()
keys={line.split('=',1)[0] for line in snippet if '=' in line}
existing=p.read_text().splitlines() if p.exists() else []
kept=[line for line in existing if not any(line.startswith(k+'=') or line.startswith('export '+k+'=') for k in keys)]
p.write_text('\n'.join(kept+snippet)+'\n')
p.chmod(0o600)
print('env_merged keys='+','.join(sorted(keys)))
PY
chown openclaw:openclaw /home/openclaw/.openclaw/.env
rm -f /tmp/mirror_runtime_env
mkdir -p /etc/systemd/system/openclaw-gateway.service.d
cat > /etc/systemd/system/openclaw-gateway.service.d/20-mirror-env.conf <<'EOF'
[Service]
EnvironmentFile=/home/openclaw/.openclaw/.env
EOF
chmod 0644 /etc/systemd/system/openclaw-gateway.service.d/20-mirror-env.conf
systemctl daemon-reload
"""
    print(remote(host, key, script).stdout)


def install_browser(host: str, key: Path, execute: bool) -> None:
    script = """set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
  echo browser_already_installed
else
  apt-get update
  apt-get install -y wget gnupg ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 xdg-utils
  install -d -m 0755 /etc/apt/keyrings
  wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg
  chmod a+r /etc/apt/keyrings/google-linux.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt-get update
  apt-get install -y google-chrome-stable
fi
google-chrome --version 2>/dev/null || chromium --version 2>/dev/null || chromium-browser --version 2>/dev/null
mkdir -p /home/openclaw/.openclaw/browser-tools
cd /home/openclaw/.openclaw/browser-tools
if [ ! -f package.json ]; then npm init -y >/dev/null; fi
npm install playwright-core >/dev/null
node - <<'JS'
const chromium = require("playwright-core").chromium;
(async()=>{
 const browser = await chromium.launch({executablePath:"/usr/bin/google-chrome", args:["--no-sandbox","--disable-gpu"], headless:true});
 const page = await browser.newPage();
 await page.goto("https://example.com");
 console.log(await page.title());
 await browser.close();
})().catch(e=>{console.error(e); process.exit(1);});
JS
"""
    if not execute:
        print("DRY-RUN would install Chrome/Chromium browser dependencies on target if missing")
        return
    print(remote(host, key, script).stdout)


def generate_report(
    *,
    instance_id: str,
    name: str,
    host: str,
    region: str | None,
    cloud_instance_id: str | None,
    workspace: str,
    baseline: str,
    memory_bundle: str,
    skill_bundle: str,
    inject_keys: bool,
    install_browser: bool,
    checklist_ran: bool,
    checklist_result: dict[str, Any] | None,
    errors: list[str],
    warnings: list[str],
    execute: bool,
) -> Path | None:
    """Generate a per-instance deployment report artifact."""
    ts = time.strftime("%Y%m%d-%H%M%S")
    out_dir = WORK / instance_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / f"{instance_id}-deploy-report-{ts}.md"

    lines: list[str] = []
    lines.append(f"# Mirror V Deployment Report — {instance_id}")
    lines.append("")
    lines.append(f"- **Instance**: {name} (`{instance_id}`)")
    lines.append(f"- **Deployed at**: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    lines.append(f"- **Target host**: {host}")
    if region:
        lines.append(f"- **Region**: {region}")
    if cloud_instance_id:
        lines.append(f"- **Cloud instance ID**: {cloud_instance_id}")
    lines.append(f"- **Workspace**: {workspace}")
    lines.append(f"- **Execute mode**: {'live' if execute else 'dry-run'}")
    lines.append("")

    lines.append("## Profile & Overlay")
    lines.append(f"- **Baseline**: {baseline}")
    lines.append(f"- **Memory bundle**: {memory_bundle}")
    lines.append(f"- **Skill bundle**: {skill_bundle}")
    lines.append(f"- **Runtime key injection**: {'yes' if inject_keys else 'no'}")
    lines.append(f"- **Install browser**: {'yes' if install_browser else 'no'}")
    lines.append("")

    lines.append("## Deployment Steps")
    steps = [
        "SSH key provisioned",
        "TAT key added (if cloud)",
        "Payload built & uploaded",
        "Config patched (openclaw.json)",
        f"Runtime keys injected ({'yes' if inject_keys else 'no'})",
        f"Browser installed ({'yes' if install_browser else 'no'})",
        "Gateway restarted & verified",
        f"Post-deploy checklist ({'ran' if checklist_ran else 'skipped'})",
    ]
    for s in steps:
        lines.append(f"- [x] {s}")
    lines.append("")

    if checklist_result:
        lines.append("## Checklist Results")
        results = checklist_result.get("results", [])
        ok_count = sum(1 for r in results if r.get("ok"))
        total = len(results)
        required_ok = all(r["ok"] for r in results if r.get("required"))
        lines.append(f"- **Pass count**: {ok_count}/{total}")
        lines.append(f"- **Required checks pass**: {'✅' if required_ok else '❌'}")
        lines.append("")
        for r in results:
            mark = "✅" if r.get("ok") else ("⚠️" if not r.get("required") else "❌")
            req = " (required)" if r.get("required") else ""
            detail = r.get("detail", "")
            lines.append(f"- {mark} **{r['name']}**{req}: {detail}")
        lines.append("")

    if warnings:
        lines.append("## Warnings")
        for w in warnings:
            lines.append(f"- ⚠️ {w}")
        lines.append("")

    if errors:
        lines.append("## Errors")
        for e in errors:
            lines.append(f"- ❌ {e}")
        lines.append("")

    if not errors and (not checklist_result or required_ok):
        lines.append("> ✅ All required steps and checks passed.")
        lines.append("")

    content = "\n".join(lines) + "\n"
    if execute:
        report_path.write_text(content)
        print(f"Deployment report saved: {report_path}")
        return report_path
    else:
        print(f"DRY-RUN would save deployment report to: {report_path}")
        return None


def restart_and_verify(host: str, key: Path, instance_id: str, execute: bool) -> None:
    script = f"""set -euo pipefail
export PATH={NODE_PATH}:$PATH
if ! systemctl --user list-unit-files | grep -q '^openclaw-gateway.service'; then
  openclaw gateway install --force --runtime node
fi
openclaw gateway restart || openclaw gateway start
sleep 4
openclaw memory index --force --agent {shlex.quote(instance_id)} >/tmp/mirror-memory-index.log 2>&1 || (cat /tmp/mirror-memory-index.log; exit 1)
openclaw status --all | grep -E 'Gateway|{instance_id}|Skills:|Channel issues' | sed -n '1,120p'
openclaw memory status --json --agent {shlex.quote(instance_id)} 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print([(x.get('agentId'), x['status'].get('provider'), x['status'].get('files'), x['status'].get('chunks'), x['status'].get('dirty')) for x in d])"
set -a; [ -f /home/openclaw/.openclaw/.env ] && . /home/openclaw/.openclaw/.env; set +a
for k in MAKARON_API_KEY APIFY_API_KEY APIFY_TOKEN BROWSER_USE_API_KEY XAI_API_KEY; do if [ -n "$(printenv "$k" || true)" ]; then echo "$k"_present=yes; else echo "$k"_present=no; fi; done
npx -y makaron-cli --version
if command -v lark-cli >/dev/null 2>&1; then lark-cli --version; lark-cli auth status --json 2>/dev/null | head -c 2000; else echo lark_cli_status=not_installed; fi
openclaw agent --agent {shlex.quote(instance_id)} --session-key agent:{shlex.quote(instance_id)}:mirror-smoke --message '用一句话回答：你是谁？' --timeout 120 --json | python3 -c "import sys,json; t=sys.stdin.read();\ntry:\n d=json.loads(t); print(d.get('turn',{{}}).get('finalAssistantVisibleText') or d.get('finalAssistantVisibleText') or t[:500])\nexcept Exception: print(t[:500])"
"""
    if not execute:
        print(f"DRY-RUN would restart gateway, index memory, and smoke-test {instance_id}")
        return
    print(remote(host, key, script).stdout)


def main() -> int:
    ap = argparse.ArgumentParser(description="Deploy Mirror V from a golden VSync payload")
    ap.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    ap.add_argument("--payload-dir", type=Path, default=DEFAULT_PAYLOAD_DIR)
    ap.add_argument("--payload-archive", type=Path, default=DEFAULT_PAYLOAD_ARCHIVE)
    ap.add_argument("--use-selected-payload", action="store_true", help="build physical payload from --memory-bundle/--skill-bundle selectors")
    ap.add_argument("--instance-id", default=None)
    ap.add_argument("--name", default=None)
    ap.add_argument("--host", default=None)
    ap.add_argument("--region", default=None)
    ap.add_argument("--instance", dest="cloud_instance_id", default=None)
    ap.add_argument("--workspace", default=None)
    ap.add_argument("--ssh-key", type=Path, default=DEFAULT_KEY)
    ap.add_argument("--inject-makaron-key", action="store_true", help="compat alias for --inject-runtime-keys")
    ap.add_argument("--inject-runtime-keys", action="store_true", help="inject selected runtime keys into target .env")
    ap.add_argument("--runtime-key", action="append", default=[], help="runtime key name to inject; repeatable; defaults to common Mirror V keys")
    ap.add_argument("--install-browser", action="store_true", help="install Chrome/Chromium on target if missing")
    ap.add_argument("--baseline", default="v001-full", help="baseline profile id; default v001-full")
    ap.add_argument("--memory-bundle", default=None, help="memory bundle selector recorded for deploy planning; default comes from baseline/profile")
    ap.add_argument("--skill-bundle", default=None, help="skill bundle selector recorded for deploy planning; default comes from baseline/profile")
    ap.add_argument("--no-inject-keys", action="store_true", help="disable runtime key injection even if profile default says yes")
    ap.add_argument("--checklist", action="store_true", help="run scripts/mirror-v-checklist.py after deploy verification")
    ap.add_argument("--local-env-file", type=Path, default=Path("/home/openclaw/.openclaw/.env"))
    ap.add_argument("--execute", action="store_true", help="actually modify target host")
    args = ap.parse_args()

    profile: dict[str, Any] = {}
    if args.profile.exists():
        profile = json.loads(args.profile.read_text())
    instance_id = args.instance_id or profile.get("instance", {}).get("id") or "mirror-v-001"
    name = args.name or profile.get("instance", {}).get("display_name") or instance_id
    target = profile.get("target", {})
    host = args.host or target.get("host")
    region = args.region or target.get("region")
    cloud_instance_id = args.cloud_instance_id or target.get("instance_id")
    workspace = args.workspace or target.get("workspace") or "/home/openclaw/makaron-openclaw/.openclaw-local/workspace"
    if not host:
        raise SystemExit("--host missing")

    marker = f"{instance_id}-deploy-{time.strftime('%Y%m%d')}"
    overlay = profile.get("overlay", {})
    memory_bundle = args.memory_bundle or overlay.get("memory_bundle") or "v001-full"
    skill_bundle = args.skill_bundle or overlay.get("skill_bundle") or "v001-full"
    should_inject_keys = (args.inject_makaron_key or args.inject_runtime_keys or bool(overlay.get("inject_keys"))) and not args.no_inject_keys
    should_install_browser = args.install_browser or bool(overlay.get("install_browser"))
    should_checklist = args.checklist or bool(overlay.get("post_deploy_checklist"))

    print(json.dumps({
        "execute": args.execute,
        "instance_id": instance_id,
        "host": host,
        "region": region,
        "cloud_instance_id": cloud_instance_id,
        "workspace": workspace,
        "baseline": args.baseline,
        "memory_bundle": memory_bundle,
        "skill_bundle": skill_bundle,
        "inject_keys": should_inject_keys,
        "install_browser": should_install_browser,
        "checklist": should_checklist,
    }, ensure_ascii=False, indent=2))

    errors: list[str] = []
    warnings: list[str] = []
    checklist_result: dict[str, Any] | None = None
    checklist_ran = False

    try:
        ensure_key(args.ssh_key, marker, args.execute)
    except SystemExit as e:
        errors.append(f"ensure_key: {e}")
        raise
    if args.execute and not args.ssh_key.with_suffix(args.ssh_key.suffix + ".pub").exists():
        raise SystemExit(f"public key missing for {args.ssh_key}")
    pub = args.ssh_key.with_suffix(args.ssh_key.suffix + ".pub").read_text().strip() if args.ssh_key.with_suffix(args.ssh_key.suffix + ".pub").exists() else "<pubkey>"
    if region and cloud_instance_id:
        try:
            tat_add_ssh_key(region, cloud_instance_id, pub, marker, args.execute)
        except SystemExit as e:
            errors.append(f"tat_add_ssh_key: {e}")
            raise

    payload_archive = args.payload_archive
    if args.use_selected_payload or memory_bundle != "v001-full" or skill_bundle != "v001-full":
        try:
            payload_archive = build_selected_payload(instance_id, name, args.profile, memory_bundle, skill_bundle, args.execute)
        except SystemExit as e:
            errors.append(f"build_selected_payload: {e}")
            raise
    else:
        build_payload(args.payload_dir, payload_archive, args.execute)
    if args.execute and not payload_archive.exists():
        raise SystemExit(f"payload archive missing: {payload_archive}")

    backup_target(host, args.ssh_key, args.execute)
    upload_and_apply_payload(host, args.ssh_key, payload_archive, args.profile, instance_id, workspace, args.execute)
    patch_config(host, args.ssh_key, instance_id, name, workspace, args.execute)
    if should_inject_keys:
        wanted = args.runtime_key or DEFAULT_RUNTIME_KEYS
        runtime_keys = read_runtime_keys(args.local_env_file, wanted)
        if not runtime_keys:
            warnings.append("No runtime keys found to inject — check local env")
        inject_runtime_keys(host, args.ssh_key, runtime_keys, args.execute)
    if should_install_browser:
        install_browser(host, args.ssh_key, args.execute)
    restart_and_verify(host, args.ssh_key, instance_id, args.execute)
    if should_checklist:
        checklist_script = ROOT / "scripts" / "mirror-v-checklist.py"
        if args.execute:
            checklist_ran = True
            try:
                cp = run(
                    [sys.executable, str(checklist_script), "--host", host, "--agent", instance_id, "--ssh-key", str(args.ssh_key), "--json"],
                    check=False,
                )
                raw = cp.stdout
                # extract JSON from output (may have leading text)
                try:
                    idx = raw.index("{")
                    checklist_result = json.loads(raw[idx:])
                except (ValueError, json.JSONDecodeError) as parse_err:
                    warnings.append(f"Checklist JSON parse failed: {parse_err}; raw output: {raw[:500]}")
                if cp.returncode == 2:
                    warnings.append("Checklist reported required check failures")
                elif cp.returncode != 0:
                    warnings.append(f"Checklist exited with code {cp.returncode}")
            except Exception as e:
                warnings.append(f"Checklist execution failed: {e}")
        else:
            print(f"DRY-RUN would run post-deploy checklist: {checklist_script} --host {host} --agent {instance_id}")

    generate_report(
        instance_id=instance_id,
        name=name,
        host=host,
        region=region,
        cloud_instance_id=cloud_instance_id,
        workspace=workspace,
        baseline=args.baseline,
        memory_bundle=memory_bundle,
        skill_bundle=skill_bundle,
        inject_keys=should_inject_keys,
        install_browser=should_install_browser,
        checklist_ran=checklist_ran,
        checklist_result=checklist_result,
        errors=errors,
        warnings=warnings,
        execute=args.execute,
    )

    if errors:
        print("\nDeploy completed with errors:", file=sys.stderr)
        for e in errors:
            print(f"  ❌ {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
