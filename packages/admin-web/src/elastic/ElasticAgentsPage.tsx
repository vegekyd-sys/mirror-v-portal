import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtNum, fmtTime } from '../components/badges';
import { useAgentTemplates } from './useAgentTemplates';

export interface ElasticAgent {
  tenantId: string;
  name: string;
  templateId: string;
  templateVersion: string;
  runtimeProvider: string;
  state: string;
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
  wakeCount: number;
  feishuBound: boolean;
  channels: string[];
  accountId: string | null;
  balance: number | null;
}

export default function ElasticAgentsPage() {
  const [agents, setAgents] = useState<ElasticAgent[] | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get('template') || 'all';
  const setSelected = (id: string) => setSearchParams(id === 'all' ? {} : { template: id });
  const [error, setError] = useState('');
  const { templates, templateError } = useAgentTemplates();
  const load = useCallback(() => {
    api<{ agents: ElasticAgent[] }>('/v1/admin/elastic/agents')
      .then((result) => { setAgents(result.agents); setError(''); })
      .catch((cause) => setError(errMsg(cause)));
  }, []);
  useEffect(() => { load(); }, [load]);
  const visibleAgents = agents?.filter((agent) => selected === 'all' || agent.templateId === selected) ?? [];
  const selectedTemplate = templates?.find((template) => template.id === selected);
  const createHref = selectedTemplate ? `/onboard?template=${encodeURIComponent(selectedTemplate.id)}` : '/onboard';
  return (
    <>
      <div className="page-head">
        <div><div className="section-title">Agent 阵容</div><div className="page-sub">选择一个 Agent，查看它的实例；扫码可创建属于自己的独立实例。</div></div>
        <div className="page-actions"><button className="btn-secondary" onClick={load}>刷新实例</button><a className="btn-primary" href={createHref}>扫码创建</a></div>
      </div>
      {templateError && <div className="msg msg-err">Agent 目录加载失败：{templateError}</div>}
      <div className="agent-roster" role="group" aria-label="选择 Agent">
        <button type="button" className={`agent-choice agent-choice-all ${selected === 'all' ? 'selected' : ''}`} aria-pressed={selected === 'all'} onClick={() => setSelected('all')}>
          <span className="agent-choice-mark">✦</span><span className="agent-choice-name">全部 Agent</span><span className="agent-choice-description">查看平台上的所有独立实例</span><span className="agent-choice-count">{agents?.length ?? '—'} 个实例</span>
        </button>
        {templates?.map((template) => {
          const count = agents?.filter((agent) => agent.templateId === template.id).length ?? 0;
          return <button type="button" key={template.id} className={`agent-choice ${selected === template.id ? 'selected' : ''}`} aria-pressed={selected === template.id} onClick={() => setSelected(template.id)}>
            <span className="agent-choice-mark">{template.name.slice(0, 1)}</span><span className="agent-choice-name">{template.name}</span><span className="agent-choice-description">{template.description}</span><span className="agent-choice-count">{count} 个实例 <span aria-hidden="true">↗</span></span>
          </button>;
        })}
      </div>
      <div className="agent-list-head"><div><h2>{selectedTemplate ? `${selectedTemplate.name} 实例` : '全部实例'}</h2><p>{visibleAgents.length} 个实例</p></div><a href={createHref}>创建新实例 <span aria-hidden="true">↗</span></a></div>
      {error && <div className="msg msg-err">加载失败：{error}</div>}
      {!agents && !error && <div className="page-loading">加载中…</div>}
      {agents && <div className="table-wrap"><table><thead><tr><th>实例</th><th>Agent</th><th>状态</th><th>渠道</th><th>Credits</th><th>最近活动</th></tr></thead><tbody>
        {visibleAgents.map((agent) => <tr key={agent.tenantId}>
          <td><Link to={`/agents/${encodeURIComponent(agent.tenantId)}`}>{agent.name}</Link><div className="mono">{agent.tenantId}</div></td>
          <td>{templates?.find((template) => template.id === agent.templateId)?.name ?? agent.templateId}<div className="mono">{agent.templateVersion}</div></td>
          <td><span className={`agent-state ${agent.state === 'failed' || agent.state === 'error' ? 'is-error' : agent.state === 'sleeping' ? 'is-idle' : 'is-live'}`}><i />{agent.state}</span></td>
          <td>{[...new Set([...(agent.feishuBound ? ['feishu'] : []), ...agent.channels])].join('、') || '未绑定'}</td>
          <td>{agent.accountId ? fmtNum(Number(agent.balance)) : '未开户'}</td>
          <td>{fmtTime(agent.lastActivity)}</td>
        </tr>)}
      </tbody></table>{visibleAgents.length === 0 && <div className="hint">这个 Agent 暂无实例。可以从扫码入口创建第一个。</div>}</div>}
    </>
  );
}
