import type { MemoryScope, Person, PersonStatus, PersonType } from '@lib/types.ts';
import { MEMORY_SCOPES, PERSON_STATUSES, PERSON_TYPES } from '@lib/constants.ts';
import { Badge, Icon, type IconName, type Tone } from '@ui';
import { partitionTone } from '../shell/util.ts';

/**
 * 人（Person）在控制台内的统一展示约定：类型、状态、可见范围与资料格式化。
 * 人不是登录账号：externalId 由调用方定义（App user_id / Agent id）。
 */

export const PERSON_TYPE_META: Record<PersonType, { label: string; tone: Tone; icon: IconName }> = {
  human: { label: '真人', tone: 'blue', icon: 'user' },
  agent: { label: '智能体', tone: 'cyan', icon: 'bot' },
  service: { label: '服务', tone: 'amber', icon: 'server' },
  other: { label: '其他', tone: 'slate', icon: 'user' },
};

export const PERSON_STATUS_META: Record<PersonStatus, { label: string; tone: Tone }> = {
  active: { label: '生效中', tone: 'green' },
  archived: { label: '已归档', tone: 'slate' },
  deleted: { label: '已删除', tone: 'red' },
};

export const PERSON_TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  ...PERSON_TYPES.map((item) => ({ value: item.value, label: item.label })),
];

export const PERSON_STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...PERSON_STATUSES.map((item) => ({ value: item.value, label: item.label })),
];

export function personTypeMeta(type: PersonType | undefined | null) {
  return (type && PERSON_TYPE_META[type]) || PERSON_TYPE_META.other;
}

export function personStatusMeta(status: PersonStatus | undefined | null) {
  return (status && PERSON_STATUS_META[status]) || PERSON_STATUS_META.active;
}

/** 人的展示名：优先 displayName，缺失时回退 externalId。 */
export function personDisplayName(person: Pick<Person, 'displayName' | 'externalId'> | null | undefined): string {
  if (!person) return '';
  return person.displayName?.trim() || person.externalId || '未命名的人';
}

/** 按 externalId + id 生成稳定色调，保证列表与详情颜色一致。 */
export function personTone(person: Pick<Person, 'id' | 'externalId'>): Tone {
  return partitionTone(`${person.externalId}:${person.id}`);
}

export function PersonTypeBadge({ type, size }: { type: PersonType | undefined | null; size?: 'sm' }) {
  const meta = personTypeMeta(type);
  return (
    <Badge tone={meta.tone} size={size} dot>
      {meta.label}
    </Badge>
  );
}

export function PersonStatusBadge({ status, size }: { status: PersonStatus | undefined | null; size?: 'sm' }) {
  const meta = personStatusMeta(status);
  return (
    <Badge tone={meta.tone} size={size} dot>
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* 可见范围（scope）                                                   */
/* ------------------------------------------------------------------ */

export const SCOPE_META: Record<MemoryScope, { label: string; tone: Tone; icon: IconName; desc: string }> = {
  person: { label: '仅本人', tone: 'violet', icon: 'lock', desc: '只有该人可见' },
  partition: { label: '分区共享', tone: 'green', icon: 'users', desc: '分区内所有人可见' },
  session: { label: '仅会话', tone: 'amber', icon: 'branch', desc: '只在当前会话内可见' },
};

export const SCOPE_OPTIONS = [
  { value: '', label: '全部范围' },
  ...MEMORY_SCOPES.map((item) => ({ value: item.value, label: item.label })),
];

export function scopeLabel(scope: MemoryScope | undefined | null): string {
  if (!scope) return '—';
  return SCOPE_META[scope]?.label ?? scope;
}

export function ScopeBadge({ scope, size }: { scope: MemoryScope | undefined | null; size?: 'sm' }) {
  const safe: MemoryScope = scope && SCOPE_META[scope] ? scope : 'partition';
  const meta = SCOPE_META[safe];
  return (
    <Badge tone={meta.tone} size={size} dot>
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* 资料格式化                                                          */
/* ------------------------------------------------------------------ */

/** 把 attributes 里的任意值格式化为单行可读文本。 */
export function formatAttributeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.trim() || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const text = value.map((item) => formatAttributeValue(item)).join(', ');
    return text || '—';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface PersonAttributeEntry {
  key: string;
  value: string;
}

/** attributes 对象 → 稳定的键值列表（键排序，便于对照）。 */
export function personAttributeEntries(person: Pick<Person, 'attributes'> | null | undefined): PersonAttributeEntry[] {
  const attributes = person?.attributes;
  if (!attributes || typeof attributes !== 'object') return [];
  return Object.entries(attributes)
    .filter(([key]) => key.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([key, value]) => ({ key, value: formatAttributeValue(value) }));
}

/** externalId 可能很长，列表里用 mono chip 截断展示。 */
export function PersonExternalIdChip({ externalId }: { externalId: string }) {
  return (
    <span className="chip mono" title={externalId}>
      <Icon name="tag" size={11} />
      <span className="truncate" style={{ maxWidth: 200 }}>
        {externalId}
      </span>
    </span>
  );
}
