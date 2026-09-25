import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtNum } from '../components/badges';

interface Summary {
  agents: Array<{ templateId: string; state: string; count: number }>;
  runs: Array<{ status: string; count: number }>;
  customers: { count: number; balance: number };
}

export default function ElasticOverviewPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Summary>('/v1/admin/elastic/summary')
      .then((result) => { if (active) setData(result); })
      .catch((cause) => { if (active) setError(errMsg(cause)); });
    return () => { active = false; };
  }, []);
  if (error) return <div className="msg msg-err">加载失败：{error}</div>;
  if (!data) return <div className="page-loading">加载中…</div>;

  const agents = data.agents.reduce((sum, row) => sum + row.count, 0);
  const completed = data.runs.find((row) => row.status === 'succeeded')?.count ?? 0;
  const failed = data.runs.find((row) => row.status === 'failed')?.count ?? 0;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">Mirror V 门户</div>
          <div className="page-sub">扫码创建独立 Agent，按模板运行并管理客户账户。</div>
        </div>
        <a className="btn-primary" href="/onboard">打开扫码入口</a>
      </div>
      <div className="stat-grid">
        <div className="stat-card"><div className="label">Agent 实例</div><div className="num">{fmtNum(agents)}</div><div className="stat-sub"><Link to="/agents">查看实例 →</Link></div></div>
        <div className="stat-card"><div className="label">完成对话</div><div className="num">{fmtNum(completed)}</div><div className="stat-sub">来自 Elastic 运行记录</div></div>
        <div className="stat-card"><div className="label">失败运行</div><div className="num">{fmtNum(failed)}</div><div className="stat-sub">可在实例详情中排查</div></div>
        <div className="stat-card"><div className="label">客户账户</div><div className="num">{fmtNum(data.customers.count)}</div><div className="stat-sub"><Link to="/customers">查看 Credits →</Link></div></div>
      </div>
      <div className="section-title">模板与状态</div>
      <div className="hint">{data.agents.map((row) => `${row.templateId} · ${row.state} ${row.count}`).join('　　') || '暂无实例'}</div>
      <div className="hint">休眠中的 Agent 会在消息到来时启动，属于正常状态。</div>
    </>
  );
}
