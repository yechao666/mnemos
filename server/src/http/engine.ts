import { DomainError } from '../engine/errors.ts';
import { estimateTokens } from '../lib/usage.ts';
import type { RequestContext } from './context.ts';
import { HttpError, errors } from './respond.ts';

/** 记忆引擎调用包装：领域错误映射为对应 HTTP 状态，未知异常统一转 500 ENGINE_ERROR。 */
export async function engineCall<T>(_rc: RequestContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DomainError) throw new HttpError(error.status, error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    throw errors.engine(`记忆引擎处理失败：${message}`);
  }
}

/** 估算一批记忆注入检索上下文的 token 数。 */
export function memoryTokenCount(items: Array<{ content: string }>): number {
  return items.reduce((sum, item) => sum + estimateTokens(item.content ?? ''), 0);
}
