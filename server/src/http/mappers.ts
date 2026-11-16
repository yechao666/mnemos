import { DEFAULT_PROJECT_SETTINGS } from '../../../shared/src/constants.ts';
import type {
  ActorType,
  ApiKey,
  ApiScope,
  AuditLog,
  EntityRef,
  Memory,
  MemoryCategory,
  MemoryEventType,
  MemoryHistoryEntry,
  MemorySource,
  MemoryStatus,
  Org,
  Project,
  ProjectMember,
  ProjectSettings,
  ProjectStatus,
  Relation,
  RetrievalWeights,
  Role,
  User,
} from '../../../shared/src/types.ts';

/**
 * SQLite 行 → 领域 DTO 的映射层。
 * 所有 JSON 列（settings / scopes / tags / metadata / detail / meta）在此统一解析，
 * 避免路由里出现裸字符串。
 */

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

export interface ProjectRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  region: string;
  env: string;
  settings: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ProjectMemberRow {
  user_id: string;
  role: string;
  joined_at: string;
  name: string;
  email: string;
  avatar_color: string;
}

export interface ApiKeyRow {
  id: string;
  project_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at?: string | null;
  allowed_ips?: string | null;
  rotated_from?: string | null;
  rotated_at?: string | null;
  rate_limit_per_min: number;
}

export interface MemoryRow {
  id: string;
  project_id: string;
  user_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  app_id: string | null;
  task_id: string | null;
  visibility: string;
  content: string;
  category: string;
  importance: number;
  confidence: number;
  source: string;
  status: string;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  expires_at: string | null;
}

export interface AuditRow {
  id: string;
  org_id: string | null;
  project_id: string | null;
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

export interface HistoryRow {
  id: string;
  memory_id: string;
  project_id: string;
  event: string;
  old_content: string | null;
  new_content: string | null;
  actor: string;
  reason: string | null;
  meta: string;
  created_at: string;
}

export interface EntityRow {
  id: string;
  name: string;
  type: string;
  mention_count: number;
}

export interface RelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation: string;
  memory_id: string | null;
  weight: number;
  created_at: string;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as unknown;
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonArray<T>(raw: string | null | undefined): T[] {
  const value = parseJson<unknown>(raw, []);
  return Array.isArray(value) ? (value as T[]) : [];
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

/** 合并默认设置，保证旧数据缺字段时前端拿到的结构完整。 */
export function parseSettings(raw: string | null | undefined): ProjectSettings {
  const parsed = parseJson<Partial<ProjectSettings>>(raw, {});
  const weights: Partial<RetrievalWeights> = parsed.weights ?? {};
  return {
    extractionMode: parsed.extractionMode ?? DEFAULT_PROJECT_SETTINGS.extractionMode,
    embeddingModel: parsed.embeddingModel ?? DEFAULT_PROJECT_SETTINGS.embeddingModel,
    topK: typeof parsed.topK === 'number' ? parsed.topK : DEFAULT_PROJECT_SETTINGS.topK,
    threshold: typeof parsed.threshold === 'number' ? parsed.threshold : DEFAULT_PROJECT_SETTINGS.threshold,
    retentionDays:
      typeof parsed.retentionDays === 'number' ? parsed.retentionDays : DEFAULT_PROJECT_SETTINGS.retentionDays,
    graphEnabled: typeof parsed.graphEnabled === 'boolean' ? parsed.graphEnabled : DEFAULT_PROJECT_SETTINGS.graphEnabled,
    dedupeThreshold:
      typeof parsed.dedupeThreshold === 'number' ? parsed.dedupeThreshold : DEFAULT_PROJECT_SETTINGS.dedupeThreshold,
    weights: {
      semantic: weights.semantic ?? DEFAULT_PROJECT_SETTINGS.weights.semantic,
      keyword: weights.keyword ?? DEFAULT_PROJECT_SETTINGS.weights.keyword,
      entity: weights.entity ?? DEFAULT_PROJECT_SETTINGS.weights.entity,
      recency: weights.recency ?? DEFAULT_PROJECT_SETTINGS.weights.recency,
    },
    monthlyQuota:
      typeof parsed.monthlyQuota === 'number' ? parsed.monthlyQuota : DEFAULT_PROJECT_SETTINGS.monthlyQuota,
    webhookUrl: parsed.webhookUrl,
    locale: parsed.locale ?? DEFAULT_PROJECT_SETTINGS.locale,
    briefMaxChars:
      typeof parsed.briefMaxChars === 'number' && Number.isFinite(parsed.briefMaxChars)
        ? parsed.briefMaxChars
        : DEFAULT_PROJECT_SETTINGS.briefMaxChars,
    briefEnabled:
      typeof parsed.briefEnabled === 'boolean' ? parsed.briefEnabled : DEFAULT_PROJECT_SETTINGS.briefEnabled,
    dreamEnabled:
      typeof parsed.dreamEnabled === 'boolean' ? parsed.dreamEnabled : DEFAULT_PROJECT_SETTINGS.dreamEnabled,
    dreamIntervalMinutes:
      typeof parsed.dreamIntervalMinutes === 'number' && Number.isFinite(parsed.dreamIntervalMinutes)
        ? parsed.dreamIntervalMinutes
        : DEFAULT_PROJECT_SETTINGS.dreamIntervalMinutes,
    reportsEnabled:
      typeof parsed.reportsEnabled === 'boolean' ? parsed.reportsEnabled : DEFAULT_PROJECT_SETTINGS.reportsEnabled,
    weeklyReportDay:
      typeof parsed.weeklyReportDay === 'number' && Number.isInteger(parsed.weeklyReportDay)
        ? Math.max(1, Math.min(7, parsed.weeklyReportDay))
        : DEFAULT_PROJECT_SETTINGS.weeklyReportDay,
    weeklyReportTime:
      typeof parsed.weeklyReportTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed.weeklyReportTime)
        ? parsed.weeklyReportTime
        : DEFAULT_PROJECT_SETTINGS.weeklyReportTime,
    monthlyReportDay:
      typeof parsed.monthlyReportDay === 'number' && Number.isInteger(parsed.monthlyReportDay)
        ? Math.max(1, Math.min(28, parsed.monthlyReportDay))
        : DEFAULT_PROJECT_SETTINGS.monthlyReportDay,
    monthlyReportTime:
      typeof parsed.monthlyReportTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed.monthlyReportTime)
        ? parsed.monthlyReportTime
        : DEFAULT_PROJECT_SETTINGS.monthlyReportTime,
  };
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    region: row.region,
    env: row.env,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
    settings: parseSettings(row.settings),
  };
}

