#!/usr/bin/env python3
"""Incremental semantic reconciliation protocol for the Librarian agent.

The scheduled LLM reads every selected input, retrieves related old claims,
and supplies evidence-backed decisions. No regex decides what is a new fact.
This program collects inputs, verifies coverage, inserts exact-span annotations
without deleting any source bytes, and records outcomes in the existing registry.
"""
from __future__ import annotations
import argparse
import datetime as dt
import difflib
import hashlib
import importlib.util
import json
import re
import subprocess
import runpy
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CACHE = '.librarian-cache/reconcile'
RAW = re.compile(r'^memory/\d{4}-\d{2}-\d{2}\.md$|^memory/(reflections|logs|imports)/')
EXCLUDED = ('memory/librarian/', 'memory/archive/', 'memory/proposals/',
            'memory/dreaming/', 'memory/daily-session-review/', 'memory/imports/')


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def read_exact(path):
    return path.read_bytes().decode('utf-8')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def safe_path(root, relative):
    p = root / relative
    if not relative.startswith('memory/') or '..' in Path(relative).parts:
        raise ValueError('only workspace memory sources are allowed')
    if not p.resolve().is_relative_to((root / 'memory').resolve()):
        raise ValueError('external symlink source rejected')
    return p


def source_path(root, relative):
    if relative.startswith('.librarian-cache/reconcile/production/'):
        p = root / relative
        if '..' in Path(relative).parts or not p.resolve().is_relative_to((root / '.librarian-cache/reconcile/production').resolve()):
            raise ValueError('unsafe production source snapshot')
        return p
    return safe_path(root, relative)


def git(root, *args):
    return subprocess.check_output(['git', '-c', 'core.quotepath=off', *args],
                                   cwd=root, stderr=subprocess.DEVNULL)


def units(path, text):
    if path.endswith('.jsonl'):
        return [{'id': path + '#' + str(i + 1), 'path': path, 'lines': [i + 1, i + 1],
                 'sha256': digest(line), 'heading': 'reflection'}
                for i, line in enumerate(text.splitlines()) if line.strip()]
    lines = text.splitlines(keepends=True)
    heads = [i for i, line in enumerate(lines) if re.match(r'^#{1,3}\s', line)]
    starts = sorted(set([0] + heads))
    result, seen = [], {}
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        body = ''.join(lines[start:end])
        if not body.strip():
            continue
        heading = lines[start].strip() if start in heads else '(preamble)'
        seen[heading] = seen.get(heading, 0) + 1
        result.append({'id': path + '#' + heading + '#' + str(seen[heading]),
                       'path': path, 'lines': [start + 1, end], 'heading': heading,
                       'sha256': digest(body)})
    return result


def current_unit(root, unit):
    text = read_exact(source_path(root, unit['path']))
    return next((x for x in units(unit['path'], text) if x['id'] == unit['id']), None)


def unit_text(root, unit):
    text = read_exact(source_path(root, unit['path']))
    current = next((x for x in units(unit['path'], text) if x['id'] == unit['id']), None)
    if not current:
        raise ValueError('reviewed input missing: ' + unit['id'])
    start, end = current['lines']
    if unit['path'].endswith('.jsonl'):
        return text.splitlines()[start - 1]
    return ''.join(text.splitlines(keepends=True)[start - 1:end])


