import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ROLE_LABEL, toneForEventType, toneForRole, toneForStatus } from '@lib/tone.ts';
import { fmtRelative } from '@lib/format.ts';
import { useAuth } from '@lib/auth.tsx';
import { useMediaQuery } from '@lib/hooks.ts';
import { Avatar, Badge, Dropdown, Icon, IconButton, Kbd, useToast } from '@ui';
import { breadcrumbs } from './nav.ts';
import { projectInitial, projectTone, projectStatusLabel } from './util.ts';
import { liveEventLabel, useLiveEvents } from './useLiveEvents.ts';
import { ChangePasswordModal } from './ChangePasswordModal.tsx';

export interface TopbarProps {
  onOpenMenu: () => void;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
}

export function Topbar({ onOpenMenu, onToggleSidebar, onOpenPalette }: TopbarProps) {
  const { projects } = useAuth();
  const location = useLocation();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const isNarrow = useMediaQuery('(max-width: 720px)');
  const crumbs = breadcrumbs(location.pathname, projects);
  const visibleCrumbs = isNarrow ? crumbs.slice(-1) : crumbs;

  return (
    <header className="topbar">
      {isMobile ? <IconButton icon="menu" label="打开导航" onClick={onOpenMenu} /> : (
        <IconButton icon="panelLeft" label="切换侧边栏" onClick={onToggleSidebar} />
      )}

      <nav className="crumbs grow" aria-label="面包屑">
        {visibleCrumbs.map((crumb, index) => (
          <span className="crumb" key={`${crumb.label}-${index}`}>
            {index > 0 ? <span className="crumb-sep" aria-hidden="true">/</span> : null}
            {crumb.to && index < visibleCrumbs.length - 1 ? (
              <Link to={crumb.to} className="truncate" title={crumb.label}>{crumb.label}</Link>
            ) : (
              <span className="truncate" style={{ color: 'var(--text-soft)' }} aria-current="page">{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>

      <button type="button" className="search-trigger" onClick={onOpenPalette} aria-label="打开命令面板">
        <Icon name="search" size={14} />
        <span>搜索页面、项目…</span>
        <Kbd>⌘K</Kbd>
      </button>

      <ProjectSwitcher key={`switcher-${location.pathname}`} compact={isNarrow} />
      <LiveEventsMenu key="live-events" compact={isNarrow} />
      <UserMenu key={`user-${location.pathname}`} />
    </header>
  );
}

function ProjectSwitcher({ compact = false }: { compact?: boolean }) {
  const { projects } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const match = /^\/projects\/([^/]+)/.exec(location.pathname);
  const current = match ? projects.find((project) => project.id === match[1]) : undefined;

  return (
    <Dropdown
      align="right"
      width={compact ? 244 : 276}
      trigger={
        <button type="button" className="ps-trigger" aria-label="切换项目">
          <span className={`ps-avatar tone-${current ? projectTone(current.id) : 'slate'}`}>
            {current ? projectInitial(current.name) : <Icon name="layers" size={11} />}
          </span>
          {compact ? null : (
            <span className="truncate" style={{ maxWidth: 112 }}>{current?.name ?? '全部项目'}</span>
          )}
          <Icon name="chevronDown" size={13} />
        </button>
      }
    >
      {(close) => (
        <>
          <div className="popover-label">项目</div>
          <button
            type="button"
            className={`popover-item${current ? '' : ' active'}`}
            onClick={() => {
              close();
              navigate('/projects');
            }}
          >
            <Icon name="layers" size={14} />
            <span className="grow">全部项目</span>
          </button>
          {projects.length === 0 ? (
            <div className="tiny dim" style={{ padding: '6px 10px 8px' }}>还没有项目，先创建一个。</div>
          ) : (
            projects.slice(0, 8).map((project) => (
              <button
                type="button"
                key={project.id}
                className={`popover-item${current?.id === project.id ? ' active' : ''}`}
                onClick={() => {
                  close();
                  navigate(`/projects/${project.id}`);
                }}
              >
                <span className={`dot tone-${toneForStatus(project.status)}`} aria-hidden="true" />
                <span className="truncate grow">{project.name}</span>
                <span className="tiny dim nowrap">{projectStatusLabel(project.status)}</span>
              </button>
            ))
          )}
          {projects.length > 8 ? (
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                close();
                navigate('/projects');
              }}
            >
              <Icon name="arrowRight" size={14} />
              查看全部 {projects.length} 个项目
            </button>
          ) : null}
          <div className="popover-sep" />
          <button
            type="button"
            className="popover-item"
            onClick={() => {
              close();
              navigate('/projects');
            }}
          >
            <Icon name="plus" size={14} />
            新建项目
          </button>
        </>
      )}
    </Dropdown>
  );
}

function LiveEventsMenu({ compact = false }: { compact?: boolean }) {
  const location = useLocation();
  const events = useLiveEvents();
  const recent = events.slice(0, 5);

  return (
    <Dropdown
      key={`live-${location.pathname}`}
      align="right"
      width={compact ? 284 : 340}
      trigger={
        <button type="button" className="ps-trigger" aria-label="实时事件">
          <span className={`dot tone-${recent.length > 0 ? 'green' : 'slate'}${recent.length > 0 ? ' dot-pulse' : ''}`} />
          {compact ? null : <span className="nowrap">实时</span>}
        </button>
      }
    >
      {() => (
        <>
          <div className="between" style={{ padding: '4px 10px 6px' }}>
            <span className="popover-label" style={{ padding: 0 }}>实时事件</span>
            <span className="tiny dim">{recent.length > 0 ? `最近 ${recent.length} 条` : '等待中'}</span>
          </div>
          {recent.length === 0 ? (
            <div className="tiny dim" style={{ padding: '8px 10px 10px', lineHeight: 1.6 }}>
              暂无实时事件。新的记忆写入、检索或密钥操作会在这里出现。
            </div>
          ) : (
            recent.map((event) => (
              <div key={event.id} className="vstack" style={{ gap: 3, padding: '8px 10px' }}>
                <div className="hstack gap-6">
                  <Badge tone={toneForEventType(event.type)} size="sm">{liveEventLabel(event.type)}</Badge>
                  <span className="tiny dim truncate">{event.actor}</span>
                  <span className="tiny dim ml-auto nowrap" title={event.at}>{fmtRelative(event.at)}</span>
                </div>
                <div className="small truncate" style={{ color: 'var(--text-soft)' }} title={event.summary}>
                  {event.summary}
                </div>
                {event.projectName ? <div className="tiny dim truncate">{event.projectName}</div> : null}
              </div>
            ))
          )}
        </>
      )}
    </Dropdown>
  );
}

function UserMenu() {
  const { user, org, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [passwordOpen, setPasswordOpen] = useState(false);

  const handleLogout = useCallback(async () => {
    await logout();
    toast.success('已退出登录');
    navigate('/login', { replace: true });
  }, [logout, navigate, toast]);

  if (!user) return null;

  return (
    <>
      <Dropdown
        align="right"
        width={228}
        trigger={
          <button type="button" className="user-chip" aria-label="用户菜单">
            <Avatar name={user.name} tone={toneForRole(user.role)} size="sm" />
            <span className="user-meta">
              <span className="user-name truncate">{user.name}</span>
              <span className="user-role">{ROLE_LABEL[user.role]}</span>
            </span>
            <Icon name="chevronDown" size={13} />
          </button>
        }
      >
        {(close) => (
          <>
            <div className="popover-label">{org?.name ?? '组织'}</div>
            <div className="tiny dim truncate" style={{ padding: '0 10px 8px' }}>{user.email}</div>
            <div className="popover-sep" />
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                close();
                navigate('/org');
              }}
            >
              <Icon name="settings" size={14} />
              组织设置
            </button>
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                close();
                setPasswordOpen(true);
              }}
            >
              <Icon name="lock" size={14} />
              修改密码
            </button>
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                close();
                void handleLogout();
              }}
            >
              <Icon name="logout" size={14} />
              退出登录
            </button>
          </>
        )}
      </Dropdown>

      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}
