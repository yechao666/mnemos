import type { Tone } from '@ui';
import type { MemoryCategory, Role } from './types.ts';

/** v6 控制台色调/标签映射：只消费本地 v6 类型。 */

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
  insight: 'amber',
  decision: 'blue',
  progress: 'green',
  lesson: 'red',
  risk: 'red',
  change: 'amber',
  acceptance: 'green',
  assumption: 'violet',
  dependency: 'blue',
};

export function toneForCategory(category: string): Tone {
  return CATEGORY_TONES[category as MemoryCategory] ?? 'slate';
}

export function toneForStatus(status: string | undefined | null): Tone {
  switch (status) {
    case 'active':
      return 'green';
    case 'paused':
      return 'amber';
    case 'archived':
      return 'slate';
    case 'deleted':
      return 'red';
    case 'running':
      return 'cyan';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'skipped':
      return 'slate';
    default:
      return 'slate';
  }
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: '所有者',
  admin: '管理员',
  developer: '开发者',
  viewer: '只读',
};

export function toneForRole(role: Role | string | undefined): Tone {
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

export const ACTION_LABEL: Record<string, string> = {
  'auth.login': '登录控制台',
  'auth.logout': '退出登录',
  'auth.password': '修改密码',
  'partition.create': '创建分区',
  'partition.update': '更新分区',
  'partition.archive': '归档分区',
  'settings.update': '更新分区设置',
  'key.create': '创建 API 密钥',
  'key.revoke': '吊销 API 密钥',
  'key.rotate': '轮换 API 密钥',
  'person.upsert': '建人/更新人',
  'person.update': '更新人资料',
  'person.delete': '删除人',
  'memory.create': '写入记忆',
  'memory.update': '更新记忆',
  'memory.delete': '删除记忆',
  'memory.search': '搜索记忆',
  'memory.read': '读取记忆',
  'memory.brief': '生成记忆简报',
  'memory.dream': '做梦整理',
  'org.key.create': '创建组织密钥',
  'org.key.revoke': '吊销组织密钥',
  'org.user.create': '创建控制台账号',
  'org.user.update': '更新控制台账号',
  'org.user.reset_password': '重置账号密码',
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

export function toneForAction(action: string, actorType?: string): Tone {
  if (actorType === 'api_key') return 'cyan';
  if (actorType === 'system') return 'violet';
  if (action.startsWith('memory.delete') || action.includes('revoke')) return 'red';
  if (action.startsWith('partition') || action.startsWith('settings')) return 'violet';
  if (action.startsWith('key')) return 'amber';
  if (action.startsWith('person')) return 'blue';
  if (action.startsWith('memory.search') || action.startsWith('memory.read')) return 'lime';
  if (action.startsWith('memory')) return 'green';
  return 'slate';
}

export const PERSON_TYPE_META: Record<string, { label: string; tone: Tone }> = {
  human: { label: '真人', tone: 'blue' },
  agent: { label: '智能体', tone: 'cyan' },
  service: { label: '服务', tone: 'amber' },
  other: { label: '其他', tone: 'slate' },
};

export const PERSON_STATUS_META: Record<string, { label: string; tone: Tone }> = {
  active: { label: '生效中', tone: 'green' },
  archived: { label: '已归档', tone: 'slate' },
  deleted: { label: '已删除', tone: 'red' },
};

export const SCOPE_META: Record<string, { label: string; tone: Tone }> = {
  person: { label: '仅本人', tone: 'violet' },
  partition: { label: '分区共享', tone: 'green' },
  session: { label: '仅会话', tone: 'amber' },
};
