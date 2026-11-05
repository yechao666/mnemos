import type { AuditLog, MemoryCategory, MemoryStatus, ProjectStatus, Role } from '@shared';
import type { Tone } from '@ui';

const CATEGORY_TONES: Record<MemoryCategory, Tone> = {
  preference: 'violet',
  identity: 'blue',
  fact: 'cyan',
  plan: 'amber',
  relationship: 'pink',
  event: 'amber',
  skill: 'lime',
  constraint: 'red',
  context: 'slate',
};

export function toneForCategory(category: string): Tone {
  return CATEGORY_TONES[category as MemoryCategory] ?? 'slate';
}

export function toneForStatus(status: MemoryStatus | ProjectStatus | string): Tone {
  switch (status) {
    case 'active':
      return 'green';
    case 'paused':
      return 'amber';
    case 'archived':
      return 'slate';
    case 'deleted':
      return 'red';
    default:
      return 'slate';
  }
}

export function toneForRole(role: Role | string): Tone {
  switch (role) {
    case 'owner':
      return 'violet';
    case 'admin':
      return 'cyan';
    case 'developer':
      return 'blue';
    default:
      return 'slate';
  }
}

export function toneForAction(action: string, actorType?: AuditLog['actorType']): Tone {
  if (actorType === 'api_key') return 'cyan';
  if (action.startsWith('memory.delete') || action.includes('revoke')) return 'red';
  if (action.startsWith('project')) return 'violet';
  if (action.startsWith('key')) return 'amber';
  if (action.startsWith('member')) return 'blue';
  if (action.startsWith('search')) return 'lime';
  return 'slate';
}

export function toneForEventType(type: string): Tone {
  if (type.includes('delete')) return 'red';
  if (type.includes('update')) return 'amber';
  if (type.includes('search')) return 'cyan';
  if (type.includes('key')) return 'pink';
  return 'green';
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: '所有者',
  admin: '管理员',
  developer: '开发者',
  viewer: '只读',
};

export const ACTION_LABEL: Record<string, string> = {
  'auth.login': '登录控制台',
  'auth.logout': '退出登录',
  'project.create': '创建项目',
  'project.update': '更新项目',
  'project.delete': '归档项目',
  'settings.update': '更新项目设置',
  'key.create': '创建 API 密钥',
  'key.revoke': '吊销 API 密钥',
  'member.add': '添加成员',
  'member.update': '调整成员角色',
  'member.remove': '移除成员',
  'memory.create': '写入记忆',
  'memory.update': '更新记忆',
  'memory.delete': '删除记忆',
  'memory.bulk': '批量操作记忆',
  'memory.feedback': '记忆反馈',
  'memory.search': '搜索记忆',
  'memory.read': '读取记忆',
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}
