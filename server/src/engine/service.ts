/**
 * 记忆服务：把索引/检索/图谱/统计编排成 MemoryService 契约实现。
 *
 * 事务边界：一次 add（可能抽出多条事实）、update、remove、bulk、feedback 各自一个事务；
 * 所有 SQL 均为 prepared statement 参数化。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  AddMemoryInput,
  AddMemoryResult,
  Actor,
  Agent,
  AgentInput,
  Briefing,
  BriefingInput,
  BulkMemoryInput,
  FeedbackInput,
  FinishTaskInput,
  GraphData,
  ListMemoriesInput,
  LiveEvent,
  Memory,
  MemoryBrief,
  MemoryBriefInput,
  MemoryCategory,
  MemoryDetail,
  MemoryDreamInput,
  MemoryDreamResult,
  MemoryDreamRun,
  MemoryDreamSettingsInput,
  MemoryDreamStatus,
  MemoryHistoryEntry,
  MemoryScope,
  MemoryService,
  MemorySource,
  MemoryVisibility,
  Paginated,
  Person,
  PersonContext,
  PersonContextInput,
  PersonInput,
  PersonListInput,
  PersonType,
  ProjectStats,
  SearchMemoryInput,
  SearchResponse,
  Task,
  TaskInput,
  TaskStatus,
  UpdateMemoryInput,
} from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { writeAudit } from '../lib/audit.ts';
import type { EventBus } from '../lib/bus.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { estimateTokens, recordUsage } from '../lib/usage.ts';
import { tx } from '../db/index.ts';
import { buildGraph, buildStats } from './analytics.ts';
import { createAgent as createAgentRecord, getAgent, listAgents, touchAgent, updateAgent as updateAgentRecord } from './agents.ts';
import { buildBriefing } from './briefing.ts';
import { clampBriefChars, ensureBrief } from './brief.ts';
import { listHistory, listMemories, listMemoryEntities, listNeighborEntities, listRelationsForEntities } from './detail.ts';
import { embedText } from './embed.ts';
import { conflict, notFound, unprocessable } from './errors.ts';
import { extractEntities, extractFromMessages, extractFromText, extractRelations, type ExtractedFact } from './extract.ts';
import { getDreamStatus, getPersonDreamStatus, latestDreamRun, runDream, updateDreamSettings as updateDreamSettingsRecord } from './dream.ts';
import {
  isPersonStatus,
  isPersonType,
  listPersons,
  loadPersonStats,
  mapPerson,
  resolvePerson,
  touchPerson as touchPersonRecord,
  updatePerson as updatePersonRecord,
  upsertPerson as upsertPersonRecord,
  type PersonRow,
} from './persons.ts';
import { retrieve } from './retrieve.ts';
import {
  attachEntities,
  attachRelations,
  detachEntities,
  findSimilarMemory,
  getMemoryRow,
  insertMemory,
  loadSettings,
  mapMemory,
  parseMetadata,
  parseTagList,
  refreshContentIndex,
  requireMemoryRow,
  scopeFromVisibility,
  visibilityFromScope,
  writeHistory,
  type LegacyScopeFields,
  type MemoryRow,
} from './store.ts';
import { applyTaskPatch, createTask as createTaskRecord, findTaskRow, getTask, listTasks, updateTask as updateTaskRecord } from './tasks.ts';

export interface MemoryServiceOptions {
  /** 进程内事件总线（SSE 实时流） */
  bus?: EventBus;
  /** 是否由引擎写 usage_events；默认 false（HTTP 层负责，避免重复计数） */
  recordUsage?: boolean;
  /** 可选大模型配置（记忆简报润色 / 做梦归纳）；缺省时全部走确定性逻辑 */
  llm?: LlmConfig | null;
}

const CATEGORIES: MemoryCategory[] = ['preference', 'identity', 'fact', 'plan', 'relationship', 'event', 'skill', 'constraint', 'context', 'insight', 'decision', 'progress', 'lesson', 'risk', 'change', 'acceptance', 'assumption', 'dependency'];
const VISIBILITIES: MemoryVisibility[] = ['project', 'agent', 'task'];
const SCOPES: MemoryScope[] = ['person', 'partition', 'session'];

/** finishTask 的沉淀：决策、进展、经验分别成为结构化项目记录，备注仍为事件。 */
const FINISH_BUCKETS: { key: 'decisions' | 'progress' | 'lessons' | 'risks' | 'changes' | 'acceptance' | 'assumptions' | 'dependencies' | 'notes'; category: MemoryCategory; importance: number }[] = [
  { key: 'decisions', category: 'decision', importance: 0.86 },
  { key: 'progress', category: 'progress', importance: 0.66 },
  { key: 'lessons', category: 'lesson', importance: 0.82 },
  { key: 'risks', category: 'risk', importance: 0.9 },
  { key: 'changes', category: 'change', importance: 0.84 },
  { key: 'acceptance', category: 'acceptance', importance: 0.78 },
  { key: 'assumptions', category: 'assumption', importance: 0.72 },
  { key: 'dependencies', category: 'dependency', importance: 0.76 },
  { key: 'notes', category: 'event', importance: 0.6 },
];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function asCategory(value: unknown): MemoryCategory | null {
  return typeof value === 'string' && (CATEGORIES as string[]).includes(value) ? (value as MemoryCategory) : null;
}

