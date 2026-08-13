// 给 skill_prices 回填 service_line（服务线/业务线归属）。
// 服务线值（中文，直接落库，可在管理页编辑）：
//   DealClaw获客 / 奥创 / 星擎 / 米奥 / CSM / 网关 / 创意生产 / 内部
// 规则：前缀优先 + 显式覆盖，剩余付费 skill → 创意生产，免费 infra → 内部。
import pg from 'pg';

// 从启动脚本读 DATABASE_URL（不打印明文）
import { readFileSync } from 'node:fs';
const startup = readFileSync('/usr/local/bin/dealclaw-credits-ledger.sh', 'utf8');
const m = startup.match(/export DATABASE_URL="([^"]+)"/);
if (!m) { console.error('DATABASE_URL not found in startup script'); process.exit(1); }
const DATABASE_URL = m[1];

// 免费内部基础设施（credit=0 的非 dealclaw / 非 gateway）
const INTERNAL = new Set([
  'auto-pipeline-skill',
  'background-worker-contract',
  'fcloud-api',
  'feishu-standalone-deliver-link-guidance',
  'image-production-routing-qc',
  'lark-cli-permission-issue-troubleshooting',
  'makaron-app-artifact-semantics',
  'makaron-app-daily-evidence-collector',
  'makaron-app-workflow-contract',
  'makaron-intermediate-continuation',
  'makaron-remotion-materialize',
  'material-verification',
  'proactive-agent',
  'scene-cli',
  'skill-creation-coach',
  'tencentcloud-infra',
  'ultron-star-products-sales-knowledge',
  'wechatpay-payment-routing-wrapper',
  'data-selection',
  'test.buyer_basic',
]);

// 显式覆盖（无清晰前缀 / 跨前缀归属）
const OVERRIDES = {
  '11': '星擎',                        // 挖需11问 → 星擎 CRM 调研
  'survey-alert': '星擎',
  's2-win-analysis': '星擎',
  'customer-health-score': '星擎',
  'star-engine-create-account': '星擎',
  'tiktok-account-report': '奥创',
  'max-qijian-planning-doc': '奥创',   // 旗舰店策划 → 奥创客户
  'qiancean-factory': 'DealClaw获客',  // 千岸工厂（买家工厂画像）
  'overseas-buyer-search': 'DealClaw获客',
  'overseas-buyer-lead-search': 'DealClaw获客',
  'overseas-textile-buyer-search': 'DealClaw获客',
  'lead-customer-profile': 'DealClaw获客',
  'qcc-company-lookup': 'DealClaw获客',
};

function serviceLine(sid) {
  if (OVERRIDES[sid]) return OVERRIDES[sid];
  if (sid.startsWith('gateway.')) return '网关';
  if (sid.startsWith('dealclaw-')) return 'DealClaw获客';
  if (sid.startsWith('aochuang-')) return '奥创';
  if (sid.startsWith('b2b-tiktok-')) return '奥创';
  if (sid.startsWith('miao-b2b-')) return '奥创';
  if (sid.startsWith('xingqing-')) return '星擎';
  if (sid.startsWith('star-engine-')) return '星擎';
  if (sid.startsWith('mio-')) return '米奥';
  if (sid.startsWith('csm-')) return 'CSM';
  if (INTERNAL.has(sid)) return '内部';
  return '创意生产';
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });

async function main() {
  const { rows } = await pool.query('SELECT skill_id, service_line FROM skill_prices ORDER BY skill_id');
  let updated = 0, same = 0;
  const report = [];
  for (const r of rows) {
    const want = serviceLine(r.skill_id);
    if (r.service_line === want) { same++; continue; }
    await pool.query('UPDATE skill_prices SET service_line = $1, updated_at = NOW() WHERE skill_id = $2', [want, r.skill_id]);
    report.push(`${r.skill_id.padEnd(38)} ${(r.service_line ?? '(null)').padEnd(12)} → ${want}`);
    updated++;
  }
  console.log(report.join('\n'));
  console.log(`\n=== 更新 ${updated} | 已是目标 ${same} | 总计 ${rows.length} ===`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
