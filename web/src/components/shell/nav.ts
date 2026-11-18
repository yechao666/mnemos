import type { Partition } from '@lib/types.ts';
import type { IconName } from '@ui';
import { PARTITION_TABS } from '@lib/constants.ts';

export interface NavEntry {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

/** v6 信息架构：组织 → 分区 → 人 → 记忆。 */
export const NAV_ENTRIES: NavEntry[] = [
  { to: '/partitions', label: '分区', icon: 'layers' },
  { to: '/org/privacy', label: '隐私规则', icon: 'shield', end: true },
  { to: '/org', label: '组织设置', icon: 'settings', end: true },
];

const TAB_LABELS: Record<string, string> = Object.fromEntries(
  PARTITION_TABS.filter((tab) => tab.to !== '.').map((tab) => [tab.to, tab.label]),
);

export interface Crumb {
  label: string;
  to?: string;
}

/** 由路径推导面包屑：分区 / 分区名 / 页签。 */
export function breadcrumbs(pathname: string, partitions: Partition[]): Crumb[] {
  if (pathname === '/' || pathname === '') return [{ label: '分区' }];

  if (pathname === '/partitions' || pathname.startsWith('/partitions/')) {
    const parts = pathname.split('/').filter(Boolean);
    const partitionId = parts[1];
    if (!partitionId) return [{ label: '分区' }];
    const partition = partitions.find((item) => item.id === partitionId || item.slug === partitionId);
    const crumbs: Crumb[] = [
      { label: '分区', to: '/partitions' },
      { label: partition?.name ?? '分区详情', to: `/partitions/${partitionId}` },
    ];
    const tab = parts[2];
    if (tab === 'persons') {
      crumbs.push({ label: '人', to: `/partitions/${partitionId}/persons` });
      if (parts[3]) crumbs.push({ label: '人详情' });
    } else if (tab) {
      crumbs.push({ label: TAB_LABELS[tab] ?? tab });
    }
    return crumbs;
  }

  if (pathname.startsWith('/org/privacy')) {
    return [{ label: '组织设置', to: '/org' }, { label: '隐私规则' }];
  }
  if (pathname.startsWith('/org')) return [{ label: '组织设置' }];
  if (pathname.startsWith('/login')) return [{ label: '登录' }];
  return [{ label: '页面不存在' }];
}

export function routeTitle(pathname: string, partitions: Partition[]): string {
  const crumbs = breadcrumbs(pathname, partitions);
  const last = crumbs[crumbs.length - 1];
  if (!last) return '控制台';
  if (crumbs.length >= 3 && /^\/partitions\/[^/]+\/[^/]+/.test(pathname)) {
    return `${crumbs[crumbs.length - 2]?.label ?? ''} · ${last.label}`;
  }
  return last.label;
}
