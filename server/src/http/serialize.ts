import type {
  CursorPage,
  EntityGraph,
  EntitySummary,
  Memory,
  MemoryAttachment,
  MemoryBrief,
  MemoryDreamResult,
  MemoryDreamRun,
  MemoryDreamStatus,
  MemoryHistoryEntry,
  MemorySearchHit,
  MemorySearchResponse,
  Partition,
  PartitionSettings,
  PartitionStats,
  Person,
  PersonContext,
  PersonExport,
  PersonFact,
  PersonMergeResult,
  PersonProfile,
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
    /* --- v6.1 --- */
    retrieval_mode: settings.retrievalMode,
    retrieval_weights: { ...settings.retrievalWeights },
    embedding_model: settings.embeddingModel,
    merge_threshold: settings.mergeThreshold,
    dedupe_threshold: settings.dedupeThreshold,
    auto_extract_entities: settings.autoExtractEntities,
    /* --- v6.1 P2 合规 --- */
    pii_redaction: settings.piiRedaction,
    /* --- v6.2 隐私规则 --- */
    privacy_llm_enabled: settings.privacyLlmEnabled,
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
    /* --- v6.1 P1 --- */
    merged_into: person.mergedInto ?? null,
    consent: person.consent ?? {},
    deleted_at: person.deletedAt ?? null,
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
    /* --- v6.1 --- */
    valid_from: memory.validFrom ?? null,
    valid_to: memory.validTo ?? null,
    superseded_by: memory.supersededBy ?? null,
    supersedes: memory.supersedes ?? null,
    fact_key: memory.factKey ?? null,
    feedback_up: memory.feedbackUp ?? 0,
    feedback_down: memory.feedbackDown ?? 0,
    /* --- v6.1 P2 多模态 --- */
    attachment_count: memory.attachmentCount ?? memory.attachments?.length ?? 0,
    ...(memory.attachments ? { attachments: memory.attachments.map(attachmentV1) } : {}),
    /* --- v6.2 隐私规则 --- */
    placeholder_count: memory.placeholderCount ?? 0,
    privacy_scanned_at: memory.privacyScannedAt ?? null,
  };
}

export function attachmentV1(attachment: MemoryAttachment): Json {
  return {
    id: attachment.id,
    memory_id: attachment.memoryId,
    kind: attachment.kind,
    url: attachment.url,
    mime: attachment.mime ?? null,
    size: attachment.size ?? null,
    caption: attachment.caption ?? null,
    created_at: attachment.createdAt,
  };
}

export function historyV1(entry: MemoryHistoryEntry): Json {
  return {
    id: entry.id,
    partition_id: entry.partitionId,
    memory_id: entry.memoryId,
    person_id: entry.personId ?? null,
    event: entry.event,
    old_content: entry.oldContent ?? null,
    new_content: entry.newContent ?? null,
    actor: entry.actor ?? null,
    reason: entry.reason ?? null,
    meta: entry.meta,
    created_at: entry.createdAt,
  };
}

export function searchHitV1(hit: MemorySearchHit): Json {
  return {
    ...memoryV1(hit),
    score: hit.score,
    signals: { ...hit.signals },
    matched_on: hit.matchedOn,
  };
}

export function searchResponseV1(response: MemorySearchResponse): Json {
  return {
    hits: response.hits.map(searchHitV1),
    took_ms: response.tookMs,
    mode: response.mode,
    strategy: response.strategy,
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
    ...(result.privacyRedacted !== undefined ? { privacy_redacted: result.privacyRedacted } : {}),
    ...(result.privacyHits !== undefined ? { privacy_hits: result.privacyHits } : {}),
  };
}

export function cursorV1<T>(page: CursorPage<T>, map: (item: T) => Json): Json {
  return {
    items: page.items.map(map),
    next_cursor: page.nextCursor,
    ...(page.partitionStats ? { partition_stats: statsV1(page.partitionStats) } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* v6.1 P2：实体 / 关系图                                               */
/* ------------------------------------------------------------------ */

export function graphV1(graph: EntityGraph): Json {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      weight: node.weight,
      memories: node.memories,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      weight: edge.weight,
    })),
    stats: {
      nodes: graph.stats.nodes,
      edges: graph.stats.edges,
      // 公开 v1 以 snake_case 为主；topTypes 作为兼容别名（与任务契约/控制台命名一致）。
      top_types: graph.stats.topTypes,
      topTypes: graph.stats.topTypes,
    },
  };
}

export function entityV1(entity: EntitySummary): Json {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    mention_count: entity.mentionCount,
    memories: entity.memories,
    created_at: entity.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* v6.1 P1：画像 / 生命周期                                             */
/* ------------------------------------------------------------------ */

export function personFactV1(fact: PersonFact): Json {
  return {
    id: fact.id,
    partition_id: fact.partitionId,
    person_id: fact.personId,
    key: fact.key,
    value: fact.value,
    confidence: fact.confidence,
    valid_from: fact.validFrom,
    valid_to: fact.validTo ?? null,
    source_memory_id: fact.sourceMemoryId ?? null,
    created_at: fact.createdAt,
    updated_at: fact.updatedAt,
  };
}

export function personProfileV1(profile: PersonProfile): Json {
  return {
    person: personV1(profile.person),
    facts: profile.facts.map(personFactV1),
    summary: profile.summary,
    generated_at: profile.generatedAt ?? null,
    ...(profile.cached !== undefined ? { cached: profile.cached } : {}),
  };
}

export function personMergeResultV1(result: PersonMergeResult): Json {
  return {
    person: personV1(result.person),
    merged_from: personV1(result.mergedFrom),
    moved_memories: result.movedMemories,
    moved_facts: result.movedFacts,
  };
}

export function personExportV1(exported: PersonExport): Json {
  return {
    person: personV1(exported.person),
    facts: exported.facts.map(personFactV1),
    memories: exported.memories.map(memoryV1),
    exported_at: exported.exportedAt,
    truncated: exported.truncated === true,
  };
}
