"""Machine-contract regressions; semantic judgments are independently replayed by an LLM."""
import copy
import importlib.util
import json
import subprocess
import shutil
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('reconcile', Path(__file__).parents[1] / 'librarian-reconcile.py')
R = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(R)


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.cache = self.root / '.cache'
        for folder in ['memory/concepts', 'memory/projects', 'memory/librarian']:
            (self.root / folder).mkdir(parents=True)
        self.old = 'Nacre handoff uses dock A.'
        self.current = 'Nacre handoff uses dock C.'
        self.path = 'memory/concepts/harbor.md'
        self.page = self.root / self.path
        self.original = 'Run rv-731; ' + self.old + ' QC=passed; invoice=88.\r\n'
        self.page.write_bytes(self.original.encode())
        self.registry = self.root / 'memory/librarian/expired-rules.json'
        R.write_json(self.registry, {'rules': []})
        self.git('init', '-q'); self.git('config', 'user.name', 'Test'); self.git('config', 'user.email', 'test@example.invalid')
        self.git('add', '.'); self.git('commit', '-qm', 'old correct operating state')
        self.base = self.git('rev-parse', 'HEAD')
        self.source = 'memory/projects/harbor-current.md'
        (self.root / self.source).write_text('# Nacre operations\n' + self.current + '\n')
        self.evidence = 'memory/2026-10-21.md'
        self.quote = 'Owner: starting October 21, route Nacre handoff through dock C; keep invoice 88.'
        (self.root / self.evidence).write_text('# Primary owner message\n' + self.quote + '\n')
        self.batch = R.prepare(self.root, self.cache, self.base)

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.DEVNULL).decode().strip()

    def report(self):
        evidence = {'kind': 'user_decision', 'ref': 'message:owner-77', 'original_date': '2026-10-21', 'actor': 'Owner',
                    'quote': self.quote, 'file': self.evidence, 'sha256': R.digest(R.read_exact(self.root / self.evidence))}
        source = next(u for u in self.batch['inputs'] if u['path'] == self.source)
        reviews = []
        for u in self.batch['inputs']:
            review = {'source_id': u['id'], 'source_sha256': u['sha256'], 'disposition': 'historical', 'reason': 'Primary evidence was read; source retained unchanged.'}
            if u == source:
                review.update(disposition='supersedes', reason='Owner changes handoff location only; unrelated accounting is still valid.',
                              retrieval=[{'tool': 'locate', 'query': 'Nacre handoff', 'paths': [self.path]}],
                              verification={'status': 'verified', 'method': 'read original owner message and older policy',
                                            'comparison_with_old': 'Same owner and same handoff; later explicit instruction changes dock, not invoice/QC.', 'evidence': [evidence]})
            reviews.append(review)
        rule = {'id': 'nacre-handoff-20261021', 'decided': '2026-10-21', 'by': 'Owner', 'summary': self.current,
                'current_rule_page': self.source, 'correction': {'claim_kind': 'policy', 'scope': 'Nacre handoff only',
                    'supersedes': [self.old], 'evidence': [{k: evidence[k] for k in ['kind', 'ref', 'original_date', 'actor']} | {'basis': self.quote}]}}
        return {'reviews': reviews, 'changes': [{'source_id': source['id'], 'record': rule, 'current_quote': self.current,
                  'annotations': [{'path': self.path, 'before_sha256': R.digest(R.read_exact(self.page)),
                                   'quote': self.old, 'scope_reason': 'Only the dock claim changes, not Run/QC/invoice.'}]}]}

    def test_changed_wiki_without_correction_words_is_required(self):
        self.assertFalse(any(x in self.current for x in ['纠正', '取消', '理解错']))
        self.assertTrue(any(u['path'] == self.source and u['semantic_review'] == 'required' for u in self.batch['inputs']))
        self.assertEqual(json.loads(self.registry.read_text())['rules'], [])

    def test_no_pattern_registration_is_needed(self):
        plan = self.report(); self.assertNotIn('patterns', plan['changes'][0]['record'])
        R.apply_report(self.root, self.cache, plan)
        rule = json.loads(self.registry.read_text())['rules'][0]
        self.assertEqual(rule['patterns'], [])

    def test_span_insertion_preserves_neighbor_facts_and_exact_crlf_bytes(self):
        R.apply_report(self.root, self.cache, self.report())
        after = R.read_exact(self.page)
        rule = json.loads(self.registry.read_text())['rules'][0]
        marker = rule['targets'][0]['marker']
        self.assertEqual(after.replace('~~' + self.old + '~~' + marker, self.old), self.original)
        self.assertTrue(after.endswith('QC=passed; invoice=88.\r\n'))
        self.assertTrue(after.startswith('Run rv-731; '))

    def test_incomplete_coverage_blocks_before_any_mutation(self):
        plan = self.report(); plan['reviews'].pop()
        with self.assertRaises(ValueError): R.apply_report(self.root, self.cache, plan)
        self.assertEqual(R.read_exact(self.page), self.original)

    def test_unverified_new_information_cannot_replace_old(self):
        plan = self.report(); next(x for x in plan['reviews'] if x['disposition'] == 'supersedes')['verification']['status'] = 'unverified'
        with self.assertRaisesRegex(ValueError, 'verify the new claim'): R.apply_report(self.root, self.cache, plan)
        self.assertEqual(R.read_exact(self.page), self.original)

    def test_conflicting_sources_cannot_replace_old(self):
        plan = self.report(); next(x for x in plan['reviews'] if x['disposition'] == 'supersedes')['verification']['status'] = 'conflicting'
        with self.assertRaises(ValueError): R.apply_report(self.root, self.cache, plan)

    def test_newer_assistant_or_qc_copy_is_not_authority(self):
        for kind in ['brief', 'qc', 'reflection', 'copy', 'assistant']:
            plan = self.report(); next(x for x in plan['reviews'] if x['disposition'] == 'supersedes')['verification']['evidence'][0]['kind'] = kind
            with self.assertRaisesRegex(ValueError, 'independent authority'): R.apply_report(self.root, self.cache, plan)
        self.assertEqual(R.read_exact(self.page), self.original)

    def test_observed_fact_cannot_revoke_policy(self):
        plan = self.report(); next(x for x in plan['reviews'] if x['disposition'] == 'supersedes')['verification']['evidence'][0]['kind'] = 'observed_state'
        with self.assertRaisesRegex(ValueError, 'observation cannot revoke'): R.apply_report(self.root, self.cache, plan)

    def test_primary_quote_is_checked_not_just_claimed(self):
        plan = self.report(); next(x for x in plan['reviews'] if x['disposition'] == 'supersedes')['verification']['evidence'][0]['quote'] = 'Owner said something else'
        with self.assertRaisesRegex(ValueError, 'quote is not present'): R.apply_report(self.root, self.cache, plan)

    def test_concurrent_target_edit_fails_closed(self):
        plan = self.report(); self.page.write_bytes((self.original + 'other worker\n').encode())
        with self.assertRaisesRegex(ValueError, 'target changed'): R.apply_report(self.root, self.cache, plan)

    def test_unresolved_remains_pending_without_changing_old(self):
        plan = self.report(); plan['changes'] = []
        for review in plan['reviews']:
            review.update(disposition='unresolved', reason='Cannot verify the claimed new authority')
        R.apply_report(self.root, self.cache, plan)
        self.assertEqual(R.read_exact(self.page), self.original)
        R.finish(self.root, self.cache)
        again = R.prepare(self.root, self.cache)
        self.assertEqual({u['id'] for u in again['inputs']}, {u['id'] for u in self.batch['inputs']})

    def test_raw_cannot_be_edited(self):
        plan = self.report(); a = plan['changes'][0]['annotations'][0]
        a.update(path=self.evidence, quote=self.quote, before_sha256=R.digest(R.read_exact(self.root / self.evidence)))
        with self.assertRaisesRegex(ValueError, 'raw sources stay immutable'): R.apply_report(self.root, self.cache, plan)

    def test_dry_run_and_idempotent_apply(self):
        plan = self.report(); R.apply_report(self.root, self.cache, plan, dry_run=True)
        self.assertEqual(R.read_exact(self.page), self.original)
        R.apply_report(self.root, self.cache, plan)
        self.assertTrue(R.apply_report(self.root, self.cache, plan)['already_applied'])

    def test_gate_and_finish_require_reviewed_staged_then_committed_content(self):
        self.assertTrue(R.gate(self.root, self.cache))
        R.apply_report(self.root, self.cache, self.report())
        self.assertTrue(R.gate(self.root, self.cache))
        self.git('add', 'memory'); self.assertEqual(R.gate(self.root, self.cache), [])
        with self.assertRaises(ValueError): R.finish(self.root, self.cache)
        self.git('commit', '-qm', 'reviewed change')
        self.assertTrue(R.finish(self.root, self.cache)['ok'])

    def test_sealed_primary_evidence_change_blocks_gate_and_finish(self):
        R.apply_report(self.root, self.cache, self.report())
        (self.root / self.evidence).write_text('Assistant: ' + self.quote + '\n')
        self.git('add', 'memory'); self.git('commit', '-qm', 'tampered evidence after review')
        self.assertTrue(any('evidence changed' in x for x in R.gate(self.root, self.cache, 'HEAD')))
        with self.assertRaises(ValueError): R.finish(self.root, self.cache)

    def test_sealed_input_change_is_not_advanced_as_seen(self):
        R.apply_report(self.root, self.cache, self.report())
        (self.root / self.source).write_text('# Nacre operations\n' + self.current + '\nNew unrelated assertion.\n')
        self.git('add', 'memory'); self.git('commit', '-qm', 'changed unreviewed input')
        with self.assertRaises(ValueError): R.finish(self.root, self.cache)
        self.assertFalse((self.cache / 'state.json').exists())

    def test_worktree_restoration_cannot_mask_poisoned_committed_evidence(self):
        R.apply_report(self.root, self.cache, self.report())
        p = self.root / self.evidence; original = p.read_bytes()
        p.write_text('Assistant: ' + self.quote + '\n')
        self.git('add', 'memory'); self.git('commit', '-qm', 'bad committed provenance')
        p.write_bytes(original)
        self.assertTrue(any('index/commit' in e for e in R.gate(self.root, self.cache, 'HEAD')))
        with self.assertRaises(ValueError): R.finish(self.root, self.cache)

    def test_worktree_restoration_cannot_mask_poisoned_staged_evidence(self):
        R.apply_report(self.root, self.cache, self.report())
        p = self.root / self.evidence; original = p.read_bytes()
        p.write_text('Assistant: ' + self.quote + '\n'); self.git('add', 'memory')
        p.write_bytes(original)
        self.assertTrue(any('index/commit' in e for e in R.gate(self.root, self.cache)))

    def test_unreadable_md_is_reported_and_retained_not_silently_seen(self):
        bad = 'memory/projects/legacy.md'
        (self.root / bad).write_bytes(b'\xff\xfe legacy')
        warnings = []
        hits = R.locate(self.root, ['Nacre'], warnings=warnings)
        self.assertTrue(hits)
        self.assertEqual(warnings[0]['path'], bad)
        batch = R.prepare(self.root, self.cache, self.base, refresh=True)
        self.assertEqual(batch['unreadable'][0]['path'], bad)
        reviews = [{'source_id': u['id'], 'source_sha256': u['sha256'],
                    'disposition': 'historical', 'reason': 'No new verified claim'} for u in batch['inputs']]
        R.apply_report(self.root, self.cache, {'reviews': reviews, 'changes': []})
        self.assertGreater(R.finish(self.root, self.cache)['pending'], 0)
        self.assertIn(bad, R.read_json(self.cache / 'state.json', {})['pending_paths'])

    def test_canonical_conclusion_cannot_be_raw_log(self):
        plan = self.report()
        plan['changes'][0]['record']['current_rule_page'] = self.evidence
        plan['changes'][0]['current_quote'] = self.quote
        with self.assertRaisesRegex(ValueError, 'canonical wiki'):
            R.apply_report(self.root, self.cache, plan)

    def test_daily_lane_is_not_blocked_by_unrelated_wiki_audit(self):
        b = R.prepare(self.root, self.cache, self.base, refresh=True, lane='daily')
        self.assertTrue(b['inputs'])
        self.assertTrue(all(u['path'] == self.evidence for u in b['inputs']))
        self.assertTrue(b['scoped'])
        self.assertNotIn(self.source, [u['path'] for u in b['inputs']])

    def test_scoped_completion_preserves_other_pending_paths_and_base(self):
        other = 'memory/concepts/unresolved-policy.md'
        R.write_json(self.cache / 'state.json', {'seen': {}, 'base': self.base, 'pending_paths': [other]})
        b = R.prepare(self.root, self.cache, self.base, refresh=True, lane='daily')
        plan = {'reviews': [{'source_id':u['id'], 'source_sha256':u['sha256'],
                            'disposition':'historical', 'reason':'event only'} for u in b['inputs']], 'changes':[]}
        R.apply_report(self.root,self.cache,plan); R.finish(self.root,self.cache)
        state = R.read_json(self.cache/'state.json',{})
        self.assertIn(other,state['pending_paths']); self.assertEqual(state['base'],self.base)

    def test_defer_reviewed_keeps_unresolved_pending_but_allows_other_work(self):
        plan=self.report();plan['changes']=[]
        for r in plan['reviews']:r.update(disposition='unresolved',reason='primary evidence missing')
        R.apply_report(self.root,self.cache,plan);R.finish(self.root,self.cache)
        batch=R.prepare(self.root,self.cache,defer_reviewed=True)
        self.assertFalse(batch['inputs']);self.assertEqual(len(batch['deferred']),len(self.batch['inputs']))
        self.assertFalse(R.read_json(self.cache/'state.json',{})['seen'])
        (self.root/self.source).write_text('# Nacre operations\nA genuinely changed new input.\n')
        batch=R.prepare(self.root,self.cache,refresh=True,defer_reviewed=True)
        self.assertTrue(any(u['path']==self.source for u in batch['inputs']))

    def test_every_disposition_blocks_staged_and_committed_input_masking(self):
        for disposition in ('no_change', 'historical', 'unresolved', 'new', 'supersedes'):
            with self.subTest(disposition=disposition):
                cache=self.root/('case-'+disposition)
                R.prepare(self.root,cache,self.base)
                plan=self.report()
                if disposition!='supersedes':plan['changes']=[]
                for review in plan['reviews']:
                    if review['source_id'].startswith(self.source+'#'):
                        review['disposition']=disposition
                R.apply_report(self.root,cache,plan)
                p=self.root/self.source; original=p.read_bytes()
                p.write_text('# Nacre operations\nForged conclusion after review.\n')
                self.git('add','memory');p.write_bytes(original)
                self.assertTrue(any('input differs in index/commit' in e for e in R.gate(self.root,cache)))
                self.git('commit','-qm','synthetic poisoned snapshot '+disposition)
                self.assertTrue(any('input differs in index/commit' in e for e in R.gate(self.root,cache,'HEAD')))
                with self.assertRaises(ValueError):R.finish(self.root,cache)
                self.assertFalse((cache/'state.json').exists())
                # Restore the synthetic Git snapshot before testing the next disposition.
                self.git('add','memory');self.git('commit','-qm','restore checked synthetic source')

    def test_ignored_raw_uses_exact_snapshot_without_staging_raw(self):
        (self.root/'.gitignore').write_text('memory/2026-10-21.md\n')
        plan=self.report();plan['changes']=[]
        for r in plan['reviews']:r.update(disposition='historical',reason='raw event only')
        R.apply_report(self.root,self.cache,plan)
        b=R.read_json(self.cache/'active.json',{})
        u=next(x for x in b['inputs'] if x['path']==self.evidence)
        snap=b['input_snapshots'][u['id']]
        self.assertEqual(R.digest(R.read_exact(self.cache/snap['file'])),u['sha256'])
        self.assertEqual(R.gate(self.root,self.cache),[])
        (self.cache/snap['file']).write_text('poisoned raw snapshot')
        self.assertTrue(any('snapshot missing or changed' in e for e in R.gate(self.root,self.cache)))

    def test_tracked_reviewed_input_cannot_disappear_from_index(self):
        self.git('add','memory');self.git('commit','-qm','adopt synthetic inputs')
        self.batch=R.prepare(self.root,self.cache,self.base,refresh=True)
        plan=self.report();plan['changes']=[]
        for r in plan['reviews']:r.update(disposition='no_change',reason='already current')
        R.apply_report(self.root,self.cache,plan)
        self.git('rm','--cached',self.source)
        self.assertTrue(any('input missing from index/commit' in e for e in R.gate(self.root,self.cache)))

    def test_checked_commit_rejects_no_change_masking_before_git_commit(self):
        scripts=self.root/'scripts';scripts.mkdir()
        for name in ('librarian-reconcile.py','librarian-corrections.py'):
            shutil.copyfile(Path(__file__).parents[1]/name,scripts/name)
        cache=self.root/R.CACHE
        R.prepare(self.root,cache,self.base)
        plan=self.report();plan['changes']=[]
        for review in plan['reviews']:review.update(disposition='no_change',reason='already current')
        R.apply_report(self.root,cache,plan)
        p=self.root/self.source;original=p.read_bytes()
        p.write_text('# Nacre operations\nPoisoned staged no-change input.\n')
        self.git('add','memory');p.write_bytes(original)
        before=self.git('rev-parse','HEAD')
        result=subprocess.run(['python3',str(scripts/'librarian-corrections.py'),'commit','-m','must not commit'],
                              cwd=self.root,text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('reviewed input differs in index/commit',result.stdout)
        self.assertEqual(self.git('rev-parse','HEAD'),before)
        with self.assertRaises(ValueError):R.finish(self.root,cache)


if __name__ == '__main__': unittest.main()
