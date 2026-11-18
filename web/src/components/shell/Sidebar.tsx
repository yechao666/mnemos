import { useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@lib/constants.ts';
import { useAuth } from '@lib/auth.tsx';
import { api } from '@lib/api.ts';
import { useAsync, useMediaQuery } from '@lib/hooks.ts';
import { Icon, IconButton } from '@ui';
import { partitionStatusTone, partitionTone, partitionInitial } from './util.ts';
import { NAV_ENTRIES } from './nav.ts';

export interface SidebarProps {
  open: boolean;
  collapsed: boolean;
  onClose: () => void;
  onToggleCollapse: () => void;
}

export function Sidebar({ open, collapsed, onClose, onToggleCollapse }: SidebarProps) {
  const { org, partitions } = useAuth();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const compact = collapsed && !isMobile;

  // 健康状态失败时静默降级，不影响导航。
  const health = useAsync(() => api.health(), []);

  const healthTone = health.error ? 'red' : health.data?.ok ? 'green' : 'slate';
  const healthLabel = health.loading ? '检测中' : health.error ? '服务不可用' : health.data?.ok ? '服务正常' : '状态未知';

  const [quickFilter, setQuickFilter] = useState('');
  const filteredPartitions = useMemo(() => {
    const keyword = quickFilter.trim().toLowerCase();
    if (!keyword) return partitions.slice(0, 6);
    return partitions.filter(
      (partition) =>
        partition.name.toLowerCase().includes(keyword) || partition.slug.toLowerCase().includes(keyword),
    );
  }, [partitions, quickFilter]);
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
          <IconButton icon="panelLeft" label="收起侧边栏" size="sm" onClick={onToggleCollapse} aria-expanded />
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
            {!compact && item.to === '/partitions' && partitions.length > 0 ? (
              <span className="nav-badge">{partitions.length}</span>
            ) : null}
          </NavLink>
        ))}

        {compact ? null : (
          <>
            <div className="nav-section quick-section">
              <span>快速访问</span>
              {partitions.length > 0 ? <span className="quick-section-count mono">{partitions.length}</span> : null}
            </div>
            {partitions.length > 0 ? (
              <div className="quick-filter">
                <Icon name="search" size={13} />
                <input
                  value={quickFilter}
                  onChange={(event) => setQuickFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setQuickFilter('');
                  }}
                  placeholder="筛选快速访问…"
                  aria-label="筛选快速访问分区"
                />
                {quickFilter ? (
                  <button
                    type="button"
                    className="quick-filter-clear"
                    aria-label="清除快速访问筛选"
                    onClick={() => setQuickFilter('')}
                  >
                    <Icon name="x" size={12} />
                  </button>
                ) : null}
              </div>
            ) : null}
            {filteredPartitions.length === 0 ? (
              <div className="tiny dim" style={{ padding: '6px 10px' }}>
                {partitions.length === 0 ? '暂无分区' : '没有匹配的分区'}
              </div>
            ) : (
              filteredPartitions.map((partition) => (
                <NavLink
                  key={partition.id}
                  to={`/partitions/${partition.id}`}
                  className={navLinkClass}
                  title={`${partition.name} · ${partition.slug}`}
                >
                  <span
                    className={`project-mark tone-${partitionTone(partition.id)}`}
                    style={{ width: 18, height: 18, borderRadius: 6, fontSize: 9, flexShrink: 0 }}
                    aria-hidden="true"
                  >
                    {partitionInitial(partition.name)}
                  </span>
                  <span className="truncate grow">{partition.name}</span>
                  <span className={`dot tone-${partitionStatusTone(partition.status)}`} aria-hidden="true" />
                </NavLink>
              ))
            )}
          </>
        )}
      </nav>

      <div className="sidebar-foot">
        {compact ? (
          <div className="center" title={healthLabel}>
            <span className={`dot tone-${healthTone}${healthTone === 'green' ? ' dot-pulse' : ''}`} />
          </div>
        ) : (
          <>
            <div className="hstack" style={{ padding: '0 2px' }}>
              <span className="status-dot" title={health.data?.version}>
                <span className={`dot tone-${healthTone}${healthTone === 'green' ? ' dot-pulse' : ''}`} />
                {healthLabel}
              </span>
              <span className="tiny dim mono ml-auto">v{health.data?.version ?? APP_VERSION}</span>
            </div>
            {org ? (
              <div className="tiny dim truncate" style={{ padding: '0 2px' }} title={org.name}>
                {org.name} · {org.plan}
              </div>
            ) : null}
            <div className="tiny dim truncate" style={{ padding: '0 2px' }}>
              分区 → 人 → 记忆
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
