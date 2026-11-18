import type { DatabaseSync } from 'node:sqlite';
import type {
  Memory,
  MemorySearchHit,
  MemorySearchInput,
  MemorySearchMode,
  MemorySearchResponse,
  MemorySearchSignals,
  RetrievalWeights,
} from '../../../shared/src/types.ts';
import { attachmentCaptions, withAttachmentCounts } from './attachments.ts';
import { blobToEmbedding, cosine, embedText } from './embed.ts';
import { engineErrors } from './errors.ts';
import { findPartitionById } from './partition.ts';
import { resolvePersonRow } from './persons.ts';
import { withPlaceholderCounts } from './privacy.ts';
import {
  escapeLike,
  ftsQuery,
  likeContains,
  needsSubstringSearch,
  parseSettings,
  toMemory,
  type MemoryRow,
} from './rows.ts';

/**
 * v6.1 P0 混合检索：
 *
 *  candidate = FTS 前缀 top 300 ∪ 该人最近 200 ∪ 分区共享最近 200（按 id 去重）
 *  rank = Σ w_i * normalized(signal_i)，signal = vector / keyword / recency / importance / entity
 *
 *  - mode=keyword：只走 FTS（CJK 退化为子串），按关键词信号排序。
 *  - mode=vector：候选正余弦重排；候选不足时补最近记忆。
 *  - mode=hybrid（默认）：三者融合；候选都没有 embedding 时退化为 keyword 排序。
 *  - 默认排除 valid_to 非空（已被取代/失效）；asOf 做时间点回看。
 */

