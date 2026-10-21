/** Called by the trusted Portal host after channel registration is confirmed. */
export async function ensureMakaronAccount({ tenant, store, endpoint, secret, fetchImpl = fetch }) {
  if (tenant.template_id !== 'makaron') return { skipped: true };
  const status = await store.tenantSecretStatus(tenant.id);
  if (status.names.includes('MAKARON_API_KEY')) return { bound: true, reused: true };
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/api/agent/provision' || url.search || url.hash || !secret || secret.length < 32)
    throw Error('MAKARON_PROVISIONING_NOT_CONFIGURED');
  const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ installationId: tenant.id }) });
  if (!response.ok) throw Error(`MAKARON_PROVISIONING_HTTP_${response.status}`);
  const body = await response.json();
  if (body.installationId !== tenant.id.toLowerCase() || !/^[0-9a-f-]{36}$/.test(body.userId || '') || !/^mk_live_[0-9a-f]{64}$/.test(body.apiKey || ''))
    throw Error('MAKARON_PROVISIONING_INVALID_RESPONSE');
  await store.bindMakaronCredential(tenant.id, body.apiKey);
  await store.event(tenant.id, 'makaron-account-bound', { userId: body.userId });
  return { bound: true, reused: body.reused === true, userId: body.userId };
}
