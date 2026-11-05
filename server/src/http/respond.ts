import type { ServerResponse } from 'node:http';
import type { Paginated } from '../../../shared/src/types.ts';

/**
 * 统一响应 / 错误模型。
 * 错误体固定为 { error: { code, message, details?, requestId } }；
 * code 为稳定英文标识，message 为可直接展示的中文文案。
 */

export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest(message = '请求参数不合法', details?: unknown): HttpError {
    return new HttpError(400, 'BAD_REQUEST', message, details);
  },
  validation(details?: unknown, message = '请求参数校验失败'): HttpError {
    return new HttpError(400, 'VALIDATION_ERROR', message, details);
  },
  invalidJson(): HttpError {
    return new HttpError(400, 'INVALID_JSON', '请求体不是合法的 JSON');
  },
  unauthorized(message = '未认证或登录凭证已失效'): HttpError {
    return new HttpError(401, 'UNAUTHORIZED', message);
  },
  invalidApiKey(message = 'API Key 无效'): HttpError {
    return new HttpError(401, 'INVALID_API_KEY', message);
  },
  apiKeyRevoked(): HttpError {
    return new HttpError(401, 'API_KEY_REVOKED', '该 API Key 已被吊销');
  },
  forbidden(message = '权限不足，无法执行该操作'): HttpError {
    return new HttpError(403, 'FORBIDDEN', message);
  },
  notFound(message = '资源不存在'): HttpError {
    return new HttpError(404, 'NOT_FOUND', message);
  },
  methodNotAllowed(method: string, path: string): HttpError {
    return new HttpError(405, 'METHOD_NOT_ALLOWED', `路由 ${path} 不支持 ${method} 方法`);
  },
  conflict(message: string, details?: unknown): HttpError {
    return new HttpError(409, 'CONFLICT', message, details);
  },
  payloadTooLarge(): HttpError {
    return new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 1MB 上限');
  },
  rateLimited(message = '请求过于频繁，请稍后重试'): HttpError {
    return new HttpError(429, 'RATE_LIMITED', message);
  },
  internal(message = '服务器内部错误'): HttpError {
    return new HttpError(500, 'INTERNAL_ERROR', message);
  },
  engine(message = '记忆引擎处理失败'): HttpError {
    return new HttpError(500, 'ENGINE_ERROR', message);
  },
  unavailable(message = '服务暂不可用'): HttpError {
    return new HttpError(503, 'SERVICE_UNAVAILABLE', message);
  },
};

/** 把任意异常规整为 HttpError（未知异常保留原始信息便于排查）。 */
export function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof Error) {
    const message = error.message?.trim() || '服务器内部错误';
    return new HttpError(500, 'INTERNAL_ERROR', message, { name: error.name });
  }
  return new HttpError(500, 'INTERNAL_ERROR', '服务器内部错误');
}

export function sendJson(
  res: ServerResponse,
  requestId: string,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  let body: string;
  try {
    body = JSON.stringify(payload ?? null);
  } catch {
    body = JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '响应序列化失败', requestId } });
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(Buffer.byteLength(body)));
  res.setHeader('x-request-id', requestId);
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  if (res.req?.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

export function sendError(res: ServerResponse, requestId: string, error: unknown): void {
  const httpError = normalizeError(error);
  if (res.headersSent) {
    // SSE / 文件流已开始输出，无法再写结构化错误，只能结束连接。
    try {
      res.end();
    } catch {
      /* noop */
    }
    return;
  }
  const payload: ErrorPayload = {
    error: {
      code: httpError.code,
      message: httpError.message,
      requestId,
    },
  };
  if (httpError.details !== undefined) payload.error.details = httpError.details;
  sendJson(res, requestId, httpError.status, payload);
  if (httpError.status >= 500) {
    console.error(`[http] ${requestId} ${httpError.status} ${httpError.code}: ${httpError.message}`);
  }
}

/** 构造 Paginated<T>，totalPages 至少为 1，便于前端分页器直接渲染。 */
export function paginate<T>(items: T[], page: number, pageSize: number, total: number): Paginated<T> {
  const safePageSize = pageSize > 0 ? pageSize : 20;
  return {
    items,
    page,
    pageSize: safePageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
  };
}

/** 线性插值百分位（0..1）。空数组返回 0。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return Math.round(low + (high - low) * weight);
}

/** 四舍五入到指定小数位。 */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