function asUnit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : null;
}

/** 解析项目 settings 原始 JSON（保留未知字段，写回时不丢配置）。 */
function parseSettingsJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function actorLabelOf(actor: Actor | undefined): string {
  if (!actor) return 'system';
  return actor.label || actor.id || actor.type || 'system';
}

function scopeOfLegacy(input: { userId?: string; agentId?: string; runId?: string; appId?: string }): LegacyScopeFields {
  return { userId: input.userId, agentId: input.agentId, runId: input.runId, appId: input.appId };
}

function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}

/** 允许通过 metadata.taskId 推断任务归属（Agent 忘记显式传 taskId 时的兜底）。 */
function resolveTaskId(input: AddMemoryInput): string | undefined {
  if (input.taskId) return input.taskId;
  const candidate = input.metadata?.taskId;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * 候选事实：
 * - infer=false：原文单条入库（不切分、不改写），分类/分数可由 metadata 覆盖（策展数据）；
 * - infer=true：走规则抽取（分句、代词归一、分类、实体与关系）。
 */
function collectFacts(input: AddMemoryInput): ExtractedFact[] {
  const infer = input.infer ?? true;
  if (!infer) {
    const content = (input.text ?? '').trim() || (input.messages ?? []).map((message) => message.content).join('\n').trim();
    if (!content) return [];
    const metadata = input.metadata ?? {};
    const entities = extractEntities(content);
    const relations = extractRelations(content, entities);
    return [
      {
        content,
        raw: content,
        category: asCategory(metadata.category) ?? 'fact',
        importance: asUnit(metadata.importance) ?? 0.5,
        confidence: asUnit(metadata.confidence) ?? 0.8,
        entities,
        relations,
      },
    ];
  }
  const messages = input.messages ?? [];
  const text = (input.text ?? '').trim();
  if (messages.length > 0) return extractFromMessages(messages);
  if (text) return extractFromText(text);
  return [];
}

/** 创建记忆服务实例。 */
export function createMemoryService(db: DatabaseSync, options: MemoryServiceOptions = {}): MemoryService {
  const bus = options.bus;
  const shouldRecordUsage = options.recordUsage ?? false;
  const llm = options.llm ?? null;

  /** 读取项目 orgId（审计归属）；项目不存在时返回 undefined。 */
  function projectOrgId(projectId: string): string | undefined {
    const row = db.prepare('SELECT org_id FROM projects WHERE id = ?').get(projectId) as unknown as
      | { org_id?: string }
      | undefined;
    return row?.org_id;
  }

  function publish(type: LiveEvent['type'], projectId: string, actor: string, summary: string, meta?: Record<string, unknown>): void {
    if (!bus) return;
    try {
      bus.publish({ id: newId('evt'), type, projectId, actor, summary, at: nowIso(), meta });
    } catch {
      /* 实时流失败不影响主流程 */
    }
  }

  function record(input: {
    projectId: string;
    operation: 'add' | 'search';
    latencyMs: number;
    resultCount: number;
    memoryTokens: number;
    actor: string;
  }): void {
    if (!shouldRecordUsage) return;
    try {
      recordUsage(db, {
        projectId: input.projectId,
        channel: 'system',
        operation: input.operation,
        latencyMs: input.latencyMs,
        resultCount: input.resultCount,
        memoryTokens: input.memoryTokens,
        actor: input.actor,
      });
    } catch {
      /* 用量记录失败不影响主流程 */
    }
  }

  /** consolidate：高相似时累加重要度并写 NOOP/MERGE 历史，不新建记忆。 */
  function mergeInto(row: MemoryRow, fact: ExtractedFact, actor: string, event: 'MERGE' | 'NOOP', similarity: number, tags: string[], metadata: Record<string, unknown>): void {
    const at = nowIso();
    const importance = clamp01(Math.round((Number(row.importance) + 0.02) * 100) / 100);
    const mergedTags = [...new Set([...parseTagList(row.tags), ...tags])];
    const mergedMetadata = { ...parseMetadata(row.metadata), ...metadata };
    db.prepare('UPDATE memories SET importance = ?, tags = ?, metadata = ?, updated_at = ? WHERE id = ?').run(
      importance,
      JSON.stringify(mergedTags),
      JSON.stringify(mergedMetadata),
      at,
      row.id,
    );
    writeHistory(db, {
      projectId: row.project_id,
      memoryId: row.id,
      event,
      oldContent: row.content,
      newContent: fact.content,
      actor,
      reason: event === 'MERGE' ? 'duplicate' : 'consolidate',
      meta: { similarity: Math.round(similarity * 1000) / 1000, importance },
      at,
    });
  }

  /* ------------------------------------------------------------------ */
  /* 人（Person）解析辅助                                                 */
  /* ------------------------------------------------------------------ */

  /** 解析 person 引用（内部 id 或 external_id），找不到抛 404。 */
  function requirePerson(projectId: string, ref: string, type?: PersonType): PersonRow {
    const row = resolvePerson(db, projectId, ref, type ? { type } : {});
    if (!row) throw notFound(`人不存在：${ref}`);
    return row;
  }

  /** 调用方 Agent 身份 → person 内部 id（解析不到返回 null，交给旧 agent_id 兼容匹配）。 */
  function callerPersonIdOf(projectId: string, agentId?: string): string | null {
    const ref = typeof agentId === 'string' ? agentId.trim() : '';
    if (!ref) return null;
    return resolvePerson(db, projectId, ref, { type: 'agent' })?.id ?? null;
  }

  /**
   * 写入时解析 person：显式 personId/personExternalId 优先，其次旧 user_id/agent_id 映射；
   * personAutoCreate=true 时懒建档（新中立 API 首次写入即建人），否则显式引用缺失即 404。
   */
  function personForWrite(projectId: string, input: AddMemoryInput, autoCreate: boolean): PersonRow | null {
    const direct = (input.personId ?? input.personExternalId ?? '').trim();
    const typeHint: PersonType | undefined = input.agentId ? 'agent' : input.userId ? 'human' : undefined;
    if (direct) {
      const existing = resolvePerson(db, projectId, direct, typeHint ? { type: typeHint } : {});
      if (existing) return existing;
      if (!autoCreate || direct.startsWith('prs_')) throw notFound(`人不存在：${direct}`);
      // external_id 同时命中多种类型（human + agent）时不能猜，要求调用方给出内部 id / 类型上下文。
      const collisions = db
        .prepare('SELECT COUNT(*) AS c FROM persons WHERE project_id = ? AND external_id = ?')
        .get(projectId, direct) as unknown as { c?: number } | undefined;
      if (Number(collisions?.c ?? 0) > 0) {
        throw unprocessable(`人引用不唯一（external_id 命中多个类型）：${direct}，请使用内部 person id`);
      }
      return upsertPersonRecord(db, projectId, { externalId: direct, type: typeHint ?? 'human' });
    }
    const agentRef = input.agentId?.trim();
    if (agentRef) {
      const existing = resolvePerson(db, projectId, agentRef, { type: 'agent' });
      if (existing) return existing;
      if (!autoCreate) return null;
      const agentRow = db.prepare('SELECT name FROM agents WHERE project_id = ? AND id = ?').get(projectId, agentRef) as
        | { name?: string }
        | undefined;
      return upsertPersonRecord(db, projectId, {
        externalId: agentRef,
        type: 'agent',
        displayName: agentRow?.name ?? agentRef,
      });
    }
    const userRef = input.userId?.trim();
    if (userRef) {
      const existing = resolvePerson(db, projectId, userRef, { type: 'human' });
      if (existing) return existing;
      if (!autoCreate) return null;
      return upsertPersonRecord(db, projectId, { externalId: userRef, type: 'human' });
    }
    return null;
  }

  /** 写入者：显式 actorPersonId 必须存在；缺省同 person（无 person 时为 NULL）。 */
  function actorPersonForWrite(projectId: string, input: AddMemoryInput, person: PersonRow | null): string | null {
    const ref = input.actorPersonId?.trim();
    if (!ref) return person?.id ?? null;
    const row = resolvePerson(db, projectId, ref);
    if (!row) throw notFound(`写入者不存在：${ref}`);
    return row.id;
  }

  /**
   * 写入记忆的同步实现。`options.tx=false` 供 finishTask 在外层事务内复用，
   * 避免嵌套 BEGIN（SQLite 不支持）。
   */
  function executeAdd(input: AddMemoryInput, options: { tx?: boolean } = {}): AddMemoryResult {
    const started = performance.now();
    const settings = loadSettings(db, input.projectId);

    // 1) scope：显式 scope > 旧 visibility 映射 > 分区设置 defaultScope；visibility 双写。
    if (input.visibility !== undefined && !VISIBILITIES.includes(input.visibility)) {
      throw unprocessable(`visibility 不合法：${String(input.visibility)}`);
    }
    if (input.scope !== undefined && !SCOPES.includes(input.scope)) {
      throw unprocessable(`scope 不合法：${String(input.scope)}`);
    }
    const scope: MemoryScope =
      input.scope ?? (input.visibility ? scopeFromVisibility(input.visibility) : settings.defaultScope);
    // 双写兼容列：显式 scope 优先，避免 scope 与 visibility 组合出不一致的存量语义。
    const visibility: MemoryVisibility =
      input.scope !== undefined ? visibilityFromScope(scope) : (input.visibility ?? visibilityFromScope(scope));
    const taskId = resolveTaskId(input);
    const sessionId = input.sessionId?.trim() || taskId || undefined;
    if (scope === 'session' && !sessionId) {
      throw unprocessable('scope=session（旧 visibility=task）时必须提供 sessionId 或 taskId');
    }

    // 2) person：显式引用优先；旧 user_id/agent_id 继续映射为 human/agent 人。
    const person = personForWrite(input.projectId, input, settings.personAutoCreate);
    if (scope === 'person' && !person) {
      throw unprocessable('scope=person 时必须提供 personId / personExternalId（或旧 userId / agentId）');
    }
    const actorPersonId = actorPersonForWrite(input.projectId, input, person);

    // 3) 事实抽取
    const mode = input.mode ?? settings.extractionMode;
    const actor = actorLabelOf(input.actor);
    const facts = collectFacts(input);
    const at = nowIso();
    const result: AddMemoryResult = { results: [], events: [], tookMs: 0, extracted: facts.length, merged: 0, skipped: 0 };
    if (facts.length === 0) {
      result.tookMs = elapsedMs(started);
      return result;
    }

    const source: MemorySource = input.source ?? (input.messages && input.messages.length > 0 ? 'conversation' : 'api');
    const tags = input.tags ?? [];
    const metadata = input.metadata ?? {};

    const runFacts = (): void => {
      for (const fact of facts) {
        if (!fact.content) {
          result.skipped++;
          continue;
        }
        // collectFacts 已在 infer=false 时应用 metadata 覆盖（分类/分数）
        const { category, importance, confidence } = fact;
        const embedding = embedText(fact.content);

        if (mode === 'consolidate') {
          // scope=person 必须按 person_id 隔离，避免不同人的相同内容被合并。
          const similar = findSimilarMemory(
            db,
            input.projectId,
            scopeOfLegacy(input),
            fact.content,
            embedding,
            settings.dedupeThreshold,
            { scope, personId: person?.id ?? null, sessionId: sessionId ?? null, visibility },
          );
          if (similar) {
            const event = similar.exact ? 'MERGE' : 'NOOP';
            mergeInto(similar.row, fact, actor, event, similar.similarity, tags, metadata);
            result.merged++;
            result.events.push({
              type: event,
              memoryId: similar.row.id,
              content: fact.content,
              reason: event === 'MERGE' ? 'duplicate' : 'consolidate',
              at: nowIso(),
            });
            continue;
          }
        }

        const memory = insertMemory(db, {
          projectId: input.projectId,
          content: fact.content,
          category,
          importance,
          confidence,
          source,
          tags,
          metadata,
          personId: person?.id ?? null,
          actorPersonId,
          scope,
          sessionId: sessionId ?? null,
          userId: input.userId,
          agentId: input.agentId,
          runId: input.runId,
          appId: input.appId,
          taskId,
          visibility,
          entities: fact.entities,
          relations: fact.relations,
          embeddingModel: settings.embeddingModel,
          embedding,
          actor,
          at,
        });
        result.results.push(memory);
        result.events.push({ type: 'ADD', memoryId: memory.id, content: memory.content, at: memory.createdAt });
      }
      if (person) touchPersonRecord(db, input.projectId, person.id, at);
      if (input.agentId) touchAgent(db, input.projectId, input.agentId, at);
    };

    if (options.tx === false) runFacts();
    else tx(db, runFacts);

    result.tookMs = elapsedMs(started);
    for (const memory of result.results.slice(0, 5)) {
      publish('memory.added', input.projectId, actor, `新增记忆：${memory.content.slice(0, 60)}`, {
        memoryId: memory.id,
        category: memory.category,
      });
    }
    record({
      projectId: input.projectId,
      operation: 'add',
      latencyMs: result.tookMs,
      resultCount: result.results.length,
      memoryTokens: result.results.reduce((sum, memory) => sum + estimateTokens(memory.content), 0),
      actor,
    });
    return result;
  }

  async function add(input: AddMemoryInput): Promise<AddMemoryResult> {
    return executeAdd(input);
  }

  async function search(input: SearchMemoryInput): Promise<SearchResponse> {
    const personFilterId = input.personId?.trim() ? requirePerson(input.projectId, input.personId).id : undefined;
    // 调用方本人：旧 agentId 优先（Agent 身份），否则人级筛选的人。
    const callerPersonId = input.agentId
      ? callerPersonIdOf(input.projectId, input.agentId)
      : (personFilterId ?? null);
    const result = retrieve(db, {
      ...input,
      personFilterId,
      callerPersonId,
      sessionId: input.taskId ?? null,
    });
    if (result.hits.length > 0) {
      const at = nowIso();
      const statement = db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ? AND project_id = ?');
      tx(db, () => {
        for (const hit of result.hits) statement.run(at, hit.id, input.projectId);
      });
    }
    publish('search.performed', input.projectId, 'user', `检索「${input.query.slice(0, 40)}」命中 ${result.total} 条`, {
      queryTerms: result.queryTerms,
      hits: result.hits.length,
    });
    record({
      projectId: input.projectId,
      operation: 'search',
      latencyMs: result.tookMs,
      resultCount: result.total,
      memoryTokens: 0,
      actor: 'user',
    });
    return {
      results: result.hits,
      total: result.total,
      tookMs: result.tookMs,
      queryTerms: result.queryTerms,
      strategy: result.strategy,
      weights: result.weights,
    };
  }

  async function list(input: ListMemoriesInput): Promise<Paginated<Memory>> {
    const personFilterId = input.personId?.trim() ? requirePerson(input.projectId, input.personId).id : undefined;
    const callerPersonId = input.agentId
      ? callerPersonIdOf(input.projectId, input.agentId)
      : (personFilterId ?? null);
    return listMemories(db, {
      ...input,
      personFilterId,
      callerPersonId,
      sessionId: input.taskId ?? null,
    });
  }

  async function get(projectId: string, id: string): Promise<MemoryDetail | null> {
    const row = getMemoryRow(db, projectId, id);
    if (!row) return null;
    const entities = listMemoryEntities(db, projectId, id);
    const entityIds = entities.map((entity) => entity.id);
    return {
      memory: mapMemory(row),
      history: listHistory(db, projectId, id),
      entities,
      relations: listRelationsForEntities(db, projectId, entityIds),
      neighbors: listNeighborEntities(db, projectId, entityIds),
    };
  }

  async function update(projectId: string, id: string, input: UpdateMemoryInput, actorInput: Actor): Promise<Memory> {
    const row = requireMemoryRow(db, projectId, id);
    const settings = loadSettings(db, projectId);
    const actor = actorLabelOf(actorInput);
    const at = nowIso();
    const nextContent = typeof input.content === 'string' && input.content.trim() ? input.content.trim() : row.content;
    const contentChanged = nextContent !== row.content;
    const tags = input.tags ?? parseTagList(row.tags);
    const metadata = input.metadata ?? parseMetadata(row.metadata);
    const category = input.category ?? (row.category as MemoryCategory);
    const importance = input.importance !== undefined ? clamp01(input.importance) : Number(row.importance);
    const status = input.status ?? row.status;
    const expiresAt = input.expiresAt === undefined ? row.expires_at : input.expiresAt;

    tx(db, () => {
      db.prepare(
        `UPDATE memories SET content = ?, category = ?, importance = ?, status = ?, tags = ?, metadata = ?, expires_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextContent, category, importance, status, JSON.stringify(tags), JSON.stringify(metadata), expiresAt, at, id);

      if (contentChanged) {
        refreshContentIndex(db, row, nextContent, settings.embeddingModel, at);
        detachAndReattachEntities(projectId, id, nextContent, at);
      }
      writeHistory(db, {
        projectId,
        memoryId: id,
        event: 'UPDATE',
        oldContent: row.content,
        newContent: nextContent,
        actor,
        reason: contentChanged ? 'content' : 'properties',
        meta: {
          contentChanged,
          category: { from: row.category, to: category },
          status: { from: row.status, to: status },
        },
        at,
      });
    });
    if (row.agent_id) touchAgent(db, projectId, row.agent_id, at);
    publish('memory.updated', projectId, actor, `更新记忆：${nextContent.slice(0, 60)}`, { memoryId: id, contentChanged });
    return mapMemory(requireMemoryRow(db, projectId, id));
  }

  /** 内容变化后重建实体/关系索引（先清理旧内容派生的边，再按新内容挂载）。 */
  function detachAndReattachEntities(projectId: string, memoryId: string, content: string, at: string): void {
    detachEntities(db, memoryId);
    db.prepare('DELETE FROM relations WHERE project_id = ? AND memory_id = ?').run(projectId, memoryId);
    const entities = extractEntities(content);
    const relations = extractRelations(content, entities);
    const attached = attachEntities(db, projectId, memoryId, entities, at);
    attachRelations(db, projectId, memoryId, relations, attached.ids, at);
  }

  async function remove(projectId: string, id: string, actorInput: Actor): Promise<void> {
    const row = requireMemoryRow(db, projectId, id);
    const actor = actorLabelOf(actorInput);
    const at = nowIso();
    tx(db, () => {
      db.prepare("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?").run(at, id);
      writeHistory(db, {
        projectId,
        memoryId: id,
        event: 'DELETE',
        oldContent: row.content,
        newContent: null,
        actor,
        reason: 'removed',
        at,
      });
    });
    publish('memory.deleted', projectId, actor, `删除记忆：${row.content.slice(0, 60)}`, { memoryId: id });
  }

  async function bulk(projectId: string, input: BulkMemoryInput, actorInput: Actor): Promise<{ affected: number }> {
    const ids = [...new Set(input.ids ?? [])].filter((id) => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return { affected: 0 };
    const actor = actorLabelOf(actorInput);
    const at = nowIso();
    const target = input.action === 'delete' ? 'deleted' : input.action === 'archive' ? 'archived' : 'active';
    let affected = 0;

    tx(db, () => {
      for (const id of ids) {
        const row = getMemoryRow(db, projectId, id);
        if (!row || row.status === target) continue;
        db.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?').run(target, at, id);
        writeHistory(db, {
          projectId,
          memoryId: id,
          event: input.action === 'delete' ? 'DELETE' : 'UPDATE',
          oldContent: row.content,
          newContent: input.action === 'delete' ? null : row.content,
          actor,
          reason: `bulk:${input.action}`,
          meta: { action: input.action, from: row.status, to: target },
          at,
        });
        affected++;
      }
    });

    publish(
      input.action === 'delete' ? 'memory.deleted' : 'memory.updated',
      projectId,
      actor,
      `批量${input.action === 'delete' ? '删除' : input.action === 'archive' ? '归档' : '恢复'} ${affected} 条记忆`,
      { action: input.action, affected },
    );
    return { affected };
  }

  async function history(projectId: string, id: string): Promise<MemoryHistoryEntry[]> {
    return listHistory(db, projectId, id);
  }

  async function feedback(projectId: string, id: string, input: FeedbackInput, actorInput: Actor): Promise<Memory> {
    const row = requireMemoryRow(db, projectId, id);
    const actor = actorLabelOf(actorInput);
    const at = nowIso();
    const delta = input.helpful ? 0.08 : -0.12;
    const importance = clamp01(Math.round((Number(row.importance) + delta) * 100) / 100);
    tx(db, () => {
      db.prepare('UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?').run(importance, at, id);
      writeHistory(db, {
        projectId,
        memoryId: id,
        event: 'UPDATE',
        oldContent: row.content,
        newContent: row.content,
        actor,
        reason: 'feedback',
        meta: { helpful: input.helpful, query: input.query ?? null, importance },
        at,
      });
    });
    return mapMemory(requireMemoryRow(db, projectId, id));
  }

  async function graph(projectId: string, limit: number): Promise<GraphData> {
    const settings = loadSettings(db, projectId);
    return buildGraph(db, projectId, limit, settings.graphEnabled);
  }

  async function stats(projectId: string): Promise<ProjectStats> {
    const settings = loadSettings(db, projectId);
    return buildStats(db, projectId, settings);
  }

  /* ------------------------------------------------------------------ */
  /* Agent 注册表 / 任务会话 / 任务简报                                    */
  /* ------------------------------------------------------------------ */

  async function agents(projectId: string): Promise<Agent[]> {
    return listAgents(db, projectId);
  }

  async function agent(projectId: string, agentId: string): Promise<Agent | null> {
    return getAgent(db, projectId, agentId);
  }

  async function createAgent(projectId: string, input: AgentInput, actor: Actor): Promise<Agent> {
    return createAgentRecord(db, projectId, input, actor);
  }

  async function updateAgent(projectId: string, agentId: string, input: Partial<AgentInput>, actor: Actor): Promise<Agent> {
    return updateAgentRecord(db, projectId, agentId, input, actor);
  }

  async function tasks(projectId: string, params: { status?: TaskStatus; agentId?: string; limit?: number } = {}): Promise<Task[]> {
    return listTasks(db, projectId, params);
  }

  async function task(projectId: string, taskId: string): Promise<Task | null> {
    return getTask(db, projectId, taskId);
  }

  async function createTask(projectId: string, input: TaskInput, actor: Actor): Promise<Task> {
    return createTaskRecord(db, projectId, input, actor);
  }

  async function updateTask(projectId: string, taskId: string, input: Partial<TaskInput> & { summary?: string }, actor: Actor): Promise<Task> {
    return updateTaskRecord(db, projectId, taskId, input, actor);
  }

  /**
   * 结束任务：同一事务内更新任务状态，并把 decisions/lessons/notes 逐条沉淀为
   * 分区共享记忆（scope=partition、visibility=project、taskId 归因、infer=false 保留原文）；
   * 有 agentId 时把决策等归属到该 Agent 对应的人（若已建档）。
   */
  async function finishTask(
    projectId: string,
    taskId: string,
    input: FinishTaskInput,
    actor: Actor,
  ): Promise<{ task: Task; memories: Memory[] }> {
    const row = findTaskRow(db, projectId, taskId);
    if (!row) throw notFound('任务不存在');
    const current = row.status as TaskStatus;
    if (current === 'done' || current === 'abandoned') {
      throw conflict('任务已结束，无法重复结束');
    }

    const status: 'done' | 'abandoned' = input.status ?? 'done';
    const memories: Memory[] = [];
    const agentPerson = input.agentId ? resolvePerson(db, projectId, input.agentId, { type: 'agent' }) : null;

    tx(db, () => {
      applyTaskPatch(db, projectId, taskId, { status, summary: input.summary });
      for (const bucket of FINISH_BUCKETS) {
        for (const raw of input[bucket.key] ?? []) {
          const content = typeof raw === 'string' ? raw.trim() : '';
          if (!content) continue;
          const result = executeAdd(
            {
              projectId,
              text: content,
              agentId: input.agentId,
              personId: agentPerson?.id,
              taskId,
              visibility: 'project',
              infer: false,
              source: input.agentId ? 'agent' : 'api',
              metadata: { category: bucket.category, importance: bucket.importance, taskId },
              actor,
            },
            { tx: false },
          );
          memories.push(...result.results);
        }
      }
    });

    const finished = getTask(db, projectId, taskId);
    if (!finished) throw notFound('任务不存在');
    return { task: finished, memories };
  }

  async function briefing(input: BriefingInput): Promise<Briefing> {
    return buildBriefing({ db, search, list }, input);
  }

  /* ------------------------------------------------------------------ */
  /* 记忆简报 / 做梦                                                      */
  /* ------------------------------------------------------------------ */

  async function brief(input: MemoryBriefInput): Promise<MemoryBrief> {
    return ensureBrief({ db, llm }, input);
  }

  /** 保存简报字符上限并立即重新生成一次（force + LLM 润色），返回最新简报。 */
  async function updateBriefSettings(projectId: string, maxChars: number, actor: Actor): Promise<MemoryBrief> {
    const row = db.prepare('SELECT id, org_id, settings FROM projects WHERE id = ?').get(projectId) as unknown as
      | { id: string; org_id: string; settings: string }
      | undefined;
    if (!row) throw notFound('项目不存在');

    const value = clampBriefChars(maxChars);
    const settings = parseSettingsJson(row.settings);
    settings.briefMaxChars = value;
    db.prepare('UPDATE projects SET settings = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(settings),
      nowIso(),
      projectId,
    );

    const generated = await ensureBrief(
      { db, llm },
      { projectId, maxChars: value, includePrivate: true, force: true, allowLlm: true },
    );

    writeAudit(db, {
      orgId: row.org_id,
      projectId,
      actor,
      action: 'memory.brief.settings',
      resourceType: 'project',
      resourceId: projectId,
      detail: { maxChars: value },
    });
    return generated;
  }

  async function dreamStatus(projectId: string): Promise<MemoryDreamStatus> {
    return getDreamStatus(db, projectId);
  }

  async function personDreamStatus(projectId: string, personRef: string): Promise<MemoryDreamStatus> {
    const person = resolvePerson(db, projectId, personRef);
    if (!person) throw notFound('人不存在');
    return getPersonDreamStatus(db, projectId, person.id);
  }

  async function updateDreamSettings(
    projectId: string,
    input: MemoryDreamSettingsInput,
    actor: Actor,
  ): Promise<MemoryDreamStatus> {
    const status = updateDreamSettingsRecord(db, projectId, input);
    writeAudit(db, {
      orgId: projectOrgId(projectId),
      projectId,
      actor,
      action: 'memory.dream.settings',
      resourceType: 'project',
      resourceId: projectId,
      detail: {
        enabled: status.settings.enabled,
        intervalMinutes: status.settings.intervalMinutes,
      },
    });
    return status;
  }

  async function dream(input: MemoryDreamInput, actor: Actor): Promise<MemoryDreamResult> {
    const projectId = input.projectId;
    const personId = input.personId?.trim() ? requirePerson(projectId, input.personId).id : undefined;
    let run: MemoryDreamRun | null = null;
    let failedRun: MemoryDreamRun | undefined;
    try {
      // addMemory 用本文件的 add 闭包：洞见走完整引擎路径（索引/实体/历史一致）。
      run = await runDream(
        { db, llm, addMemory: add },
        projectId,
        input.trigger ?? 'manual',
        input.batchSize,
        { personId },
      );
      return { run, status: getDreamStatus(db, projectId) };
    } catch (error) {
      // 手动触发失败会 rethrow；仍要留下审计（failed run 已落库）。
      const latest = latestDreamRun(db, projectId, personId);
      failedRun = latest?.status === 'failed' ? latest : undefined;
      throw error;
    } finally {
      const audited = run ?? failedRun;
      if (audited) {
        writeAudit(db, {
          orgId: projectOrgId(projectId),
          projectId,
          actor,
          action: 'memory.dream.run',
          resourceType: personId ? 'person' : 'project',
          resourceId: personId ?? projectId,
          detail: {
            runId: audited.id,
            trigger: audited.trigger,
            status: audited.status,
            inputCount: audited.inputCount,
            insightCount: audited.insightCount,
            personId: personId ?? null,
          },
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 人（Person）与人的上下文                                             */
  /* ------------------------------------------------------------------ */

  async function persons(input: PersonListInput): Promise<Paginated<Person>> {
    return listPersons(db, input);
  }

  async function person(projectId: string, personRef: string): Promise<Person | null> {
    const row = resolvePerson(db, projectId, personRef);
    if (!row) return null;
    return mapPerson(row, loadPersonStats(db, projectId, row.id));
  }

  /** 校验人写入参数（HTTP 层之外再兜一层，保证引擎契约不被脏数据破坏）。 */
  function validatePersonInput(input: Partial<PersonInput>): void {
    if (input.externalId !== undefined && !input.externalId.trim()) {
      throw unprocessable('person.externalId 不能为空');
    }
    if (input.type !== undefined && !isPersonType(input.type)) {
      throw unprocessable(`person.type 不合法：${String(input.type)}`);
    }
    if (input.status !== undefined && !isPersonStatus(input.status)) {
      throw unprocessable(`person.status 不合法：${String(input.status)}`);
    }
  }

  async function upsertPerson(projectId: string, input: PersonInput, actor: Actor): Promise<Person> {
    validatePersonInput(input);
    const row = upsertPersonRecord(db, projectId, input, { actor });
    return mapPerson(row, loadPersonStats(db, projectId, row.id));
  }

  async function updatePerson(
    projectId: string,
    personRef: string,
    input: Partial<PersonInput>,
    actor: Actor,
  ): Promise<Person> {
    validatePersonInput(input);
    const row = updatePersonRecord(db, projectId, personRef, input, actor);
    return mapPerson(row, loadPersonStats(db, projectId, row.id));
  }

  /**
   * 人的上下文：人资料 + 人的简报 + 高相关记忆（约 8 条）+（可选）分区共享知识，
   * 组装成可直接注入提示词的 prompt，并返回 token 估算与引用记忆 id。
   */
  async function personContext(input: PersonContextInput): Promise<PersonContext> {
    const personRow = requirePerson(input.projectId, input.personRef);
    const builtAt = nowIso();

    const brief = await ensureBrief(
      { db, llm },
      { projectId: input.projectId, personId: personRow.id, includePrivate: true },
    );

    const query = input.query?.trim();
    let memories: Memory[];
    if (query) {
      memories = (
        await search({
          projectId: input.projectId,
          query,
          personId: personRow.id,
          includePrivate: true,
          topK: 8,
        })
      ).results;
    } else {
      memories = (
        await list({
          projectId: input.projectId,
          personId: personRow.id,
          includePrivate: true,
          sort: 'recent',
          page: 1,
          pageSize: 8,
        })
      ).items;
    }

    const shared: Memory[] = [];
    if (input.includePartition !== false) {
      const page = await list({
        projectId: input.projectId,
        scope: 'partition',
        includePrivate: false,
        sort: 'recent',
        page: 1,
        pageSize: 8,
      });
      shared.push(...page.items);
    }

    const person = mapPerson(personRow, loadPersonStats(db, input.projectId, personRow.id));
    const lines: string[] = [];
    const citations: string[] = [];
    const pushCitation = (id: string) => {
      if (citations.length < 20 && !citations.includes(id)) citations.push(id);
    };

    const displayName = person.displayName || person.externalId;
    lines.push(`# 人的上下文：${displayName}`);
    lines.push('');
    lines.push(`- 人：${displayName}（${person.type} · ${person.externalId}）`);
    lines.push(`- 分区：${input.projectId}`);
    const attributes = Object.keys(person.attributes);
    if (attributes.length > 0) lines.push(`- 资料：${JSON.stringify(person.attributes)}`);
    lines.push(`- 生成时间：${builtAt}`);

    if (brief.count > 0) {
      lines.push('');
      lines.push('## 人的简报');
      const body = brief.text.split('\n');
      if (body[0]?.startsWith('# 记忆简报')) body.shift();
      for (const line of body) if (line.trim()) lines.push(line);
    }

    lines.push('');
    lines.push('## 相关记忆');
    if (memories.length === 0) {
      lines.push('- （暂无）');
    } else {
      for (const memory of memories) {
        lines.push(`- [${memory.id}] ${memory.content.replace(/\s+/g, ' ').trim()}`);
        pushCitation(memory.id);
      }
    }

    if (input.includePartition !== false) {
      lines.push('');
      lines.push('## 分区共享知识');
      if (shared.length === 0) {
        lines.push('- （暂无）');
      } else {
        for (const memory of shared) {
          lines.push(`- [${memory.id}] ${memory.content.replace(/\s+/g, ' ').trim()}`);
          pushCitation(memory.id);
        }
      }
    }

    const prompt = lines.join('\n');
    return {
      person,
      brief,
      memories,
      shared,
      prompt,
      tokenEstimate: estimateTokens(prompt),
      citations,
      builtAt,
    };
  }

  return {
    add,
    search,
    list,
    get,
    update,
    remove,
    bulk,
    history,
    feedback,
    graph,
    stats,
    agents,
    agent,
    createAgent,
    updateAgent,
    tasks,
    task,
    createTask,
    updateTask,
    finishTask,
    briefing,
    brief,
    updateBriefSettings,
    dreamStatus,
    personDreamStatus,
    updateDreamSettings,
    dream,
    persons,
    person,
    upsertPerson,
    updatePerson,
    personContext,
  };
}
