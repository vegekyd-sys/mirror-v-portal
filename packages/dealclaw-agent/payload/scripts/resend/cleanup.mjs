import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(resolve(__dirname, '.env'), 'utf8');
const key = envContent.split('\n').find(l => l.startsWith('RESEND_API_KEY=')).split('=')[1];
const h = { Authorization: '***' + key };

// Delete mail.meorient.com and send.meorient.com
const toDelete = [
  '7374a208-93ba-45b2-9aee-f564a2c64cc6',
  'e1db1ba4-eb28-44b7-b28b-e9416c01d47c'
];

for (const id of toDelete) {
  const res = await fetch('https://api.resend.com/domains/' + id, { method: 'DELETE', headers: h });
  const d = await res.json();
  console.log('Deleted:', id.slice(0,8) + '...', d.status || d.message || 'ok');
}

// Verify
const final = await (await fetch('https://api.resend.com/domains', { headers: h })).json();
console.log('\nRemaining:', final.data.length);
final.data.forEach(x => console.log('  -', x.name, x.id, x.status));
