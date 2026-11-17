import { closeDatabase, migrate, openDatabase } from '../db/index.ts';
import { createMemoryService } from '../engine/index.ts';
import { ensureDir, loadEnv } from '../env.ts';
import { EventBus } from '../lib/bus.ts';
import { runSeed } from './seed.ts';

const env = loadEnv();
ensureDir(env.dataDir);

const db = openDatabase(env.dbPath);
migrate(db);

const bus = new EventBus();
const engine = createMemoryService(db, { bus });

const force = process.argv.includes('--force');
const summary = await runSeed({ db, engine, bus, env, force, log: (line) => console.log(`[seed] ${line}`) });

console.log('');
console.log(`  项目        ${summary.projects}`);
console.log(`  成员关系    ${summary.members}`);
console.log(`  Agent       ${summary.agents}`);
console.log(`  人          ${summary.persons}`);
console.log(`  任务会话    ${summary.tasks}`);
console.log(`  记忆        ${summary.memories}`);
console.log(`  用量事件    ${summary.usageEvents}`);
console.log(`  审计日志    ${summary.auditEvents}`);
if (summary.demoApiKey) {
  console.log(`  演示密钥    ${summary.demoApiKey.secret}（${summary.demoApiKey.projectSlug}）`);
}
console.log('');

closeDatabase(db);
