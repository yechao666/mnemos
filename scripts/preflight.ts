/**
 * v6 上线预检：数据目录可写、数据库完整性、schema 版本、端口占用、演示/生产账号提示。
 *
 * 用法：
 *   node scripts/preflight.ts
 *   MNEMOS_DATA_DIR=data-v6 MNEMOS_PORT=4380 node scripts/preflight.ts
 */
import { accessSync, constants, existsSync } from 'node:fs';
import net from 'node:net';
import { ensureDir, loadEnv } from '../server/src/env.ts';
import { getSchemaVersion, migrate, openDatabase, SCHEMA_VERSION } from '../server/src/db/index.ts';

const env = loadEnv();
const issues: string[] = [];
const warnings: string[] = [];

try {
  ensureDir(env.dataDir);
  accessSync(env.dataDir, constants.W_OK);
} catch (error) {
  issues.push(`数据目录不可写：${env.dataDir}（${error instanceof Error ? error.message : String(error)}）`);
}

let users = 0;
if (existsSync(env.dbPath)) {
  const db = openDatabase(env.dbPath);
  try {
    migrate(db);
    const version = getSchemaVersion(db);
    if (version !== SCHEMA_VERSION) issues.push(`schema_version=${version}，期望 ${SCHEMA_VERSION}`);
    const integrity = db.prepare('PRAGMA integrity_check').get() as unknown as { integrity_check?: string };
    if (integrity?.integrity_check !== 'ok') issues.push(`integrity_check=${integrity?.integrity_check ?? 'unknown'}`);
    users = Number((db.prepare('SELECT COUNT(*) AS c FROM users').get() as unknown as { c?: number })?.c ?? 0);
    if (users === 0 && !env.demoMode && !env.bootstrapEmail) {
      warnings.push('库中没有用户：生产首次启动需 MNEMOS_BOOTSTRAP_EMAIL / MNEMOS_BOOTSTRAP_PASSWORD，或设置 MNEMOS_DEMO=1');
    }
  } finally {
    db.close();
  }
} else {
  warnings.push(`数据库尚不存在（首次启动会创建）：${env.dbPath}`);
}

const portFree = await new Promise<boolean>((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.once('listening', () => server.close(() => resolve(true)));
  server.listen(env.port, env.host);
});

console.log(JSON.stringify({
  env: {
    nodeEnv: env.nodeEnv,
    demoMode: env.demoMode,
    host: env.host,
    port: env.port,
    dataDir: env.dataDir,
    dbPath: env.dbPath,
    webDist: env.webDist,
  },
  schemaVersion: existsSync(env.dbPath) ? getSchemaVersion(openDatabase(env.dbPath)) : null,
  users,
  portFree,
  warnings,
  issues,
}, null, 2));

if (issues.length > 0 || !portFree) {
  if (!portFree) issues.push(`端口被占用：${env.host}:${env.port}`);
  console.error('[preflight] 未通过：' + issues.join('；'));
  process.exit(1);
}
console.log('[preflight] 通过');
