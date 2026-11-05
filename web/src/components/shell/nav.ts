import type { Project } from '@shared';
import type { IconName } from '@ui';

export interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

export const NAV_ENTRIES: NavEntry[] = [
  { to: '/', label: '概览', icon: 'dashboard', end: true },
  { to: '/projects', label: '项目', icon: 'folder', end: true },
  { to: '/team', label: '组织成员', icon: 'users' },
  { to: '/ops', label: '运维', icon: 'activity' },
  { to: '/org', label: '组织设置', icon: 'settings' },
];

export const PROJECT_TAB_LABELS: Record<string, string> = {
  '': '概览',
  memories: '记忆',
  graph: '图谱',
  agents: 'Agent',
  tasks: '任务',
  webhooks: '事件订阅',
  playground: '演练场',
  keys: '密钥',
  usage: '用量',
  audit: '审计',
  settings: '设置',
  docs: 'API 文档',
};

export interface Crumb {
  label: string;
  to?: string;
}

/** 由路径推导面包屑：概览 / 项目 / 项目名 / 页签。 */
export function breadcrumbs(pathname: string, projects: Project[]): Crumb[] {
  if (pathname === '/' || pathname === '') return [{ label: '概览' }];

  if (pathname === '/projects' || pathname.startsWith('/projects/')) {
    const parts = pathname.split('/').filter(Boolean);
    const projectId = parts[1];
    if (!projectId) return [{ label: '项目' }];
    const project = projects.find((item) => item.id === projectId);
    const crumbs: Crumb[] = [
      { label: '项目', to: '/projects' },
      { label: project?.name ?? '项目详情', to: `/projects/${projectId}` },
    ];
    const tab = parts[2];
    if (tab) crumbs.push({ label: PROJECT_TAB_LABELS[tab] ?? tab });
    return crumbs;
  }

  if (pathname.startsWith('/team')) return [{ label: '组织成员' }];
  if (pathname.startsWith('/ops')) return [{ label: '系统运维' }];
  if (pathname.startsWith('/org')) return [{ label: '组织设置' }];
  if (pathname.startsWith('/login')) return [{ label: '登录' }];
  return [{ label: '页面不存在' }];
}

export function routeTitle(pathname: string, projects: Project[]): string {
  const crumbs = breadcrumbs(pathname, projects);
  const last = crumbs[crumbs.length - 1];
  if (!last) return '控制台';
  // 项目页签使用「项目名 · 页签」，其余页面直接用当前面包屑。
  if (crumbs.length >= 2 && /^\/projects\/[^/]+\/[^/]+/.test(pathname)) {
    return `${crumbs[crumbs.length - 2]?.label ?? ''} · ${last.label}`;
  }
  return last.label;
}
