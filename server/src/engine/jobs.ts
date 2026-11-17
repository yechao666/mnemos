import type { DatabaseSync } from 'node:sqlite';
import type { MemoryJob, MemoryJobStatus, MemoryJobType } from '../../../shared/src/types.ts';
import { newId, nowIso, sha256 } from '../lib/ids.ts';
import { blobToEmbedding, embedText, EMBEDDING_DIM, EMBEDDING_MODEL, embeddingToBlob } from './embed.ts';
import { parseJson } from './rows.ts';

/**
 * v6.1 P0 异步写管线任务队列（同进程 worker）。
 *
 * 表：memory_jobs(status pending|running|done|failed, attempts, run_after, locked_at, error)。
 * 语义：
 *  - 写入事务内 enqueue；worker 每 1s 取一批 pending（run_after <= now）。
 *  - 处理前 status→running + locked_at，防同一进程/多 tick 重入。
 *  - 失败 attempts+1；< maxAttempts 回到 pending 并按指数退避更新 run_after，否则 failed。
 *  - 崩溃遗留的 running 超过 STALE_LOCK_MS 会重新入队，保证重启不丢任务。
 */

export const MAX_JOB_ATTEMPTS = 5;
export const STALE_LOCK_MS = 5 * 60_000;

export interface JobRow {
  id: string;
  partition_id: string;
  type: string;
  status: string;
  payload: string;
  attempts: number;
  run_after: string;
  locked_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueJobInput {
  partitionId: string;
  type: MemoryJobType;
  payload?: Record<string, unknown>;
  runAfter?: string;
}

export function toMemoryJob(row: JobRow): MemoryJob {
  return {
    id: row.id,
    partitionId: row.partition_id,
    type: row.type as MemoryJobType,
    status: row.status as MemoryJobStatus,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    attempts: row.attempts,
    runAfter: row.run_after,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 入队一个任务（调用方负责放进写入事务）。 */
export function enqueueJob(db: DatabaseSync, input: EnqueueJobInput): string {
  const id = newId('job');
  const at = nowIso();
  db.prepare(
    `INSERT INTO memory_jobs (id, partition_id, type, status, payload, attempts, run_after, error, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, 0, ?, NULL, ?, ?)`,
  ).run(id, input.partitionId, input.type, JSON.stringify(input.payload ?? {}), input.runAfter ?? at, at, at);
  return id;
}

export interface EnqueueMemoryJobsInput {
  partitionId: string;
  personId: string;
  memoryId: string;
  hasEmbedding: boolean;
  autoExtractEntities: boolean;
  factKey?: string | null;
}

/**
 * 写入后的标准任务：缺 embedding→embed；开启实体抽取→extract；有 fact_key→profile。
 * 注意：写入路径已同步计算 embedding，因此 embed 只在导入/旧数据等缺失场景入队。
 */
export function enqueueMemoryJobs(db: DatabaseSync, input: EnqueueMemoryJobsInput): string[] {
  const ids: string[] = [];
  if (!input.hasEmbedding) {
    ids.push(
      enqueueJob(db, {
        partitionId: input.partitionId,
        type: 'embed',
        payload: { memoryId: input.memoryId, personId: input.personId },
      }),
    );
  }
  if (input.autoExtractEntities) {
    ids.push(
      enqueueJob(db, {
        partitionId: input.partitionId,
        type: 'extract',
        payload: { memoryId: input.memoryId, personId: input.personId },
      }),
    );
  }
  if (input.factKey) {
    ids.push(
      enqueueJob(db, {
        partitionId: input.partitionId,
        type: 'profile',
        payload: { memoryId: input.memoryId, personId: input.personId },
      }),
    );
  }
  return ids;
}

/** 崩溃恢复：running 且锁定超过 STALE_LOCK_MS 的任务回到 pending。 */
export function requeueStaleJobs(db: DatabaseSync, now = Date.now()): number {
  const cutoff = new Date(now - STALE_LOCK_MS).toISOString();
  const result = db
    .prepare(
      `UPDATE memory_jobs
          SET status = 'pending', locked_at = NULL, updated_at = ?
        WHERE status = 'running' AND (locked_at IS NULL OR locked_at < ?)`,
    )
    .run(nowIso(), cutoff);
  return Number(result.changes ?? 0);
}

/** 领取一批到期任务：status→running 并 locked_at（attempts 在领取时 +1）。 */
export function claimDueJobs(db: DatabaseSync, limit = 10, now = Date.now()): JobRow[] {
  requeueStaleJobs(db, now);
  const at = new Date(now).toISOString();
  const due = db
    .prepare(
      `SELECT id FROM memory_jobs
        WHERE status = 'pending' AND run_after <= ?
        ORDER BY run_after ASC, created_at ASC
        LIMIT ?`,
    )
    .all(at, Math.max(1, Math.min(100, limit))) as unknown as { id: string }[];
  if (due.length === 0) return [];
  const update = db.prepare(
    `UPDATE memory_jobs
        SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'pending'`,
  );
  const claimed: string[] = [];
  for (const row of due) {
    const result = update.run(at, at, row.id);
    if (Number(result.changes ?? 0) > 0) claimed.push(row.id);
  }
  if (claimed.length === 0) return [];
  const placeholders = claimed.map(() => '?').join(', ');
  return db
    .prepare(`SELECT * FROM memory_jobs WHERE id IN (${placeholders}) ORDER BY run_after ASC, created_at ASC`)
    .all(...claimed) as unknown as JobRow[];
}

/* ------------------------------------------------------------------ */
/* 任务执行                                                            */
/* ------------------------------------------------------------------ */

const QUOTED_ENTITY_RE = /[「『“"'《]([^」』”"'》]{1,40})[」』”"'》]/g;
const ASCII_ENTITY_RE = /[A-Za-z][A-Za-z0-9_.-]{2,}/g;
const ENTITY_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'with', 'you', 'are']);

function upsertEntity(db: DatabaseSync, partitionId: string, name: string, type = 'concept'): string {
  const normalized = name.trim().toLowerCase();
  const at = nowIso();
  db.prepare(
    `INSERT INTO entities (id, partition_id, name, type, normalized, mention_count, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(partition_id, normalized, type)
     DO UPDATE SET mention_count = mention_count + 1`,
  ).run(newId('ent'), partitionId, name.trim().slice(0, 120), type, normalized, at);
  const row = db
    .prepare('SELECT id FROM entities WHERE partition_id = ? AND normalized = ? AND type = ?')
    .get(partitionId, normalized, type) as unknown as { id: string } | undefined;
  return row?.id ?? '';
}

/** 规则实体抽取（P0 只求可用；P2 再引入词典/关系）。 */
export function extractEntities(db: DatabaseSync, partitionId: string, memoryId: string): number {
  const row = db.prepare('SELECT content FROM memories WHERE id = ? AND partition_id = ?').get(memoryId, partitionId) as unknown as
    | { content: string }
    | undefined;
  if (!row) throw new Error('记忆不存在，无法抽取实体');
  const names = new Set<string>();
  for (const match of row.content.matchAll(QUOTED_ENTITY_RE)) {
    const name = match[1]?.trim();
    if (name && name.length >= 1) names.add(name);
  }
  for (const match of row.content.matchAll(ASCII_ENTITY_RE)) {
    const name = match[0];
    if (name.length >= 3 && !ENTITY_STOP.has(name.toLowerCase())) names.add(name);
  }
  for (const name of names) {
    const entityId = upsertEntity(db, partitionId, name);
    if (!entityId) continue;
    db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, salience) VALUES (?, ?, 1)').run(
      memoryId,
      entityId,
    );
  }
  return names.size;
}

