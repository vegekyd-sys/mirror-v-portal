import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(resolve(__dirname, '.env'), 'utf8');
const key = envContent.split('\n').find(l => l.startsWith('RESEND_API_KEY='***'=')[1];
const h = { Authorization: '***' + key };

const res = await fetch('https://api.resend.com/domains/c03b028a-b954-485e-a642-6a4769b0835f', { headers: h });
const full = await res.json();

console.log('Domain:', full.name, full.status);
console.log('');

for (let i = 0; i < (full.records||[]).length; i++) {
  const r = full.records[i];
  const fn = r.name.includes('.') ? r.name : r.name + '.dealclaw.io';
  console.log((i+1) + '. Type: ' + r.type + '  Name: ' + fn);
  if (r.priority !== undefined) console.log('   Priority: ' + r.priority);
  console.log('   Value: ' + r.value);
  console.log('');
}
