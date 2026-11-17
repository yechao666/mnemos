import type {
  CursorPage,
  Memory,
  MemoryBrief,
  MemoryDreamResult,
  MemoryDreamRun,
  MemoryDreamStatus,
  Partition,
  PartitionSettings,
  PartitionStats,
  Person,
  PersonContext,
} from '../../../shared/src/types.ts';

/**
 * 公开 v1 API 的 snake_case 序列化（控制台 /api 直接返回 camelCase 领域对象）。
 * 保持字段与 docs/v6-architecture.md 第 3 节一致；不额外计算统计。
 */

type Json = Record<string, unknown>;

export function settingsV1(settings: PartitionSettings): Json {
  return {
    default_scope: settings.defaultScope,
    brief_max_chars: settings.briefMaxChars,
    brief_enabled: settings.briefEnabled,
    dream_enabled: settings.dreamEnabled,
    dream_interval_minutes: settings.dreamIntervalMinutes,
    retention_days: settings.retentionDays,
    monthly_quota: settings.monthlyQuota,
    person_auto_create: settings.personAutoCreate,
    locale: settings.locale,
  };
}

export function partitionV1(partition: Partition): Json {
  return {
    id: partition.id,
    org_id: partition.orgId,
    slug: partition.slug,
    name: partition.name,
    description: partition.description,
    status: partition.status,
    settings: settingsV1(partition.settings),
    created_at: partition.createdAt,
    updated_at: partition.updatedAt,
    archived_at: partition.archivedAt ?? null,
    ...(partition.stats ? { stats: statsV1(partition.stats) } : {}),
  };
}

export function statsV1(stats: PartitionStats): Json {
  return {
    partition_id: stats.partitionId,
    persons_total: stats.personsTotal,
    persons_human: stats.personsHuman,
    persons_agent: stats.personsAgent,
    persons_service: stats.personsService,
    memories_total: stats.memoriesTotal,
    shared_total: stats.sharedTotal,
    sessions_total: stats.sessionsTotal,
    updated_at: stats.updatedAt,
  };
}

export function personV1(person: Person): Json {
  return {
    id: person.id,
    partition_id: person.partitionId,
    external_id: person.externalId,
    type: person.type,
    display_name: person.displayName,
    attributes: person.attributes,
    status: person.status,
    memory_count: person.memoryCount,
    shared_memory_count: person.sharedMemoryCount,
    session_count: person.sessionCount,
    last_memory_at: person.lastMemoryAt ?? null,
    first_seen_at: person.firstSeenAt,
    last_seen_at: person.lastSeenAt,
    created_at: person.createdAt,
    updated_at: person.updatedAt,
  };
}

export function memoryV1(memory: Memory): Json {
  return {
    id: memory.id,
    partition_id: memory.partitionId,
    person_id: memory.personId,
    person_external_id: memory.personExternalId ?? null,
    actor_person_id: memory.actorPersonId ?? null,
    scope: memory.scope,
    session_id: memory.sessionId ?? null,
    category: memory.category,
    content: memory.content,
    importance: memory.importance,
    confidence: memory.confidence,
    source: memory.source,
    status: memory.status,
    tags: memory.tags,
    metadata: memory.metadata,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    expires_at: memory.expiresAt ?? null,
    dreamed_at: memory.dreamedAt ?? null,
  };
}

export function briefV1(brief: MemoryBrief): Json {
  return {
    partition_id: brief.partitionId,
    person_id: brief.personId ?? null,
    scope_key: brief.scopeKey,
    text: brief.text,
    max_chars: brief.maxChars,
    count: brief.count,
    model: brief.model,
    cached: brief.cached,
    source_hash: brief.sourceHash,
    generated_at: brief.generatedAt,
    recent: brief.recent.map((item) => ({
      id: item.id,
      content: item.content,
      category: item.category,
      importance: item.importance,
      scope: item.scope,
      updated_at: item.updatedAt,
      person_id: item.personId,
      person_external_id: item.personExternalId ?? null,
    })),
  };
}

export function contextV1(context: PersonContext): Json {
  return {
    person: personV1(context.person),
    brief: briefV1(context.brief),
    memories: context.memories.map(memoryV1),
    shared: context.shared.map(memoryV1),
    prompt: context.prompt,
    token_estimate: context.tokenEstimate,
    citations: context.citations,
    built_at: context.builtAt,
  };
}

export function dreamRunV1(run: MemoryDreamRun): Json {
  return {
    id: run.id,
    partition_id: run.partitionId,
    person_id: run.personId ?? null,
    trigger: run.trigger,
    status: run.status,
    input_count: run.inputCount,
    insight_count: run.insightCount,
    summary: run.summary ?? null,
    error: run.error ?? null,
    started_at: run.startedAt,
    finished_at: run.finishedAt ?? null,
  };
}

export function dreamStatusV1(status: MemoryDreamStatus): Json {
  return {
    settings: {
      enabled: status.settings.enabled,
      interval_minutes: status.settings.intervalMinutes,
      last_at: status.settings.lastAt ?? null,
    },
    person_id: status.personId ?? null,
    pending_count: status.pendingCount,
    last_run: status.lastRun ? dreamRunV1(status.lastRun) : null,
    runs: status.runs.map(dreamRunV1),
  };
}

export function dreamResultV1(result: MemoryDreamResult): Json {
  return {
    run: result.run ? dreamRunV1(result.run) : null,
    status: dreamStatusV1(result.status),
  };
}

export function cursorV1<T>(page: CursorPage<T>, map: (item: T) => Json): Json {
  return {
    items: page.items.map(map),
    next_cursor: page.nextCursor,
    ...(page.partitionStats ? { partition_stats: statsV1(page.partitionStats) } : {}),
  };
}
