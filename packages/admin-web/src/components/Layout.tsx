import { LOCAL_PREVIEW } from "../lib/local-preview";
// App shell shared by the legacy console and the Mirror V portal.
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { IconLogout, IconNexus } from './icons';
import PortalWordmark from '../elastic/PortalWordmark';

interface NavItem {
  to: string;
  icon: string;
  label: string;
  end?: boolean;
}

const WORKBENCH: NavItem[] = [
  { to: '/', icon: '概', label: '概览', end: true },
  { to: '/customers', icon: '客', label: '客户与 Credits' },
  { to: '/agents', icon: 'A', label: 'Agents 管理' },
  { to: '/catalog', icon: '录', label: '模型目录' },
  { to: '/llm-token-pricing', icon: '价', label: 'LLM Token 定价' },
  { to: '/chat', icon: '聊', label: '对话' },
  { to: '/pricing', icon: '价', label: 'Skill 定价' },
  { to: '/plans', icon: '套', label: '套餐模板' },
  { to: '/skills', icon: '技', label: 'Skill 管理' },
];

const SYSTEM: NavItem[] = [
  { to: '/nexus-manager', icon: 'N', label: 'Nexus Manager' },
  { to: '/image-releases', icon: '镜', label: '镜像版本' },
  { to: '/rollout-tasks', icon: '发', label: '发布进度' },
  { to: '/runtime-configs', icon: '配', label: '运行时配置' },
  { to: '/audit-logs', icon: '审', label: '审计日志' },
  { to: '/users', icon: '户', label: '用户管理' },
  { to: '/external-api-keys', icon: '钥', label: '外部 API Key' },
  { to: '/chat-api-keys', icon: '匙', label: '对话 API Key' },
  { to: '/llm-push-tasks', icon: '任', label: '异步任务' },
];

const ELASTIC_WORKBENCH: NavItem[] = [
  { to: '/', icon: 'overview', label: '总览', end: true },
  { to: '/agents', icon: 'agents', label: 'Agent' },
  { to: '/customers', icon: 'customers', label: '客户' },
  { to: '/plans', icon: 'plans', label: '套餐' },
  { to: '/pricing', icon: 'pricing', label: '定价' },
];

const ELASTIC_SYSTEM: NavItem[] = [
  { to: '/users', icon: 'users', label: '管理员' },
];

function ElasticNavIcon({ name }: { name: string }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'overview' && <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>}
    {name === 'agents' && <><circle cx="12" cy="12" r="3" /><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-35 12 12)" /><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(35 12 12)" /></>}
    {name === 'customers' && <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2" /></>}
    {name === 'plans' && <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /></>}
    {name === 'pricing' && <><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="11" cy="17" r="2" fill="currentColor" stroke="none" /></>}
    {name === 'users' && <><circle cx="12" cy="8" r="3.5" /><path d="M5 20v-2a7 7 0 0 1 14 0v2" /></>}
  </svg>;
}

function SideNav({ items, elastic = false }: { items: NavItem[]; elastic?: boolean }) {
  return (
    <>
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          className={({ isActive }) => `side-item ${isActive ? 'active' : ''}`}
        >
          <span className="side-icon">{elastic ? <ElasticNavIcon name={it.icon} /> : it.icon}</span>
          <span className="nav-label">{it.label}</span>
        </NavLink>
      ))}
    </>
  );
}

export default function Layout({ elastic = false }: { elastic?: boolean }) {
  const { user, logout } = useAuth();

  return (
    <div className={`app-shell ${elastic ? 'elastic-shell' : ''}`}>
      <aside className="sidebar">
        <div className="side-logo">
          {elastic ? <PortalWordmark /> : <div className="logo-mark"><IconNexus size={22} /></div>}
          {!elastic &&
          <div>
            <div className="brand">Mirror V Portal</div>
            <div className="brand-sub">控制台</div>
          </div>}
        </div>
        {elastic && <div className="elastic-side-caption">Agent 工作台</div>}
        <nav className="side-nav">
          {!elastic && <div className="side-section">工作台</div>}
          <SideNav items={elastic ? ELASTIC_WORKBENCH : WORKBENCH} elastic={elastic} />
          {elastic ? <div className="elastic-nav-divider" /> : <div className="side-section">系统</div>}
          <SideNav items={elastic ? ELASTIC_SYSTEM : SYSTEM} elastic={elastic} />
        </nav>
        <div className="side-foot">
          <div className="side-status">
            <span className="status-dot" />
            <div>
              {LOCAL_PREVIEW ? "本地预览" : "服务正常"}
              {!elastic && <div className="sub">{LOCAL_PREVIEW ? "不连接线上 · 操作不执行" : "前端静态托管 · API 实时同步"}</div>}
            </div>
          </div>
          <div className="side-user">
            <span className="user">{user?.displayName || user?.username || 'Admin'}</span>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                logout();
              }}
            >
              退出登录 <IconLogout size={12} />
            </a>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="container">
          {elastic && <div className="elastic-utility"><span>{LOCAL_PREVIEW ? '本地预览' : 'Mirror V Portal'}</span><a href="/onboard">进入门户 <IconLogout size={14} /></a></div>}
          {LOCAL_PREVIEW && !elastic && <div className="hint" style={{marginBottom:16}}>本地页面结构预览 · 全部为示例数据与示例价格 · 不连接线上服务</div>}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
