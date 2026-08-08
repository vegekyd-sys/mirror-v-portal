from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PHP = ROOT / 'php'


def test_php_files_exist():
    for name in ['common.php','ZohoCrmClient.php','MioCdpClient.php','crm.php','selection.php']:
        assert (PHP / name).exists()


def test_crm_php_agent_contract_keywords():
    s = (PHP / 'crm.php').read_text()
    for token in ['commands', 'schema', 'dry-run', 'mock', 'agent-friendly-crm-php-cli', 'orders.summary', 'Deals.Sales_Man']:
        assert token in s


def test_selection_php_agent_contract_keywords():
    s = (PHP / 'selection.php').read_text()
    for token in ['commands', 'schema', 'dry-run', 'mock', 'agent-friendly-selection-php-cli', 'search', 'industries']:
        assert token in s


def test_common_json_envelope_contract():
    s = (PHP / 'common.php').read_text()
    for token in ['count', 'data', 'error', 'json_encode', 'JSON_UNESCAPED_UNICODE']:
        assert token in s


def test_zoho_php_has_token_cache_and_lock():
    s = (PHP / 'ZohoCrmClient.php').read_text()
    for token in ['ZOHO_CRM_TOKEN_CACHE', 'flock', 'refresh_token', 'coqlAll', 'moduleFields']:
        assert token in s
