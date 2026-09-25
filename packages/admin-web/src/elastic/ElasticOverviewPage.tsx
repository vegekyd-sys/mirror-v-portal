import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtNum } from '../components/badges';
import { useAgentTemplates } from './useAgentTemplates';

interface Summary {
  agents: Array<{ templateId: string; state: string; count: number }>;
  runs: Array<{ status: string; count: number }>;
  customers: { count: number; balance: number };
}

export default function ElasticOverviewPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const { templates } = useAgentTemplates();
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
      <section className="elastic-hero">
        <div className="elastic-hero-copy"><span className="elastic-hero-kicker">Nexus / Mirror V</span><h1>每个 Agent，<br />都有自己的世界。</h1><p>从这里查看 Agent 阵容、独立实例与运行状态。</p><div className="elastic-hero-actions"><Link className="btn-primary" to="/agents">选择 Agent</Link><a href="/onboard">打开扫码入口 <span aria-hidden="true">↗</span></a></div></div>
        <div className="elastic-hero-orbit" aria-hidden="true"><span /></div>
      </section>
      <div className="stat-grid">
        <div className="stat-card"><div className="label">Agent 实例</div><div className="num">{fmtNum(agents)}</div><div className="stat-sub"><Link to="/agents">查看全部实例</Link></div></div>
        <div className="stat-card"><div className="label">完成对话</div><div className="num">{fmtNum(completed)}</div><div className="stat-sub">来自 Elastic 运行记录</div></div>
        <div className="stat-card"><div className="label">失败运行</div><div className="num">{fmtNum(failed)}</div><div className="stat-sub">可在实例详情中排查</div></div>
        <div className="stat-card"><div className="label">客户账户</div><div className="num">{fmtNum(data.customers.count)}</div><div className="stat-sub"><Link to="/customers">查看 Credits</Link></div></div>
      </div>
      <div className="agent-list-head"><div><h2>可用 Agent</h2><p>来自扫码入口的实时目录</p></div><Link to="/agents">查看阵容 <span aria-hidden="true">↗</span></Link></div>
      <div className="overview-agent-grid">{templates?.map((template) => <Link className="overview-agent" key={template.id} to={`/agents?template=${encodeURIComponent(template.id)}`}><span className="overview-agent-symbol">{template.name.slice(0, 1)}</span><span><strong>{template.name}</strong><small>{template.description}</small></span><span className="overview-agent-total">{data.agents.filter((row) => row.templateId === template.id).reduce((sum, row) => sum + row.count, 0)} 个实例</span></Link>)}</div>
      <div className="hint">休眠中的 Agent 会在消息到来时启动。</div>
    </>
  );
}
