import { useEffect, type ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../lib/auth';
import Layout from '../components/Layout';
import LoginPage from '../pages/LoginPage';
import CustomerDetailPage from '../pages/CustomerDetailPage';
import PlansPage from '../pages/PlansPage';
import SkillPricesPage from '../pages/SkillPricesPage';
import UsersPage from '../pages/UsersPage';
import ElasticOverviewPage from './ElasticOverviewPage';
import ElasticAgentsPage from './ElasticAgentsPage';
import ElasticAgentDetailPage from './ElasticAgentDetailPage';
import ElasticCustomersPage from './ElasticCustomersPage';
import './elastic.css';

function RequireAuth({ children }: { children: ReactElement }) {
  const { ready, user } = useAuth();
  if (!ready) return <div className="page-loading">加载中…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function ElasticApp() {
  useEffect(() => { document.title = 'Mirror V Portal · 管理后台'; }, []);
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth><Layout elastic /></RequireAuth>}>
            <Route index element={<ElasticOverviewPage />} />
            <Route path="agents" element={<ElasticAgentsPage />} />
            <Route path="agents/:tenantId" element={<ElasticAgentDetailPage />} />
            <Route path="customers" element={<ElasticCustomersPage />} />
            <Route path="customers/:tenantId" element={<CustomerDetailPage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="pricing" element={<SkillPricesPage />} />
            <Route path="users" element={<UsersPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
