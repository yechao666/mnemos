import { APP_VERSION } from '../../shared/src/constants.ts';
import type { AppContext } from './contracts.ts';
import { getSchemaVersion, migrate, openDatabase, tableCount } from './db/index.ts';
import { createLlmRouter, createMemoryService } from './engine/index.ts';
import { startDreamScheduler } from './engine/dream-scheduler.ts';
import { startMemoryJobWorker } from './engine/jobs.ts';
import { assertEnv, ensureDir, loadEnv } from './env.ts';
import { createHttpServer, drainConnections } from './http/server.ts';
import { initObservability } from './observability/otel.ts';
import { createPlatform } from './platform/index.ts';
import { bootstrapAdminIfNeeded } from './bootstrap.ts';
import { runSeed } from './seed/seed.ts';

const env = loadEnv();

try {
  assertEnv(env);
} catch (error) {
  console.error(`[mnemos] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (env.devNoApiKey) {
  console.warn(
    '[mnemos] 警告：MNEMOS_DEV_NO_API_KEY=1 —— v1 API 已跳过 API Key 鉴权（以第一个 owner 身份），仅限本地开发，生产禁止',
  );
}

ensureDir(env.dataDir);
ensureDir(env.backupDir);

const db = openDatabase(env.dbPath);
try {
  migrate(db);
} catch (error) {
  console.error(`[mnemos] 数据库初始化失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const platform = createPlatform({ db, env });
const { logger, metrics } = platform;
const engine = createMemoryService(db, { llm: env.llm });
const observability = await initObservability(env, logger);

const context: AppContext = {
  db,
  engine,
  env,
  startedAt: Date.now(),
  logger,
  metrics,
  platform,
};

try {
  if (tableCount(db, 'users') === 0) {
    if (!env.demoMode) {
      const boot = bootstrapAdminIfNeeded(db, env, logger);
      if (boot) logger.info('首次启动：已创建初始管理员', { email: boot.email });
    }
  }

  if (env.demoMode && tableCount(db, 'orgs') === 0) {
    logger.info('空数据库，写入演示数据集');
    const summary = await runSeed({ db, engine, env, log: (line) => logger.info(`seed: ${line}`) });
    logger.info('演示数据就绪', {
      partitions: summary.partitions,
      persons: summary.persons,
      memories: summary.memories,
    });
    if (summary.demoApiKey) {
      logger.warn('已生成演示分区 API Key，请勿在生产环境保留', {
        partition: summary.demoApiKey.partitionSlug,
        keyPrefix: summary.demoApiKey.secret.slice(0, 18),
      });
    }
  }
} catch (error) {
  logger.error('初始化数据失败，进程退出', {
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    db.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
}

const server = createHttpServer(context);
const jobWorker = startMemoryJobWorker({
  db,
  logger,
  tickMs: 1_000,
  batchSize: 10,
  llm: createLlmRouter(db, env.llm),
});
logger.info('memory_jobs.worker_started', { tickMs: 1_000, batchSize: 10 });
let stopDreamScheduler: () => void = () => {};

server.listen(env.port, env.host, () => {
  const base = `http://${env.host}:${env.port}`;
  logger.info('Mnemos v6 已启动', {
    url: base,
    api: `${base}/v1`,
    version: APP_VERSION,
    schemaVersion: getSchemaVersion(db),
    db: env.dbPath,
    logLevel: env.logLevel,
    metrics: env.metricsEnabled,
  });
  if (env.dreamSchedulerEnabled) {
    stopDreamScheduler = startDreamScheduler({ db, engine, logger, tickMs: env.dreamTickMs });
    logger.info('dream.scheduler_started', { tickMs: env.dreamTickMs });
  }
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('开始优雅停机', { signal, timeoutMs: env.shutdownTimeoutMs });

  const forceTimer = setTimeout(() => {
    logger.error('优雅停机超时，强制退出');
    process.exit(1);
  }, env.shutdownTimeoutMs + 2_000);
  forceTimer.unref();

  try {
    const drain = drainConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await drain;
    stopDreamScheduler();
    jobWorker.stop();
    await observability.shutdown();
    await platform.shutdown();
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.close();
    } catch (error) {
      logger.warn('关闭数据库时出现异常', { error: error instanceof Error ? error.message : String(error) });
    }
    clearTimeout(forceTimer);
    logger.info('已完成停机');
    process.exit(0);
  } catch (error) {
    logger.error('停机过程中出错', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', { error: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (error) => {
  logger.error('未捕获异常，进程退出', { error: error.message, stack: error.stack });
  void shutdown('uncaughtException');
});
