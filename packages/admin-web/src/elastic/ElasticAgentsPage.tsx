import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtNum, fmtTime } from '../components/badges';

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
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ agents: ElasticAgent[] }>('/v1/admin/elastic/agents')
      .then((result) => { setAgents(result.agents); setError(''); })
      .catch((cause) => setError(errMsg(cause)));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <div className="page-head">
        <div><div className="section-title">Agent 实例</div><div className="page-sub">每次扫码创建独立实例，模板与渠道绑定保存在实例上。</div></div>
        <div className="page-actions"><button className="btn-secondary" onClick={load}>刷新</button><a className="btn-primary" href="/onboard">扫码创建</a></div>
      </div>
      {error && <div className="msg msg-err">加载失败：{error}</div>}
      {!agents && !error && <div className="page-loading">加载中…</div>}
      {agents && <div className="table-wrap"><table><thead><tr><th>实例</th><th>模板</th><th>状态</th><th>渠道</th><th>Credits</th><th>最近活动</th></tr></thead><tbody>
        {agents.map((agent) => <tr key={agent.tenantId}>
          <td><Link to={`/agents/${encodeURIComponent(agent.tenantId)}`}>{agent.name}</Link><div className="mono">{agent.tenantId}</div></td>
          <td>{agent.templateId}<div className="mono">{agent.templateVersion}</div></td>
          <td>{agent.state}</td>
          <td>{[...(agent.feishuBound ? ['feishu'] : []), ...agent.channels].join('、') || '未绑定'}</td>
          <td>{agent.accountId ? fmtNum(Number(agent.balance)) : '未开户'}</td>
          <td>{fmtTime(agent.lastActivity)}</td>
        </tr>)}
      </tbody></table>{agents.length === 0 && <div className="hint">暂无 Agent 实例。</div>}</div>}
    </>
  );
}
