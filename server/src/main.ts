import { createMemoryService } from './engine/index.ts';
import { assertEnv, ensureDir, loadEnv } from './env.ts';
import { getSchemaVersion, migrate, openDatabase, tableCount } from './db/index.ts';
import { createHttpServer, drainConnections } from './http/server.ts';
import { EventBus } from './lib/bus.ts';
import { createPlatform } from './platform/index.ts';
import { createWebhookDispatcher } from './webhooks/index.ts';
import { initObservability } from './observability/otel.ts';
import type { AppContext } from './contracts.ts';
import { APP_VERSION } from '../../shared/src/constants.ts';
import { runSeed } from './seed/seed.ts';
import { bootstrapAdminIfNeeded } from './bootstrap.ts';

const env = loadEnv();

try {
  assertEnv(env);
} catch (error) {
  console.error(`[mnemos] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

ensureDir(env.dataDir);
ensureDir(env.backupDir);

const db = openDatabase(env.dbPath);
migrate(db);

const bus = new EventBus();
const engine = createMemoryService(db, { bus });
const platform = createPlatform({ db, env, bus });
const { logger, metrics } = platform;

const observability = await initObservability(env, logger);
const webhooks = createWebhookDispatcher({ db, env, bus, logger, metrics });

const context: AppContext = {
  db,
  engine,
  env,
  bus,
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
    const summary = await runSeed({ db, engine, bus, env, log: (line) => logger.info(`seed: ${line}`) });
    logger.info('演示数据就绪', {
      projects: summary.projects,
      agents: summary.agents,
      tasks: summary.tasks,
      memories: summary.memories,
      usageEvents: summary.usageEvents,
    });
    if (summary.demoApiKey) {
      logger.warn('已生成演示 API Key，请勿在生产环境保留', {
        project: summary.demoApiKey.projectSlug,
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

server.listen(env.port, env.host, () => {
  const base = `http://${env.host}:${env.port}`;
  logger.info('Mnemos 已启动', {
    url: base,
    api: `${base}/v1`,
    version: APP_VERSION,
    schemaVersion: getSchemaVersion(db),
    db: env.dbPath,
    logLevel: env.logLevel,
    metrics: env.metricsEnabled,
    quotaEnforce: env.quotaEnforce,
  });
  // 启动 60s 后首次维护，之后按间隔重复
  platform.maintenance.start();
  webhooks.start();
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
    // 先结束 keep-alive/SSE，否则 server.close() 会一直等待长连接
    const drain = drainConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await drain;
    webhooks.stop();
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
