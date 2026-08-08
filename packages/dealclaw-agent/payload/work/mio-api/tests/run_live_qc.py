#!/usr/bin/env python3
"""Run live QC cases from qc_cases.yaml.

No external yaml dependency: this script parses the simple generated file format.
"""
import json, os, shlex, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CASES=Path(__file__).with_name('qc_cases.yaml')

def parse_cases(text):
    cases=[]; cur=None
    for line in text.splitlines():
        if line.startswith('- id:'):
            if cur: cases.append(cur)
            cur={'id': line.split(':',1)[1].strip()}
        elif cur and ':' in line and line.startswith('  '):
            k,v=line.strip().split(':',1); v=v.strip()
            if len(v)>=2 and v[0] in "'\"" and v[-1]==v[0]: v=v[1:-1]
            if v in ('true','false'): v=(v=='true')
            cur[k]=v
    if cur: cases.append(cur)
    return cases

def main():
    live='--live' in sys.argv
    cases=parse_cases(CASES.read_text())
    results=[]
    for c in cases:
        if c.get('live') and not live:
            results.append({'id':c['id'],'status':'SKIP','reason':'live case'})
            continue
        cmd=c['command']
        proc=subprocess.run(cmd, shell=True, cwd=ROOT, text=True, capture_output=True, timeout=120)
        ok=False; err=None; count=None
        try:
            payload=json.loads(proc.stdout); err=payload.get('error'); count=payload.get('count')
            # Normal live cases require successful command. Negative/auth contract cases are allowed
            # to return a structured JSON error as long as they do not traceback.
            if proc.returncode==0 and err is None:
                ok=True
            elif c['id'] in ('TC-AUTH002',) and isinstance(err, dict) and err.get('code') == 'MISSING_ENV':
                ok=True
        except Exception as e:
            err=str(e)
        results.append({'id':c['id'],'status':'PASS' if ok else 'FAIL','returncode':proc.returncode,'count':count,'error':err,'command':cmd})
    print(json.dumps({'count':len(results),'results':results}, ensure_ascii=False, indent=2))
    if any(r['status']=='FAIL' for r in results): sys.exit(1)
if __name__=='__main__': main()
