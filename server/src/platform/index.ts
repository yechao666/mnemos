import { APP_VERSION } from '../../../shared/src/constants.ts';
import type { Platform, PlatformDeps } from '../contracts.ts';
import { createBackupController } from './backup.ts';
import { createLogger, type AppLogger } from './logger.ts';
import { createMaintenanceController } from './maintenance.ts';
import { createMetrics } from './metrics.ts';

export interface CreatePlatformOptions {
  /** 测试中可关闭维护调度（默认开启）。 */
  startMaintenance?: boolean;
}

/**
 * 组装生产平台能力：日志、指标、维护调度、备份。
 */
export function createPlatform(deps: PlatformDeps, options: CreatePlatformOptions = {}): Platform {
  const startedAt = Date.now();
  const logger: AppLogger = createLogger(deps.env);
  const metrics = createMetrics({ version: APP_VERSION, startedAt });
  const maintenance = createMaintenanceController({
    db: deps.db,
    env: deps.env,
    logger,
    metrics,
  });
  const backups = createBackupController({ db: deps.db, env: deps.env, logger });

  if (options.startMaintenance !== false) maintenance.start();

  logger.info('platform.ready', {
    version: APP_VERSION,
    logLevel: deps.env.logLevel,
    logFormat: deps.env.logFormat,
    metricsEnabled: deps.env.metricsEnabled,
    maintenanceIntervalMs: deps.env.maintenanceIntervalMs,
    backupDir: deps.env.backupDir,
  });

  return {
    logger,
    metrics,
    maintenance,
    backups,
    async shutdown() {
      maintenance.stop();
      logger.flush();
    },
  };
}

export { createBackupController } from './backup.ts';
export { createLogger } from './logger.ts';
export { createMaintenanceController } from './maintenance.ts';
export { createMetrics, HISTOGRAM_BUCKETS_MS } from './metrics.ts';
export {
  assertQuota,
  evaluatePartitionQuota,
  monthlyMemoryTokens,
  startOfNextUtcMonth,
  startOfUtcMonth,
  type QuotaState,
} from './quota.ts';
