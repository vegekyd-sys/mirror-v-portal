"""Behavioral regressions: source authority, stale recurrence, fail-closed commit."""
import copy
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('corrections', Path(__file__).parents[1] / 'librarian-corrections.py')
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)


def rule():
    return {'id': 'export-review', 'decided': '2026-10-10', 'by': 'Owner',
            'summary': 'Exports require review; a previous successful export is not authorization.',
            'current_rule_page': 'memory/concepts/export.md',
            'patterns': ['auto.export is mandatory'], 'allow_patterns': ['keep original', '客户明确'],
            'correction': {'claim_kind': 'policy', 'scope': 'Exports only, not local drafts',
                           'supersedes': ['auto-export without review'],
                           'evidence': [{'kind': 'user_correction', 'original_date': '2026-10-10',
                                         'actor': 'Owner', 'ref': 'message:owner-correction',
                                         'basis': 'Explicitly cancelled auto export'}]}}


class CorrectionTests(unittest.TestCase):
    def test_explicit_source_valid(self):
        self.assertEqual(C.validate_rule(rule()), [])

    def test_newer_derived_copy_not_authority(self):
        for kind in ['brief', 'qc', 'reflection', 'copy']:
            r = rule()
            r['correction']['evidence'][0].update(kind=kind, original_date='2026-10-19')
            self.assertTrue(C.validate_rule(r))

    def test_observed_execution_does_not_change_policy(self):
        r = rule()
        r['correction']['evidence'][0]['kind'] = 'observed_state'
        self.assertTrue(C.validate_rule(r))
        r['correction']['claim_kind'] = 'fact'
        self.assertEqual(C.validate_rule(r), [])

    def test_repeated_bad_statement_is_flagged_not_promoted(self):
        self.assertEqual(len(C.findings('memory/concepts/x.md', 'auto-export is mandatory\n' * 3, [rule()])), 3)

    def test_historical_mark_preserves_old_statement(self):
        self.assertEqual(C.findings('memory/concepts/history.md',
                                   '【已过期、不执行】auto-export is mandatory → see current rule.', [rule()]), [])

    def test_mixed_current_and_obsolete_clause_not_whitelisted(self):
        self.assertTrue(C.findings('x.md', 'keep original；auto-export is mandatory', [rule()]))
        self.assertTrue(C.findings('x.md', 'keep original however auto-export is mandatory', [rule()]))
        self.assertTrue(C.findings('x.md', 'keep original，auto-export is mandatory', [rule()]))
        self.assertTrue(C.findings('x.md', 'keep original但auto-export is mandatory', [rule()]))

    def test_claimed_customer_request_alone_not_authority(self):
        self.assertTrue(C.findings('x.md', '客户明确 auto-export is mandatory', [rule()]))

    def test_regex_does_not_claim_semantic_completeness(self):
        self.assertEqual(C.findings('x.md', 'send all exports without asking', [rule()]), [])

    def test_input_annotation_preserves_source_and_unrelated_work(self):
        source = [{'id': 'old', 'file': 'memory/2026-10-19.md', 'lines': '1-4',
                   'body': 'auto-export is mandatory'},
                  {'id': 'other', 'file': 'memory/2026-10-19.md', 'lines': '5-9',
                   'body': 'Unrelated project is complete.'}]
        before = copy.deepcopy(source)
        rows = C.annotate_inputs(source, [rule()])
        self.assertEqual(rows[0]['review'], 'required')
        self.assertEqual(rows[1]['review'], 'normal')
        self.assertNotIn('body', rows[0])
        self.assertEqual(source, before)

    def test_correction_language_is_a_candidate_not_a_new_rule(self):
        rows = C.annotate_inputs([{'id': 'today', 'file': 'memory/2026-10-19.md',
                                   'body': '这条理解错了，纠正一下。'}], [rule()])
        self.assertTrue(rows[0]['correction_candidate'])
        self.assertEqual(rows[0]['conflict_candidates'], [])


class GitGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.root / 'memory/concepts').mkdir(parents=True)
        self.page = self.root / 'memory/concepts/export.md'
        self.page.write_text('Current: review exports.\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'baseline')
        self.base = self.git('rev-parse', 'HEAD')
        self.checker = self.root / 'checker.py'
        self.checker.write_text('raise SystemExit(0)\n')

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, stderr=subprocess.DEVNULL).decode().strip()

    def test_staged_whole_page_catches_preexisting_bad_claim(self):
        self.page.write_text('auto-export is mandatory\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'old wrong memory')
        self.page.write_text('auto-export is mandatory\nHarmless added detail.\n')
        self.git('add', 'memory')
        self.assertTrue(C.check(self.root, [rule()]))

    def test_raw_history_and_binary_are_not_rewritten_or_decoded(self):
        raw = self.root / 'memory/2026-10-19.md'
        raw.write_text('auto-export is mandatory\n')
        image = self.root / 'memory/example.png'
        image.write_bytes(b'\x89PNG\xff')
        self.git('add', 'memory')
        before = raw.read_bytes()
        self.assertEqual(C.check(self.root, [rule()]), [])
        self.assertEqual(raw.read_bytes(), before)

    def test_known_obsolete_statement_blocks_commit(self):
        self.page.write_text('auto-export is mandatory\n')
        self.git('add', 'memory')
        self.assertEqual(C.checked_commit(self.root, [rule()], 'must fail', self.checker), 1)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.base)

    def test_move_check_failure_blocks_commit(self):
        self.page.write_text('Current: review all exports.\n')
        self.git('add', 'memory')
        self.checker.write_text('raise SystemExit(9)\n')
        self.assertEqual(C.checked_commit(self.root, [rule()], 'must fail', self.checker), 9)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.base)

    def test_passed_checks_commit_and_are_retrospectively_checkable(self):
        self.page.write_text('Current: review all exports.\n')
        self.git('add', 'memory')
        self.assertEqual(C.checked_commit(self.root, [rule()], 'checked', self.checker), 0)
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), self.base)
        self.assertEqual(C.check(self.root, [rule()], 'HEAD'), [])

    def test_changed_index_after_check_blocks_commit(self):
        self.page.write_text('Current: review all exports.\n')
        self.git('add', 'memory')
        self.checker.write_text("from pathlib import Path\nimport subprocess\np=Path('memory/concepts/export.md')\np.write_text('auto-export is mandatory')\nsubprocess.run(['git','add',str(p)],check=True)\n")
        self.assertEqual(C.checked_commit(self.root, [rule()], 'must fail', self.checker), 1)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.base)


if __name__ == '__main__':
    unittest.main()
