// Small display helpers shared by tenant-facing pages.

const STATUS_BADGE: Record<string, string> = {
  active: 'badge-active',
  pending: 'badge-pending',
  provisioning: 'badge-provisioning',
  provisioning_failed: 'badge-failed',
  suspended: 'badge-failed',
  low_credits: 'badge-warn',
  grace: 'badge-warn',
  destroyed: 'badge-dead',
};

export function StatusBadge({ status }: { status?: string | null }) {
  const cls = STATUS_BADGE[status ?? ''] ?? 'badge-dead';
  return <span className={`badge ${cls}`}>{status || 'unknown'}</span>;
}

export function PlanBadge({ plan }: { plan?: string | null }) {
  return <span className={`badge badge-plan-${plan || 'starter'}`}>{plan || '-'}</span>;
}

export function shortId(id?: string | null): string {
  if (!id) return '-';
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function fmtTime(ts?: string | null): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

export function fmtNum(n?: number | null): string {
  return Number(n || 0).toLocaleString();
}
