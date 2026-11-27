import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const BASE = 'https://api.apify.com/v2';
export function hasErrorRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.error || row.errorMessage || ['ERROR','FAILED'].includes(String(row.status).toUpperCase())) return true;
  return Object.values(row).some(v => v && typeof v === 'object' && hasErrorRow(v));
}
// Single credential scope: the default account only. Per-account Apify keys are not used.
export function loadCredential(account = 'default') {
  if (account !== 'default') throw new Error('Unknown Apify account scope');
  const names = ['APIFY_TOKEN', 'APIFY_API_KEY'];
  let values = {};
  try {
    for (const line of readFileSync(resolve(homedir(), '.openclaw/.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && names.includes(m[1])) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  for (const name of names) {
    const value = process.env[name] || values[name];
    if (value) return { name, value };
  }
  throw new Error(`Missing Apify credential for ${account}; use protected credential setup`);
}

export function client(account = 'default') {
  const credential = loadCredential(account);
  return async (path, { method = 'GET', body } = {}) => {
    let response;
    try {
      response = await fetch(`${BASE}/${path}`, {
        method, headers: { Authorization: `Bearer ${credential.value}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
    } catch { throw new Error(`Apify ${method} network failure (response unknown)`); }
    if (!response.ok) {
      // Do not echo API bodies/URLs: they may contain credentials or signed media.
      throw new Error(`Apify ${method} HTTP ${response.status}`);
    }
    try { return await response.json(); }
    catch { throw new Error('Apify returned invalid JSON'); }
  };
}

export async function runActor(actor, input, { account = 'default', timeout = 240,
  maxCharge = 0.5, statePath = resolve('work/apify-runs', randomUUID()+'.json'), pollMs = 3000 } = {}) {
  if (!/^[\w.-]+~[\w.-]+$/.test(actor)) throw new Error('Use username~actor-name');
  if (!(timeout > 0 && maxCharge > 0)) throw new Error('Positive timeout and cost cap required');
  const api = client(account);
  const requestKey = createHash('sha256').update(JSON.stringify({actor,input,account})).digest('hex');
  let state;
  const save = () => {
    if (statePath) {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    }
  };
  if (statePath && existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.requestKey !== requestKey) throw new Error('State belongs to another request; use a new state path');
    if (!state.runId) throw new Error('Prior submit outcome unknown; reconcile Apify runs before resubmission');
  } else {
    state = { actor, account, requestKey, status: 'SUBMITTING' }; save();
    const r = (await api(`acts/${actor}/runs?timeout=${timeout}&maxTotalChargeUsd=${maxCharge}`, {method:'POST',body:input})).data;
    if (!r?.id) throw new Error('Submit returned no run ID; reconcile before retry');
    Object.assign(state, {runId:r.id,datasetId:r.defaultDatasetId,status:r.status}); save();
  }
  const deadline = Date.now() + timeout * 1000;
  while (true) {
    const r = (await api(`actor-runs/${state.runId}`)).data;
    if (!r?.status) throw new Error(`Missing run status; resume ${state.runId}`);
    Object.assign(state, {status:r.status,datasetId:r.defaultDatasetId,costUsd:r.usageTotalUsd}); save();
    if (r.status === 'SUCCEEDED') break;
    if (['FAILED','ABORTED','TIMED-OUT'].includes(r.status)) throw new Error(`Run ${state.runId} ${r.status}`);
    if (Date.now() >= deadline) throw new Error(`Run ${state.runId} pending; resume same state, do not resubmit`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  if (!state.datasetId) throw new Error('Successful run has no dataset');
  const items = await api(`datasets/${state.datasetId}/items?clean=true&format=json`);
  if (!Array.isArray(items)) throw new Error('Dataset is not an array');
  if (items.some(hasErrorRow)) throw new Error(`Run ${state.runId} has error rows; do not report as success`);
  return { items, evidence: state };
}
