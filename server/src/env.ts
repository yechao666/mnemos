import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_PORT } from '../../shared/src/constants.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = resolve(here, '..');
export const APP_ROOT = resolve(SERVER_ROOT, '..');

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'pretty';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  embeddingModel: string;
}

export interface Env {
  nodeEnv: string;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  webDist: string;
  authDisabled: boolean;
  demoMode: boolean;
  /** 企业微信 Mock 登录：默认跟随 demoMode，可用 MNEMOS_WECOM_MOCK=0/1 覆盖 */
  wecomMock: boolean;
  sessionTtlHours: number;
  llm: LlmConfig | null;
  /* --- 生产运行参数 --- */
  logLevel: LogLevel;
  logFormat: LogFormat;
  metricsEnabled: boolean;
  trustProxy: boolean;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  maintenanceIntervalMs: number;
  backupDir: string;
  quotaEnforce: boolean;
  hstsEnabled: boolean;
  bodyLimitBytes: number;
  loginMaxAttempts: number;
  loginLockMinutes: number;
  /* --- 首次启动初始化管理员（生产模式无用户时必填） --- */
  bootstrapEmail?: string;
  bootstrapPassword?: string;
  bootstrapName?: string;
  bootstrapOrgName?: string;
  bootstrapOrgSlug?: string;
  /* --- 做梦调度 --- */
  /** MNEMOS_DREAM_SCHEDULER≠0/'' 时开启（默认 true） */
  dreamSchedulerEnabled: boolean;
  /** 调度 tick 间隔（毫秒，默认 60000，最小 5000） */
  dreamTickMs: number;
  /* --- OpenTelemetry --- */
  otelEnabled: boolean;
  otelEndpoint: string;
  otelSampleRate: number;
  otelServiceName: string;
  /** 存储驱动：当前仅 sqlite */
  storageDriver: 'sqlite' | 'postgres';
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function flag(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

/** 默认开启的开关：MNEMOS_DREAM_SCHEDULER=0 或 '' 时关闭，其余保持开启。 */
function flagDefaultOn(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  return !(normalized === '' || normalized === '0' || normalized === 'false');
}

function level(value: string | undefined): LogLevel {
  const allowed: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  return allowed.includes(value as LogLevel) ? (value as LogLevel) : 'info';
}

function format(value: string | undefined): LogFormat {
  return value === 'pretty' || value === 'json' ? value : 'json';
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  // v6 与 v5 数据目录分离：v5 的 data/ 保留不迁移，v6 默认使用 data-v6/。
  const dataDir = process.env.MNEMOS_DATA_DIR ?? join(APP_ROOT, 'data-v6');
  const llmKey = process.env.MNEMOS_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  const llmBase = process.env.MNEMOS_LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '';

  const env: Env = {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    host: process.env.MNEMOS_HOST ?? '127.0.0.1',
    port: num(process.env.MNEMOS_PORT ?? process.env.PORT, DEFAULT_SERVER_PORT),
    dataDir,
    dbPath: process.env.MNEMOS_DB_PATH ?? join(dataDir, 'mnemos.db'),
    webDist: process.env.MNEMOS_WEB_DIST ?? join(APP_ROOT, 'web', 'dist'),
    authDisabled: process.env.MNEMOS_AUTH_DISABLED === '1',
    demoMode: process.env.MNEMOS_DEMO !== '0',
    wecomMock:
      process.env.MNEMOS_WECOM_MOCK === undefined
        ? process.env.MNEMOS_DEMO !== '0'
        : flag(process.env.MNEMOS_WECOM_MOCK, false),
    sessionTtlHours: num(process.env.MNEMOS_SESSION_TTL_HOURS, 72),
    llm:
      llmKey && llmBase
        ? {
            baseUrl: llmBase,
            apiKey: llmKey,
            model: process.env.MNEMOS_LLM_MODEL ?? 'gpt-4o-mini',
            embeddingModel: process.env.MNEMOS_EMBEDDING_MODEL ?? 'text-embedding-3-small',
          }
        : null,
    logLevel: level(process.env.MNEMOS_LOG_LEVEL),
    logFormat: format(process.env.MNEMOS_LOG_FORMAT ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')),
    metricsEnabled: flag(process.env.MNEMOS_METRICS_ENABLED, true),
    trustProxy: flag(process.env.MNEMOS_TRUST_PROXY, false),
    requestTimeoutMs: num(process.env.MNEMOS_REQUEST_TIMEOUT_MS, 30_000),
    shutdownTimeoutMs: num(process.env.MNEMOS_SHUTDOWN_TIMEOUT_MS, 10_000),
    maintenanceIntervalMs: num(process.env.MNEMOS_MAINTENANCE_INTERVAL_MIN, 360) * 60_000,
    backupDir: process.env.MNEMOS_BACKUP_DIR ?? join(dataDir, 'backups'),
    quotaEnforce: flag(process.env.MNEMOS_QUOTA_ENFORCE, true),
    hstsEnabled: flag(process.env.MNEMOS_HSTS, false),
    bodyLimitBytes: num(process.env.MNEMOS_BODY_LIMIT_BYTES, 1_048_576),
    loginMaxAttempts: num(process.env.MNEMOS_LOGIN_MAX_ATTEMPTS, 5),
    loginLockMinutes: num(process.env.MNEMOS_LOGIN_LOCK_MINUTES, 15),
    bootstrapEmail: process.env.MNEMOS_BOOTSTRAP_EMAIL,
    bootstrapPassword: process.env.MNEMOS_BOOTSTRAP_PASSWORD,
    bootstrapName: process.env.MNEMOS_BOOTSTRAP_NAME,
    bootstrapOrgName: process.env.MNEMOS_BOOTSTRAP_ORG_NAME,
    bootstrapOrgSlug: process.env.MNEMOS_BOOTSTRAP_ORG_SLUG,
    dreamSchedulerEnabled: flagDefaultOn(process.env.MNEMOS_DREAM_SCHEDULER),
    dreamTickMs: Math.max(5_000, num(process.env.MNEMOS_DREAM_TICK_MS, 60_000)),
    otelEnabled: flag(process.env.MNEMOS_OTEL_ENABLED, false),
    otelEndpoint: process.env.MNEMOS_OTEL_ENDPOINT ?? 'http://127.0.0.1:4318/v1/traces',
    otelSampleRate: Math.min(1, Math.max(0, Number(process.env.MNEMOS_OTEL_SAMPLE_RATE ?? 0.1) || 0.1)),
    otelServiceName: process.env.MNEMOS_OTEL_SERVICE_NAME ?? 'mnemos',
    storageDriver: (process.env.MNEMOS_STORAGE === 'postgres' ? 'postgres' : 'sqlite') as 'sqlite' | 'postgres',
    ...overrides,
  };

  return env;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/**
 * 启动前校验配置：尽可能在监听端口之前失败，避免半可用状态。
 * 返回问题列表；调用方决定抛错或告警。
 */
export function validateEnv(env: Env): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(env.port) || env.port < 1 || env.port > 65_535) {
    problems.push(`MNEMOS_PORT 非法：${env.port}`);
  }
  if (!env.host) problems.push('MNEMOS_HOST 不能为空');
  if (env.requestTimeoutMs < 1_000) problems.push('MNEMOS_REQUEST_TIMEOUT_MS 至少 1000');
  if (env.maintenanceIntervalMs < 60_000) problems.push('维护间隔至少 1 分钟');
  if (env.storageDriver !== 'sqlite') {
    problems.push('MNEMOS_STORAGE=postgres 尚未实现，当前版本仅支持 sqlite');
  }
  if (env.logLevel && !['debug', 'info', 'warn', 'error'].includes(env.logLevel)) {
    problems.push(`MNEMOS_LOG_LEVEL 非法：${env.logLevel}`);
  }

  try {
    ensureDir(env.dataDir);
    accessSync(env.dataDir, constants.W_OK);
    const stat = statSync(env.dataDir);
    if (!stat.isDirectory()) problems.push(`数据目录不是目录：${env.dataDir}`);
  } catch (error) {
    problems.push(`数据目录不可写：${env.dataDir}（${error instanceof Error ? error.message : String(error)}）`);
  }

  try {
    ensureDir(env.backupDir);
    accessSync(env.backupDir, constants.W_OK);
  } catch (error) {
    problems.push(`备份目录不可写：${env.backupDir}（${error instanceof Error ? error.message : String(error)}）`);
  }

  const production = env.nodeEnv === 'production';
  if (production && env.authDisabled) problems.push('生产环境禁止 MNEMOS_AUTH_DISABLED=1');
  if (production && env.demoMode) {
    problems.push('生产环境建议设置 MNEMOS_DEMO=0，避免空库自动写入演示数据');
  }
  return problems;
}

/** 生产环境启动自检，返回 fatal 问题（调用方应立即退出）。 */
export function assertEnv(env: Env): void {
  const problems = validateEnv(env);
  const fatal = problems.filter((problem) => !problem.includes('MNEMOS_DEMO=0'));
  if (fatal.length > 0) {
    throw new Error(`配置校验失败：\n- ${fatal.join('\n- ')}`);
  }
}
