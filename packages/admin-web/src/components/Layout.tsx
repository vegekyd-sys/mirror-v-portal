// App shell: top header with navigation. Pages marked 待迁移 still live in
// the legacy admin-dashboard and will move here in later iterations.
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
          <span className="nav-disabled" title="仍在旧后台，后续迁移">
            运行时配置（待迁移）
          </span>
          <span className="nav-disabled" title="仍在旧后台，后续迁移">
            Skill 管理（待迁移）
          </span>
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
