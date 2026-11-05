import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../../contracts.ts';
import { sendJson } from '../respond.ts';

/**
 * 请求超时保护：超过 env.requestTimeoutMs 返回 504 JSON（已开始输出则直接结束连接）。
 * SSE（/api/events）与长连接流不适用，直接豁免。
 */

const EXEMPT_PATHS = new Set(['/api/events']);

export interface RequestTimeoutHandle {
  /** 是否已因超时结束了响应。 */
  readonly expired: boolean;
  /** 响应已结束时清理定时器；流式响应（未结束）会保留定时器继续守护。 */
  clear(): void;
}

export function createRequestTimeout(
  app: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  pathname: string,
): RequestTimeoutHandle {
  if (EXEMPT_PATHS.has(pathname)) {
    return { expired: false, clear() {} };
  }

  const timeoutMs = Math.max(1_000, app.env.requestTimeoutMs);
  const seconds = Math.round(timeoutMs / 1_000);
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    if (res.writableEnded || res.destroyed || req.destroyed) return;
    expired = true;
    app.metrics.counter('mnemos_timeouts_total');
    app.logger.warn('http.request.timeout', { requestId, path: pathname, timeoutMs });
    if (!res.headersSent) {
      sendJson(res, requestId, 504, {
        error: {
          code: 'REQUEST_TIMEOUT',
          message: `请求处理超过 ${seconds} 秒，已中止`,
          requestId,
        },
      });
    } else {
      try {
        res.end();
      } catch {
        /* 客户端已断开 */
      }
    }
  }, timeoutMs);
  timer.unref();

  return {
    get expired() {
      return expired;
    },
    clear() {
      // 仅在响应真正结束后清理；流式下载/SSE 之外的慢响应仍受超时保护。
      if (!res.writableEnded && !res.destroyed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
