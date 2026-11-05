/**
 * 引擎领域错误。
 *
 * 引擎只负责抛出带 status/code 的领域错误，HTTP 层（http/engine.ts）统一映射为
 * `{ error: { code, message } }` 响应，避免把状态码语义散落进领域逻辑。
 */

export class DomainError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

export function notFound(message: string): DomainError {
  return new DomainError(404, 'NOT_FOUND', message);
}

export function conflict(message: string): DomainError {
  return new DomainError(409, 'CONFLICT', message);
}

/** 语义不合法但 JSON 形状合法（如 visibility=task 却缺少 taskId）。 */
export function unprocessable(message: string): DomainError {
  return new DomainError(422, 'UNPROCESSABLE_ENTITY', message);
}