/** embed 任务：补齐/刷新单条记忆的 embedding、normalized_hash、dim。 */
export function runEmbedJob(db: DatabaseSync, memoryId: string): void {
  const row = db.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId) as unknown as
    | { content: string }
    | undefined;
  if (!row) throw new Error('记忆不存在，无法计算 embedding');
  const vector = embedText(row.content);
  db.prepare(
    `UPDATE memories
        SET embedding = ?, embedding_model = ?, dim = ?, updated_at = ?
      WHERE id = ?`,
  ).run(embeddingToBlob(vector), EMBEDDING_MODEL, EMBEDDING_DIM, nowIso(), memoryId);
}

function personOfPayload(db: DatabaseSync, payload: Record<string, unknown>): string | null {
  const personId = typeof payload.personId === 'string' ? payload.personId : '';
  if (personId) return personId;
  const memoryId = typeof payload.memoryId === 'string' ? payload.memoryId : '';
  if (!memoryId) return null;
  const row = db.prepare('SELECT person_id FROM memories WHERE id = ?').get(memoryId) as unknown as
    | { person_id: string }
    | undefined;
  return row?.person_id ?? null;
}

/**
 * profile/summarize 任务：确定性画像摘要（不依赖 LLM），并把 fact_key 记忆同步到 person_facts。
 * P1 会在此基础上接入 LLM 摘要；P0 先保证任务可用、可重跑。
 */
