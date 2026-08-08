#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(resolve(__dirname, '.env'), 'utf8');
// Read key by splitting lines instead of regex
const key = envContent.split('\n')
  .find(l => l.startsWith('RESEND_API_KEY='))
  .split('=')[1];

const h = {
  Authorization: '***' + key,
  'Content-Type': 'application/json'
};

const email = {
  from: 'Thia <v@mail.dealclaw.io>',
  to: ['cui_turing@163.com'],
  subject: 'Hello from DealClaw',
  html: '<p>Hi there,</p><p>This is a greeting email sent via DealClaw email proxy by Thia.</p><p>Best regards,<br>Thia from Meorient</p>'
};

console.log('From:', email.from);
console.log('To:', email.to[0]);

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST', headers: h, body: JSON.stringify(email)
});
const data = await res.json();
if (data.id) {
  console.log('SENT! ID:', data.id);
} else {
  console.log('Result:', JSON.stringify(data, null, 2));
}
