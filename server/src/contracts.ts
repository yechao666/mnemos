import type { DatabaseSync } from 'node:sqlite';
import type {
  BackupInfo,
  MaintenanceRun,
  MemoryService,
  OpsMaintenanceInput,
  OpsMaintenanceResult,
} from '../../shared/src/types.ts';
import type { Env } from './env.ts';

export type LogFields = Record<string, unknown>;

/** 结构化日志接口：platform/logger.ts 实现。 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** 指标注册表：计数器 / 直方图 / 仪表，支持 Prometheus 文本输出。 */
export interface Metrics {
  counter(name: string, labels?: Record<string, string>, value?: number): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  incGauge(name: string, labels?: Record<string, string>, delta?: number): void;
  render(): string;
  snapshot(): {
    requestsTotal: number;
    errorsTotal: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    sseClients: number;
    rateLimitedTotal: number;
    authFailuresTotal: number;
  };
}

export interface MaintenanceController {
  start(): void;
  stop(): void;
  run(input?: OpsMaintenanceInput, actor?: string): Promise<OpsMaintenanceResult>;
  history(limit?: number): MaintenanceRun[];
}

export interface BackupController {
  create(kind: BackupInfo['kind'], actor?: string): Promise<BackupInfo>;
  list(): BackupInfo[];
  pathOf(fileName: string): string | null;
}

/** 生产平台能力：日志、指标、维护、备份、停机收尾。 */
export interface Platform {
  logger: Logger;
  metrics: Metrics;
  maintenance: MaintenanceController;
  backups: BackupController;
  /** 关闭定时器、flush 日志。 */
  shutdown(): Promise<void>;
}

export interface PlatformDeps {
  db: DatabaseSync;
  env: Env;
}

/**
 * 应用上下文：所有传输层（HTTP / CLI / seed）共享的依赖注入容器。
 * 由 main.ts 构造，http/server.ts 只消费不构造。
 */
export interface AppContext {
  db: DatabaseSync;
  engine: MemoryService;
  env: Env;
  startedAt: number;
  logger: Logger;
  metrics: Metrics;
  platform: Platform;
}