export function runProfileJob(db: DatabaseSync, partitionId: string, payload: Record<string, unknown>): void {
  const personId = personOfPayload(db, payload);
  if (!personId) throw new Error('profile 任务缺少 personId/memoryId');
  const at = nowIso();

  // fact_key 记忆 → person_facts（同 key 旧值置为失效）
  const factRows = db
    .prepare(
      `SELECT id, fact_key, content, confidence FROM memories
        WHERE partition_id = ? AND person_id = ? AND fact_key IS NOT NULL
          AND status = 'active' AND valid_to IS NULL
        ORDER BY updated_at DESC`,
    )
    .all(partitionId, personId) as unknown as {
    id: string;
    fact_key: string;
    content: string;
    confidence: number;
  }[];
  const seen = new Set<string>();
  for (const fact of factRows) {
    if (seen.has(fact.fact_key)) continue;
    seen.add(fact.fact_key);
    const current = db
      .prepare(
        `SELECT id, value FROM person_facts
          WHERE partition_id = ? AND person_id = ? AND key = ? AND valid_to IS NULL
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(partitionId, personId, fact.fact_key) as unknown as { id: string; value: string } | undefined;
    if (current?.value === fact.content) continue;
    if (current) {
      db.prepare('UPDATE person_facts SET valid_to = ?, updated_at = ? WHERE id = ?').run(at, at, current.id);
    }
    db.prepare(
      `INSERT INTO person_facts
         (id, partition_id, person_id, key, value, confidence, valid_from, valid_to, source_memory_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      newId('fact'),
      partitionId,
      personId,
      fact.fact_key.slice(0, 120),
      fact.content,
      Math.min(1, Math.max(0, fact.confidence)),
      at,
      fact.id,
      at,
      at,
    );
  }

  // 画像摘要：最近/最重要的 30 条有效记忆
  const rows = db
    .prepare(
      `SELECT id, category, content, updated_at FROM memories
        WHERE partition_id = ? AND person_id = ? AND status = 'active' AND valid_to IS NULL
        ORDER BY importance DESC, updated_at DESC LIMIT 30`,
    )
    .all(partitionId, personId) as unknown as {
    id: string;
    category: string;
    content: string;
    updated_at: string;
  }[];
  const lines = rows.map((row) => `- [${row.category}] ${row.content.replace(/\s+/g, ' ').slice(0, 160)}`);
  const summary = lines.join('\n');
  const sourceHash = sha256(rows.map((row) => `${row.id}:${row.updated_at}`).join('|'));
  db.prepare(
    `INSERT INTO person_profiles (partition_id, person_id, summary, source_hash, generated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(partition_id, person_id)
     DO UPDATE SET summary = excluded.summary, source_hash = excluded.source_hash, generated_at = excluded.generated_at`,
  ).run(partitionId, personId, summary, sourceHash, at);
}

/** 执行一个已领取的任务（成功后由 processJobs 落 done）。 */
export function executeJob(db: DatabaseSync, job: JobRow): void {
  const payload = parseJson<Record<string, unknown>>(job.payload, {});
  switch (job.type) {
    case 'embed': {
      const memoryId = typeof payload.memoryId === 'string' ? payload.memoryId : '';
      if (!memoryId) throw new Error('embed 任务缺少 memoryId');
      runEmbedJob(db, memoryId);
      return;
    }
    case 'extract': {
      const memoryId = typeof payload.memoryId === 'string' ? payload.memoryId : '';
      if (!memoryId) throw new Error('extract 任务缺少 memoryId');
      extractEntities(db, job.partition_id, memoryId);
      return;
    }
    case 'profile':
    case 'summarize':
    case 'consolidate':
      runProfileJob(db, job.partition_id, payload);
      return;
    default:
      throw new Error(`未知任务类型：${job.type}`);
  }
}

export interface ProcessJobsResult {
  processed: number;
  succeeded: number;
  failed: number;
  requeued: number;
  pending: number;
}

function pendingCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM memory_jobs WHERE status = 'pending'").get() as unknown as {
    c: number;
  };
  return row?.c ?? 0;
}

