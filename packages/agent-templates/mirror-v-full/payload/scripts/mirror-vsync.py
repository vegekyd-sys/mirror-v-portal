#!/usr/bin/env python3
"""Mirror V's door to v-sync-hub (VSync), through the Portal's VSync broker.

Mirror V never holds a GitHub credential. The platform gives this instance an
agent id and a token (env NEXUS_VSYNC_URL / NEXUS_VSYNC_AGENT / NEXUS_VSYNC_TOKEN;
a customer's own deployment sets the same three). With them it can only:
read its inbox and the packages addressed to it, append its own ACKs, and send
packages / messages to the counterparts the platform allows (private-v).

  mirror-vsync.py whoami
  mirror-vsync.py inbox                      messages addressed to me
  mirror-vsync.py packages                   packages addressed to me (+ sender's manifest row)
  mirror-vsync.py fetch <package-id> <dir>   download a package, verify sha256 against the manifest/inbox
  mirror-vsync.py get <hub path> [out]       one file I am allowed to read
  mirror-vsync.py ack <in_reply_to> <applied|blocked|received|rejected|partial> <summary> [--json extra.json]
  mirror-vsync.py send <subject> [--body text] [--dir package-dir] [--to private-v]
  mirror-vsync.py replies                    counterparts' ACKs of what I sent
Exit code 3 = no hub identity configured (fall back to the Feishu file route in skills/vsync).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

URL = os.environ.get("NEXUS_VSYNC_URL", "").rstrip("/")
AGENT = os.environ.get("NEXUS_VSYNC_AGENT", "")
TOKEN = os.environ.get("NEXUS_VSYNC_TOKEN", "")


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def call(op: str, method: str = "GET", body: dict | None = None, query: dict | None = None, raw: bool = False):
    if not (URL and AGENT and TOKEN):
        die("BLOCKED: no v-sync-hub identity on this instance (NEXUS_VSYNC_* not set)", 3)
    url = f"{URL}/{op}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "x-vsync-agent": AGENT, "x-vsync-token": TOKEN, "user-agent": "mirror-vsync/1",
        **({"content-type": "application/json"} if data is not None else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=150) as r:
            payload = r.read()
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error")
        except Exception:
            err = None
        die(f"BLOCKED: hub {op} failed: HTTP {e.code} {err or ''}".strip(), 2)
    except urllib.error.URLError as e:
        die(f"BLOCKED: hub unreachable: {e.reason}", 2)
    return payload if raw else json.loads(payload)


def out(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=1))


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def fetch(package_id: str, dest: str) -> None:
    pkgs = [p for p in call("packages")["packages"] if p["packageId"] == package_id]
    if not pkgs:
        die(f"BLOCKED: package {package_id} is not addressed to {AGENT}", 2)
    pkg = pkgs[0]
    expected: dict[str, str] = {}
    manifest = pkg.get("manifest") or {}
    expected.update(manifest.get("file_sha256") or {})
    for row in call("inbox")["rows"]:
        refs = row.get("refs") or {}
        if refs.get("package_id") == package_id:
            for f in refs.get("files") or []:
                if isinstance(f, dict) and f.get("path") and f.get("sha256"):
                    expected[f["path"]] = f["sha256"]
            if isinstance(refs.get("sha256"), str) and len(pkg["files"]) == 1:
                expected.setdefault(pkg["files"][0]["path"], refs["sha256"])
    single = manifest.get("sha256") if len(pkg["files"]) == 1 else None
    base = f"agents/{pkg['from']}/returns/{AGENT}/{package_id}/"
    root = Path(dest)
    report = []
    for f in pkg["files"]:
        body = call("file", query={"path": f["path"]}, raw=True)
        rel = f["path"][len(base):] if f["path"].startswith(base) else Path(f["path"]).name
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        got = sha256(body)
        want = expected.get(f["path"]) or single
        report.append({"path": str(target), "sha256": got, "expected": want, "match": (got == want) if want else None})
    out({"from": pkg["from"], "packageId": package_id, "files": report})
    if any(r["match"] is False for r in report):
        die("BLOCKED: sha256 mismatch (see above); do not install", 4)


def send(args: list[str]) -> None:
    if not args or args[0].startswith("-"):
        die("usage: send <subject> [--body text] [--dir package-dir] [--to private-v]  (nothing was sent)")
    subject, rest = args[0], args[1:]
    if len(subject.strip()) < 3:
        die("send: subject too short (nothing was sent)")
    opts = {"--body": "", "--dir": "", "--to": "private-v", "--note": ""}
    while rest:
        k = rest.pop(0)
        if k not in opts or not rest:
            die(f"bad option {k}")
        opts[k] = rest.pop(0)
    files = []
    if opts["--dir"]:
        root = Path(opts["--dir"])
        for p in sorted(root.rglob("*")):
            if p.is_file() and ".git" not in p.parts:
                files.append({"path": p.relative_to(root).as_posix(), "contentBase64": base64.b64encode(p.read_bytes()).decode()})
    out(call("send", "POST", {"to": opts["--to"], "subject": subject, "body": opts["--body"], "note": opts["--note"], "files": files}))


def main(argv: list[str]) -> None:
    # Any help flag only prints usage: an agent exploring the CLI must never write to the hub by accident.
    if not argv or any(a in ("-h", "--help", "help") for a in argv):
        print(__doc__)
        return
    cmd, args = argv[0], argv[1:]
    if cmd in ("whoami", "inbox", "packages", "replies", "acks"):
        out(call(cmd))
    elif cmd == "fetch" and len(args) == 2:
        fetch(*args)
    elif cmd == "get" and args:
        body = call("file", query={"path": args[0]}, raw=True)
        if len(args) > 1:
            Path(args[1]).write_bytes(body)
            out({"path": args[1], "sha256": sha256(body), "bytes": len(body)})
        else:
            sys.stdout.buffer.write(body)
    elif cmd == "ack" and len(args) >= 3:
        row = {"in_reply_to": args[0], "status": args[1], "summary": args[2]}
        if len(args) == 5 and args[3] == "--json":
            row.update(json.loads(Path(args[4]).read_text()))
        out(call("ack", "POST", {"row": row}))
    elif cmd == "send":
        send(args)
    else:
        die(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