const FTS_LIMIT = 300;
const RECENT_LIMIT = 200;
const VECTOR_RECENT_LIMIT = 500;
const MAX_CANDIDATES = 700;
const DEFAULT_TOP_K = 8;
const DEFAULT_WEIGHTS: RetrievalWeights = { vector: 0.45, keyword: 0.3, recency: 0.15, importance: 0.1, entity: 0 };
const ASCII_TERM_RE = /[a-z0-9][a-z0-9_.+#-]*/g;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

interface QueryParts {
  sql: string;
  params: (string | number)[];
  limit: number;
}

interface Candidate {
  row: MemoryRow;
  memory: Memory;
  vector: number;
  keyword: number;
  recency: number;
  importance: number;
  entity: number;
  /** 附件 caption 命中强度（只用于 matchedOn 标记，不单独计入权重） */
  attachment: number;
  score: number;
  matchedOn: string[];
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function memTerms(text: string): { ascii: string[]; chars: Set<string>; bigrams: Set<string> } {
  const lower = text.normalize('NFKC').toLowerCase();
  const ascii = [...lower.matchAll(ASCII_TERM_RE)].map((match) => match[0]).filter((term) => term.length >= 2);
  const chars = new Set<string>();
  const bigrams = new Set<string>();
  for (const match of lower.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    for (let index = 0; index < run.length; index += 1) {
      const char = run[index] ?? '';
      chars.add(char);
      const bigram = char + (run[index + 1] ?? '');
      if (bigram.length === 2) bigrams.add(bigram);
    }
  }
  return { ascii, chars, bigrams };
}

/**
 * 关键词相关性（0–1）：CJK 二元组/单字覆盖率 + 英文词命中率；整句子串命中直接记 1。
 * 不使用 FTS rank，保证 hybrid 融合时信号可解释、可跨模式比较。
 */
export function keywordScore(content: string, query: string): number {
  const q = query.trim();
  if (!q) return 0;
  const lowerContent = content.normalize('NFKC').toLowerCase();
  const lowerQuery = q.normalize('NFKC').toLowerCase();
  if (lowerContent.includes(lowerQuery)) return 1;
  const queryTerms = memTerms(q);
  let score = 0;
  let parts = 0;
  if (queryTerms.ascii.length > 0) {
    let hit = 0;
    for (const term of queryTerms.ascii) {
      if (lowerContent.includes(term)) hit += 1;
    }
    score += (hit / queryTerms.ascii.length) * 0.6;
    parts += 0.6;
  }
  if (queryTerms.chars.size > 0) {
    const contentTerms = memTerms(content);
    let bigramHit = 0;
    for (const bigram of queryTerms.bigrams) if (contentTerms.bigrams.has(bigram)) bigramHit += 1;
    let charHit = 0;
    for (const char of queryTerms.chars) if (contentTerms.chars.has(char)) charHit += 1;
    const bigramRatio = queryTerms.bigrams.size > 0 ? bigramHit / queryTerms.bigrams.size : 0;
    const charRatio = queryTerms.chars.size > 0 ? charHit / queryTerms.chars.size : 0;
    score += bigramRatio * 0.7 + charRatio * 0.3;
    parts += 1;
  }
  return parts > 0 ? clamp01(score / parts) : 0;
}

function queryTermsOf(query: string): string[] {
  const terms = memTerms(query);
  return [...new Set([...terms.ascii, ...terms.chars, ...terms.bigrams])];
}

function validityCondition(
  conditions: string[],
  params: (string | number)[],
  asOf: string | undefined,
  includeSuperseded: boolean,
): void {
  if (includeSuperseded) {
    if (asOf) {
      conditions.push('(m.valid_from IS NULL OR m.valid_from <= ?)');
      params.push(asOf);
    }
    return;
  }
  if (asOf) {
    conditions.push('(m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_to IS NULL OR m.valid_to > ?)');
    params.push(asOf, asOf);
  } else {
    conditions.push('m.valid_to IS NULL');
  }
}

function keywordQuery(
  input: MemorySearchInput,
  baseConditions: string[],
  baseParams: (string | number)[],
  mode: MemorySearchMode,
  personId: string | null,
): QueryParts | null {
  const q = (input.query ?? '').trim();
  if (!q) return null;
  const conditions = [...baseConditions];
  const params = [...baseParams];
  // 人级视角（默认）：只能看到本人记忆 + 分区共享；控制台/审计可 includePrivate 看全部。
  if (personId && input.includePrivate !== true) {
    conditions.push("(m.person_id = ? OR m.scope = 'partition')");
    params.push(personId);
  }
  const match = ftsQuery(q);
  if (!needsSubstringSearch(q) && q.length >= 3 && match) {
    conditions.push('m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
    params.push(match);
  } else {
    // CJK/短查询：unicode61 会把连续 CJK 当整词，前缀无法命中词中段 → 按查询词子串 OR。
    const terms = q
      .split(/[^\p{L}\p{N}]+/u)
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (terms.length === 0) return null;
    const likes = terms.map(() => "m.content LIKE ? ESCAPE '\\'");
    conditions.push(`(${likes.join(' OR ')})`);
    for (const term of terms) params.push(likeContains(term.slice(0, 200)));
  }
  return {
    sql: conditions.join(' AND '),
    params,
    limit: mode === 'keyword' ? FTS_LIMIT : FTS_LIMIT,
  };
}

/**
 * 附件 caption 候选（P2 轻量检索）：把 caption LIKE 命中的记忆并入候选集，
 * 让「图片描述」这类不在 content 里的文字也能被检索到。
 */
function captionQuery(
  input: MemorySearchInput,
  baseConditions: string[],
  baseParams: (string | number)[],
  personId: string | null,
): QueryParts | null {
  const q = (input.query ?? '').trim();
  if (!q) return null;
  const conditions = [...baseConditions];
  const params = [...baseParams];
  if (personId && input.includePrivate !== true) {
    conditions.push("(m.person_id = ? OR m.scope = 'partition')");
    params.push(personId);
  }
  const terms = q
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (terms.length === 0) return null;
  const likes = terms.map(() => "a.caption LIKE ? ESCAPE '\\'");
  conditions.push(`(${likes.join(' OR ')})`);
  for (const term of terms) params.push(likeContains(term.slice(0, 200)));
  return { sql: conditions.join(' AND '), params, limit: FTS_LIMIT };
}

function runCaptionCandidateQuery(db: DatabaseSync, parts: QueryParts): MemoryRow[] {
  return db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m
         JOIN persons p ON p.id = m.person_id
         JOIN memory_attachments a ON a.memory_id = m.id
        WHERE ${parts.sql}
        GROUP BY m.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(...parts.params, parts.limit) as unknown as MemoryRow[];
}

function runCandidateQuery(db: DatabaseSync, parts: QueryParts): MemoryRow[] {
  return db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m JOIN persons p ON p.id = m.person_id
        WHERE ${parts.sql}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(...parts.params, parts.limit) as unknown as MemoryRow[];
}

function entitySignals(db: DatabaseSync, ids: string[], terms: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (ids.length === 0 || terms.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT me.memory_id AS memory_id, e.name AS name
         FROM memory_entities me JOIN entities e ON e.id = me.entity_id
        WHERE me.memory_id IN (${placeholders})`,
    )
    .all(...ids) as unknown as { memory_id: string; name: string }[];
  const termSet = new Set(terms.map((term) => term.toLowerCase()));
  for (const row of rows) {
    const name = row.name.toLowerCase();
    let score = 0;
    for (const term of termSet) {
      if (name === term || name.includes(term) || term.includes(name)) score = Math.max(score, 0.8);
      else if (term.length >= 2 && name.length >= 2) score = Math.max(score, 0.4);
    }
    if (score > 0) result.set(row.memory_id, Math.max(result.get(row.memory_id) ?? 0, score));
  }
  return result;
}

function weightsOf(settings: ReturnType<typeof parseSettings>): RetrievalWeights {
  const weights = settings.retrievalWeights ?? DEFAULT_WEIGHTS;
  const total = weights.vector + weights.keyword + weights.recency + weights.importance + weights.entity;
  return total > 0 ? weights : { ...DEFAULT_WEIGHTS };
}

function strategyOf(mode: MemorySearchMode, candidateCount: number, embeddedCount: number, asOf?: string): string {
  const parts: string[] = [];
  if (mode === 'hybrid') {
    parts.push(embeddedCount === 0 ? 'hybrid:keyword-fallback(no-embedding)' : 'hybrid:vector+keyword+recency+importance');
  } else if (mode === 'keyword') {
    parts.push('keyword:fts');
  } else {
    parts.push(embeddedCount === 0 ? 'vector:cosine(no-embedding,recent)' : 'vector:cosine');
  }
  parts.push(`cand=${candidateCount}`);
  parts.push(`embed=${embeddedCount}`);
  if (asOf) parts.push(`as_of=${asOf}`);
  return parts.join(';');
}

/** 混合检索主入口。同步访问 SQLite；候选集上限 700，不做全表扫描。 */
export function searchMemories(db: DatabaseSync, input: MemorySearchInput): MemorySearchResponse {
  const started = Date.now();
  const partition = findPartitionById(db, input.partitionId);
  if (!partition) throw engineErrors.notFound('分区不存在');
  const settings = parseSettings(partition.settings);
  const mode: MemorySearchMode = input.mode ?? settings.retrievalMode;
  const topK = Math.min(50, Math.max(1, Math.trunc(input.topK ?? DEFAULT_TOP_K)));
  const query = (input.query ?? '').trim();
  let asOf: string | undefined;
  if (input.asOf) {
    const parsed = Date.parse(input.asOf);
    if (!Number.isFinite(parsed)) throw engineErrors.validation('as_of 必须是合法的 ISO 8601 时间字符串');
    asOf = new Date(parsed).toISOString();
  }
  const includeSuperseded = input.includeSuperseded === true;
  const personRequested = Boolean(input.personId || input.personExternalId);

  let personId = input.personId ?? null;
  if (!personId && input.personExternalId) {
    const person = resolvePersonRow(db, input.partitionId, input.personExternalId);
    personId = person?.id ?? null;
  } else if (personId) {
    const person = resolvePersonRow(db, input.partitionId, personId);
    personId = person?.id ?? null;
  }
  if (personRequested && !personId) {
    return { hits: [], tookMs: Date.now() - started, mode, strategy: 'person-not-found' };
  }

  const baseConditions: string[] = ["m.partition_id = ?", "m.status = 'active'"];
  const baseParams: (string | number)[] = [input.partitionId];
  validityCondition(baseConditions, baseParams, asOf, includeSuperseded);
  if (input.category) {
    baseConditions.push('m.category = ?');
    baseParams.push(input.category);
  }
  if (input.scope) {
    baseConditions.push('m.scope = ?');
    baseParams.push(input.scope);
  }

  const queries: QueryParts[] = [];
  const keywordPart = keywordQuery(input, baseConditions, baseParams, mode, personId);
  if (keywordPart) queries.push(keywordPart);
  const captionPart = captionQuery(input, baseConditions, baseParams, personId);

  const includeRecent = mode !== 'keyword';
  if (includeRecent) {
    if (personId && input.includePrivate !== true) {
      const conditions = [...baseConditions, 'm.person_id = ?'];
      const params = [...baseParams, personId];
      queries.push({
        sql: conditions.join(' AND '),
        params,
        limit: mode === 'vector' ? VECTOR_RECENT_LIMIT : RECENT_LIMIT,
      });
      const sharedConditions = [...baseConditions, "m.scope = 'partition'"];
      queries.push({
        sql: sharedConditions.join(' AND '),
        params: [...baseParams],
        limit: mode === 'vector' ? VECTOR_RECENT_LIMIT : RECENT_LIMIT,
      });
    } else {
      queries.push({
        sql: baseConditions.join(' AND '),
        params: [...baseParams],
        limit: mode === 'vector' ? VECTOR_RECENT_LIMIT : RECENT_LIMIT,
      });
    }
  }

  const seen = new Set<string>();
  const candidates: MemoryRow[] = [];
  const accept = (row: MemoryRow): void => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    candidates.push(row);
  };
  for (const parts of queries) {
    for (const row of runCandidateQuery(db, parts)) {
      accept(row);
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  // P2：附件 caption 命中的记忆并入候选（content 里没有的字也能被搜到）。
  if (captionPart && candidates.length < MAX_CANDIDATES) {
    for (const row of runCaptionCandidateQuery(db, captionPart)) {
      accept(row);
      if (candidates.length >= MAX_CANDIDATES) break;
    }
  }

  if (candidates.length === 0) {
    return { hits: [], tookMs: Date.now() - started, mode, strategy: strategyOf(mode, 0, 0, asOf) };
  }

  const queryVector = query ? embedText(query) : null;
  const queryTerms = queryTermsOf(query);
  const entityScores = entitySignals(db, candidates.map((row) => row.id), queryTerms);
  const captionScores = attachmentCaptions(db, candidates.map((row) => row.id));
  const weights = weightsOf(settings);
  const now = Date.now();

  const scored: Candidate[] = candidates.map((row) => {
    const memory = toMemory(row);
    const vector = queryVector
      ? clamp01(cosine(queryVector, blobToEmbedding(row.embedding)))
      : 0;
    const contentKeyword = query ? keywordScore(row.content, query) : 0;
    // 附件 caption 作为记忆的轻量文本参与 keyword 信号；同时单独记录命中用于 matchedOn。
    let attachment = 0;
    for (const caption of captionScores.get(row.id) ?? []) {
      if (!query) break;
      attachment = Math.max(attachment, keywordScore(caption, query));
    }
    const keyword = Math.max(contentKeyword, attachment);
    const createdMs = Date.parse(row.created_at);
    const ageDays = Number.isFinite(createdMs) ? Math.max(0, (now - createdMs) / 86_400_000) : 365;
    const recency = clamp01(0.5 ** (ageDays / 30));
    // importance 信号同时吸收 confidence：反馈（±0.05）会微调排序，避免反馈只改展示。
    const importance = clamp01(row.importance * 0.7 + row.confidence * 0.3);
    const entity = clamp01(entityScores.get(row.id) ?? 0);
    return { row, memory, vector, keyword, recency, importance, entity, attachment, score: 0, matchedOn: [] };
  });

  const embeddedCount = candidates.reduce((count, row) => count + (row.embedding && row.embedding.length > 0 ? 1 : 0), 0);
  const degraded = mode === 'hybrid' && embeddedCount === 0;
  const totalWeight = weights.vector + weights.keyword + weights.recency + weights.importance + weights.entity;

  for (const item of scored) {
    let score: number;
    if (mode === 'keyword') {
      score = item.keyword;
    } else if (mode === 'vector') {
      score = item.vector;
    } else if (degraded) {
      score = item.keyword;
    } else {
      score =
        (weights.vector * item.vector +
          weights.keyword * item.keyword +
          weights.recency * item.recency +
          weights.importance * item.importance +
          weights.entity * item.entity) /
        totalWeight;
    }
    item.score = clamp01(score);
    const signals: MemorySearchSignals = {
      vector: item.vector,
      keyword: item.keyword,
      recency: item.recency,
      importance: item.importance,
      entity: item.entity,
    };
    item.matchedOn = (Object.keys(signals) as (keyof MemorySearchSignals)[]).filter(
      (key) => signals[key] > 0.0001,
    );
    if (item.attachment > 0.0001) item.matchedOn.push('attachment');
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.importance !== left.importance) return right.importance - left.importance;
    return right.row.created_at.localeCompare(left.row.created_at);
  });

  // hybrid 候选里包含「该人最近 / 分区共享最近」，它们可能与本查询无关；
  // 用关键词命中或足够高的向量相似度做相关性门槛，避免 topK 被无关记忆填满。
  const relevant =
    query && mode === 'hybrid'
      ? scored.filter((item) => item.keyword > 0.0001 || item.vector >= 0.15)
      : scored;

  const hits: MemorySearchHit[] = withPlaceholderCounts(
    db,
    withAttachmentCounts(
      db,
      relevant.slice(0, topK).map((item) => ({
        ...item.memory,
        score: round(item.score),
        signals: {
          vector: round(item.vector),
          keyword: round(item.keyword),
          recency: round(item.recency),
          importance: round(item.importance),
          entity: round(item.entity),
        },
        matchedOn: item.matchedOn,
      })),
    ),
  );

  return {
    hits,
    tookMs: Date.now() - started,
    mode,
    strategy: strategyOf(mode, candidates.length, embeddedCount, asOf),
  };
}

/** 供测试/脚本使用：LIKE 转义保持一致（避免重复实现）。 */
export { escapeLike };
