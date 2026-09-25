import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtTime } from '../components/badges';
import type { ElasticAgent } from './ElasticAgentsPage';
import { agentChannelLabel, agentStateLabel } from './labels';

interface RunRow { id: string; channel: string; status: string; delivery: string; createdAt: string; completedAt: string | null; error: string | null }

export default function ElasticAgentDetailPage() {
  const { tenantId = '' } = useParams();
  const [agent, setAgent] = useState<ElasticAgent | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ agents: ElasticAgent[] }>('/v1/admin/elastic/agents'),
      api<{ runs: RunRow[] }>(`/v1/admin/elastic/agents/${encodeURIComponent(tenantId)}/runs`),
    ]).then(([agentsResult, runsResult]) => {
      if (!active) return;
      setAgent(agentsResult.agents.find((item) => item.tenantId === tenantId) ?? null);
      setRuns(runsResult.runs);
    }).catch((cause) => { if (active) setError(errMsg(cause)); });
    return () => { active = false; };
  }, [tenantId]);
  if (error) return <div className="msg msg-err">加载失败：{error}</div>;
  if (!agent) return <div className="page-loading">加载中…</div>;
  return <>
    <div className="page-head"><div><Link to="/agents" className="link-back">← 返回 Agent 实例</Link><div className="section-title">{agent.name}</div><div className="page-sub mono">{agent.tenantId}</div></div></div>
    <div className="stat-grid">
      <div className="stat-card"><div className="label">模板</div><div className="num">{agent.templateId}</div><div className="stat-sub">{agent.templateVersion}</div></div>
      <div className="stat-card"><div className="label">运行状态</div><div className="num">{agentStateLabel(agent.state)}</div><div className="stat-sub">{agent.runtimeProvider}</div></div>
      <div className="stat-card"><div className="label">唤醒次数</div><div className="num">{agent.wakeCount}</div><div className="stat-sub">最近活动 {fmtTime(agent.lastActivity)}</div></div>
      <div className="stat-card"><div className="label">渠道</div><div className="num">{agent.feishuBound ? '飞书' : '未绑定飞书'}</div><div className="stat-sub">{agent.channels.map(agentChannelLabel).join('、') || '暂无其他渠道'}</div></div>
    </div>
    {agent.lastError && <div className="msg msg-err">最近错误：{agent.lastError}</div>}
    <div className="section-title">最近运行</div>
    <div className="table-wrap"><table><thead><tr><th>时间</th><th>渠道</th><th>结果</th><th>送达</th><th>错误</th></tr></thead><tbody>
      {runs.map((run) => <tr key={run.id}><td>{fmtTime(run.createdAt)}</td><td>{run.channel}</td><td>{run.status}</td><td>{run.delivery}</td><td>{run.error || '—'}</td></tr>)}
    </tbody></table>{runs.length === 0 && <div className="hint">暂无运行记录。</div>}</div>
  </>;
}
