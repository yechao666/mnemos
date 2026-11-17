/** v6 控制台常量：产品信息、分页与筛选项（不依赖 @shared，避免后端重建期间的类型漂移）。 */

import type { MemoryCategory, MemoryScope, PersonStatus, PersonType, Role } from './types.ts';

export const APP_NAME = 'Mnemos';
export const APP_TAGLINE = '分区 · 人 · 记忆';
export const APP_VERSION = '6.0.0';

/** 人/记忆列表每页条数（游标分页；契约默认 50，最大 200）。 */
export const PAGE_SIZE = 50;
/** 人列表固定行高（虚拟滚动窗口化依赖固定行高）。 */
export const PERSON_ROW_HEIGHT = 56;

export const ROLE_RANK: Record<Role, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };

export const ROLE_LABEL: Record<Role, string> = {
  owner: '所有者',
  admin: '管理员',
  developer: '开发者',
  viewer: '只读',
};

export const PARTITION_STATUSES: { value: 'active' | 'paused' | 'archived'; label: string }[] = [
  { value: 'active', label: '运行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'archived', label: '已归档' },
];

export const PARTITION_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  ...PARTITION_STATUSES.map((item) => ({ value: item.value, label: item.label })),
];

export const PERSON_TYPES: { value: PersonType; label: string; desc: string }[] = [
  { value: 'human', label: '真人', desc: 'App 用户、员工、客户等自然人' },
  { value: 'agent', label: '智能体', desc: 'AI Agent / 数字员工' },
  { value: 'service', label: '服务', desc: '后台服务或系统身份' },
  { value: 'other', label: '其他', desc: '无法归类的主体' },
];

export const PERSON_STATUSES: { value: PersonStatus; label: string }[] = [
  { value: 'active', label: '生效中' },
  { value: 'archived', label: '已归档' },
  { value: 'deleted', label: '已删除' },
];

export const PERSON_TYPE_OPTIONS: { value: PersonType | ''; label: string }[] = [
  { value: '', label: '全部类型' },
  ...PERSON_TYPES.map((item) => ({ value: item.value, label: item.label })),
];

export const PERSON_STATUS_OPTIONS: { value: PersonStatus | ''; label: string }[] = [
  { value: '', label: '全部状态' },
  ...PERSON_STATUSES.map((item) => ({ value: item.value, label: item.label })),
];

export type PersonSort = 'recent' | 'new' | 'name';

export const PERSON_SORT_OPTIONS: { value: PersonSort; label: string }[] = [
  { value: 'recent', label: '最近活跃' },
  { value: 'new', label: '最新建档' },
  { value: 'name', label: '姓名排序' },
];

export const MEMORY_SCOPES: { value: MemoryScope; label: string; desc: string }[] = [
  { value: 'person', label: '仅本人', desc: '只有该人可见' },
  { value: 'partition', label: '分区共享', desc: '分区内所有人可见' },
  { value: 'session', label: '仅会话', desc: '只在当前会话内可见' },
];

export const SCOPE_OPTIONS: { value: MemoryScope | ''; label: string }[] = [
  { value: '', label: '全部范围' },
  ...MEMORY_SCOPES.map((item) => ({ value: item.value, label: item.label })),
];

export const MEMORY_CATEGORIES: { value: MemoryCategory; label: string }[] = [
  { value: 'preference', label: '偏好' },
  { value: 'identity', label: '身份' },
  { value: 'fact', label: '事实' },
  { value: 'plan', label: '计划' },
  { value: 'relationship', label: '关系' },
  { value: 'event', label: '事件' },
  { value: 'skill', label: '技能' },
  { value: 'constraint', label: '约束' },
  { value: 'context', label: '上下文' },
  { value: 'insight', label: '洞见' },
  { value: 'decision', label: '决策' },
  { value: 'progress', label: '进展' },
  { value: 'lesson', label: '经验' },
  { value: 'risk', label: '风险' },
  { value: 'change', label: '变更' },
  { value: 'acceptance', label: '验收' },
  { value: 'assumption', label: '假设' },
  { value: 'dependency', label: '依赖' },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  MEMORY_CATEGORIES.map((item) => [item.value, item.label]),
);

export const CATEGORY_OPTIONS: { value: MemoryCategory | ''; label: string }[] = [
  { value: '', label: '全部分类' },
  ...MEMORY_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
];

export const SOURCE_LABEL: Record<string, string> = {
  conversation: '对话抽取',
  api: 'API 写入',
  agent: '智能体写入',
  import: '导入',
  playground: '演练场',
  dream: '做梦沉淀',
};

/** 分区页签（信息架构只保留 v6 领域）。 */
export const PARTITION_TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '.', label: '概览', end: true },
  { to: 'persons', label: '人' },
  { to: 'memories', label: '记忆', end: true },
  { to: 'keys', label: '密钥', end: true },
  { to: 'usage', label: '用量', end: true },
  { to: 'audit', label: '审计', end: true },
  { to: 'settings', label: '设置', end: true },
  { to: 'docs', label: 'API 文档', end: true },
];
