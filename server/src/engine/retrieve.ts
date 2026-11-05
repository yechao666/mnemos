/**
 * 多信号混合检索。
 *
 * 信号与聚合：
 * - semantic : 查询向量与记忆向量的余弦相似度（clamp 0..1）
 * - keyword  : BM25（k1=1.2, b=0.75；df 来自 memory_terms，N 为项目 active 记忆数），按候选最大值归一化
 * - entity   : 查询实体命中占比（命中实体数 / 查询实体数）
 * - recency  : exp(-days / 30)
 * - importance: 记忆自身 importance
 *
 * 最终分 = settings.weights 加权和；查询实体在候选集中无任何命中时，
 * entity 权重按 semantic/keyword 现有比例分摊（契约要求）。
 * importance 不在 weights 中，作为 ±6% 的乘性微调参与排序，避免破坏权重语义。
 */

import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PROJECT_SETTINGS } from '../../../shared/src/constants.ts';
import type { MemoryVisibility, RetrievalWeights, SearchFilters, SearchHit, SignalScores } from '../../../shared/src/types.ts';
import { blobToVector, cosine, embedText } from './embed.ts';
import { extractEntities, normalizeEntityName } from './extract.ts';
import { tokenize } from './tokenize.ts';
import { chunk, loadSettings, mapMemory, visibilityClause, type MemoryRow } from './store.ts';

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** 候选集上限（SQL 预筛） */
const MAX_CANDIDATES = 4000;
const MAX_QUERY_TERMS = 24;
const MAX_QUERY_ENTITIES = 16;
/** recency 衰减半衰尺度（天） */
const RECENCY_DAYS = 30;
const DAY_MS = 86_400_000;

export interface RetrieveInput {
  projectId: string;
  query: string;
  userId?: string;
  agentId?: string;
  writtenByAgentId?: string;
  runId?: string;
  appId?: string;
  /** 仅返回该任务写入的记忆 */
  taskId?: string;
  /** 仅返回指定可见性 */
  visibility?: MemoryVisibility;
  /** 控制台 / 审计视角：包含所有 Agent 私有与任务记忆 */
  includePrivate?: boolean;
  filters?: SearchFilters;
  topK?: number;
  threshold?: number;
}

export interface RetrieveResult {
  hits: SearchHit[];
  total: number;
  tookMs: number;
  queryTerms: string[];
  strategy: string;
  weights: RetrievalWeights;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round(value: number, digits: number): number {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

/** 权重归一化，保证总和为 1（缺省/全零时回退默认权重）。 */
function normalizeWeights(weights: RetrievalWeights): RetrievalWeights {
  const sum = weights.semantic + weights.keyword + weights.entity + weights.recency;
  if (sum <= 0) return { ...DEFAULT_PROJECT_SETTINGS.weights };
  return {
    semantic: weights.semantic / sum,
    keyword: weights.keyword / sum,
    entity: weights.entity / sum,
    recency: weights.recency / sum,
  };
}

/** 实体信号整体未命中时，把 entity 权重按比例分摊到 semantic / keyword。 */
function redistributeEntityWeight(weights: RetrievalWeights): RetrievalWeights {
  const textWeights = weights.semantic + weights.keyword;
  if (weights.entity <= 0 || textWeights <= 0) return { ...weights, entity: 0 };
  return {
    semantic: weights.semantic + weights.entity * (weights.semantic / textWeights),
    keyword: weights.keyword + weights.entity * (weights.keyword / textWeights),
    entity: 0,
    recency: weights.recency,
  };
}

function metadataMatches(metadata: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in metadata)) return false;
    const actual = metadata[key];
    if (actual === value) continue;
    if (actual && typeof actual === 'object' && value && typeof value === 'object') {
      if (JSON.stringify(actual) === JSON.stringify(value)) continue;
    }
    return false;
  }
  return true;
}

function tagsMatch(tags: string[], expected: string[]): boolean {
  if (expected.length === 0) return true;
  return expected.some((tag) => tags.includes(tag));
}

function recencyScore(createdAt: string, now: number): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 0;
  const days = Math.max(0, (now - created) / DAY_MS);
  return Math.exp(-days / RECENCY_DAYS);
}

