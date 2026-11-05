import { NavLink } from 'react-router-dom';
import { APP_NAME, APP_TAGLINE } from '@shared';
import { useAuth } from '@lib/auth.tsx';
import { api } from '@lib/api.ts';
import { useAsync, useMediaQuery } from '@lib/hooks.ts';
import { fmtCompact, fmtPct } from '@lib/format.ts';
import { Icon, IconButton, Progress } from '@ui';
import { toneForStatus } from '@lib/tone.ts';
import { NAV_ENTRIES } from './nav.ts';

export interface SidebarProps {
  open: boolean;
  collapsed: boolean;
  onClose: () => void;
  onToggleCollapse: () => void;
}

export function Sidebar({ open, collapsed, onClose, onToggleCollapse }: SidebarProps) {
  const { org, projects } = useAuth();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const compact = collapsed && !isMobile;

  // 侧栏配额与健康状态：失败时静默降级为占位符，不影响导航。
  const dashboard = useAsync(() => api.dashboard(), []);
  const health = useAsync(() => api.health(), []);

  // 配额按「本月记忆注入 Token」计量，与项目 settings.monthlyQuota 同口径
  const used = dashboard.data?.totals.tokensSaved ?? 0;
  const quota = projects.reduce((sum, project) => sum + (project.settings?.monthlyQuota ?? 0), 0);
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const usageReady = Boolean(dashboard.data) && quota > 0;

  const healthTone = health.error ? 'red' : health.data?.ok ? 'green' : 'slate';
  const healthLabel = health.loading ? '检测中' : health.error ? '服务不可用' : health.data?.ok ? '服务正常' : '状态未知';
  const healthVersion = health.data?.version ? `v${health.data.version}` : undefined;

  const quickProjects = projects.slice(0, 4);
  const navLinkClass = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`;
  const compactStyle = compact ? { justifyContent: 'center', padding: 0 } : undefined;

  return (
    <aside
      className={`sidebar${open ? ' open' : ''}`}
      style={compact ? { width: 'var(--sidebar-w-collapsed)' } : undefined}
      aria-label="主导航"
    >
      <div className="sidebar-brand" style={compact ? { justifyContent: 'center', padding: '4px 0 18px' } : undefined}>
        <div className="brand-mark" aria-hidden="true">M</div>
        {compact ? null : (
          <div className="grow">
            <div className="brand-name">{APP_NAME}</div>
            <div className="brand-sub">{APP_TAGLINE}</div>
          </div>
        )}
        {isMobile ? (
          <IconButton icon="x" label="关闭导航" size="sm" onClick={onClose} />
        ) : compact ? null : (
          <IconButton
            icon="panelLeft"
            label="收起侧边栏"
            size="sm"
            onClick={onToggleCollapse}
            aria-expanded
          />
        )}
      </div>

      <nav className="nav" aria-label="控制台导航">
        {NAV_ENTRIES.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={navLinkClass}
            style={compactStyle}
            title={compact ? item.label : undefined}
          >
            <Icon name={item.icon} size={16} />
            {compact ? null : <span className="truncate">{item.label}</span>}
            {!compact && item.to === '/projects' && projects.length > 0 ? (
              <span className="nav-badge">{projects.length}</span>
            ) : null}
          </NavLink>
        ))}

        {compact ? null : (
          <>
            <div className="nav-section">快速访问</div>
            {quickProjects.length === 0 ? (
              <div className="tiny dim" style={{ padding: '4px 10px' }}>
                暂无项目
              </div>
            ) : (
              quickProjects.map((project) => (
                <NavLink
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className={navLinkClass}
                  title={project.name}
                >
                  <span className={`dot tone-${toneForStatus(project.status)}`} aria-hidden="true" />
                  <span className="truncate">{project.name}</span>
                </NavLink>
              ))
            )}
          </>
        )}
      </nav>

      <div className="sidebar-foot">
        {compact ? (
          <div className="center" title={`${healthLabel}${healthVersion ? ` · ${healthVersion}` : ''}`}>
            <span className={`dot tone-${healthTone}${healthTone === 'green' ? ' dot-pulse' : ''}`} />
          </div>
        ) : (
          <>
            <div className="usage-meter">
              <div className="usage-meter-head">
                <span>月度配额</span>
                <span className="mono">{usageReady ? fmtPct(pct, 1) : '—'}</span>
              </div>
              <Progress value={usageReady ? pct : 0} thin tone={pct > 85 ? 'amber' : 'violet'} />
              <div className="between tiny dim mt-8">
                <span className="truncate">{usageReady ? `已用 ${fmtCompact(used)}` : '等待用量数据'}</span>
                <span className="nowrap">{usageReady ? `上限 ${fmtCompact(quota)}` : '—'}</span>
              </div>
            </div>
            <div className="hstack" style={{ padding: '0 2px' }}>
              <span className="status-dot" title={healthVersion}>
                <span className={`dot tone-${healthTone}${healthTone === 'green' ? ' dot-pulse' : ''}`} />
                {healthLabel}
              </span>
              {healthVersion ? <span className="tiny dim mono ml-auto">{healthVersion}</span> : null}
            </div>
            {org ? <div className="tiny dim truncate" style={{ padding: '0 2px' }} title={org.name}>{org.name}</div> : null}
          </>
        )}
      </div>
    </aside>
  );
}
