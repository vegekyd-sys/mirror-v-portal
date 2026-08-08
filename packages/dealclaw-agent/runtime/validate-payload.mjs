import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('payload');

// DealClaw agent requires these payload files at minimum.
// Additional files are permitted but not required.
const requiredFiles = [
  'payload-manifest.json',
  'AGENTS.md',
  'work/mio-api/dealclaw_search.py',
];

for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) {
    throw new Error(`Missing required payload file: ${relative}`);
  }
}

const forbiddenNames = ['.env', 'auth-profiles.json', 'credentials.json'];
const forbiddenPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:password|passwd)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /\b(?:api[_-]?key|token|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{24,}['"]/i,
];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const relative = path.relative(root, full);
    if (forbiddenNames.includes(entry.name)) throw new Error(`Forbidden payload file: ${relative}`);
    const content = fs.readFileSync(full, 'utf8');
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(content)) throw new Error(`Possible embedded secret in payload: ${relative}`);
    }
  }
}

walk(root);
console.log(`Payload validated: ${requiredFiles.length} required files, no embedded secret pattern found`);