/** 执行一次混合检索（同步；service 负责异步包装与访问计数）。 */
export function retrieve(db: DatabaseSync, input: RetrieveInput): RetrieveResult {
  const started = performance.now();
  const settings = loadSettings(db, input.projectId);
  const filters: SearchFilters = input.filters ?? {};
  const status = filters.status ?? 'active';
  const query = input.query ?? '';
  const queryTerms = tokenize(query).slice(0, MAX_QUERY_TERMS);
  const queryVector = embedText(query);

  // 1) SQL 预筛：scope + status + 时间/分类/重要度
  const where: string[] = ['m.project_id = ?', 'm.status = ?'];
  const params: (string | number)[] = [input.projectId, status];
  if (input.userId !== undefined) {
    where.push('m.user_id = ?');
    params.push(input.userId);
  }
  // 注意：agentId 是「调用方身份」，只参与可见性判定，不能在这里硬过滤；
  // 需要「只看某人写的」时用 writtenByAgentId。
  if (input.writtenByAgentId !== undefined) {
    where.push('m.agent_id = ?');
    params.push(input.writtenByAgentId);
  }
  if (input.runId !== undefined) {
    where.push('m.run_id = ?');
    params.push(input.runId);
  }
  if (input.appId !== undefined) {
    where.push('m.app_id = ?');
    params.push(input.appId);
  }
  // 任务上下文：taskId 为调用方任务，既要作为可见性依据，也保持旧的「仅本任务」过滤语义。
  if (input.taskId !== undefined) {
    where.push('m.task_id = ?');
    params.push(input.taskId);
  }
  const visible = visibilityClause({
    agentId: input.agentId,
    taskId: input.taskId,
    visibility: input.visibility,
    includePrivate: input.includePrivate,
  });
  if (visible.sql) {
    where.push(visible.sql);
    params.push(...visible.params);
  }
  if (filters.category) {
    where.push('m.category = ?');
    params.push(filters.category);
  }
  if (typeof filters.minImportance === 'number') {
    where.push('m.importance >= ?');
    params.push(filters.minImportance);
  }
  if (filters.createdAfter) {
    where.push('m.created_at >= ?');
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore) {
    where.push('m.created_at <= ?');
    params.push(filters.createdBefore);
  }
  const rawCandidates = db
    .prepare(
      `SELECT * FROM memories m
       WHERE ${where.join(' AND ')}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${MAX_CANDIDATES}`,
    )
    .all(...params) as unknown as MemoryRow[];

  // tags / metadata 在 JS 层过滤（JSON 字段，SQL 过滤代价高且易误伤）
  const candidates = rawCandidates.filter((row) => {
    const memory = mapMemory(row);
    if (filters.tags && !tagsMatch(memory.tags, filters.tags)) return false;
    if (filters.metadata && !metadataMatches(memory.metadata, filters.metadata)) return false;
    return true;
  });

  // 2) BM25 统计量
  const activeRow = db
    .prepare("SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND status = 'active'")
    .get(input.projectId) as unknown as { c: number } | undefined;
  const totalDocs = Math.max(1, Number(activeRow?.c ?? 0));
  const dlRow = db
    .prepare('SELECT COALESCE(SUM(tf), 0) AS total, COUNT(DISTINCT memory_id) AS docs FROM memory_terms WHERE project_id = ?')
    .get(input.projectId) as unknown as { total: number; docs: number } | undefined;
  const avgdl = Number(dlRow?.docs ?? 0) > 0 ? Number(dlRow?.total ?? 0) / Number(dlRow?.docs ?? 1) : 1;

  const df = new Map<string, number>();
  const termTf = new Map<string, Map<string, number>>();
  const docLength = new Map<string, number>();
  if (queryTerms.length > 0) {
    const placeholders = queryTerms.map(() => '?').join(', ');
    const dfRows = db
      .prepare(`SELECT term, COUNT(*) AS df FROM memory_terms WHERE project_id = ? AND term IN (${placeholders}) GROUP BY term`)
      .all(input.projectId, ...queryTerms) as unknown as { term: string; df: number }[];
    for (const row of dfRows) df.set(row.term, Number(row.df));

    const tfRows = db
      .prepare(`SELECT memory_id, term, tf FROM memory_terms WHERE project_id = ? AND term IN (${placeholders})`)
      .all(input.projectId, ...queryTerms) as unknown as { memory_id: string; term: string; tf: number }[];
    for (const row of tfRows) {
      const bag = termTf.get(row.memory_id) ?? new Map<string, number>();
      bag.set(row.term, Number(row.tf));
      termTf.set(row.memory_id, bag);
    }
  }
  const dlRows = db
    .prepare('SELECT memory_id, SUM(tf) AS dl FROM memory_terms WHERE project_id = ? GROUP BY memory_id')
    .all(input.projectId) as unknown as { memory_id: string; dl: number }[];
  for (const row of dlRows) docLength.set(row.memory_id, Number(row.dl));

  function bm25(memoryId: string): number {
    const bag = termTf.get(memoryId);
    if (!bag || bag.size === 0) return 0;
    const dl = docLength.get(memoryId) ?? 0;
    let score = 0;
    for (const term of queryTerms) {
      const tf = bag.get(term);
      if (!tf) continue;
      const dfv = df.get(term) ?? 0;
      const idf = Math.log(1 + (totalDocs - dfv + 0.5) / (dfv + 0.5));
      score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl));
    }
    return score;
  }

  // 3) 实体命中
  const queryEntities: string[] = [];
  for (const entity of extractEntities(query).slice(0, MAX_QUERY_ENTITIES)) {
    const normalized = normalizeEntityName(entity.name);
    if (normalized && !queryEntities.includes(normalized)) queryEntities.push(normalized);
  }
  const entityMatches = new Map<string, number>();
  if (queryEntities.length > 0 && candidates.length > 0) {
    const entityPlaceholders = queryEntities.map(() => '?').join(', ');
    const entityRows = db
      .prepare(`SELECT id FROM entities WHERE project_id = ? AND normalized IN (${entityPlaceholders})`)
      .all(input.projectId, ...queryEntities) as unknown as { id: string }[];
    const matchedIds = entityRows.map((row) => row.id);
    if (matchedIds.length > 0) {
      const idPlaceholders = matchedIds.map(() => '?').join(', ');
      for (const ids of chunk(candidates.map((row) => row.id), 400)) {
        const memoryPlaceholders = ids.map(() => '?').join(', ');
        const links = db
          .prepare(
            `SELECT memory_id, entity_id FROM memory_entities
             WHERE entity_id IN (${idPlaceholders}) AND memory_id IN (${memoryPlaceholders})`,
          )
          .all(...matchedIds, ...ids) as unknown as { memory_id: string; entity_id: string }[];
        for (const link of links) entityMatches.set(link.memory_id, (entityMatches.get(link.memory_id) ?? 0) + 1);
      }
    }
  }
  const entityHitTotal = [...entityMatches.values()].reduce((sum, count) => sum + count, 0);

  // 4) 逐条打分
  const weights = normalizeWeights(settings.weights);
  const effective = entityHitTotal > 0 ? weights : redistributeEntityWeight(weights);
  const now = Date.now();
  const scored = candidates.map((row) => {
    const memory = mapMemory(row);
    const semantic = clamp01(cosine(queryVector, blobToVector(row.embedding)));
    const keywordRaw = bm25(row.id);
    const entity = queryEntities.length > 0 ? clamp01((entityMatches.get(row.id) ?? 0) / queryEntities.length) : 0;
    const recency = recencyScore(row.created_at, now);
    const importance = clamp01(Number(row.importance));
    return { row, memory, semantic, keywordRaw, entity, recency, importance };
  });

  const keywordMax = scored.reduce((max, item) => Math.max(max, item.keywordRaw), 0);
  const threshold = input.threshold ?? settings.threshold;
  const topK = Math.max(1, Math.round(input.topK ?? settings.topK));

  const evaluated = scored.map((item) => {
    const keyword = keywordMax > 0 ? clamp01(item.keywordRaw / keywordMax) : 0;
    const base =
      effective.semantic * item.semantic +
      effective.keyword * keyword +
      effective.entity * item.entity +
      effective.recency * item.recency;
    // importance 作乘性微调（0.94x ~ 1.06x），不改变权重语义
    const score = clamp01(base * (0.94 + 0.12 * item.importance));
    const matchedOn: string[] = [];
    if (item.semantic >= 0.25) matchedOn.push('semantic');
    if (keyword > 0) matchedOn.push('keyword');
    if (item.entity > 0) matchedOn.push('entity');
    if (item.recency >= 0.5) matchedOn.push('recency');
    const signals: SignalScores = {
      semantic: round(item.semantic, 3),
      keyword: round(keyword, 3),
      entity: round(item.entity, 3),
      recency: round(item.recency, 3),
      importance: round(item.importance, 3),
    };
    return { item, score, signals, matchedOn };
  });

  const passing = evaluated
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || b.item.row.created_at.localeCompare(a.item.row.created_at) || a.item.row.id.localeCompare(b.item.row.id));
  const top = passing.slice(0, topK);

  // 5) 命中记忆的实体名（用于结果卡片展示）
  const entityNames = new Map<string, string[]>();
  if (top.length > 0) {
    const placeholders = top.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT me.memory_id, e.name, me.salience FROM memory_entities me
         JOIN entities e ON e.id = me.entity_id
         WHERE me.memory_id IN (${placeholders})
         ORDER BY me.salience DESC, e.name ASC`,
      )
      .all(...top.map((entry) => entry.item.row.id)) as unknown as { memory_id: string; name: string; salience: number }[];
    for (const row of rows) {
      const list = entityNames.get(row.memory_id) ?? [];
      if (!list.includes(row.name)) list.push(row.name);
      entityNames.set(row.memory_id, list);
    }
  }

  const hits: SearchHit[] = top.map((entry) => ({
    ...entry.item.memory,
    score: round(entry.score, 4),
    signals: entry.signals,
    matchedOn: entry.matchedOn,
    entities: entityNames.get(entry.item.row.id) ?? [],
  }));

  const strategy =
    entityHitTotal > 0
      ? 'hybrid:semantic+keyword+entity+recency'
      : 'hybrid:semantic+keyword+recency (entity weight redistributed)';

  return {
    hits,
    total: passing.length,
    tookMs: Math.round((performance.now() - started) * 10) / 10,
    queryTerms,
    strategy,
    weights: {
      semantic: round(effective.semantic, 4),
      keyword: round(effective.keyword, 4),
      entity: round(effective.entity, 4),
      recency: round(effective.recency, 4),
    },
  };
}
