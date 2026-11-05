import { setTimeout as sleep } from 'node:timers/promises';
import { sha256, nowIso } from '../lib/ids.ts';
import { headerOf, type RequestContext } from './context.ts';
import { HttpError, sendJson } from './respond.ts';

/**
 * 写操作幂等键（Idempotency-Key）。
 *
 * 语义（与 Stripe 风格一致）：
 *  - 作用域 = 同一个 key + 同一个项目；同一个 key 复用到不同 endpoint 视为冲突；
 *  - 同 key + 同请求体 → 原样回放首次响应（状态码一致），并带 `x-idempotent-replayed: true`；
 *  - 同 key + 不同请求体 → 409 `idempotency_conflict`；
 *  - 并发同 key：`INSERT OR IGNORE` 抢占，未抢到的请求轮询等待（50ms，最多 2s），
 *    超时返回 409 `idempotency_in_progress`；
 *  - 5xx 与无法序列化的响应不入库；无 key 直接执行。
 */

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
const CLAIM_POLL_MS = 50;
const CLAIM_MAX_WAIT_MS = 2_000;
/** 进程崩溃遗留的抢占行超过该时长后允许接管。 */
const CLAIM_STALE_MS = 30_000;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

interface IdempotencyRow {
  key: string;
  project_id: string;
  endpoint: string;
  request_hash: string;
  status_code: number;
  response: string;
  created_at: string;
  expires_at: string;
}

type Handler = () => IdempotentResponse | Promise<IdempotentResponse>;

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) ordered[key] = canonical(source[key]);
  return ordered;
}

function hashRequest(body: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonical(body ?? null));
  } catch {
    serialized = JSON.stringify(body ?? null);
  }
  return sha256(serialized);
}

function loadRow(rc: RequestContext, key: string, projectId: string): IdempotencyRow | null {
  const row = rc.app.db
    .prepare('SELECT * FROM idempotency_keys WHERE key = ? AND project_id = ?')
    .get(key, projectId) as unknown as IdempotencyRow | undefined;
  return row ?? null;
}

function releaseClaim(rc: RequestContext, key: string, projectId: string): void {
  try {
    rc.app.db
      .prepare('DELETE FROM idempotency_keys WHERE key = ? AND project_id = ? AND status_code = 0')
      .run(key, projectId);
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function isExpired(row: IdempotencyRow): boolean {
  const expiresAt = Date.parse(row.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function isStaleClaim(row: IdempotencyRow): boolean {
  if (row.status_code !== 0) return false;
  const createdAt = Date.parse(row.created_at);
  return Number.isFinite(createdAt) && Date.now() - createdAt > CLAIM_STALE_MS;
}

function conflict(key: string): HttpError {
  return new HttpError(409, 'idempotency_conflict', `Idempotency-Key「${key}」已被不同请求体或接口使用`);
}

function inProgress(key: string): HttpError {
  return new HttpError(409, 'idempotency_in_progress', `Idempotency-Key「${key}」的首次请求仍在处理中，请稍后重试`);
}

/** 原样回放已保存响应（JSON 文本重新解析后序列化，键顺序与数值保持一致）。 */
function replay(rc: RequestContext, row: IdempotencyRow): void {
  let body: unknown = null;
  try {
    body = row.response.length > 0 ? (JSON.parse(row.response) as unknown) : null;
  } catch {
    body = row.response;
  }
  sendJson(rc.res, rc.requestId, row.status_code, body, { 'x-idempotent-replayed': 'true' });
}

function deliver(rc: RequestContext, status: number, body: unknown): void {
  sendJson(rc.res, rc.requestId, status, body);
}

interface WaitResult {
  kind: 'replay' | 'timeout' | 'released';
  row?: IdempotencyRow;
}

async function waitForCompletion(
  rc: RequestContext,
  key: string,
  projectId: string,
  endpoint: string,
  requestHash: string,
): Promise<WaitResult> {
  const deadline = Date.now() + CLAIM_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(CLAIM_POLL_MS);
    const row = loadRow(rc, key, projectId);
    if (!row) return { kind: 'released' };
    if (row.request_hash !== requestHash || row.endpoint !== endpoint) {
      throw new HttpError(409, 'idempotency_conflict', `Idempotency-Key「${key}」已被不同请求体或接口使用`);
    }
    if (row.status_code > 0) return { kind: 'replay', row };
  }
  return { kind: 'timeout' };
}

/**
 * 幂等执行：`fn` 返回响应 `{status, body}`，本函数负责查表 / 抢占 / 回放 / 写表并输出响应。
 * 表结构见 `db/schema.sql` 的 `idempotency_keys`（清理由 maintenance 负责）。
 */
export async function withIdempotency(
  rc: RequestContext,
  endpoint: string,
  fn: Handler,
): Promise<void> {
  const projectId = rc.project?.id;
  const rawKey = headerOf(rc.req, 'idempotency-key')?.trim();
  if (!rawKey || !projectId) {
    const result = await fn();
    deliver(rc, result.status, result.body);
    return;
  }

  if (!KEY_PATTERN.test(rawKey)) {
    throw new HttpError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key 需为 8–128 个字符，仅允许字母、数字与 . _ : -',
    );
  }

  const requestHash = hashRequest(await rc.readBody());
  const key = rawKey;

  // 最多两轮：第一轮遇到过期/被释放的行时清理后重试一次。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = loadRow(rc, key, projectId);
    if (existing) {
      if (isExpired(existing)) {
        rc.app.db.prepare('DELETE FROM idempotency_keys WHERE key = ? AND project_id = ?').run(key, projectId);
      } else {
        if (existing.request_hash !== requestHash || existing.endpoint !== endpoint) throw conflict(key);
        if (existing.status_code > 0) {
          replay(rc, existing);
          return;
        }
        if (isStaleClaim(existing)) {
          releaseClaim(rc, key, projectId);
          continue;
        }
        const waited = await waitForCompletion(rc, key, projectId, endpoint, requestHash);
        if (waited.kind === 'replay' && waited.row) {
          replay(rc, waited.row);
          return;
        }
        if (waited.kind === 'released') continue;
        throw inProgress(key);
      }
    }

    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();
    const claim = rc.app.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys
           (key, project_id, endpoint, request_hash, status_code, response, created_at, expires_at)
         VALUES (?, ?, ?, ?, 0, '', ?, ?)`,
      )
      .run(key, projectId, endpoint, requestHash, createdAt, expiresAt);

    if (Number(claim.changes) === 0) continue; // 另一个请求刚抢占，回到循环顶部读取

    let result: IdempotentResponse;
    try {
      result = await fn();
    } catch (error) {
      releaseClaim(rc, key, projectId);
      throw error;
    }

    if (result.status >= 500) {
      releaseClaim(rc, key, projectId);
      deliver(rc, result.status, result.body);
      return;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(result.body ?? null);
    } catch {
      releaseClaim(rc, key, projectId);
      deliver(rc, result.status, result.body);
      return;
    }

    try {
      rc.app.db
        .prepare(
          `UPDATE idempotency_keys
              SET status_code = ?, response = ?, expires_at = ?
            WHERE key = ? AND project_id = ?`,
        )
        .run(result.status, serialized, new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(), key, projectId);
    } catch {
      releaseClaim(rc, key, projectId);
    }
    deliver(rc, result.status, result.body);
    return;
  }

  throw inProgress(key);
}