/** 执行一批到期任务（供 worker 与 /api/ops/jobs/tick 复用）。 */
export function processJobs(
  db: DatabaseSync,
  options: { limit?: number; maxAttempts?: number; now?: number } = {},
): ProcessJobsResult {
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_JOB_ATTEMPTS);
  const jobs = claimDueJobs(db, options.limit ?? 10, options.now);
  let succeeded = 0;
  let failed = 0;
  let requeued = 0;
  for (const job of jobs) {
    try {
      executeJob(db, job);
      db.prepare(
        "UPDATE memory_jobs SET status = 'done', locked_at = NULL, error = NULL, updated_at = ? WHERE id = ?",
      ).run(nowIso(), job.id);
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.attempts >= maxAttempts) {
        db.prepare(
          "UPDATE memory_jobs SET status = 'failed', locked_at = NULL, error = ?, updated_at = ? WHERE id = ?",
        ).run(message.slice(0, 1000), nowIso(), job.id);
        failed += 1;
      } else {
        const backoffMs = Math.min(300_000, 2 ** job.attempts * 1_000);
        const runAfter = new Date(Date.now() + backoffMs).toISOString();
        db.prepare(
          "UPDATE memory_jobs SET status = 'pending', locked_at = NULL, error = ?, run_after = ?, updated_at = ? WHERE id = ?",
        ).run(message.slice(0, 1000), runAfter, nowIso(), job.id);
        requeued += 1;
      }
    }
  }
  return { processed: jobs.length, succeeded, failed, requeued, pending: pendingCount(db) };
}

export interface JobWorker {
  /** 立即触发一次（测试/运维用）。 */
  tick(): ProcessJobsResult;
  stop(): void;
}

export interface StartJobWorkerOptions {
  db: DatabaseSync;
  logger?: { debug(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
  tickMs?: number;
  batchSize?: number;
}

/** 启动同进程 worker：默认 1s tick、每批 10 条；timer.unref 不阻止进程退出。 */
export function startMemoryJobWorker(options: StartJobWorkerOptions): JobWorker {
  const { db, logger } = options;
  const tickMs = Math.max(100, options.tickMs ?? 1_000);
  const batchSize = Math.max(1, options.batchSize ?? 10);
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, tickMs);
    timer.unref?.();
  };

  const run = (): ProcessJobsResult => {
    if (stopped || running) return { processed: 0, succeeded: 0, failed: 0, requeued: 0, pending: pendingCount(db) };
    running = true;
    try {
      const result = processJobs(db, { limit: batchSize });
      if (result.processed > 0) {
        logger?.debug('memory_jobs.tick', {
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
          requeued: result.requeued,
          pending: result.pending,
        });
      }
      return result;
    } catch (error) {
      logger?.warn('memory_jobs.tick_failed', { error: error instanceof Error ? error.message : String(error) });
      return { processed: 0, succeeded: 0, failed: 0, requeued: 0, pending: 0 };
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();

  return {
    tick() {
      return run();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** 测试/回填辅助：读取记忆 embedding 向量（无则 null）。 */
export function embeddingOf(db: DatabaseSync, memoryId: string): Float32Array | null {
  const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(memoryId) as unknown as
    | { embedding: Uint8Array | null }
    | undefined;
  return blobToEmbedding(row?.embedding ?? null);
}
