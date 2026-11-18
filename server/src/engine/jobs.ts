import type { DatabaseSync } from 'node:sqlite';
import type { MemoryJob, MemoryJobStatus, MemoryJobType } from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { blobToEmbedding, embedText, EMBEDDING_DIM, EMBEDDING_MODEL, embeddingToBlob } from './embed.ts';
import { applyPrivacyToMemory, applyPrivacyToMemorySync } from './privacy.ts';
import { getPersonProfile } from './profile.ts';
import { resolvePerson } from './persons.ts';
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
  /** v6.2：是否需要异步执行 prompt 隐私规则（basic + privacyLlmEnabled + 有 prompt 规则）。 */
  privacyScan?: boolean;
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
  if (input.privacyScan) {
    ids.push(
      enqueueJob(db, {
        partitionId: input.partitionId,
        type: 'privacy',
        payload: { memoryId: input.memoryId, personId: input.personId },
      }),
    );
  }
  return ids;
}

/** v6.2：入队一条 privacy 任务（写入/更新/重扫统一入口）。 */
export function enqueuePrivacyJob(
  db: DatabaseSync,
  input: { partitionId: string; memoryId: string; personId?: string },
): string {
  return enqueueJob(db, {
    partitionId: input.partitionId,
    type: 'privacy',
    payload: { memoryId: input.memoryId, personId: input.personId },
  });
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

/**
 * 找或建实体（不直接累加 mention_count）；mention_count 在实际新增 memory_entities
 * 关联时 +1，保证同一记忆重复抽取不会把计数翻倍（幂等）。
 */
function findOrCreateEntity(db: DatabaseSync, partitionId: string, name: string, type = 'concept'): string {
  const normalized = name.trim().toLowerCase();
  const at = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO entities (id, partition_id, name, type, normalized, mention_count, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(newId('ent'), partitionId, name.trim().slice(0, 120), type, normalized, at);
  const row = db
    .prepare('SELECT id FROM entities WHERE partition_id = ? AND normalized = ? AND type = ?')
    .get(partitionId, normalized, type) as unknown as { id: string } | undefined;
  return row?.id ?? '';
}

/**
 * 同一记忆内实体两两写 co_occurs 关系（P2）；`UNIQUE(partition_id, source, target, relation)`
 * 保证幂等：重复抽取 / 重复写入只会 INSERT OR IGNORE。source/target 按 id 排序，方向稳定。
 */
export function linkCoOccurringRelations(db: DatabaseSync, partitionId: string, memoryId: string): number {
  const rows = db
    .prepare('SELECT entity_id FROM memory_entities WHERE memory_id = ? ORDER BY entity_id ASC')
    .all(memoryId) as unknown as { entity_id: string }[];
  const entityIds = [...new Set(rows.map((row) => row.entity_id))];
  if (entityIds.length < 2) return 0;
  const at = nowIso();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO relations
       (id, partition_id, source_entity_id, target_entity_id, relation, memory_id, weight, created_at)
     VALUES (?, ?, ?, ?, 'co_occurs', ?, 1, ?)`,
  );
  let linked = 0;
  for (let left = 0; left < entityIds.length; left += 1) {
    for (let right = left + 1; right < entityIds.length; right += 1) {
      const result = stmt.run(newId('rel'), partitionId, entityIds[left], entityIds[right], memoryId, at);
      linked += Number(result.changes ?? 0);
    }
  }
  return linked;
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
    const entityId = findOrCreateEntity(db, partitionId, name);
    if (!entityId) continue;
    const link = db
      .prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, salience) VALUES (?, ?, 1)')
      .run(memoryId, entityId);
    if (Number(link.changes ?? 0) > 0) {
      db.prepare('UPDATE entities SET mention_count = mention_count + 1 WHERE id = ?').run(entityId);
    }
  }
  // P2：同一记忆内实体共现关系（幂等）。
  linkCoOccurringRelations(db, partitionId, memoryId);
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
 * profile / summarize 任务（v6.1 P1）：
 *  - 把同 person 的 fact_key 记忆沉淀为 person_facts（版本化，幂等）；
 *  - 生成确定性画像摘要并写入 person_profiles 缓存（sourceHash 未变则直接复用）。
 *  - LLM 增强由 HTTP GET /persons/:ref/profile 的按需生成路径完成（jobs 保持同步）。
 */
export function runProfileJob(db: DatabaseSync, partitionId: string, payload: Record<string, unknown>): void {
  const personId = personOfPayload(db, payload);
  if (!personId) throw new Error('profile 任务缺少 personId/memoryId');
  // resolvePerson 跟随 merged_into：合并前入队的任务也能落到 canonical 人。
  // getPersonProfile 内部会同步 factKey 记忆并写入摘要缓存（幂等）。
  const person = resolvePerson(db, partitionId, personId);
  getPersonProfile(db, partitionId, person.id);
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
    case 'privacy': {
      const memoryId = typeof payload.memoryId === 'string' ? payload.memoryId : '';
      if (!memoryId) throw new Error('privacy 任务缺少 memoryId');
      applyPrivacyToMemorySync(db, job.partition_id, memoryId, { reason: 'privacy:job' });
      return;
    }
    default:
      throw new Error(`未知任务类型：${job.type}`);
  }
}

/** privacy 任务异步执行（regex + prompt；无 LLM 时等价于 regex）。 */
export async function runPrivacyJob(
  db: DatabaseSync,
  llm: LlmConfig | null,
  partitionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const memoryId = typeof payload.memoryId === 'string' ? payload.memoryId : '';
  if (!memoryId) throw new Error('privacy 任务缺少 memoryId');
  await applyPrivacyToMemory(db, llm, partitionId, memoryId, { reason: 'privacy:job' });
}

async function executeJobAsync(db: DatabaseSync, llm: LlmConfig | null, job: JobRow): Promise<void> {
  if (job.type === 'privacy') {
    await runPrivacyJob(db, llm, job.partition_id, parseJson<Record<string, unknown>>(job.payload, {}));
    return;
  }
  executeJob(db, job);
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

/**
 * 异步任务执行（生产 worker 使用）：privacy 任务可以 await LLM；其余任务与 processJobs 同语义。
 * processJobs 保持同步（测试/运维 tick 兼容），privacy 任务退化为仅 regex。
 */
export async function processJobsAsync(
  db: DatabaseSync,
  llm: LlmConfig | null,
  options: { limit?: number; maxAttempts?: number; now?: number } = {},
): Promise<ProcessJobsResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_JOB_ATTEMPTS);
  const jobs = claimDueJobs(db, options.limit ?? 10, options.now);
  let succeeded = 0;
  let failed = 0;
  let requeued = 0;
  for (const job of jobs) {
    try {
      await executeJobAsync(db, llm, job);
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
  /** 立即触发一次（测试/运维用；同步执行，privacy 任务退化为仅 regex）。 */
  tick(): ProcessJobsResult;
  /** 异步触发一次（privacy 任务可调用 LLM）。 */
  tickAsync(): Promise<ProcessJobsResult>;
  stop(): void;
}

export interface StartJobWorkerOptions {
  db: DatabaseSync;
  logger?: { debug(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
  tickMs?: number;
  batchSize?: number;
  /** v6.2：prompt 隐私规则需要的 LLM 配置（缺省则 privacy 任务只跑 regex）。 */
  llm?: LlmConfig | null;
}

/** 启动同进程 worker：默认 1s tick、每批 10 条；timer.unref 不阻止进程退出。 */
export function startMemoryJobWorker(options: StartJobWorkerOptions): JobWorker {
  const { db, logger } = options;
  const llm = options.llm ?? null;
  const tickMs = Math.max(100, options.tickMs ?? 1_000);
  const batchSize = Math.max(1, options.batchSize ?? 10);
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const idle = (): ProcessJobsResult => ({
    processed: 0,
    succeeded: 0,
    failed: 0,
    requeued: 0,
    pending: pendingCount(db),
  });

  const schedule = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void runAsync();
    }, tickMs);
    timer.unref?.();
  };

  const logResult = (result: ProcessJobsResult): void => {
    if (result.processed === 0) return;
    logger?.debug('memory_jobs.tick', {
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      requeued: result.requeued,
      pending: result.pending,
    });
  };

  const runAsync = async (): Promise<ProcessJobsResult> => {
    if (stopped || running) return idle();
    running = true;
    try {
      const result = await processJobsAsync(db, llm, { limit: batchSize });
      logResult(result);
      return result;
    } catch (error) {
      logger?.warn('memory_jobs.tick_failed', { error: error instanceof Error ? error.message : String(error) });
      return idle();
    } finally {
      running = false;
      schedule();
    }
  };

  const runSync = (): ProcessJobsResult => {
    if (stopped || running) return idle();
    running = true;
    try {
      const result = processJobs(db, { limit: batchSize });
      logResult(result);
      return result;
    } catch (error) {
      logger?.warn('memory_jobs.tick_failed', { error: error instanceof Error ? error.message : String(error) });
      return idle();
    } finally {
      running = false;
    }
  };

  schedule();

  return {
    tick() {
      return runSync();
    },
    tickAsync() {
      return runAsync();
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
