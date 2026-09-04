export function toE164(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("+")) return trimmed;
  return `+${trimmed.replace(/[^\d]/g, "")}`;
}

export function windowExpiresFromNow(hours = 24): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export function isWindowOpen(expiresAt: Date | null | undefined, now = new Date()): boolean {
  return Boolean(expiresAt && expiresAt.getTime() > now.getTime());
}
