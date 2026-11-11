import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registrationScopes } from '../services/feishu-register.js';

describe('registration scopes', () => {
  it('asks for document-reading user scopes only where the agent reads documents', () => {
    expect(registrationScopes('mirror-v-full').user).toContain('docx:document:readonly');
    for (const id of ['dealclaw', 'makaron', 'xingqing']) expect(registrationScopes(id).user).toEqual([]);
    expect(registrationScopes('makaron').tenant).toEqual(['im:message:send_as_bot', 'contact:user.base:readonly']);
  });
  it('covers every scope the payload checks before reading', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../../../agent-templates/mirror-v-full/payload/scripts/feishu-docs.py'), 'utf8');
    const block = (name: string) => script.match(new RegExp(`${name} = \\{([\\s\\S]*?)\\}`))![1];
    const scopes = [...`${block('REQUIRED_SCOPES')}${block('OPTIONAL_SCOPES')}`.matchAll(/"([a-z_.]+:[a-z_.:]+)"/g)].map((m) => m[1]);
    expect(scopes.length).toBeGreaterThanOrEqual(5);
    expect(registrationScopes('mirror-v-full').user.sort()).toEqual(scopes.sort());
  });
});
