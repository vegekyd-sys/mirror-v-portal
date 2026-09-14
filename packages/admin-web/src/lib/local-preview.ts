// Explicit local-only UI preview. Never enabled in a production build.
export const LOCAL_PREVIEW = import.meta.env.DEV && import.meta.env.VITE_LOCAL_PREVIEW === '1'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname);
export const previewUser = { username: 'local-preview', displayName: '本地结构预览', role: 'admin' };
const tenants = [
  { tenantId:'demo-export', companyName:'示例客户 · 海外贸易', status:'active', planTier:'pro', createdAt:'2026-09-01T00:00:00Z', quotaAgents:2, quotaCreditsMonthly:1000000 },
  { tenantId:'demo-maker', companyName:'示例客户 · 智能制造', status:'active', planTier:'starter', createdAt:'2026-09-05T00:00:00Z', quotaAgents:1, quotaCreditsMonthly:100000 },
  { tenantId:'demo-trial', companyName:'示例客户 · 试用中', status:'pending', planTier:'starter', createdAt:'2026-09-14T00:00:00Z', quotaAgents:1, quotaCreditsMonthly:10000 },
];
const customers=tenants.map((t,i)=>({...t,accountId:`acct_${t.tenantId}`,balance:[860000,75000,10000][i],availableBalance:[860000,75000,10000][i],frozenCredits:0,monthlyAllowance:t.quotaCreditsMonthly,monthlyUsed:[140000,25000,0][i],lifetimeConsumed:[140000,25000,0][i],totalConsumed:[140000,25000,0][i],totalTasks:[28,5,0][i]}));
export function previewResponse(url:string, method='GET'): unknown {
  if(!LOCAL_PREVIEW) throw Error('Local preview is disabled');
  if(!['GET','HEAD'].includes(method.toUpperCase())) throw Error('本地页面结构预览：此操作不会执行，请关闭弹窗继续浏览。');
  const p=url.split('?')[0];
  if(p==='/v1/tenants') return {tenants};
  if(p.startsWith('/v1/tenants/')) return {tenant:tenants.find(t=>p.includes(t.tenantId)) || tenants[0],statusLog:[],sessions:[],messages:[],entries:[],total:0};
  if(p==='/v1/admin/customers') return {customers,stats:{total:3,active:2,totalBalance:945000,totalConsumed:165000,lowBalance:0}};
  if(p.startsWith('/v1/admin/customers/')) {const customer=customers.find(t=>p.endsWith(t.tenantId)) || customers[0];return {...customer,customer,account:customer,auditLog:[],billingEvents:[],dailyConsumption:[],dailyTotals:[],skillBreakdown:{},shadowBreakdown:{}};}
  if(p==='/v1/admin/plans') return {plans:[{planId:'demo-starter',planName:'入门版（示例）',tier:'starter',annualFeeYuan:999,initialCredit:100000,seatsMin:1,seatsMax:1,monthlyAllowance:100000,renewalDiscount:1,renewalPricePer100k:100},{planId:'demo-pro',planName:'专业版（示例）',tier:'pro',annualFeeYuan:3999,initialCredit:1000000,seatsMin:1,seatsMax:5,monthlyAllowance:1000000,renewalDiscount:0.9,renewalPricePer100k:90}]};
  if(p==='/v1/skill-prices') return {prices:[{skillId:'find-buyers',skillName:'寻找买家（示例）',category:'获客',creditPerUnit:100,cost:0.1,billingUnit:'per_item',status:'live',activationStatus:'approved'},{skillId:'buyer-profile',skillName:'买家画像（示例）',category:'获客',creditPerUnit:50,cost:0.05,billingUnit:'per_item',status:'shadow',activationStatus:'pending'}],summary:[]};
  if(p==='/v1/billing/llm-token-pricing') return {pricing:[{provider:'demo-provider',model:'demo-model',inputCacheHitPeak:0.1,inputCacheHitOffpeak:0.1,inputCacheMissPeak:1,inputCacheMissOffpeak:1,outputPeak:2,outputOffpeak:2,currency:'CNY',updatedAt:'2026-09-14T00:00:00Z'}]};
  if(p==='/v1/admin/llm-providers') return {config:null};
  if(p==='/v1/admin/auth/me') return {user:previewUser};
  return {items:[],users:[],keys:[],logs:[],events:[],skills:[],releases:[],presets:[],tasks:[],tenants:[],providers:[],sessions:[],messages:[],total:0,config:null};
}
