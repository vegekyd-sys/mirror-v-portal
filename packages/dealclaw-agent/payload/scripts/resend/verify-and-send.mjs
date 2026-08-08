import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envContent = readFileSync(resolve(__dirname, '.env'), 'utf8');
const key = envContent.split('\n').find(l => l.startsWith('RESEND_API_KEY='***'=')[1];
const h = { Authorization: '***' + key, 'Content-Type': 'application/json' };
const domId = 'c03b028a-b954-485e-a642-6a4769b0835f';

// Step 1: Trigger Resend verification
console.log('Verifying domain...');
const verifyRes = await fetch('https://api.resend.com/domains/' + domId + '/verify', { method: 'POST', headers: h });
const vData = await verifyRes.json();
console.log('Verify:', vData.status || JSON.stringify(vData));

// Step 2: Check domain status
const checkRes = await fetch('https://api.resend.com/domains/' + domId, { headers: h });
const checkData = await checkRes.json();
console.log('Status:', checkData.status);
console.log('');

// Step 3: Send email
if (checkData.status === 'verified') {
  const email = {
    from: 'Thia <thia@mail.dealclaw.io>',
    to: ['tiangengjun@meorient.com'],
    subject: 'Hello from DealClaw!',
    html: '<p>Hi!</p><p>Greetings from DealClaw - our email proxy system is now live.</p><p>This is a test email sent via <b>thia@mail.dealclaw.io</b>.</p><p>Best regards,<br>Thia</p>'
  };
  console.log('Sending to tiangengjun@meorient.com...');
  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: h, body: JSON.stringify(email)
  });
  const sendData = await sendRes.json();
  if (sendData.id) {
    console.log('SENT! ID:', sendData.id);
  } else {
    console.log('Send result:', JSON.stringify(sendData));
  }
} else {
  console.log('Domain not verified yet, status:', checkData.status);
}
