import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import type { ProjectSummary } from '@shared';
import { ENVIRONMENTS, PROJECT_STATUSES, REGIONS } from '@shared';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  IconButton,
  LoadingBlock,
  PageHead,
  Skeleton,
} from '@ui';
import { useAsync } from '@lib/hooks.ts';
import { api } from '@lib/api.ts';
import { fmtRelative } from '@lib/format.ts';
import { toneForStatus } from '@lib/tone.ts';
import { ProjectContext, type ProjectContextValue } from '@lib/project-context.tsx';
import { projectInitials, projectTone } from '../components/project/shared.tsx';

interface TabDefinition {
  to: string;
  label: string;
  end?: boolean;
}

const PROJECT_TABS: TabDefinition[] = [
  { to: '.', label: '概览', end: true },
  { to: 'memories', label: '记忆', end: true },
  // 人不加 end：进入人详情 /persons/:ref 时页签仍保持高亮。
  { to: 'persons', label: '人' },
  { to: 'records', label: '项目记录', end: true },
  { to: 'retrospective', label: '复盘总结', end: true },
  { to: 'members', label: '成员', end: true },
  { to: 'graph', label: '图谱', end: true },
  { to: 'agents', label: 'Agent', end: true },
  { to: 'tasks', label: '任务', end: true },
  { to: 'webhooks', label: '事件订阅', end: true },
  { to: 'playground', label: '演练场', end: true },
  { to: 'keys', label: '密钥', end: true },
  { to: 'usage', label: '用量', end: true },
  { to: 'audit', label: '审计', end: true },
  { to: 'settings', label: '设置', end: true },
  { to: 'docs', label: 'API 文档', end: true },
];

function labelOf(options: { value: string; label: string }[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** 项目工作区骨架：统一拉取项目详情，并向所有子页面提供 ProjectContext。 */
export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const id = projectId ?? '';

  const { data, loading, error, refresh } = useAsync(() => api.projects.get(id), [id], Boolean(id));

  const [project, setProjectState] = useState<ProjectSummary | null>(null);

  useEffect(() => {
    if (data && data.id === id) setProjectState(data);
  }, [data, id]);

  const setProject = useCallback((next: ProjectSummary | null) => {
    setProjectState(next);
  }, []);

  // 切换项目时避免短暂展示上一个项目的数据。
  const activeProject = project && project.id === id ? project : null;

  const tabs = activeProject && !activeProject.settings.reportsEnabled
    ? PROJECT_TABS.filter((tab) => tab.to !== 'retrospective')
    : PROJECT_TABS;

  const contextValue = useMemo<ProjectContextValue>(
    () => ({ project: activeProject, loading, error, refresh, setProject }),
    [activeProject, loading, error, refresh, setProject],
  );

  if (!id) {
    return (
      <div className="page">
        <PageHead
          eyebrow="项目"
          title="缺少项目标识"
          desc="当前地址未包含项目 ID，请从项目列表重新进入。"
          actions={
            <Button icon="chevronLeft" onClick={() => navigate('/projects')}>
              返回项目列表
            </Button>
          }
        />
        <Card pad>
          <ErrorState message="项目 ID 缺失，无法加载工作区。" />
        </Card>
      </div>
    );
  }

  if (!activeProject) {
    if (!error) return <LayoutSkeleton />;
    const errorText = error;
    const notFound = errorText.includes('404') || errorText.includes('不存在');
    return (
      <div className="page">
        <PageHead
          eyebrow="项目"
          title={notFound ? '项目不存在' : '无法加载项目'}
          desc={`项目 ${id}：${error ?? '尚未获取到项目数据，请稍后重试。'}`}
          actions={
            <Button icon="chevronLeft" onClick={() => navigate('/projects')}>
              返回项目列表
            </Button>
          }
        />
        <Card pad>
          <ErrorState message={error ?? '项目加载失败，请稍后重试。'} onRetry={() => void refresh()} />
        </Card>
      </div>
    );
  }

  const tone = projectTone(activeProject.name);
  const statusMeta = PROJECT_STATUSES.find((status) => status.value === activeProject.status);
  const envTone =
    activeProject.env === 'production' ? 'green' : activeProject.env === 'staging' ? 'amber' : 'cyan';

  return (
    <ProjectContext.Provider value={contextValue}>
      <div className="page">
        <div className="page-head">
          <div className="hstack gap-12" style={{ alignItems: 'flex-start' }}>
            <span
              className={`project-mark tone-${tone}`}
              style={{ width: 48, height: 48, borderRadius: 14, fontSize: 18 }}
              aria-hidden="true"
            >
              {projectInitials(activeProject.name)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="page-eyebrow">分区工作区 · 项目 / 应用 / 租户</div>
              <h1 className="page-title">{activeProject.name}</h1>
              <div className="hstack gap-8 wrap mt-8">
                <span className="project-slug mono">{activeProject.slug}</span>
                <Badge tone={toneForStatus(activeProject.status)} size="sm" dot>
                  {statusMeta?.label ?? activeProject.status}
                </Badge>
                <span className="pill">
                  <span className={`dot tone-${envTone}`} />
                  {labelOf(ENVIRONMENTS, activeProject.env)}
                </span>
                <span className="pill">{labelOf(REGIONS, activeProject.region)}</span>
                <span className="tiny dim" title={activeProject.updatedAt}>
                  更新于 {fmtRelative(activeProject.updatedAt)}
                </span>
              </div>
            </div>
          </div>
          <div className="page-actions">
            {loading ? (
              <span className="tiny dim hstack gap-6">
                <span className="spinner-lg" style={{ width: 12, height: 12 }} />
                同步中
              </span>
            ) : null}
            <Button icon="play" onClick={() => navigate('playground')}>
              演练场
            </Button>
            <Button variant="primary" icon="key" onClick={() => navigate('keys')}>
              新建密钥
            </Button>
            <IconButton icon="refresh" label="刷新项目" disabled={loading} onClick={() => void refresh()} />
          </div>
        </div>

        <nav className="tabs" aria-label="项目页签">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <Outlet />
      </div>
    </ProjectContext.Provider>
  );
}

function LayoutSkeleton() {
  return (
    <div className="page">
      <div className="page-head">
        <div className="hstack gap-12" style={{ alignItems: 'flex-start' }}>
          <Skeleton w={48} h={48} style={{ borderRadius: 14 }} />
          <div className="vstack gap-8">
            <Skeleton w={120} h={10} />
            <Skeleton w={240} h={24} />
            <Skeleton w={320} h={12} />
          </div>
        </div>
        <div className="hstack gap-10">
          <Skeleton w={88} h={32} style={{ borderRadius: 9 }} />
          <Skeleton w={96} h={32} style={{ borderRadius: 9 }} />
        </div>
      </div>
      <Skeleton h={38} />
      <Card pad>
        <LoadingBlock label="正在加载项目工作区…" />
      </Card>
    </div>
  );
}
