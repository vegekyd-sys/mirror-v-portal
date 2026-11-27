import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registrationEvents, registrationScopes } from '../services/feishu-register.js';
import { MIRROR_V_NOT_REQUESTED } from '../services/feishu-scopes.js';

describe('registration scopes', () => {
  it('Mirror V asks for its whole set once; other templates keep the minimum', () => {
    const mirror = registrationScopes('mirror-v-full');
    expect(mirror.tenant).toEqual(expect.arrayContaining(['im:message:send_as_bot', 'contact:user.base:readonly', 'im:message.group_msg', 'docx:document', 'calendar:calendar', 'task:task:write']));
    expect(mirror.user).toEqual(expect.arrayContaining(['offline_access', 'docx:document', 'calendar:calendar', 'task:task:write', 'base:record:create', 'sheets:spreadsheet:write_only']));
    for (const id of ['dealclaw', 'makaron', 'xingqing']) {
      expect(registrationScopes(id)).toEqual({ tenant: ['im:message:send_as_bot', 'contact:user.base:readonly'], user: [] });
      expect(registrationEvents(id)).toEqual(['im.message.receive_v1']);
    }
    expect(registrationEvents('mirror-v-full')).toEqual(expect.arrayContaining(['im.message.receive_v1', 'im.chat.member.bot.added_v1', 'drive.notice.comment_add_v1']));
  });
  it('leaves out only the listed categories, and has no duplicates', () => {
    const all = [...registrationScopes('mirror-v-full').tenant, ...registrationScopes('mirror-v-full').user];
    for (const prefix of Object.keys(MIRROR_V_NOT_REQUESTED)) expect(all.filter((s) => s === prefix || s.startsWith(`${prefix}:`))).toEqual([]);
    for (const list of Object.values(registrationScopes('mirror-v-full'))) expect(new Set(list).size).toBe(list.length);
  });
  it('covers every scope the payload asks the owner for (reading and writing)', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../../../agent-templates/mirror-v-full/payload/scripts/feishu-docs.py'), 'utf8');
    const block = (name: string) => script.match(new RegExp(`${name} = \\{([\\s\\S]*?)\\}`))![1];
    const scopes = [...`${block('REQUIRED_SCOPES')}${block('OPTIONAL_SCOPES')}${block('WRITE_SCOPES')}`.matchAll(/"([a-z_.]+:[a-z_.:]+)"/g)].map((m) => m[1]);
    expect(scopes.length).toBeGreaterThanOrEqual(5);
    expect(registrationScopes('mirror-v-full').user).toEqual(expect.arrayContaining(scopes));
  });
});
