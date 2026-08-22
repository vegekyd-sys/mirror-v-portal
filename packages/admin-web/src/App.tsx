import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import TenantsPage from './pages/TenantsPage';

// Router basename mirrors vite `base` (phase 2: /admin2, phase 3: '').
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function RequireAuth({ children }: { children: ReactElement }) {
  const { ready, user } = useAuth();
  if (!ready) return <div className="page-loading">加载中…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter basename={BASE}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<OverviewPage />} />
            <Route path="tenants" element={<TenantsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
