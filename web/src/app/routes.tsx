import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth.tsx';
import { AppShell } from './AppShell.tsx';
import { LoginPage } from '../pages/LoginPage.tsx';
import { PartitionsPage } from '../pages/PartitionsPage.tsx';
import { PartitionLayout } from '../pages/PartitionLayout.tsx';
import { PartitionOverviewPage } from '../pages/PartitionOverviewPage.tsx';
import { PersonsPage } from '../pages/PersonsPage.tsx';
import { PersonDetailPage } from '../pages/PersonDetailPage.tsx';
import { MemoriesPage } from '../pages/MemoriesPage.tsx';
import { PartitionGraphPage } from '../pages/PartitionGraphPage.tsx';
import { KeysPage } from '../pages/KeysPage.tsx';
import { UsagePage } from '../pages/UsagePage.tsx';
import { AuditPage } from '../pages/AuditPage.tsx';
import { SettingsPage } from '../pages/SettingsPage.tsx';
import { PrivacyRulesPage } from '../pages/PrivacyRulesPage.tsx';
import { ApiDocsPage } from '../pages/ApiDocsPage.tsx';
import { OrgSettingsPage } from '../pages/OrgSettingsPage.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';

function BootScreen() {
  return (
    <div className="center" style={{ minHeight: '100vh', flexDirection: 'column', gap: 18 }}>
      <div className="brand-mark" style={{ width: 44, height: 44, borderRadius: 13, fontSize: 20 }}>
        M
      </div>
      <div className="hstack gap-10">
        <span className="spinner-lg" />
        <span className="muted small">正在载入 Mnemos 控制台…</span>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <BootScreen />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** v6 路由：组织 → 分区 → 人 → 记忆（旧领域路由一律删除）。 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/partitions" replace />} />
        <Route path="/partitions" element={<PartitionsPage />} />
        <Route path="/partitions/:partitionId" element={<PartitionLayout />}>
          <Route index element={<PartitionOverviewPage />} />
          <Route path="persons" element={<PersonsPage />} />
          <Route path="persons/:personRef" element={<PersonDetailPage />} />
          <Route path="memories" element={<MemoriesPage />} />
          <Route path="graph" element={<PartitionGraphPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="privacy" element={<PrivacyRulesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="docs" element={<ApiDocsPage />} />
        </Route>
        <Route path="/org/privacy" element={<PrivacyRulesPage />} />
        <Route path="/org" element={<OrgSettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export { BrowserRouter };
