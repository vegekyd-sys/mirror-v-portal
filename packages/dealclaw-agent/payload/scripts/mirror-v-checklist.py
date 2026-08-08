#!/usr/bin/env python3
"""Post-deploy checklist for Mirror V.

Runs mostly non-sending checks. Feishu send is gated and only runs when
--feishu-send-target is explicitly provided.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path

DEFAULT_KEY = Path("work/mirror-v/keys/mirror_v_deploy_ed25519")
NODE_PATH = "/opt/node-v22.23.1/bin:/home/openclaw/.local/share/pnpm:/home/openclaw/.local/bin:/usr/local/bin:/usr/bin:/bin"


def run_remote(host: str, key: Path, script: str, timeout: int = 300) -> tuple[int, str, str]:
    cmd = ["ssh", "-i", str(key), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", f"root@{host}", "bash", "-s"]
    p = subprocess.run(cmd, input=script, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--agent", default="mirror-v-001")
    ap.add_argument("--ssh-key", type=Path, default=DEFAULT_KEY)
    ap.add_argument("--feishu-send-target", help="explicit safe Feishu target to send a test message to; omitted means no send")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    feishu_target = args.feishu_send_target or ""
    script = f'''set -euo pipefail
export PATH={NODE_PATH}:$PATH
cd /home/openclaw/makaron-openclaw/.openclaw-local/workspace
set -a; [ -f /home/openclaw/.openclaw/.env ] && . /home/openclaw/.openclaw/.env; set +a
AGENT={shlex.quote(args.agent)}
FEISHU_TARGET={shlex.quote(feishu_target)}
python3 - <<'PY'
import json, os, subprocess, shlex, sys, time
agent=os.environ.get('AGENT','mirror-v-001')
feishu_target=os.environ.get('FEISHU_TARGET','')
results=[]

def add(name, ok, detail='', required=True):
    results.append({{'name':name,'ok':bool(ok),'required':required,'detail':detail[:1000]}})

def cmd(command, timeout=120):
    p=subprocess.run(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    return p.returncode, p.stdout.decode('utf-8','replace').strip(), p.stderr.decode('utf-8','replace').strip()

rc,out,err=cmd('openclaw gateway status',60)
add('gateway_reachable', rc==0 and 'Connectivity probe: ok' in out, out or err)

rc,out,err=cmd('openclaw agents list',60)
add('agent_listed', rc==0 and agent in out, out or err)

rc,out,err=cmd(f'openclaw memory status --json --agent {{shlex.quote(agent)}}',120)
try:
    data=json.loads(out)
    s=data[0]['status'] if data else {{}}
    provider=s.get('provider')
    add('memory_index_ready', s.get('files',0)>0 and s.get('chunks',0)>0 and not s.get('dirty'), f"provider={{provider}} files={{s.get('files')}} chunks={{s.get('chunks')}} dirty={{s.get('dirty')}}")
    add('semantic_memory_enabled', provider not in (None, 'none'), f"provider={{provider}}; provider=none means FTS-only, not semantic memory")
except Exception as e:
    add('memory_index_ready', False, (out or err or str(e)))

rc,out,err=cmd('test -d scripts && find scripts -type f | wc -l',30)
try:
    script_count=int((out or '0').strip().splitlines()[-1])
except Exception:
    script_count=0
add('scripts_present', script_count >= 10, f"scripts_count={{script_count}}")

rc,out,err=cmd(f'openclaw memory search --agent {{shlex.quote(agent)}} --query "V from Versa" --max-results 2',120)
add('memory_search_returns_results', rc==0 and 'V from Versa' in out, out or err)

for k in ['MAKARON_API_KEY','APIFY_API_KEY','APIFY_TOKEN','BROWSER_USE_API_KEY','BROWSERUSE_API_KEY','XAI_API_KEY']:
    add('key_'+k, bool(os.environ.get(k)), 'present' if os.environ.get(k) else 'missing', required=k in ['MAKARON_API_KEY','APIFY_API_KEY','BROWSER_USE_API_KEY'])

rc,out,err=cmd('npx -y makaron-cli --version',120)
add('makaron_cli_available', rc==0 and out.strip(), out or err)

# lark-cli: installed + auth check (required for customer profiles with CLI-specific Feishu workflows)
rc,out,err=cmd('command -v lark-cli && lark-cli --version',60)
add('lark_cli_installed', rc==0 and out.strip(), out or err)
rc,out,err=cmd('lark-cli auth status --json 2>/dev/null | head -c 4000',120)
if rc==0 and out:
    try:
        auth_data=json.loads(out)
        identities=auth_data.get('identities',{{}})
        bot_ok=identities.get('bot',{{}}).get('status')=='ready'
        user_ok=identities.get('user',{{}}).get('status')=='ready'
        detail=f"appId={{auth_data.get('appId','?')}} brand={{auth_data.get('brand','?')}} bot={{'ready' if bot_ok else 'not-ready'}} user={{'ready' if user_ok else 'not-ready'}}"
        add('lark_cli_auth', bot_ok or user_ok, detail)
    except Exception:
        add('lark_cli_auth', False, out[:500] or err[:500])
else:
    add('lark_cli_auth', False, err or out or 'no output')

# Makaron auth-ish check: use help/version only here to avoid creating media/projects.
rc,out,err=cmd('npx -y makaron-cli list --json 2>/tmp/makaron-list-err.txt | head -c 1000',180)
if rc==0 and out:
    add('makaron_auth_list_projects', True, 'list returned data')
else:
    err2=''
    try: err2=open('/tmp/makaron-list-err.txt').read()[:1000]
    except Exception: pass
    add('makaron_auth_list_projects', False, err or err2 or out)

# Social research / Apify: call Apify user endpoint, non-scraping and cheap.
if os.environ.get('APIFY_API_KEY') or os.environ.get('APIFY_TOKEN'):
    token=os.environ.get('APIFY_API_KEY') or os.environ.get('APIFY_TOKEN')
    rc,out,err=cmd('TOKEN="${{APIFY_API_KEY:-${{APIFY_TOKEN:-}}}}"; curl -fsS -o /tmp/apify-me.json -w "%{{http_code}}" -H "Authorization: Bearer $TOKEN" https://api.apify.com/v2/users/me',40)
    add('social_research_apify_auth', rc==0 and '200' in out, out or err)
else:
    add('social_research_apify_auth', False, 'missing APIFY key')

# Browser readiness: local Chrome/Playwright style checks without external browsing.
rc,out,err=cmd('command -v google-chrome || command -v chromium || command -v chromium-browser || true',30)
add('browser_chrome_installed', bool(out.strip()), out or err)
rc,out,err=cmd('cd /home/openclaw/.openclaw/browser-tools && echo Y29uc3QgY2hyb21pdW0gPSByZXF1aXJlKCJwbGF5d3JpZ2h0LWNvcmUiKS5jaHJvbWl1bTsKKGFzeW5jKCk9PnsKICBjb25zdCBicm93c2VyID0gYXdhaXQgY2hyb21pdW0ubGF1bmNoKHtleGVjdXRhYmxlUGF0aDoiL3Vzci9iaW4vZ29vZ2xlLWNocm9tZSIsIGFyZ3M6WyItLW5vLXNhbmRib3giLCItLWRpc2FibGUtZ3B1Il0sIGhlYWRsZXNzOnRydWV9KTsKICBjb25zdCBwYWdlID0gYXdhaXQgYnJvd3Nlci5uZXdQYWdlKCk7CiAgYXdhaXQgcGFnZS5nb3RvKCJodHRwczovL2V4YW1wbGUuY29tIik7CiAgY29uc29sZS5sb2coYXdhaXQgcGFnZS50aXRsZSgpKTsKICBhd2FpdCBicm93c2VyLmNsb3NlKCk7Cn0pKCkuY2F0Y2goZT0+eyBjb25zb2xlLmVycm9yKGUpOyBwcm9jZXNzLmV4aXQoMSk7IH0pOwo= | base64 -d > mirror-playwright-check.js && node mirror-playwright-check.js',90)
add('browser_playwright_node_module', rc==0 and 'Example Domain' in out, out or err, required=False)

# Feishu plugin configured (OpenClaw runtime level).
rc,out,err=cmd('openclaw status --all | grep -E -A3 -B2 "openclaw-lark|lark"',120)
add('feishu_plugin_configured', rc==0 and ('OK' in out or 'configured' in out), out or err)

if feishu_target:
    # Explicitly gated. Sends a short test message through OpenClaw agent message tool path would need a channel target.
    add('feishu_send_test', False, 'send target provided but implementation intentionally not automatic in checklist v0; run manual approved send', required=False)
else:
    add('feishu_send_test', False, 'skipped: no --feishu-send-target provided', required=False)

rc,out,err=cmd(f'openclaw agent --agent {{shlex.quote(agent)}} --session-key agent:{{shlex.quote(agent)}}:checklist --message "用一句话回答：Mirror V checklist smoke test." --timeout 120 --json',160)
add('agent_smoke_turn', rc==0 and ('Mirror' in out or 'checklist' in out or 'V' in out), out[-1000:] or err)

required_ok=all(r['ok'] for r in results if r['required'])
print(json.dumps({{'ok':required_ok,'results':results}}, ensure_ascii=False, indent=2))
sys.exit(0 if required_ok else 2)
PY
'''
    rc, out, err = run_remote(args.host, args.ssh_key, script, timeout=420)
    if args.json:
        print(out)
        if err:
            print(err, file=sys.stderr)
    else:
        try:
            data = json.loads(out[out.index('{'):])
            print('Mirror V checklist:', 'PASS' if data.get('ok') else 'FAIL')
            for r in data.get('results', []):
                mark = '✅' if r.get('ok') else ('⚠️' if not r.get('required') else '❌')
                print(f"{mark} {r['name']}: {r.get('detail','')}")
        except Exception:
            print(out)
            if err:
                print(err, file=sys.stderr)
    return rc


if __name__ == '__main__':
    raise SystemExit(main())
