// App shell: top header with navigation. All pages live in this SPA since
// phase 3 retired the legacy admin-dashboard.
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <>
      <header className="header">
        <h1>🏢 DealClaw Admin</h1>
        <nav>
          <NavLink to="/" end>
            概览
          </NavLink>
          <NavLink to="/tenants">租户管理</NavLink>
          <NavLink to="/customers">客户与 Credits</NavLink>
          <NavLink to="/plans">套餐模板</NavLink>
          <NavLink to="/pricing">Skill 定价</NavLink>
          <NavLink to="/skills">Skill 管理</NavLink>
          <NavLink to="/runtime-configs">运行时配置</NavLink>
          <NavLink to="/users">用户管理</NavLink>
        </nav>
        <div className="header-right">
          <span className="user">{user?.displayName || user?.username || 'Admin'}</span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              logout();
            }}
          >
            退出
          </a>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
