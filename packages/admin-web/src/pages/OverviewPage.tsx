// Overview: quick tenant status census + entry points.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import type { Tenant } from '../lib/types';

export default function OverviewPage() {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ tenants: Tenant[] }>('/v1/tenants')
      .then((r) => setTenants(r.tenants || []))
      .catch((e) => setError(errMsg(e)));
  }, []);

  if (error) return <div className="msg msg-err">加载失败：{error}</div>;
  if (!tenants) return <div className="page-loading">加载中…</div>;

  const count = (statuses: string[]) =>
    tenants.filter((t) => statuses.includes(t.status ?? '')).length;

  const cards = [
    { label: '租户总数', num: tenants.length },
    { label: 'active', num: count(['active']) },
    { label: '开通中 / 失败', num: count(['pending', 'provisioning', 'provisioning_failed']) },
    { label: '停用 / 宽限 / 欠费', num: count(['suspended', 'grace', 'low_credits']) },
    { label: '已销毁', num: count(['destroyed']) },
  ];

  return (
    <>
      <div className="section-title">概览</div>
      <div className="stat-grid">
        {cards.map((c) => (
          <div className="stat-card" key={c.label}>
            <div className="num">{c.num}</div>
            <div className="label">{c.label}</div>
          </div>
        ))}
      </div>
      <div className="hint">
        数据来自 provisioning-service <code>GET /v1/tenants</code>（最多 100 条）。
        前往 <Link to="/tenants">租户管理</Link> 查看完整列表与操作。
      </div>
    </>
  );
}
