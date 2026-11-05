import type { LogFields, Logger } from '../contracts.ts';
import type { Env, LogLevel } from '../env.ts';

/**
 * 结构化日志：JSON（默认）/ pretty 两种输出，级别过滤、child 继承字段、
 * 敏感字段自动脱敏、Error 序列化为 message/stack。
 * 写入使用同步 stdout（Node 下 stdout 对文件是同步的），因此 flush() 无需额外工作。
 */

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_FRAGMENTS = ['authorization', 'password', 'apikey', 'secret', 'token', 'cookie', 'credential'];
const REDACTED = '[REDACTED]';
const MAX_SANITIZE_DEPTH = 6;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function serializeError(error: Error): LogFields {
  const fields: LogFields = { name: error.name, message: error.message };
  if (error.stack) fields.stack = error.stack;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) {
    fields.cause = cause instanceof Error ? serializeError(cause) : sanitizeValue(cause, 1);
  }
  return fields;
}

/** 递归脱敏：对敏感 key 直接替换，Error 展开，循环引用折叠。 */
function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Error) return serializeError(value);
  if (depth >= MAX_SANITIZE_DEPTH) return '[truncated]';
  if (typeof value === 'object') {
    const object = value as object;
    if (seen.has(object)) return '[circular]';
    seen.add(object);
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1, seen));
    }
    const result: LogFields = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(item, depth + 1, seen);
    }
    return result;
  }
  return String(value);
}

export interface LoggerOptions {
  /** 测试环境默认静默，避免污染测试输出。 */
  silent?: boolean;
  /** 自定义输出（默认写 stdout，便于测试注入）。 */
  sink?: (line: string) => void;
}

export interface AppLogger extends Logger {
  /** 同步写入无需刷新，保留接口以适配退出流程。 */
  flush(): void;
}

function formatPretty(record: Record<string, unknown>): string {
  const ts = String(record['ts'] ?? '');
  const level = String(record['level'] ?? 'info').toUpperCase().padEnd(5);
  const message = String(record['msg'] ?? '');
  const parts: string[] = [ts, level, message];
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ts' || key === 'level' || key === 'msg') continue;
    if (value === undefined) continue;
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(' ');
}

export function createLogger(env: Env, baseFields: LogFields = {}, options: LoggerOptions = {}): AppLogger {
  const threshold = LEVEL_WEIGHT[env.logLevel] ?? LEVEL_WEIGHT.info;
  const silent = options.silent ?? env.nodeEnv === 'test';
  const format = env.logFormat;
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const base = baseFields;

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (silent) return;
    if (LEVEL_WEIGHT[level] < threshold) return;

    const merged: LogFields = { ...base };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        merged[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(value);
      }
    }
    const record: Record<string, unknown> = {
      ...merged,
      ts: new Date().toISOString(),
      level,
      msg: message,
    };
    try {
      sink(format === 'pretty' ? formatPretty(record) : JSON.stringify(record));
    } catch {
      // 日志本身不得影响主流程：序列化失败时退化为纯文本。
      sink(`${record['ts']} ${level} ${message}`);
    }
  }

  const logger: AppLogger = {
    debug(message, fields) {
      emit('debug', message, fields);
    },
    info(message, fields) {
      emit('info', message, fields);
    },
    warn(message, fields) {
      emit('warn', message, fields);
    },
    error(message, fields) {
      emit('error', message, fields);
    },
    child(fields) {
      return createLogger(env, { ...base, ...fields }, { silent, sink });
    },
    flush() {
      /* stdout 同步写入，无需刷新 */
    },
  };

  return logger;
}