def prepare(root, cache, since=None, limit=60, only=None, refresh=False, lane='all', defer_reviewed=False):
    existing = read_json(cache / 'active.json', {})
    if existing and not refresh:
        return dict(existing, resume=True)
    state = read_json(cache / 'state.json', {'seen': {}, 'base': since})
    base = state.get('base') or since
    if not base:
        raise ValueError('first prepare needs --since <last Librarian content commit>')
    git(root, 'rev-parse', '--verify', base + '^{commit}')
    changed = set(git(root, 'diff', '--name-only', '-z', base, '--', 'memory').decode().split('\0'))
    changed.update(git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', 'memory').decode().split('\0'))
    # Raw logs can be gitignored; always inspect recent raw input, regardless of cues.
    today = dt.datetime.now(ZoneInfo('Asia/Shanghai')).date()
    for offset in range(3):
        day = (today - dt.timedelta(days=offset)).isoformat()
        changed.update([f'memory/{day}.md', f'memory/reflections/{day}.jsonl'])
    daily_helper = root / 'scripts/librarian-daily-queue.py'
    daily_pending = None
    if daily_helper.exists():
        daily = runpy.run_path(str(daily_helper))
        daily_pending = daily['queue'](daily['load_state'](), 'daily')
        changed.update(u['file'] for u in daily_pending)
    cursor = read_json(root / 'memory/librarian/reflections-cursor.json', {})
    since_day = str(cursor.get('new_since', today.isoformat()))[:10]
    if (root / 'memory/reflections').exists():
        changed.update(p.relative_to(root).as_posix() for p in (root / 'memory/reflections').glob('*.jsonl') if p.stem >= since_day)
    origins = {}
    helper = root / 'scripts/librarian-rule-sources.py'
    if helper.exists() and not only and lane in ('all', 'production'):
        spec = importlib.util.spec_from_file_location('production_sources', helper)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        now, previous = module.current(), module.load_snapshot()
        for origin in sorted(set(now) | set(previous)):
            if now.get(origin) == previous.get(origin):
                continue
            rel = '.librarian-cache/reconcile/production/' + hashlib.sha256(origin.encode()).hexdigest() + '.md'
            p = root / rel; p.parent.mkdir(parents=True, exist_ok=True)
            # Full before/after source, not a cue-word sample or a replacement rule.
            body = '# Production source: ' + origin + '\n\n## Current source\n' + now.get(origin, '(source removed)') + '\n\n## Previous snapshot (historical evidence)\n' + previous.get(origin, '(source newly added)')
            p.write_text(body); p.chmod(0o600)
            changed.add(rel); origins[rel] = origin
    # Previously deferred raw inputs remain discoverable after the recent window.
    changed.update(state.get('pending_paths', []))
    selected, unreadable, deferred, seen = [], [], [], state.get('seen', {})
    for rel in sorted(changed):
        if not rel or rel.startswith(EXCLUDED) or rel in ('memory/log.md', 'memory/index.md'):
            continue
        if only and rel not in only:
            continue
        is_daily = bool(re.fullmatch(r'memory/\d{4}-\d{2}-\d{2}\.md', rel))
        is_reflection = rel.startswith('memory/reflections/')
        is_production = rel.startswith('.librarian-cache/reconcile/production/')
        if lane == 'daily' and not is_daily:
            continue
        if lane == 'reflection' and not is_reflection:
            continue
        if lane == 'production' and not is_production:
            continue
        if lane == 'wiki' and (RAW.search(rel) or is_production):
            continue
        if not rel.endswith(('.md', '.jsonl')):
            continue
        p = source_path(root, rel)
        if not p.is_file():
            continue
        try:
            text = read_exact(p)
        except (UnicodeError, OSError) as e:
            unreadable.append({'path': rel, 'error': type(e).__name__, 'disposition': 'unresolved'})
            continue
        old = {}
        if not RAW.search(rel):
            try:
                old = {u['id']: u['sha256'] for u in units(rel, git(root, 'show', base + ':' + rel).decode())}
            except subprocess.CalledProcessError:
                pass
        for u in units(rel, text):
            if lane == 'daily' and daily_pending is not None:
                ranges = [list(map(int, x['lines'].split('-'))) for x in daily_pending if x['file'] == rel]
                if not any(u['lines'][0] <= end and start <= u['lines'][1] for start, end in ranges):
                    continue
            if seen.get(u['id']) == u['sha256'] or (u['id'] not in seen and old.get(u['id']) == u['sha256']):
                continue
            u.update(kind='raw-evidence' if RAW.search(rel) else 'changed-wiki',
                     semantic_review='required', authority='unverified; read primary provenance')
            if rel in origins:
                u.update(kind='production-source-delta', origin=origins[rel])
            previous_review = state.get('deferred', {}).get(u['id'], {})
            if (defer_reviewed and previous_review.get('date') == today.isoformat()
                    and previous_review.get('sha256') == u['sha256']):
                deferred.append(u)
                continue
            selected.append(u)
    # A broad audit is not a prerequisite for the ordinary compile queue.
    selected.sort(key=lambda u: (0 if re.fullmatch(r'memory/\d{4}-\d{2}-\d{2}\.md', u['path']) else
                                1 if u['path'].startswith('memory/reflections/') else
                                3 if u['kind'] == 'production-source-delta' else 2,
                                u['path'], u['lines'][0]))
    batch = {'base': base, 'prepared_head': git(root, 'rev-parse', 'HEAD').decode().strip(),
             'total_pending': len(selected), 'inputs': selected[:limit],
             'remaining': selected[limit:], 'scoped': bool(only) or lane != 'all', 'lane': lane, 'sealed': False}
    batch['unreadable'] = unreadable
    batch['deferred'] = deferred
    write_json(cache / 'active.json', batch)
    return batch


def locate(root, terms, limit=30, warnings=None):
    """Candidate recall only. Terms come from the LLM, never a topic rule table."""
    hits = []
    for p in sorted((root / 'memory').rglob('*.md')):
        rel = p.relative_to(root).as_posix()
        if rel.startswith(EXCLUDED) or p.is_symlink():
            continue
        safe_path(root, rel)
        try:
            text = read_exact(p)
        except (UnicodeError, OSError) as e:
            if warnings is not None:
                warnings.append({'path': rel, 'error': type(e).__name__})
            continue
        sha = digest(text)
        for i, line in enumerate(text.splitlines(), 1):
            score = sum(t.casefold() in line.casefold() for t in terms if t)
            if score:
                hits.append({'path': rel, 'line': i, 'score': score,
                             'sha256': sha})
    return sorted(hits, key=lambda x: (-x['score'], bool(RAW.search(x['path'])), x['path'], x['line']))[:limit]


def validate_report(root, batch, report):
    expected = {u['id']: u for u in batch['inputs']}
    reviews = report.get('reviews', [])
    if len(reviews) != len(expected) or {r['source_id'] for r in reviews} != set(expected):
        raise ValueError('every selected input needs exactly one semantic review, including no-change')
    by_id = {r['source_id']: r for r in reviews}
    for sid, u in expected.items():
        r = by_id[sid]
        current = current_unit(root, u)
        if not current or current['sha256'] != u['sha256'] or r.get('source_sha256') != u['sha256']:
            raise ValueError('source changed; reread before judgment: ' + sid)
        if r.get('disposition') not in ('no_change', 'new', 'supersedes', 'historical', 'unresolved') or not r.get('reason'):
            raise ValueError('missing semantic disposition/reason')
        if r['disposition'] in ('new', 'supersedes') and not r.get('retrieval'):
            raise ValueError('new claims require semantic retrieval evidence, even zero-hit searches')
        if r['disposition'] in ('new', 'supersedes'):
            for search in r['retrieval']:
                if (not isinstance(search, dict) or search.get('tool') not in ('memory_search', 'locate')
                        or not search.get('query') or not isinstance(search.get('paths'), list)):
                    raise ValueError('retrieval needs actual tool/query/result-path evidence')
            v = r.get('verification', {})
            if v.get('status') != 'verified' or not v.get('method') or not v.get('evidence'):
                raise ValueError('newer is not truer: verify the new claim before promotion')
            if not v.get('comparison_with_old'):
                raise ValueError('explicitly compare new authority/scope/time against the old evidence')
            for e in v['evidence']:
                if e.get('kind') not in ('user_correction', 'user_decision', 'observed_state', 'authoritative_source'):
                    raise ValueError('brief/QC/assistant copy is not independent authority')
                if not all(e.get(k) for k in ('ref', 'quote', 'file', 'sha256', 'actor', 'original_date')):
                    raise ValueError('new claim verification needs checked primary provenance')
                evidence_text = read_exact(source_path(root, e['file']))
                if digest(evidence_text) != e['sha256'] or e['quote'] not in evidence_text:
                    raise ValueError('new claim evidence changed or quote is not present')
    annotation_ranges = {}
    spec = importlib.util.spec_from_file_location('corrections', ROOT / 'scripts/librarian-corrections.py')
    c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
    for change in report.get('changes', []):
        rule = change['record']
        errors = c.validate_rule(rule)
        if errors:
            raise ValueError('; '.join(errors))
        review = by_id.get(change.get('source_id'), {})
        if review.get('disposition') != 'supersedes':
            raise ValueError('supersession must be linked to a reviewed new input')
        verification = review['verification']
        verified_refs = {e['ref'] for e in verification['evidence']}
        if not all(e['ref'] in verified_refs for e in rule['correction']['evidence']):
            raise ValueError('decision authority must be among the checked primary evidence')
        if rule['correction']['claim_kind'] in ('policy', 'preference') and not any(
                e['kind'] in ('user_correction', 'user_decision') for e in verification['evidence']):
            raise ValueError('an observation cannot revoke a policy or preference')
        page = safe_path(root, rule['current_rule_page'])
        if RAW.search(rule['current_rule_page']) or rule['current_rule_page'].startswith(EXCLUDED):
            raise ValueError('current conclusion belongs in a canonical wiki page, not raw/audit')
        if change.get('current_quote', '') not in read_exact(page) or not change.get('current_quote'):
            raise ValueError('correct current claim must already exist on its canonical page')
        for a in change.get('annotations', []):
            p = safe_path(root, a['path'])
            if RAW.search(a['path']) or a['path'].startswith(EXCLUDED):
                raise ValueError('raw sources stay immutable; use registry relation, not raw edits')
            text = read_exact(p)
            if digest(text) != a['before_sha256']:
                raise ValueError('target changed concurrently')
            quote = a.get('quote', '')
            start = a.get('span_start', text.find(quote))
            if not quote or '\n' in quote or not isinstance(start, int) or start < 0 or text[start:start + len(quote)] != quote:
                raise ValueError('old claim needs an exact single-line span, not whole-line replacement')
            if text.count(quote) != 1 and 'span_start' not in a:
                raise ValueError('duplicate quote needs explicit span_start')
            before = text[:start].rsplit('\n', 1)[-1]
            if before.count('~~') % 2 or text[start + len(quote):].startswith('~~【已过期'):
                raise ValueError('already historical: classify instead of double annotation')
            ranges = annotation_ranges.setdefault(a['path'], [])
            end = start + len(quote)
            if any(start < y and x < end for x, y in ranges):
                raise ValueError('overlapping annotations rejected')
            ranges.append((start, end))
            if not a.get('scope_reason'):
                raise ValueError('explain why this exact span, not neighboring facts, is obsolete')
    supersedes_ids = {r['source_id'] for r in reviews if r['disposition'] == 'supersedes'}
    if supersedes_ids != {c['source_id'] for c in report.get('changes', [])}:
        raise ValueError('each supersedes decision needs its own linked change')
    return by_id


def apply_report(root, cache, report, dry_run=False):
    batch = read_json(cache / 'active.json', {})
    if batch.get('sealed'):
        if report == batch.get('report'):
            return {'ok': True, 'already_applied': True}
        raise ValueError('sealed batch cannot be overwritten; finish or refresh explicitly')
    by_id = validate_report(root, batch, report)
    registry_path = root / 'memory/librarian/expired-rules.json'
    registry = read_json(registry_path, {'rules': []})
    originals, outputs, insertions = {}, {}, {}
    for change in report.get('changes', []):
        record = dict(change['record']); record.setdefault('patterns', [])
        relations = []
        for a in change.get('annotations', []):
            rel = a['path']; original = read_exact(safe_path(root, rel))
            originals.setdefault(rel, original)
            quote = a['quote']
            marker = f"【已过期、不执行 · {record['decided']} · {record['id']} · 现行见 {record['current_rule_page']}】"
            annotated = '~~' + quote + '~~' + marker
            start = a.get('span_start', original.find(quote))
            insertions.setdefault(rel, []).append((start, quote, annotated))
            relations.append({'path': rel, 'quote': quote, 'marker': marker,
                              'scope_reason': a['scope_reason']})
        # Raw hits are relations, never mutated; consumers can explain them by source.
        for relation in change.get('raw_relations', []):
            p = safe_path(root, relation['path'])
            if not RAW.search(relation['path']) or relation['quote'] not in read_exact(p):
                raise ValueError('invalid original raw quote relation')
            relations.append(dict(relation, immutable_raw=True))
        record['targets'] = relations
        existing = next((r for r in registry['rules'] if r['id'] == record['id']), None)
        if existing and existing.get('summary') != record['summary']:
            raise ValueError('do not overwrite another decision; create a new relation id')
        if existing:
            existing['targets'] = list({json.dumps(x, sort_keys=True): x for x in existing.get('targets', []) + relations}.values())
        else:
            registry['rules'].append(record)
    for rel, patches in insertions.items():
        text = originals[rel]
        for start, quote, annotated in sorted(patches, reverse=True):
            text = text[:start] + annotated + text[start + len(quote):]
        # Reconstruct the input by removing ONLY our insertions, including neighbors.
        restored = text
        for _, quote, annotated in patches:
            restored = restored.replace(annotated, quote, 1)
        if restored != originals[rel]:
            raise ValueError('non-insertion edit rejected')
        outputs[rel] = text
    if dry_run:
        return {'ok': True, 'dry_run': True, 'reviews': len(by_id), 'targets': list(outputs)}
    validate_report(root, batch, report)
    # Validate all targets before any write; concurrent changes fail closed.
    for rel, original in originals.items():
        if read_exact(safe_path(root, rel)) != original:
            raise ValueError('target changed before write')
    for rel, text in outputs.items():
        safe_path(root, rel).write_text(text)
    if report.get('changes'):
        write_json(registry_path, registry)
    checked_evidence = {e['file'] for review in report['reviews']
                        for e in review.get('verification', {}).get('evidence', [])}
    canonical_pages = {change['record']['current_rule_page'] for change in report.get('changes', [])}
    changed_ids = {change['record']['id'] for change in report.get('changes', [])}
    # Raw/ignored inputs need a durable checked snapshot without forcing raw into Git.
    # Every disposition is sealed, not just claims that replace another claim.
    snapshots = {}
    for u in batch['inputs']:
        body = unit_text(root, u)
        sha = digest(body)
        rel = 'snapshots/' + sha + '.txt'
        path = cache / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body.encode('utf-8')); path.chmod(0o600)
        snapshots[u['id']] = {'file': rel, 'sha256': sha}
    versioned_paths = [rel for rel in {u['path'] for u in batch['inputs']}
                       if git(root, 'ls-files', '--', rel).strip()]
    batch.update(sealed=True, report=report, target_hashes={k: digest(v) for k, v in outputs.items()},
                 input_snapshots=snapshots, versioned_paths=versioned_paths,
                 reviewed_hashes={u['id']: current_unit(root, u)['sha256'] for u in batch['inputs']},
                 evidence_hashes={p: digest(read_exact(source_path(root, p))) for p in checked_evidence},
                 canonical_hashes={p: digest(read_exact(safe_path(root, p))) for p in canonical_pages},
                 audit_expected={r['id']: r for r in registry['rules'] if r['id'] in changed_ids})
    write_json(cache / 'active.json', batch)
    return {'ok': True, 'reviews': len(by_id), 'targets': list(outputs),
            'unresolved': [sid for sid, r in by_id.items() if r['disposition'] == 'unresolved']}


