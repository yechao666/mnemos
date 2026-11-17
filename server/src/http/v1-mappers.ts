import type {
  Memory,
  MemoryBrief,
  MemoryBriefItem,
  MemoryDreamRun,
  MemoryDreamStatus,
  MemoryHistoryEntry,
  Person,
  PersonContext,
  PersonStats,
  Project,
  SearchHit,
} from '../../../shared/src/types.ts';

/**
 * 公开 `/v1` 中立面的 snake_case 读视图映射。
 *
 * 旧 v1（`/v1/memories` 等）与新中立 v1（`/v1/partitions/:p/...`）共用这些函数：
 * 新字段只增不改，旧调用方依赖的 `memory` / `user_id` / `visibility` 等字段继续保留。
 */

function optional<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/** 一条记忆（v1 snake_case）。`memory` 为旧字段别名（= content）。 */
export function v1Memory(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    memory: memory.content,
    content: memory.content,
    project_id: memory.projectId,
    partition_id: memory.projectId,
    person_id: optional(memory.personId),
    person_external_id: optional(memory.personExternalId),
    actor_person_id: optional(memory.actorPersonId),
    scope: memory.scope,
    session_id: optional(memory.sessionId),
    user_id: optional(memory.userId),
    agent_id: optional(memory.agentId),
    run_id: optional(memory.runId),
    app_id: optional(memory.appId),
    task_id: optional(memory.taskId),
    visibility: memory.visibility,
    category: memory.category,
    importance: memory.importance,
    confidence: memory.confidence,
    source: memory.source,
    status: memory.status,
    tags: memory.tags,
    metadata: memory.metadata,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    last_accessed_at: optional(memory.lastAccessedAt),
    access_count: memory.accessCount,
    expires_at: optional(memory.expiresAt),
  };
}

/** 检索命中（记忆字段 + 融合分与信号）。 */
export function v1Hit(hit: SearchHit): Record<string, unknown> {
  return {
    ...v1Memory(hit),
    score: hit.score,
    signals: hit.signals,
    matched_on: hit.matchedOn,
  };
}

export function v1History(entry: MemoryHistoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    memory_id: entry.memoryId,
    event: entry.event,
    old_memory: entry.oldContent ?? null,
    new_memory: entry.newContent ?? null,
    actor: entry.actor,
    reason: entry.reason ?? null,
    created_at: entry.createdAt,
    meta: entry.meta,
  };
}

export function v1PersonStats(stats: PersonStats | undefined): Record<string, unknown> {
  return {
    memories: stats?.memories ?? 0,
    shared_memories: stats?.sharedMemories ?? 0,
    sessions: stats?.sessions ?? 0,
    last_memory_at: optional(stats?.lastMemoryAt),
  };
}

/** 人（Person，snake_case）。 */
export function v1Person(person: Person): Record<string, unknown> {
  return {
    id: person.id,
    partition_id: person.partitionId,
    project_id: person.partitionId,
    external_id: person.externalId,
    type: person.type,
    display_name: person.displayName,
    attributes: person.attributes,
    status: person.status,
    first_seen_at: person.firstSeenAt,
    last_seen_at: person.lastSeenAt,
    created_at: person.createdAt,
    updated_at: person.updatedAt,
    ...(person.stats ? { stats: v1PersonStats(person.stats) } : {}),
  };
}

/** 分页人列表（`results` 兼顾插件/旧习惯，`items` 便于通用分页器）。 */
export function v1PersonPage(input: {
  items: Person[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}): Record<string, unknown> {
  const results = input.items.map(v1Person);
  return {
    results,
    items: results,
    count: input.total,
    total: input.total,
    page: input.page,
    page_size: input.pageSize,
    total_pages: input.totalPages,
  };
}

/** 分区（对外叫 partition，存储仍是 projects）；不含 settings 等敏感配置。 */
export function v1Partition(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    partition_id: project.id,
    project_id: project.id,
    org_id: project.orgId,
    slug: project.slug,
    name: project.name,
    description: project.description,
    status: project.status,
    region: project.region,
    env: project.env,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    archived_at: optional(project.archivedAt),
  };
}

export function v1BriefItem(item: MemoryBriefItem): Record<string, unknown> {
  return {
    id: item.id,
    content: item.content,
    category: item.category,
    importance: item.importance,
    updated_at: item.updatedAt,
    task_id: optional(item.taskId),
    agent_id: optional(item.agentId),
    person_id: optional(item.personId),
    person_external_id: optional(item.personExternalId),
    scope: optional(item.scope),
  };
}

export function v1Brief(brief: MemoryBrief): Record<string, unknown> {
  return {
    project_id: brief.projectId,
    partition_id: brief.projectId,
    person_id: optional(brief.personId),
    text: brief.text,
    max_chars: brief.maxChars,
    count: brief.count,
    model: brief.model,
    cached: brief.cached,
    generated_at: brief.generatedAt,
    recent: brief.recent.map(v1BriefItem),
  };
}

export function v1PersonContext(context: PersonContext): Record<string, unknown> {
  return {
    person: v1Person(context.person),
    brief: v1Brief(context.brief),
    memories: context.memories.map(v1Memory),
    shared: context.shared.map(v1Memory),
    prompt: context.prompt,
    token_estimate: context.tokenEstimate,
    citations: context.citations,
    built_at: context.builtAt,
  };
}

export function v1DreamRun(run: MemoryDreamRun): Record<string, unknown> {
  return {
    id: run.id,
    project_id: run.projectId,
    partition_id: run.projectId,
    person_id: optional(run.personId),
    trigger: run.trigger,
    status: run.status,
    input_count: run.inputCount,
    insight_count: run.insightCount,
    summary: optional(run.summary),
    error: optional(run.error),
    started_at: run.startedAt,
    finished_at: optional(run.finishedAt),
  };
}

export function v1DreamStatus(status: MemoryDreamStatus): Record<string, unknown> {
  return {
    person_id: optional(status.personId),
    settings: {
      enabled: status.settings.enabled,
      interval_minutes: status.settings.intervalMinutes,
      last_at: optional(status.settings.lastAt),
    },
    pending_count: status.pendingCount,
    ...(status.lastRun ? { last_run: v1DreamRun(status.lastRun) } : {}),
    runs: status.runs.map(v1DreamRun),
  };
}
