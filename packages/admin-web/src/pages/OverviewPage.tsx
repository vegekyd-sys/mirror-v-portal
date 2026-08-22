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
    { chip: '租', tone: '', label: '租户总数', num: tenants.length, sub: 'provisioning-service' },
    { chip: '活', tone: 'green', label: '正常服务（active）', num: count(['active']), sub: '可正常调用 Skill' },
    {
      chip: '开',
      tone: 'blue',
      label: '开通中 / 失败',
      num: count(['pending', 'provisioning', 'provisioning_failed']),
      sub: 'pending · provisioning · failed',
    },
    {
      chip: '停',
      tone: 'orange',
      label: '停用 / 宽限 / 欠费',
      num: count(['suspended', 'grace', 'low_credits']),
      sub: '需关注续费与健康度',
    },
    { chip: '销', tone: '', label: '已销毁', num: count(['destroyed']), sub: '资源已回收' },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">概览</div>
          <div className="page-sub">租户开通状态总览，客户用量详见「客户与 Credits」</div>
        </div>
      </div>
      <div className="stat-grid">
        {cards.map((c) => (
          <div className="stat-card" key={c.label}>
            <span className={`stat-icon ${c.tone}`}>{c.chip}</span>
            <div className="label">{c.label}</div>
            <div className="num">{c.num}</div>
            <div className="stat-sub">{c.sub}</div>
          </div>
        ))}
      </div>
      <div className="hint">
        数据来自 provisioning-service <code>GET /v1/tenants</code>（最多 100 条）。
        前往 <Link to="/customers">客户与 Credits</Link> 查看完整列表与操作。
      </div>
    </>
  );
}
