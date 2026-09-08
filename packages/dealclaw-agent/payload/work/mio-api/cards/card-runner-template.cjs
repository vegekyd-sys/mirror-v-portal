#!/usr/bin/env node
// Generic Feishu/Lark Channel SDK card runner template (DealClaw copy).
// Reused from the shared feishu-channel-cards skill; only the Lark SDK
// resolution was hardened so it works on this host without a manual env var.
// Usage:
//   node card-runner-template.cjs --demo
//   node card-runner-template.cjs --send oc_xxx

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function esc(s) {
  return String(s || '').replace(/</g, '‹').replace(/>/g, '›');
}

function trim(s, n = 1200) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function progressBar(p) {
  if (typeof p !== 'number' || Number.isNaN(p)) return '';
  const n = 12;
  const done = Math.max(0, Math.min(n, Math.round((p / 100) * n)));
  return '▰'.repeat(done) + '<font color="grey">' + '▱'.repeat(n - done) + '</font>' + `  ${p}%`;
}

function button(action) {
  const base = {
    tag: 'button',
    text: {tag: 'plain_text', content: action.text || '按钮'},
    type: action.type || 'default',
    width: 'fill',
  };
  if (action.url) {
    base.behaviors = [{type: 'open_url', default_url: action.url}];
  } else {
    base.behaviors = [{type: 'callback', value: action.callback || {action: action.action || 'unknown'}}];
  }
  return base;
}

function actionBlock(actions = []) {
  if (!actions.length) return [];
  if (actions.length === 1) return [button(actions[0])];
  const cols = actions.slice(0, 2).map(a => ({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [button(a)],
  }));
  return [{tag: 'column_set', flex_mode: 'bisect', background_style: 'default', columns: cols}];
}

function renderCard(dsl) {
  const color = dsl.color || (dsl.failed ? 'red' : dsl.done ? 'green' : 'purple');
  const elements = [];

  if (dsl.subtitle || dsl.summary?.length) {
    const summary = (dsl.summary || []).map(x => `• ${esc(x)}`).join('\n');
    elements.push({
      tag: 'div',
      text: {tag: 'lark_md', text_size: 'large', content: trim(`${dsl.subtitle ? `<font color="grey">${esc(dsl.subtitle)}</font>\n` : ''}${summary}`)},
    });
  }

  if (dsl.status || typeof dsl.progress === 'number') {
    elements.push({tag: 'hr'});
    elements.push({
      tag: 'div',
      text: {tag: 'lark_md', text_size: 'large', content: `**状态：** <font color="${color}">${esc(dsl.status || '处理中')}</font>${typeof dsl.progress === 'number' ? `\n${progressBar(dsl.progress)}` : ''}`},
    });
  }

  for (const section of dsl.sections || []) {
    const lines = (section.lines || []).map(x => `• ${esc(x)}`).join('\n');
    const links = (section.links || []).map(l => `• [${esc(l.text)}](${l.url})`).join('\n');
    elements.push({
      tag: 'div',
      text: {tag: 'lark_md', text_size: section.large ? 'large' : 'normal', content: trim(`**${esc(section.title || '信息')}**\n${[lines, links].filter(Boolean).join('\n')}`)},
    });
  }

  const actions = actionBlock(dsl.actions || []);
  if (actions.length) {
    elements.push({tag: 'hr'});
    elements.push(...actions);
  }

  return {
    schema: '2.0',
    config: {width_mode: 'fill'},
    header: {title: {tag: 'plain_text', content: dsl.title || '任务卡片'}, template: color},
    body: {elements},
  };
}

function resolveLarkSdk() {
  const explicit = process.env.LARK_SDK_PATH || process.env.OPENCLAW_LARK_SDK_PATH;
  const directCandidates = [
    explicit,
    '/home/openclaw/.openclaw/npm/node_modules/@larksuiteoapi/node-sdk/lib/index.js',
    path.join(os.homedir(), '.openclaw/npm/node_modules/@larksuiteoapi/node-sdk/lib/index.js'),
  ].filter(Boolean);

  const projectRoots = [
    '/home/openclaw/.openclaw/npm/projects',
    path.join(os.homedir(), '.openclaw/npm/projects'),
  ];

  const discovered = [];
  for (const root of [...new Set(projectRoots)]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('openclaw-feishu-')) continue;
      const sdkPath = path.join(
        root,
        entry.name,
        'node_modules/@openclaw/feishu/node_modules/@larksuiteoapi/node-sdk/lib/index.js',
      );
      if (fs.existsSync(sdkPath)) {
        discovered.push({ path: sdkPath, mtimeMs: fs.statSync(sdkPath).mtimeMs });
      }
    }
  }
  discovered.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const candidates = [...new Set([...directCandidates, ...discovered.map(x => x.path)])];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const sdk = require(candidate);
      if (typeof sdk.createLarkChannel === 'function' && sdk.LoggerLevel && sdk.Domain) {
        return { sdk, path: candidate };
      }
    } catch {
      // try next installed Feishu SDK copy
    }
  }
  throw new Error('Unable to locate the Feishu Lark SDK. Set LARK_SDK_PATH or OPENCLAW_LARK_SDK_PATH.');
}

