// 一次性给所有 112 个 skill 算价并落库。
// 成本模型：
//   token ≈ ¥0.01/1K tokens
//   内部 skill 定价 ≈ cost × 1000（成本回收 + 毛利缓冲），无业务价值加成
//   business skill（dealclaw 14）已用 V1.2 真实成本 + 业务价值底线，本轮不动
//   gateway 5 个 metering 已 live，不动
//
// 每个 skill: [cost_元, price_cr, billing_unit]  (cost=null 表示免费/内部)
const BASE = 'http://localhost:8081';

// 完整映射（非 dealclaw / 非 gateway）
const M = {
  // —— 奥创 aochuang（TikTok 营销服务，客户交付）——
  'aochuang-leads': [0.50, 500, 'per_report'],
  'aochuang-metro': [0.30, 300, 'per_item'],
  'aochuang-review-report': [0.60, 600, 'per_report'],
  'aochuang-standard-solution': [0.30, 300, 'per_item'],

  // —— 星擎 xingqing（CRM/ops，康浩源）——
  'xingqing-account-bootstrapper': [0.30, 300, 'per_use'],
  'xingqing-ai-customer-profile-report': [0.60, 600, 'per_report'],
  'xingqing-dashboard-refresh': [0.30, 300, 'per_use'],
  'xingqing-hot-product-insights': [0.50, 500, 'per_item'],
  'xingqing-lead-ingestion': [0.20, 200, 'per_use'],
  'xingqing-ops-allocation-workload': [0.10, 100, 'per_use'],
  'xingqing-s2-data-analysis': [0.60, 600, 'per_report'],
  'xingqing-sales-trainer': [0.50, 500, 'per_item'],
  'xingqing-sales-visit-scripts': [0.30, 300, 'per_item'],
  'xingqing-service-stage-notification': [0.05, 50, 'per_use'],
  'xingqing-tracking-dashboard': [0.10, 100, 'per_item'],

  // —— 米奥 mio（奥创 CRM API）——
  'mio-customer-visit-analysis': [0.40, 400, 'per_report'],
  'mio-data-selection-api': [0.15, 150, 'per_use'],
  'mio-zoho-minutes-transcript': [0.15, 150, 'per_use'],

  // —— CSM 服务卡 ——
  'csm-mobile-service-progress-card': [0.30, 300, 'per_item'],
  'csm-personnel-intro-card': [0.30, 300, 'per_item'],
  'csm-premium-marketing-poster': [0.50, 500, 'per_item'],

  // —— 创意生产 / 视频 / 内容 ——
  'ai-video-generator': [3.00, 3000, 'per_item'],
  'auto-travel-vlog': [2.00, 2000, 'per_item'],
  'autoflow-pipeline': [2.00, 2000, 'per_item'],
  'content-creation-workflow': [5.00, 5400, 'per_item'],
  'corporate-video-script': [0.80, 800, 'per_item'],
  'creative-production-orchestrator': [0.50, 500, 'per_item'],
  'd12-video-tool-test': [0.50, 500, 'per_item'],
  'expo-industrial-video-bg': [1.50, 1500, 'per_item'],
  'finished-video-brief': [0.30, 300, 'per_item'],
  'fcloud-video-review': [0.80, 800, 'per_report'],
  'montage-script-writer': [0.50, 500, 'per_item'],
  'tron-openmontage-kling-video': [3.00, 3000, 'per_item'],
  'video-review-analysis': [0.80, 800, 'per_report'],
  'viral-absurd-demo-video': [2.00, 2000, 'per_item'],
  'viral-extreme-product-demo': [2.00, 2000, 'per_item'],
  'viral-impossible-test-video': [2.00, 2000, 'per_item'],
  'volcano-voice-clone-workflow': [0.50, 500, 'per_item'],
  'feishu-group-avatar': [0.30, 300, 'per_item'],

  // —— 策划案 / 规划文档 ——
  'b2b-tiktok-half-year-planning': [0.60, 600, 'per_report'],
  'b2b-tiktok-quarter-planning': [0.40, 400, 'per_report'],
  'max-qijian-planning-doc': [0.80, 800, 'per_report'],
  'miao-b2b-exhibition-planning-doc': [0.60, 600, 'per_report'],
  'miao-b2b-tiktok-planning-doc': [0.50, 500, 'per_report'],
  'presales-planning-doc': [0.50, 500, 'per_report'],
  'qiancean-factory': [0.60, 600, 'per_report'],
  'requirement-form-questions': [0.20, 200, 'per_report'],
  'shooting-checklist-builder': [0.30, 300, 'per_item'],
  'shooting-checklist-v2': [0.30, 300, 'per_item'],
  'monthly-service-review-card': [0.30, 300, 'per_item'],
  'service-perception-card-maker': [0.40, 400, 'per_item'],
  'sop-service-perception-card': [0.30, 300, 'per_item'],
  'customer-health-score': [0.60, 600, 'per_report'],

  // —— 搜索 / 分析 ——
  'social-search-apify-first': [0.60, 600, 'per_item'],
  'image-search-apify-first': [0.50, 500, 'per_item'],
  'overseas-buyer-search': [0.50, 500, 'per_item'],
  'overseas-buyer-lead-search': [0.60, 600, 'per_item'],
  'overseas-textile-buyer-search': [0.50, 500, 'per_item'],
  'qcc-company-lookup': [0.40, 400, 'per_use'],
  'lead-customer-profile': [0.50, 500, 'per_report'],
  's2-win-analysis': [0.80, 800, 'per_report'],
  'tiktok-account-report': [0.60, 600, 'per_report'],

  // —— 其他交付物 / 工具 ——
  '11': [0.50, 500, 'per_item'],
  '3d-asset-ar-showcase': [0.80, 800, 'per_item'],
  'account-list-doc': [0.20, 200, 'per_item'],
  'figma-reference-replication': [0.30, 300, 'per_item'],
  'geelark-cloud-phone': [0.50, 500, 'per_use'],
  'html-poster-design': [0.40, 400, 'per_item'],
  'landing-page-enterprise-onboarding': [0.80, 800, 'per_item'],
  'ppt-master-integration': [0.50, 500, 'per_item'],
  'star-engine-create-account': [0.30, 300, 'per_use'],
  'survey-alert': [0.10, 100, 'per_use'],
  'yitu-quanjie': [0.50, 500, 'per_item'],

  // —— 内部基础设施 / 契约 / 教练 / 废弃（免费）——
  'auto-pipeline-skill': [null, 0, 'per_item'],
  'background-worker-contract': [null, 0, 'per_item'],
  'fcloud-api': [null, 0, 'per_item'],
  'feishu-standalone-deliver-link-guidance': [null, 0, 'per_item'],
  'image-production-routing-qc': [null, 0, 'per_item'],
  'lark-cli-permission-issue-troubleshooting': [null, 0, 'per_item'],
  'makaron-app-artifact-semantics': [null, 0, 'per_item'],
  'makaron-app-daily-evidence-collector': [null, 0, 'per_item'],
  'makaron-app-workflow-contract': [null, 0, 'per_item'],
  'makaron-intermediate-continuation': [null, 0, 'per_item'],
  'makaron-remotion-materialize': [null, 0, 'per_item'],
  'material-verification': [null, 0, 'per_item'],
  'proactive-agent': [null, 0, 'per_item'],
  'scene-cli': [null, 0, 'per_item'],
  'skill-creation-coach': [null, 0, 'per_item'],
  'tencentcloud-infra': [null, 0, 'per_item'],
  'ultron-star-products-sales-knowledge': [null, 0, 'per_item'],
  'wechatpay-payment-routing-wrapper': [null, 0, 'per_item'],
  'data-selection': [null, 0, 'per_item'],
  'test.buyer_basic': [null, 0, 'per_item'],
};

