import type { DatabaseSync } from 'node:sqlite';
import { nowIso, sha256 } from '../../lib/ids.ts';
import type { RequestContext } from '../context.ts';
import { headerOf } from '../context.ts';
import { errors } from '../respond.ts';

/**
 * POST 写接口幂等（v6.1 P0）：
 *  - 请求带 `Idempotency-Key` 时，24h 内相同 key + 相同方法/路径/请求体 → 直接回放首次响应；
 *  - key 相同但请求体/路径不同 → 409 CONFLICT；
 *  - 只缓存成功响应（status < 400）；过期记录在下次写入时顺带清理。
 *
 * body 列存 JSON 信封 { bodyHash, response }：schema 契约里没有 body_hash 列，
 * 用信封在不动表结构的前提下实现「同 body 回放 / 异 body 冲突」。
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

interface StoredEnvelope {
  bodyHash: string;
  response: unknown;
}

interface IdempotencyRow {
  key: string;
  partition_id: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  body: string | null;
  created_at: string;
  expires_at: string;
}

export interface PreparedIdempotency {
  key: string;
  /** 命中历史响应：直接回放（不再执行 handler）。 */
  replay?: { status: number; body: unknown };
  commit(capture: { status: number; body: unknown }): void;
}

/** 稳定序列化（对象键排序），保证等价 JSON 得到同一 hash。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function idempotencyKeyOf(rc: RequestContext): string | null {
  const raw = headerOf(rc.req, 'idempotency-key');
  if (!raw) return null;
  const key = raw.trim();
  if (!key) return null;
  if (key.length > 200) throw errors.badRequest('Idempotency-Key 最长 200 字符');
  return key;
}

function parseEnvelope(body: string | null): StoredEnvelope | null {
  if (!body) return null;
  try {
    const value = JSON.parse(body) as unknown;
    if (value && typeof value === 'object' && 'bodyHash' in value && 'response' in value) {
      return value as StoredEnvelope;
    }
    return { bodyHash: '', response: value };
  } catch {
    return null;
  }
}

function cleanupExpired(db: DatabaseSync, now: string): void {
  try {
    db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 读取请求体并准备幂等上下文；无 Idempotency-Key 时返回 null。 */
export async function prepareIdempotency(rc: RequestContext): Promise<PreparedIdempotency | null> {
  const key = idempotencyKeyOf(rc);
  if (!key) return null;
  const rawBody = await rc.readBody();
  const bodyHash = sha256(canonicalJson(rawBody));
  const at = nowIso();
  cleanupExpired(rc.app.db, at);

  const row = rc.app.db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key) as unknown as
    | IdempotencyRow
    | undefined;
  if (row) {
    if (row.method !== rc.method || row.path !== rc.pathname) {
      throw errors.conflict('Idempotency-Key 已用于其他请求（方法或路径不同）');
    }
    const envelope = parseEnvelope(row.body);
    if (!envelope || envelope.bodyHash !== bodyHash) {
      throw errors.conflict('Idempotency-Key 已用于不同的请求体');
    }
    return {
      key,
      replay: { status: row.status ?? 200, body: envelope.response },
      commit: () => undefined,
    };
  }

  return {
    key,
    commit(capture) {
      if (capture.status >= 400) return;
      const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();
      const envelope: StoredEnvelope = { bodyHash, response: capture.body };
      const partitionRef = typeof rc.params.partition === 'string' ? rc.params.partition : null;
      try {
        rc.app.db
          .prepare(
            `INSERT INTO idempotency_keys (key, partition_id, method, path, status, body, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            key,
            partitionRef,
            rc.method,
            rc.pathname,
            capture.status,
            JSON.stringify(envelope),
            at,
            expiresAt,
          );
      } catch {
        /* 幂等缓存写入失败不影响已成功的业务响应 */
      }
    },
  };
}
