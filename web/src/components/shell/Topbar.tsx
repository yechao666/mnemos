import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ROLE_LABEL, toneForRole } from '@lib/tone.ts';
import { useAuth } from '@lib/auth.tsx';
import { useMediaQuery } from '@lib/hooks.ts';
import { Avatar, Dropdown, Icon, IconButton, Kbd, useToast } from '@ui';
import { breadcrumbs } from './nav.ts';
import { partitionInitial, partitionStatusTone, partitionTone } from './util.ts';
import { ChangePasswordModal } from './ChangePasswordModal.tsx';

export interface TopbarProps {
  onOpenMenu: () => void;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
}

export function Topbar({ onOpenMenu, onToggleSidebar, onOpenPalette }: TopbarProps) {
  const { partitions } = useAuth();
  const location = useLocation();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const isNarrow = useMediaQuery('(max-width: 720px)');
  const crumbs = breadcrumbs(location.pathname, partitions);
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
        <span>搜索页面、分区…</span>
        <Kbd>⌘K</Kbd>
      </button>

      <PartitionSwitcher key={`switcher-${location.pathname}`} compact={isNarrow} />
      <UserMenu key={`user-${location.pathname}`} />
    </header>
  );
}

function PartitionSwitcher({ compact = false }: { compact?: boolean }) {
  const { partitions } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const match = /^\/partitions\/([^/]+)/.exec(location.pathname);
  const currentId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  const current = currentId
    ? partitions.find((partition) => partition.id === currentId || partition.slug === currentId)
    : undefined;

  return (
    <Dropdown
      align="right"
      width={compact ? 244 : 288}
      trigger={
        <button type="button" className="ps-trigger" aria-label="切换分区">
          <span className={`ps-avatar tone-${current ? partitionTone(current.id) : 'slate'}`}>
            {current ? partitionInitial(current.name) : <Icon name="layers" size={11} />}
          </span>
          {compact ? null : (
            <span className="truncate" style={{ maxWidth: 120 }}>{current?.name ?? '全部分区'}</span>
          )}
          <Icon name="chevronDown" size={13} />
        </button>
      }
    >
      {(close) => (
        <>
          <div className="popover-label">分区</div>
          <button
            type="button"
            className={`popover-item${current ? '' : ' active'}`}
            onClick={() => {
              close();
              navigate('/partitions');
            }}
          >
            <Icon name="layers" size={14} />
            <span className="grow">全部分区</span>
          </button>
          {partitions.length === 0 ? (
            <div className="tiny dim" style={{ padding: '6px 10px 8px' }}>还没有分区，先创建一个。</div>
          ) : (
            partitions.slice(0, 10).map((partition) => (
              <button
                type="button"
                key={partition.id}
                className={`popover-item${current?.id === partition.id ? ' active' : ''}`}
                onClick={() => {
                  close();
                  navigate(`/partitions/${partition.id}`);
                }}
              >
                <span className={`dot tone-${partitionStatusTone(partition.status)}`} aria-hidden="true" />
                <span className="truncate grow">{partition.name}</span>
                <span className="tiny dim nowrap mono">{partition.slug}</span>
              </button>
            ))
          )}
          {partitions.length > 10 ? (
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                close();
                navigate('/partitions');
              }}
            >
              <Icon name="arrowRight" size={14} />
              查看全部 {partitions.length} 个分区
            </button>
          ) : null}
          <div className="popover-sep" />
          <button
            type="button"
            className="popover-item"
            onClick={() => {
              close();
              navigate('/partitions');
            }}
          >
            <Icon name="plus" size={14} />
            新建分区
          </button>
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
        width={232}
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