// dealclaw 里需要补 cost / 微调的（其余 13 个已 V1.2 对齐，跳过）
const DEALCLAW_PATCH = {
  'dealclaw-buyer-leads-push': [0.30, 300, 'per_item'], // 待拍板：新 skill
  'dealclaw-market-report': null, // 待拍板：重复 ID，建议 disable
};

async function main() {
  const res = await fetch(`${BASE}/v1/skill-prices`);
  const j = await res.json();
  const arr = Array.isArray(j) ? j : (j.prices || []);
  const byId = Object.fromEntries(arr.map(p => [p.skillId, p]));

  const gateway = new Set(['gateway.chat', 'gateway.command', 'gateway.query', 'gateway.action', 'gateway.default']);
  const dealclawDone = new Set([
    'dealclaw-analyze-company','dealclaw-email-bindings','dealclaw-email-founder-direct',
    'dealclaw-email-growth-send','dealclaw-exhibition-invitation','dealclaw-exhibition-leads',
    'dealclaw-find-buyers','dealclaw-knowledge-base','dealclaw-lead-import',
    'dealclaw-market-insight','dealclaw-review','dealclaw-smart-reply',
  ]);

  let updated = 0, skipped = 0, missing = [];
  const report = [];

  const targets = { ...M };
  for (const [sid, v] of Object.entries(DEALCLAW_PATCH)) {
    if (v) targets[sid] = v;
  }

  for (const [sid, [cost, price, unit]] of Object.entries(targets)) {
    const cur = byId[sid];
    if (!cur) { missing.push(sid); continue; }
    if (gateway.has(sid) || dealclawDone.has(sid)) { skipped++; continue; }

    const body = {
      skillName: cur.skillName,
      description: cur.description,
      category: cur.category,
      creditPerUnit: price,
      cost: cost === null ? null : cost,
      billingUnit: unit,
      status: cur.status,
      responsiblePerson: cur.responsiblePerson,
      sortOrder: cur.sortOrder,
      changedBy: 'v-price-all',
    };
    const r = await fetch(`${BASE}/v1/skill-prices/${encodeURIComponent(sid)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ok = r.ok;
    report.push(`${ok ? 'OK ' : 'ERR'} ${sid.padEnd(38)} ${String(cur.creditPerUnit).padStart(5)}→${String(price).padStart(5)} cr  cost=${cost ?? 'null'}`);
    if (ok) updated++; else skipped++;
  }

  console.log(report.join('\n'));
  console.log(`\n=== 更新 ${updated} | 跳过(已对齐/gateway) ${skipped} | 缺失 ${missing.length} ===`);
  if (missing.length) console.log('缺失:', missing.join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
