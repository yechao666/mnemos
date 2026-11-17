/**
 * 引擎错误：与 HTTP 层解耦，由 http/respond.ts 统一映射为错误响应。
 */
export type EngineErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'DREAM_RUNNING'
  | 'INVALID_CURSOR'
  | 'PARTITION_ARCHIVED'
  | 'INTERNAL';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: EngineErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const engineErrors = {
  notFound(message = '资源不存在'): EngineError {
    return new EngineError('NOT_FOUND', message, 404);
  },
  validation(message = '请求参数不合法', details?: unknown): EngineError {
    return new EngineError('VALIDATION', message, 400, details);
  },
  conflict(message: string, details?: unknown): EngineError {
    return new EngineError('CONFLICT', message, 409, details);
  },
  dreamRunning(message = '该作用域正在做梦，请稍后重试'): EngineError {
    return new EngineError('DREAM_RUNNING', message, 409);
  },
  invalidCursor(message = '游标无效或已过期'): EngineError {
    return new EngineError('INVALID_CURSOR', message, 400);
  },
  archivedPartition(message = '分区已归档，无法写入'): EngineError {
    return new EngineError('PARTITION_ARCHIVED', message, 403);
  },
};
