import { CURSOR_LIMIT_DEFAULT, CURSOR_LIMIT_MAX } from '../../../shared/src/constants.ts';
import { engineErrors } from './errors.ts';

/**
 * 游标分页：cursor = base64url(JSON {v, id, s})。
 * v = 排序值（last_seen_at / created_at / display_name），id = tie-breaker，s = 排序方式。
 * 服务端用 keyset：recent/new 用 `(v,id) < (?,?)`，name 用 `(v,id) > (?,?)`。
 */
export interface CursorValue {
  v: string;
  id: string;
  s: string;
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({ v: value.v, id: value.id, s: value.s }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string, expectedSort: string): CursorValue {
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(text) as Partial<CursorValue>;
    if (typeof parsed.v !== 'string' || typeof parsed.id !== 'string' || typeof parsed.s !== 'string') {
      throw new Error('bad cursor');
    }
    if (parsed.s !== expectedSort) throw engineErrors.invalidCursor('游标与当前排序方式不匹配');
    return { v: parsed.v, id: parsed.id, s: parsed.s };
  } catch (error) {
    if (error instanceof Error && error.name === 'EngineError') throw error;
    throw engineErrors.invalidCursor();
  }
}

/** limit 默认 50、最大 200。 */
export function normalizeLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return CURSOR_LIMIT_DEFAULT;
  return Math.min(CURSOR_LIMIT_MAX, Math.max(1, Math.trunc(n)));
}
