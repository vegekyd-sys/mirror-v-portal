#!/usr/bin/env python3
"""Correction-first support for Librarian; semantic decisions remain the agent's job.

Uses the existing expired-rules registry, never treats regex hits as proof of a
contradiction, and never rewrites raw sources. Prints locations, not source text.
context: load corrections before compiling; register: validate a sourced decision;
check: inspect the staged Markdown against registered obsolete formulations;
commit: run both checks sequentially and commit only if they pass.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import runpy
import datetime as dt
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = Path('memory/librarian/expired-rules.json')
PRIMARY = {'user_correction', 'user_decision', 'observed_state', 'authoritative_source'}
MARK = re.compile(r'已过期、不执行|已过时')
CORRECTION_CUE = re.compile(r'纠正|取消(?:这|该|旧|限制|规则)|理解错|不再执行|已废止|旧(?:规则|口径)|不是.{0,24}意思')


def git(root, *args):
    return subprocess.check_output(['git', '-c', 'core.quotepath=off', *args], cwd=root)


def validate_rule(rule):
    """New registrations require primary evidence, not a newer derived copy."""
    errors = []
    for field in ('id', 'decided', 'by', 'summary', 'current_rule_page', 'correction'):
        if not rule.get(field):
            errors.append(f'missing {field}')
    correction = rule.get('correction', {})
    for field in ('claim_kind', 'scope', 'supersedes', 'evidence'):
        if not correction.get(field):
            errors.append(f'missing correction.{field}')
    if correction.get('claim_kind') not in {'policy', 'fact', 'preference'}:
        errors.append('claim_kind must be policy/fact/preference')
    evidence = correction.get('evidence', [])
    if not isinstance(evidence, list) or not evidence:
        evidence = []
        errors.append('evidence must be a nonempty list')
    for item in evidence:
        if not isinstance(item, dict):
            errors.append('invalid evidence item')
            continue
        if item.get('kind') not in PRIMARY:
            errors.append('derived brief/QC/reflection/copy cannot authorize a correction')
        for key in ('ref', 'original_date', 'actor', 'basis'):
            if not item.get(key):
                errors.append(f'evidence missing {key}')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(item.get('original_date', ''))):
            errors.append('original_date must be the evidence date, not the copy date')
    if correction.get('claim_kind') in {'policy', 'preference'} and not any(
        x.get('kind') in {'user_correction', 'user_decision'} for x in evidence if isinstance(x, dict)
    ):
        errors.append('policy/preference changes require an explicit user basis')
    for pattern in rule.get('patterns', []) + rule.get('allow_patterns', []):
        try:
            re.compile(pattern, re.I)
        except (re.error, TypeError):
            errors.append('invalid pattern')
    return errors


def findings(path, text, rules):
    """Clause-local allowances: 'keep original, BUT crop...' must not pass.

    A match is a review requirement, not a factual verdict. Verified exceptions
    should be rewritten with specific evidence and precise scope, or registered
    with narrowly scoped allow_patterns; 'customer asked' alone is not evidence.
    """
    out = []
    for number, line in enumerate(text.splitlines(), 1):
        # Existing per-line historical markers apply to the complete quotation.
        if MARK.search(line):
            continue
        for clause in re.split(r'[。；;，,]|(?:但是|但|不过|然而|however|\bbut\b)', line):
            for rule in rules:
                if not any(re.search(p, clause, re.I) for p in rule.get('patterns', [])):
                    continue
                if MARK.search(clause):
                    continue
                allowances = rule.get('allow_patterns', [])
                if rule.get('correction'):
                    # A phrase in our own brief is not independent customer authority.
                    allowances = [p for p in allowances if p not in
                                  {'客户明确', '客户点名', '用户明确', '现行口径', '取代下面'}]
                if any(re.search(p, clause, re.I) for p in allowances):
                    continue
                out.append({'path': path, 'line': number, 'rule_id': rule['id'],
                            'current_rule_page': rule.get('current_rule_page'),
                            'status': 'needs_review'})
    return out


def snapshot_rules(root, revision=None):
    """Validate exactly the registry being checked/committed, not unstaged edits."""
    spec = f'{revision}:{REGISTRY.as_posix()}' if revision else f':{REGISTRY.as_posix()}'
    rules = json.loads(git(root, 'show', spec).decode('utf-8'))['rules']
    for rule in rules:
        if rule.get('correction'):
            errors = validate_rule(rule)
            if errors:
                raise ValueError(f"invalid correction metadata: {rule['id']}: {', '.join(errors)}")
    return rules


def check(root, rules, revision=None):
    if revision:
        names = git(root, 'diff', '--name-only', '-z', '--diff-filter=ACMR',
                    revision + '^', revision, '--', 'memory', 'USER.md')
    else:
        names = git(root, 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR',
                    '--', 'memory', 'USER.md')
    out = []
    for raw in names.split(b'\0'):
        if not raw:
            continue
        path = raw.decode('utf-8')
        if not path.endswith('.md') or path.startswith('memory/librarian/'):
            continue
        # Raw sources stay untouched; their contradictory statements are reviewed
        # as evidence, never promoted to instructions automatically.
        if re.match(r'memory/\d{4}-\d{2}-\d{2}\.md$', path) or path.startswith(
            ('memory/reflections/', 'memory/logs/', 'memory/imports/', 'memory/dreaming/',
             'memory/daily-session-review/')
        ):
            continue
        spec = f'{revision}:{path}' if revision else f':{path}'
        text = git(root, 'show', spec).decode('utf-8')
        # Check the whole staged page: a harmless added line must not hide an
        # uncorrected old instruction in the surrounding paragraph.
        out.extend(findings(path, text, rules))
    return out


def annotate_inputs(items, rules):
    """Read-only candidates; neither block unrelated sections nor mark any done."""
    result = []
    for item in items:
        row = {k: v for k, v in item.items() if k not in {'body', 'heading'}}
        row['correction_candidate'] = bool(CORRECTION_CUE.search(item.get('body', '')))
        row['conflict_candidates'] = sorted({x['rule_id'] for x in
                                             findings(item['file'], item.get('body', ''), rules)})
        row['review'] = 'required' if row['conflict_candidates'] or row['correction_candidate'] else 'normal'
        result.append(row)
    return result


def checked_commit(root, rules, message, move_checker=None):
    before = hashlib.sha256(git(root, 'diff', '--cached', '--binary')).hexdigest()
    reconciler = root / 'scripts/librarian-reconcile.py'
    if reconciler.exists():
        gate = subprocess.run([sys.executable, str(reconciler), 'gate'], cwd=root)
        if gate.returncode:
            return gate.returncode
    hits = check(root, rules)
    if hits:
        print(json.dumps({'ok': False, 'needs_review': hits}, ensure_ascii=False))
        return 1
    checker = move_checker or root / 'scripts/librarian-move-check.py'
    result = subprocess.run([sys.executable, str(checker)], cwd=root)
    if result.returncode:
        return result.returncode
    after = hashlib.sha256(git(root, 'diff', '--cached', '--binary')).hexdigest()
    if before != after:
        print('staged content changed during checks; re-check before commit', file=sys.stderr)
        return 1
    return subprocess.run(['git', 'commit', '-m', message], cwd=root).returncode


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='action', required=True)
    sub.add_parser('context')
    inputs = sub.add_parser('inputs', help='annotated pending daily + today corrections, without rewriting raw')
    inputs.add_argument('--date', help='inspect one date, including today; do not mark it compiled')
    inputs.add_argument('--limit', type=int, default=0)
    reg = sub.add_parser('register')
    reg.add_argument('--record', required=True, type=Path,
                     help='complete rule JSON with correction evidence; preserve existing fields')
    scan = sub.add_parser('check')
    scan.add_argument('--commit', help='read a past commit instead of the index')
    commit = sub.add_parser('commit')
    commit.add_argument('-m', '--message', required=True)
    args = ap.parse_args()
    registry = ROOT / REGISTRY
    data = json.loads(registry.read_text(encoding='utf-8'))
    if args.action == 'register':
        rule = json.loads(args.record.read_text(encoding='utf-8'))
        errors = validate_rule(rule)
        if errors:
            print(json.dumps({'ok': False, 'errors': errors}, ensure_ascii=False))
            return 1
        existing = next((r for r in data['rules'] if r['id'] == rule['id']), None)
        if existing:
            # Do not silently discard legacy patterns, source metadata or exceptions.
            for field in existing:
                if field not in rule:
                    print(f'missing existing field: {field}', file=sys.stderr)
                    return 1
            existing.update(rule)
        else:
            data['rules'].append(rule)
        registry.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'ok': True, 'rule_id': rule['id']}, ensure_ascii=False))
        return 0
    rules = data['rules']
    if args.action == 'inputs':
        queue = runpy.run_path(str(ROOT / 'scripts/librarian-daily-queue.py'))
        if args.date:
            dt.date.fromisoformat(args.date)
            items = queue['sections'](args.date)
        else:
            items = queue['queue'](queue['load_state'](), 'daily')
            today = dt.datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
            items.extend({**x, 'kind': 'today-correction-review-only'} for x in queue['sections'](today))
        rows = annotate_inputs(items, rules)
        selected = rows[:args.limit] if args.limit else rows
        print(json.dumps({'total': len(rows), 'returned': len(selected),
                          'needs_review': sum(x['review'] == 'required' for x in rows),
                          'sections': selected}, ensure_ascii=False, indent=2))
        return 0
    if args.action == 'context':
        print(json.dumps({'rules': rules,
                          'limits': 'Patterns identify known wording only; agent must review semantic conflicts, scope and primary provenance. Repetition is not corroboration.'},
                         ensure_ascii=False, indent=2))
        return 0
    if args.action == 'check':
        hits = check(ROOT, snapshot_rules(ROOT, args.commit), args.commit)
        print(json.dumps({'ok': not hits, 'needs_review': hits}, ensure_ascii=False, indent=2))
        return int(bool(hits))
    return checked_commit(ROOT, snapshot_rules(ROOT), args.message)


if __name__ == '__main__':
    sys.exit(main())
