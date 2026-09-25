import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtNum, fmtTime } from '../components/badges';

interface Customer { tenantId: string; companyName: string | null; planTier: string; balance: number; lifetimeConsumed: number; status: string; createdAt: string }

export default function ElasticCustomersPage() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ customers: Customer[] }>('/v1/admin/customers')
      .then((result) => { if (active) setCustomers(result.customers); })
      .catch((cause) => { if (active) setError(errMsg(cause)); });
    return () => { active = false; };
  }, []);
  return <>
    <div className="page-head"><div><div className="section-title">客户与 Credits</div><div className="page-sub">账户和交易使用原 credits-ledger；新建 Agent 请从扫码入口进入。</div></div></div>
    {error && <div className="msg msg-err">加载失败：{error}</div>}
    {!customers && !error && <div className="page-loading">加载中…</div>}
    {customers && <div className="table-wrap"><table><thead><tr><th>客户</th><th>套餐</th><th>余额</th><th>累计消耗</th><th>状态</th><th>创建时间</th></tr></thead><tbody>
      {customers.map((customer) => <tr key={customer.tenantId}>
        <td><Link to={`/customers/${encodeURIComponent(customer.tenantId)}`}>{customer.companyName || customer.tenantId}</Link><div className="mono">{customer.tenantId}</div></td>
        <td>{customer.planTier}</td><td>{fmtNum(customer.balance)}</td><td>{fmtNum(customer.lifetimeConsumed)}</td><td>{customer.status}</td><td>{fmtTime(customer.createdAt)}</td>
      </tr>)}
    </tbody></table>{customers.length === 0 && <div className="hint">暂无客户账户。</div>}</div>}
  </>;
}