function loadOpenClawFeishuAccount() {
  const cfgPath = process.env.OPENCLAW_CONFIG || '/home/openclaw/.openclaw/openclaw.json';
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const feishu = cfg.channels?.feishu || {};
  const account = feishu.accounts?.default || feishu;
  return {feishu, account};
}

async function connect(chatId) {
  const {sdk} = resolveLarkSdk();
  const {createLarkChannel, LoggerLevel, Domain} = sdk;
  const {feishu, account} = loadOpenClawFeishuAccount();
  const domain = (account.domain || feishu.domain || 'feishu') === 'lark' ? Domain.Lark : Domain.Feishu;
  const channel = createLarkChannel({
    appId: account.appId || feishu.appId,
    appSecret: account.appSecret || feishu.appSecret,
    domain,
    loggerLevel: LoggerLevel.warn,
    policy: {requireMention: false, dmMode: 'open'},
  });
  await channel.connect();
  return {channel, chatId};
}

async function disconnect(channel) {
  try {
    await Promise.race([
      channel.disconnect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('disconnect timeout')), 3000)),
    ]);
  } catch (e) {
    console.error('disconnect failed:', e.message);
  }
}

async function withChannel(chatId, fn) {
  const {channel} = await connect(chatId);
  try { return await fn({channel, chatId}); }
  finally { await disconnect(channel); }
}

async function streamCard(channel, chatId, initialDsl, producer) {
  let state = {...initialDsl};
  const make = () => renderCard(state);
  await channel.stream(chatId, {
    card: {
      initial: make(),
      producer: async (ctrl) => {
        const update = (patch = {}) => {
          state = {...state, ...patch};
          ctrl.update(make());
        };
        await producer({update, getState: () => ({...state}), messageId: ctrl.messageId});
      },
    },
  });
}

function finalCard(dsl, patch = {}) {
  return {...dsl, ...patch, done: true, color: patch.color || 'green', progress: patch.progress ?? 100};
}

const demoDsl = {
  title: '任务进度卡 Demo',
  subtitle: '通用 Feishu Channel SDK card',
  status: '处理中',
  color: 'purple',
  progress: 66,
  summary: ['已提交任务', '正在生成产物', '完成后会更新同一张卡片'],
  sections: [
    {title: '产物', lines: ['等待输出'], links: [{text: '打开 Dashboard', url: 'https://example.com'}]},
  ],
  actions: [
    {text: '确认', type: 'primary_filled', callback: {oc: 'ocf1', a: 'demo.accept'}},
    {text: '重试', type: 'default', callback: {oc: 'ocf1', a: 'demo.retry'}},
  ],
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--demo')) {
    console.log(JSON.stringify(renderCard(demoDsl), null, 2));
  } else if (args.includes('--final-demo')) {
    console.log(JSON.stringify(renderCard(finalCard(demoDsl, {status: '已完成', summary: ['同一张卡已完成更新', '不要再用普通文字重复结果']})), null, 2));
  } else if (args.includes('--send')) {
    const chatId = args[args.indexOf('--send') + 1];
    if (!chatId) throw new Error('missing chatId after --send');
    withChannel(chatId, async ({channel, chatId}) => {
      await channel.send(chatId, {card: renderCard(demoDsl)});
      console.log('sent demo card to', chatId);
    }).catch(e => { console.error(e); process.exit(1); });
  } else {
    console.error('Usage: node card-runner-template.cjs --demo | --final-demo | --send <oc_xxx>');
    process.exit(2);
  }
}

module.exports = {renderCard, connect, disconnect, withChannel, streamCard, finalCard};
