import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtNum } from '../components/badges';
import { useAgentTemplates } from './useAgentTemplates';
import AgentGlyph from './AgentGlyph';

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
        <div className="elastic-hero-copy"><h1>每个 Agent，<br />都有自己的世界。</h1><div className="elastic-hero-actions"><Link className="btn-primary" to="/agents">查看 Agent</Link></div></div>
        <div className="elastic-hero-orbit" aria-hidden="true"><span /></div>
      </section>
      <div className="stat-grid">
        <div className="stat-card"><div className="label">Agent 实例</div><div className="num">{fmtNum(agents)}</div></div>
        <div className="stat-card"><div className="label">完成对话</div><div className="num">{fmtNum(completed)}</div></div>
        <div className="stat-card"><div className="label">失败运行</div><div className="num">{fmtNum(failed)}</div></div>
        <div className="stat-card"><div className="label">客户账户</div><div className="num">{fmtNum(data.customers.count)}</div></div>
      </div>
      <div className="agent-list-head"><div><h2>可用 Agent</h2></div></div>
      <div className="overview-agent-grid">{templates?.map((template) => <Link className="overview-agent" key={template.id} to={`/agents?template=${encodeURIComponent(template.id)}`}><span className="overview-agent-symbol"><AgentGlyph templateId={template.id} /></span><span><strong>{template.name}</strong><small>{template.description}</small></span><span className="overview-agent-total">{data.agents.filter((row) => row.templateId === template.id).reduce((sum, row) => sum + row.count, 0)} 个实例</span></Link>)}</div>
    </>
  );
}
