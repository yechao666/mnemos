import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth.tsx';
import { AppShell } from './AppShell.tsx';
import { LoginPage } from '../pages/LoginPage.tsx';
import { DashboardPage } from '../pages/DashboardPage.tsx';
import { ProjectsPage } from '../pages/ProjectsPage.tsx';
import { TeamPage } from '../pages/TeamPage.tsx';
import { OrgSettingsPage } from '../pages/OrgSettingsPage.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
import { OpsPage } from '../pages/OpsPage.tsx';
import { ProjectLayout } from '../pages/ProjectLayout.tsx';
import { ProjectOverviewPage } from '../pages/project/ProjectOverviewPage.tsx';
import { MemoriesPage } from '../pages/project/MemoriesPage.tsx';
import { RecordsPage } from '../pages/project/RecordsPage.tsx';
import { ProjectMembersPage } from '../pages/project/ProjectMembersPage.tsx';
import { RetrospectivePage } from '../pages/project/RetrospectivePage.tsx';
import { GraphPage } from '../pages/project/GraphPage.tsx';
import { AgentsPage } from '../pages/project/AgentsPage.tsx';
import { TasksPage } from '../pages/project/TasksPage.tsx';
import { WebhooksPage } from '../pages/project/WebhooksPage.tsx';
import { PlaygroundPage } from '../pages/project/PlaygroundPage.tsx';
import { KeysPage } from '../pages/project/KeysPage.tsx';
import { UsagePage } from '../pages/project/UsagePage.tsx';
import { AuditPage } from '../pages/project/AuditPage.tsx';
import { SettingsPage } from '../pages/project/SettingsPage.tsx';
import { ApiDocsPage } from '../pages/project/ApiDocsPage.tsx';

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
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<ProjectOverviewPage />} />
          <Route path="memories" element={<MemoriesPage />} />
          <Route path="records" element={<RecordsPage />} />
          <Route path="members" element={<ProjectMembersPage />} />
          <Route path="retrospective" element={<RetrospectivePage />} />
          <Route path="graph" element={<GraphPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="webhooks" element={<WebhooksPage />} />
          <Route path="playground" element={<PlaygroundPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="docs" element={<ApiDocsPage />} />
        </Route>
        <Route path="/team" element={<TeamPage />} />
        <Route path="/ops" element={<OpsPage />} />
        <Route path="/org" element={<OrgSettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export { BrowserRouter };
