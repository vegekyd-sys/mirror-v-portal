import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CRM = ROOT / 'crm'
SEL = ROOT / 'selection'

def run(cmd, env=None):
    e=os.environ.copy(); e.update(env or {}); e['PYTHONPATH']=str(ROOT)
    return subprocess.run(cmd,cwd=ROOT,env=e,text=True,capture_output=True,timeout=30)

def parse(proc):
    assert proc.stdout.strip(), proc.stderr
    return json.loads(proc.stdout)

def assert_envelope(j):
    assert set(['count','data','error']).issubset(j.keys())


def test_crm_commands_discovery():
    p=run([str(CRM),'commands']); assert p.returncode==0
    j=parse(p); assert_envelope(j)
    assert 'orders.list' in j['data']; assert 'accounts.search' in j['data']


def test_crm_schema_discovery():
    p=run([str(CRM),'schema']); j=parse(p); assert j['error'] is None
    assert j['data']['fields']['orders']['sales']=='Deals.Sales_Man'


def test_crm_module_schema():
    p=run([str(CRM),'contacts','schema']); j=parse(p)
    assert j['data']['fields']['module']=='Contacts'


def test_crm_dry_run_no_credentials():
    p=run([str(CRM),'orders','list','--zone','宠物展区','--project','2026印尼','--stage','赢单','--dry-run'])
    assert p.returncode==0
    j=parse(p); assert_envelope(j)
    assert j['meta']['mode']=='dry-run'
    assert j['data']['module']=='Sales_Orders'
    assert 'project filter is applied locally' in ' '.join(j['data']['notes'])


def test_crm_mock_no_credentials():
    p=run([str(CRM),'orders','list','--mock'])
    j=parse(p); assert j['meta']['mode']=='mock'; assert j['count'] >= 1
    assert j['data'][0]['销售人员']=='杨盛麟'


def test_crm_error_json_missing_arg():
    p=run([str(CRM),'accounts','search'])
    assert p.returncode==1
    j=parse(p); assert j['error']['code']=='MISSING_ARG'


def test_selection_commands_schema():
    p=run([str(SEL),'schema']); j=parse(p)
    assert 'search' in j['data']['commands']; assert '宠物' in j['data']['industries']


def test_selection_dry_run_and_mock():
    p=run([str(SEL),'search','--industry','宠物','--country','印尼','--dry-run']); j=parse(p)
    assert j['meta']['mode']=='dry-run'
    p=run([str(SEL),'search','--industry','宠物','--country','印尼','--mock']); j=parse(p)
    assert j['meta']['mode']=='mock'; assert j['data'][0]['industry']=='宠物'


def test_selection_missing_token_json_error():
    p=run([str(SEL),'company','--id','xxx'], env={'MIO_CDP_APP_SECRET':'','SELECTION_API_TOKEN':''})
    j=parse(p); assert p.returncode==1; assert j['error']['code']=='MISSING_ENV'


def test_qc_cases_count_55():
    text=(ROOT/'tests'/'qc_cases.yaml').read_text()
    assert text.count('\n- id: ')==55
