import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@lib/auth.tsx';
import { fmtRelative } from '@lib/format.ts';
import { EmptyState, Icon, Kbd, useToast, type IconName } from '@ui';
import { NAV_ENTRIES } from './nav.ts';
import { projectStatusLabel } from './util.ts';

interface PaletteCommand {
  id: string;
  label: string;
  meta?: string;
  icon: IconName;
  run: () => void;
}

interface PaletteGroup {
  title: string;
  items: PaletteCommand[];
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { projects, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  const recentProject = [...projects].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )[0];

  const groups: PaletteGroup[] = [
    {
      title: '页面导航',
      items: NAV_ENTRIES.map((entry) => ({
        id: `nav-${entry.to}`,
        label: entry.label,
        meta: entry.to,
        icon: entry.icon,
        run: () => go(entry.to),
      })),
    },
    {
      title: '项目',
      items: projects.map((project) => ({
        id: `project-${project.id}`,
        label: project.name,
        meta: `${project.slug} · ${projectStatusLabel(project.status)}`,
        icon: 'folder',
        run: () => go(`/projects/${project.id}`),
      })),
    },
    {
      title: '快捷操作',
      items: [
        {
          id: 'action-create-project',
          label: '新建项目',
          meta: '前往项目列表',
          icon: 'plus',
          run: () => go('/projects'),
        },
        ...(recentProject
          ? [
              {
                id: 'action-recent-project',
                label: `打开最近项目：${recentProject.name}`,
                meta: fmtRelative(recentProject.updatedAt),
                icon: 'clock' as IconName,
                run: () => go(`/projects/${recentProject.id}`),
              },
            ]
          : []),
        {
          id: 'action-logout',
          label: '退出登录',
          meta: '结束当前会话',
          icon: 'logout',
          run: () => {
            onClose();
            void logout().then(() => {
              toast.success('已退出登录');
              navigate('/login', { replace: true });
            });
          },
        },
      ],
    },
  ];

  const keyword = query.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => ({
      title: group.title,
      items: group.items.filter((item) =>
        keyword ? `${item.label} ${item.meta ?? ''}`.toLowerCase().includes(keyword) : true,
      ),
    }))
    .filter((group) => group.items.length > 0);

  const flatItems = visibleGroups.flatMap((group) => group.items);
  const groupOffsets: number[] = [];
  let offset = 0;
  for (const group of visibleGroups) {
    groupOffsets.push(offset);
    offset += group.items.length;
  }

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (flatItems.length === 0 ? 0 : (current + 1) % flatItems.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (flatItems.length === 0 ? 0 : (current - 1 + flatItems.length) % flatItems.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const command = flatItems[active];
      if (command) {
        onClose();
        command.run();
      }
    }
  };

  return (
    <div
      className="cmdk-wrap"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="cmdk-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="搜索页面、项目或操作…"
            aria-label="命令搜索"
            autoComplete="off"
          />
          <Kbd>esc</Kbd>
        </div>

        <div className="cmdk-list" ref={listRef} role="listbox" aria-label="命令列表">
          {flatItems.length === 0 ? (
            <EmptyState
              compact
              icon="search"
              title="没有匹配的结果"
              description="试试页面名称、项目名称或操作关键词。"
            />
          ) : (
            visibleGroups.map((group, groupIndex) => (
              <div key={group.title}>
                <div className="cmdk-group">{group.title}</div>
                {group.items.map((item, itemIndex) => {
                  const index = (groupOffsets[groupIndex] ?? 0) + itemIndex;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      data-index={index}
                      role="option"
                      aria-selected={index === active}
                      className={`cmdk-item${index === active ? ' active' : ''}`}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => {
                        onClose();
                        item.run();
                      }}
                    >
                      <Icon name={item.icon} size={14} />
                      <span className="truncate">{item.label}</span>
                      {item.meta ? <span className="cmdk-meta truncate">{item.meta}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmdk-foot">
          <span className="hstack gap-4"><Kbd>↑</Kbd><Kbd>↓</Kbd> 选择</span>
          <span className="hstack gap-4"><Kbd>↵</Kbd> 执行</span>
          <span className="hstack gap-4"><Kbd>esc</Kbd> 关闭</span>
          <span className="ml-auto">Mnemos 命令面板</span>
        </div>
      </div>
    </div>
  );
}
