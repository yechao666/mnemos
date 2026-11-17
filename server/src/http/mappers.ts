import type {
  ActorType,
  ApiKey,
  ApiKeyKind,
  ApiScope,
  AuditLog,
  Org,
  Role,
  User,
} from '../../../shared/src/types.ts';

/**
 * SQLite 行 → 领域 DTO 的映射层（HTTP 层使用）。
 * 分区/人/记忆/简报/做梦的行映射与引擎共用（engine/rows.ts），这里只补认证/组织/审计。
 */

export {
  parseJson,
  parseJsonArray,
  parseSettings,
  mergeSettings,
  toPartition,
  toStats,
  toPerson,
  toMemory,
  toSession,
  toBrief,
  toDreamRun,
  ftsQuery,
  escapeLike,
} from '../engine/rows.ts';
export type {
  PartitionRow,
  StatsRow,
  PersonRow,
  MemoryRow,
  SessionRow,
  BriefRow,
  DreamRunRow,
} from '../engine/rows.ts';

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_at: string;
}

export interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: string;
  title: string | null;
  avatar_color: string;
  password_hash: string;
  status?: string | null;
  password_changed_at?: string | null;
  last_login_at?: string | null;
  failed_login_attempts?: number | null;
  locked_until?: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  partition_id: string | null;
  org_id: string | null;
  kind: string | null;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  allowed_ips: string | null;
  rotated_from: string | null;
  rotated_at: string | null;
  rate_limit_per_min: number;
}

export interface AuditRow {
  id: string;
  org_id: string | null;
  partition_id: string | null;
  actor_type: string;
  actor_id: string | null;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  detail: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface PartitionKeyRow {
  id: string;
  partition_id: string;
}

export function toOrg(row: OrgRow): Org {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    createdAt: row.created_at,
  };
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    title: row.title ?? undefined,
    avatarColor: row.avatar_color,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? undefined,
    lastLoginAt: row.last_login_at ?? undefined,
    passwordChangedAt: row.password_changed_at ?? undefined,
  };
}

export function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    partitionId: row.partition_id ?? undefined,
    orgId: row.org_id ?? undefined,
    kind: row.kind === 'org' ? 'org' : ('partition' as ApiKeyKind),
    name: row.name,
    prefix: row.prefix,
    scopes: parseArray<ApiScope>(row.scopes),
    createdBy: row.created_by ?? '',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    allowedIps: parseArray<string>(row.allowed_ips),
    rotatedFrom: row.rotated_from ?? undefined,
    rotatedAt: row.rotated_at ?? undefined,
    rateLimitPerMin: row.rate_limit_per_min,
  };
}

function parseArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

export function toAuditLog(row: AuditRow): AuditLog {
  return {
    id: row.id,
    orgId: row.org_id ?? undefined,
    partitionId: row.partition_id ?? undefined,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id ?? undefined,
    actorLabel: row.actor_label,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? undefined,
    detail: parseRecord(row.detail),
    ip: row.ip ?? undefined,
    userAgent: row.user_agent ?? undefined,
    createdAt: row.created_at,
  };
}

function parseRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
