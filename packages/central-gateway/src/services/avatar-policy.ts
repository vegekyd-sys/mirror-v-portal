// Shared by the static response and template catalog. New Agent names require
// no whitelist edit. Only content-addressed public artwork gets CORS access.
export const AVATAR_POLICY_VERSION = 'canvas-cors-20261021';
export function isPublicAvatarFile(filename: string): boolean {
  return /(?:^|[\\/])(?:makaron-avatar|agent-[a-z0-9]+(?:-[a-z0-9]+)*-portrait)-[a-f0-9]{12}\.png$/.test(filename);
}

export function nativeAvatarUrl(value: string, portalBaseUrl: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('INVALID_TEMPLATE_AVATAR_URL');
  if (url.origin === new URL(portalBaseUrl).origin && url.pathname.startsWith('/onboard/assets/') && isPublicAvatarFile(url.pathname))
    url.searchParams.set('v', AVATAR_POLICY_VERSION);
  return url.href;
}
