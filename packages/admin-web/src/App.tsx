import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import CustomersPage from './pages/CustomersPage';
import CustomerDetailPage from './pages/CustomerDetailPage';
import AgentsPage from './pages/AgentsPage';
import AgentDetailPage from './pages/AgentDetailPage';
import PlansPage from './pages/PlansPage';
import SkillPricesPage from './pages/SkillPricesPage';
import SkillsPage from './pages/SkillsPage';
import RuntimeConfigsPage from './pages/RuntimeConfigsPage';
import LlmProvidersPage from './pages/LlmProvidersPage';
import LlmTokenPricingPage from './pages/LlmTokenPricingPage';
import LlmPushTasksPage from './pages/LlmPushTasksPage';
import UsersPage from './pages/UsersPage';
import ExternalApiKeysPage from './pages/ExternalApiKeysPage';
import ChatApiKeysPage from './pages/ChatApiKeysPage';
import ImageReleasesPage from './pages/ImageReleasesPage';
import AuditLogsPage from './pages/AuditLogsPage';
import ChatPage from './pages/ChatPage';

// Router basename mirrors vite `base` (phase 3: '/' → empty basename).
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
            <Route path="tenants" element={<Navigate to="/customers" replace />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="customers/:tenantId" element={<CustomerDetailPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="agents/:tenantId" element={<AgentDetailPage />} />
            <Route path="llm-providers" element={<LlmProvidersPage />} />
            <Route path="llm-token-pricing" element={<LlmTokenPricingPage />} />
            <Route path="llm-push-tasks" element={<LlmPushTasksPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="pricing" element={<SkillPricesPage />} />
            <Route path="skills" element={<SkillsPage />} />
            <Route path="image-releases" element={<ImageReleasesPage />} />
            <Route path="audit-logs" element={<AuditLogsPage />} />
            <Route path="runtime-configs" element={<RuntimeConfigsPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="external-api-keys" element={<ExternalApiKeysPage />} />
            <Route path="chat-api-keys" element={<ChatApiKeysPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