export function toProjectMember(row: ProjectMemberRow): ProjectMember {
  return {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    avatarColor: row.avatar_color,
    joinedAt: row.joined_at,
  };
}

export function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseJsonArray<ApiScope>(row.scopes),
    createdBy: row.created_by ?? '',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    allowedIps: parseJsonArray<string>(row.allowed_ips),
    rotatedFrom: row.rotated_from ?? undefined,
    rotatedAt: row.rotated_at ?? undefined,
    rateLimitPerMin: row.rate_limit_per_min,
  };
}

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    runId: row.run_id ?? undefined,
    appId: row.app_id ?? undefined,
    taskId: row.task_id ?? undefined,
    visibility: row.visibility === 'agent' || row.visibility === 'task' ? row.visibility : 'project',
    content: row.content,
    category: row.category as MemoryCategory,
    importance: row.importance,
    confidence: row.confidence,
    source: row.source as MemorySource,
    status: row.status as MemoryStatus,
    tags: parseJsonArray<string>(row.tags),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at ?? undefined,
    accessCount: row.access_count,
    expiresAt: row.expires_at ?? undefined,
  };
}

export function toAuditLog(row: AuditRow): AuditLog {
  return {
    id: row.id,
    orgId: row.org_id ?? undefined,
    projectId: row.project_id ?? undefined,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id ?? undefined,
    actorLabel: row.actor_label,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? undefined,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    ip: row.ip ?? undefined,
    userAgent: row.user_agent ?? undefined,
    createdAt: row.created_at,
  };
}

export function toHistoryEntry(row: HistoryRow): MemoryHistoryEntry {
  return {
    id: row.id,
    memoryId: row.memory_id,
    event: row.event as MemoryEventType,
    oldContent: row.old_content ?? undefined,
    newContent: row.new_content ?? undefined,
    actor: row.actor,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
  };
}

export function toEntityRef(row: EntityRow): EntityRef {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mentionCount: row.mention_count,
  };
}

export function toRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relation: row.relation,
    memoryId: row.memory_id ?? undefined,
    weight: row.weight,
    createdAt: row.created_at,
  };
}