def gate(root, cache, revision=None):
    b = read_json(cache / 'active.json', {})
    if not b:
        return []
    if not b.get('sealed'):
        return ['semantic review batch is incomplete; no keyword-list bypass']
    errors = []
    for u in b.get('inputs', []):
        current = current_unit(root, u)
        if not current or current['sha256'] != b.get('reviewed_hashes', {}).get(u['id']):
            errors.append('reviewed input changed after sealing: ' + u['id'])
        snapshot = b.get('input_snapshots', {}).get(u['id'], {})
        rel = snapshot.get('file', '')
        path = cache / rel
        if (not rel.startswith('snapshots/') or '..' in Path(rel).parts
                or not path.is_file() or digest(read_exact(path)) != b.get('reviewed_hashes', {}).get(u['id'])
                or snapshot.get('sha256') != b.get('reviewed_hashes', {}).get(u['id'])):
            errors.append('reviewed input snapshot missing or changed: ' + u['id'])
    for rel, sha in b.get('evidence_hashes', {}).items():
        if digest(read_exact(source_path(root, rel))) != sha:
            errors.append('verified primary evidence changed after sealing: ' + rel)
        # Working-tree restoration must not mask a poisoned staged/committed source.
        try:
            snapshot = git(root, 'show', (revision + ':' if revision else ':') + rel).decode()
            if digest(snapshot) != sha:
                errors.append('primary evidence differs in index/commit: ' + rel)
        except subprocess.CalledProcessError:
            if git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', rel).strip():
                errors.append('primary evidence missing from index/commit: ' + rel)
    for u in b.get('inputs', []):
        try:
            snapshot = git(root, 'show', (revision + ':' if revision else ':') + u['path']).decode()
        except subprocess.CalledProcessError:
            if u['path'] in b.get('versioned_paths', []):
                errors.append('reviewed input missing from index/commit: ' + u['id'])
            continue
        source = next((x for x in units(u['path'], snapshot) if x['id'] == u['id']), None)
        if not source or source['sha256'] != b['reviewed_hashes'][u['id']]:
            errors.append('reviewed input differs in index/commit: ' + u['id'])
    expected_pages = dict(b.get('target_hashes', {}), **b.get('canonical_hashes', {}))
    for rel, sha in expected_pages.items():
        try:
            staged = git(root, 'show', (revision + ':' if revision else ':') + rel).decode()
        except subprocess.CalledProcessError:
            if revision:
                errors.append('reviewed annotation absent from commit: ' + rel)
                continue
            staged = read_exact(safe_path(root, rel))
        if digest(staged) != sha:
            errors.append('reviewed annotation changed: ' + rel)
    try:
        registry = json.loads(git(root, 'show', (revision + ':' if revision else ':') + 'memory/librarian/expired-rules.json'))
    except subprocess.CalledProcessError:
        if revision:
            return errors + ['correction registry absent from commit'] if b.get('report', {}).get('changes') else errors
        registry = read_json(root / 'memory/librarian/expired-rules.json', {'rules': []})
    for expected in b.get('audit_expected', {}).values():
        actual = next((r for r in registry['rules'] if r['id'] == expected['id']), None)
        if actual != expected:
            errors.append('correction relation not staged/committed: ' + expected['id'])
    return errors


