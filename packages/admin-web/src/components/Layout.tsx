import { LOCAL_PREVIEW } from "../lib/local-preview";
// App shell: dark sidebar navigation + light content area (phase 3 redesign).
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { IconLogout, IconNexus } from './icons';
import nexusLogo from '../../../central-gateway/public/onboard/nexus-logo-v2.webp';

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
  { to: '/', icon: '◈', label: '总览', end: true },
  { to: '/agents', icon: '✦', label: 'Agent 阵容' },
  { to: '/customers', icon: '客', label: '客户与 Credits' },
  { to: '/plans', icon: '套', label: '套餐模板' },
  { to: '/pricing', icon: '价', label: 'Skill 定价' },
];

const ELASTIC_SYSTEM: NavItem[] = [
  { to: '/users', icon: '户', label: '管理员' },
];

function SideNav({ items }: { items: NavItem[] }) {
  return (
    <>
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          end={it.end}
          className={({ isActive }) => `side-item ${isActive ? 'active' : ''}`}
        >
          <span className="side-icon">{it.icon}</span>
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
          {elastic ? <img className="elastic-logo" src={nexusLogo} alt="Nexus" /> : <div className="logo-mark"><IconNexus size={22} /></div>}
          {!elastic &&
          <div>
            <div className="brand">Nexus</div>
            <div className="brand-sub">{elastic ? 'Mirror V 门户' : '控制台'}</div>
          </div>}
        </div>
        {elastic && <div className="elastic-side-caption">Mirror V 门户 / 管理工作台</div>}
        <nav className="side-nav">
          <div className="side-section">工作台</div>
          <SideNav items={elastic ? ELASTIC_WORKBENCH : WORKBENCH} />
          <div className="side-section">系统</div>
          <SideNav items={elastic ? ELASTIC_SYSTEM : SYSTEM} />
        </nav>
        <div className="side-foot">
          <div className="side-status">
            <span className="status-dot" />
            <div>
              {LOCAL_PREVIEW ? "本地结构预览 · 示例数据" : "服务运行正常"}
              <div className="sub">{LOCAL_PREVIEW ? "不连接线上 · 操作不执行" : "前端静态托管 · API 实时同步"}</div>
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
        {elastic && <div className="elastic-topbar"><span>管理工作台</span><div><a href="/onboard">打开门户 <span aria-hidden="true">↗</span></a><span className="elastic-topbar-user">{user?.displayName || user?.username || 'Admin'}</span></div></div>}
        <div className="container">
          {LOCAL_PREVIEW && <div className="hint" style={{marginBottom:16}}>本地页面结构预览 · 全部为示例数据与示例价格 · 不连接线上服务</div>}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
