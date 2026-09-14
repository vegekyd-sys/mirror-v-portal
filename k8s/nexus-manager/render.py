"""Render validated non-secret deployment parameters; never applies to a cluster."""
import os
import re
from pathlib import Path

keys = ['NAS_VSWITCH_ID', 'NEXUS_MANAGER_IMAGE', 'ADMIN_HOST', 'NEXUS_UI_HOST',
        'MODEL_BASE_URL', 'MODEL_ID', 'PROVISIONING_NAMESPACE']
values = {}
for key in keys:
    value = os.environ.get(key, '')
    if not value or not re.fullmatch(r'[a-zA-Z0-9._:/@+-]+', value):
        raise SystemExit(f'{key}: missing or invalid non-secret value')
    values[key] = value
if values['ADMIN_HOST'] == values['NEXUS_UI_HOST']:
    raise SystemExit('UI must use a separate hostname')
if not values['MODEL_BASE_URL'].startswith('https://'):
    raise SystemExit('MODEL_BASE_URL must use HTTPS')
text = Path(__file__).with_name('resources.yaml').read_text()
print(re.sub('|'.join(keys), lambda match: values[match.group()], text), end='')