def finish(root, cache):
    b = read_json(cache / 'active.json', {})
    if not b.get('sealed') or gate(root, cache) or gate(root, cache, 'HEAD'):
        raise ValueError('cannot checkpoint an unreviewed/changed batch')
    state = read_json(cache / 'state.json', {'seen': {}, 'base': b['base']})
    unresolved = set()
    for review in b['report']['reviews']:
        if review['disposition'] == 'unresolved':
            sid = review['source_id']
            state.setdefault('deferred', {})[sid] = {'sha256': b['reviewed_hashes'][sid],
                'date': dt.datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()}
            unresolved.add(sid); continue
        u = next(x for x in b['inputs'] if x['id'] == review['source_id'])
        # Never mark a newly changed, unreviewed version as seen, even in a race.
        state['seen'][u['id']] = b['reviewed_hashes'][u['id']]
    pending = b.get('remaining', []) + b.get('deferred', []) + [u for u in b['inputs'] if u['id'] in unresolved]
    retained = set(state.get('pending_paths', [])) if b.get('scoped') else set()
    state['pending_paths'] = sorted(retained | {u['path'] for u in pending + b.get('unreadable', [])})
    if not state['pending_paths'] and not b.get('scoped'):
        state['base'] = b['prepared_head']
    write_json(cache / 'state.json', state)
    write_json(cache / 'last-completed.json', b)
    (cache / 'active.json').unlink()
    return {'ok': True, 'reviewed': len(b['inputs']) - len(unresolved),
            'pending': len(pending) + len(b.get('unreadable', []))}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=ROOT)
    p.add_argument('--cache', default=CACHE)
    sub = p.add_subparsers(dest='action', required=True)
    prep = sub.add_parser('prepare'); prep.add_argument('--since'); prep.add_argument('--limit', type=int, default=60); prep.add_argument('--only', action='append'); prep.add_argument('--refresh', action='store_true')
    prep.add_argument('--lane', choices=['all', 'daily', 'reflection', 'wiki', 'production'], default='all')
    prep.add_argument('--defer-reviewed', action='store_true', help='retain but do not retry unchanged unresolved inputs again today')
    sub.add_parser('gate'); sub.add_parser('finish')
    loc = sub.add_parser('locate'); loc.add_argument('--terms', nargs='+', required=True); loc.add_argument('--limit', type=int, default=30)
    apply = sub.add_parser('apply'); apply.add_argument('--report', type=Path, required=True); apply.add_argument('--dry-run', action='store_true')
    explain = sub.add_parser('explain'); explain.add_argument('--path', required=True)
    args = p.parse_args(); root = args.root.resolve(); cache = root / args.cache
    try:
        if args.action == 'prepare':
            result = prepare(root, cache, args.since, args.limit, args.only, args.refresh, args.lane, args.defer_reviewed)
        elif args.action == 'locate':
            warnings = []
            result = {'candidates': locate(root, args.terms, args.limit, warnings),
                      'semantic_verdict': False, 'warnings': warnings}
        elif args.action == 'apply':
            result = apply_report(root, cache, json.loads(args.report.read_text()), args.dry_run)
        elif args.action == 'finish':
            result = finish(root, cache)
        elif args.action == 'explain':
            result = {'relations': [r for r in read_json(root / 'memory/librarian/expired-rules.json', {'rules': []})['rules'] if any(t['path'] == args.path for t in r.get('targets', []))]}
        else:
            errors = gate(root, cache); result = {'ok': not errors, 'errors': errors}
            print(json.dumps(result, ensure_ascii=False)); return int(bool(errors))
        print(json.dumps(result, ensure_ascii=False, indent=2)); return 0
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)); return 1


if __name__ == '__main__':
    raise SystemExit(main())
