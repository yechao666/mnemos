/**
 * 手动写入 v6 演示数据：`node server/src/seed/run-seed.ts --force`
 * --force 会清空 v6 全部业务数据（含 org/users，保证重复执行幂等）。
 */
import { ensureDir, loadEnv } from '../env.ts';
import { migrate, openDatabase, tableCount } from '../db/index.ts';
import { createMemoryService } from '../engine/index.ts';
import { runSeed } from './seed.ts';

const env = loadEnv();
ensureDir(env.dataDir);
const db = openDatabase(env.dbPath);
migrate(db);

if (tableCount(db, 'partitions') > 0 && !process.argv.includes('--force')) {
  console.error('[seed] 数据库中已有分区；如需重建演示数据请加 --force');
  db.close();
  process.exit(1);
}

if (process.argv.includes('--force')) {
  // 全量清空演示数据：先子表后主表；orgs 删除会级联 users / partitions / api_keys。
  db.exec(`
    DELETE FROM memory_briefs;
    DELETE FROM dream_runs;
    DELETE FROM memories;
    DELETE FROM sessions;
    DELETE FROM persons;
    DELETE FROM usage_events;
    DELETE FROM audit_logs;
    DELETE FROM user_sessions;
    DELETE FROM api_keys;
    DELETE FROM partitions;
    DELETE FROM users;
    DELETE FROM orgs;
  `);
}

const engine = createMemoryService(db);
const summary = await runSeed({ db, engine, env, log: (line) => console.log(`[seed] ${line}`) });
console.log(
  JSON.stringify(
    {
      orgId: summary.orgId,
      partitions: summary.partitions,
      persons: summary.persons,
      memories: summary.memories,
      demoPartitionKey: summary.demoApiKey?.secret,
      orgKey: summary.orgKey?.secret,
    },
    null,
    2,
  ),
);
console.log('[seed] 演示账号：admin@mnemos.dev / Demo123456');
db.close();
