/**
 * v6 规模种子：生成 1 个分区 + N 个人（默认 100000，可 --persons=1000000）+ 部分人的记忆。
 *
 * 用法：
 *   node scripts/seed-scale.ts --persons=100000
 *   node scripts/seed-scale.ts --persons=1000000 --db=/tmp/scale.db --batch=20000
 *
 * 说明：
 * - 使用全新/已有 v6 库；脚本自己跑 migrate()，不会碰 v5 的 data/（默认写 data-v6/scale.db）。
 * - 批量事务 + 预编译语句；FTS 与计数触发器保持开启（与生产同一路径）。
 * - 结束后打印 JSON：分区 id、人数、记忆数、耗时、persons/秒、触发器计数校验结果。
 */

import { join, resolve } from 'node:path';
import { APP_ROOT } from '../server/src/env.ts';
import { migrate, openDatabase, tx } from '../server/src/db/index.ts';
import { newId, nowIso } from '../server/src/lib/ids.ts';

interface Options {
  persons: number;
  dbPath: string;
  batch: number;
  slug: string;
  orgSlug: string;
  memoryEvery: number;
  memoriesPerPerson: number;
  /** 给第 0 个人额外写入 N 条记忆，用于「每人 1000 条」的性能验收 */
  heavyMemories: number;
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found?.slice(prefix.length);
}

function positiveInt(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) throw new Error(`--${name} 必须是正整数`);
  return Math.min(max, Math.trunc(value));
}

function parseOptions(): Options {
  const dbPath = resolve(arg('db') ?? join(APP_ROOT, 'data-v6', 'scale.db'));
  const forbidden = resolve(join(APP_ROOT, 'data'));
  if (dbPath.startsWith(`${forbidden}/`)) {
    throw new Error('拒绝写入 v5 数据目录 data/：v6 规模种子请使用 data-v6/ 或 /tmp 下的新库');
  }
  return {
    persons: positiveInt('persons', 100_000),
    dbPath,
    batch: positiveInt('batch', 10_000),
    slug: arg('slug') ?? 'scale',
    orgSlug: arg('org') ?? 'scale-org',
    memoryEvery: positiveInt('memory-every', 10),
    memoriesPerPerson: positiveInt('memories-per-person', 3, 20),
    heavyMemories: positiveInt('heavy-memories', 0, 100_000),
  };
}

const MEMORY_TEXTS = [
  '偏好简洁的周报，重点看关键指标与风险',
  '负责人列表与检索模块，使用 TypeScript 与 SQLite',
  '约定周一发布、周五代码冻结',
  '担心百万级数据下的 COUNT(*) 全表扫描',
  '要求列表接口 p95 小于 100ms、搜索 p95 小于 300ms',
  '遇到 FTS5 外部内容表触发器漏写导致搜索不到新数据',
  '决策：v6 只保留分区 / 人 / 记忆三个核心概念',
  '计划把游标分页接入控制台虚拟滚动',
  '风险：批量导入后计数需要 reconcile 校准',
  '记录：data-v6 是新的数据目录，旧 data/ 不迁移',
];

function seed(options: Options): Record<string, unknown> {
  const started = Date.now();
  const db = openDatabase(options.dbPath);
  // 批量导入优化：关闭自动 checkpoint + 关闭同步刷盘，结束前统一 checkpoint。
  // 仅影响本进程的连接；FTS 触发器与计数触发器仍逐行生效。
  db.exec('PRAGMA synchronous = OFF;');
  db.exec('PRAGMA wal_autocheckpoint = 0;');
  const migrateStarted = Date.now();
  migrate(db);
  const schemaMs = Date.now() - migrateStarted;

  const at = nowIso();
  const orgId = tx(db, () => {
    const existing = db.prepare('SELECT id FROM orgs WHERE slug = ?').get(options.orgSlug) as unknown as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    const id = newId('org');
    db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      options.orgSlug,
      options.orgSlug,
      'enterprise',
      at,
    );
    return id;
  });

  const partitionId = tx(db, () => {
    const existing = db
      .prepare('SELECT id FROM partitions WHERE org_id = ? AND slug = ?')
      .get(orgId, options.slug) as unknown as { id: string } | undefined;
    if (existing) return existing.id;
    const id = newId('ptn');
    db.prepare(
      `INSERT INTO partitions
         (id, org_id, slug, name, description, status, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      id,
      orgId,
      options.slug,
      `规模测试分区 ${options.slug}`,
      'seed-scale 生成',
      JSON.stringify({ defaultScope: 'partition', briefMaxChars: 1200, dreamEnabled: false }),
      at,
      at,
    );
    return id;
  });

  const insertPerson = db.prepare(
    `INSERT OR IGNORE INTO persons
       (id, partition_id, external_id, type, display_name, attributes, status,
        memory_count, shared_memory_count, session_count,
        last_memory_at, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 0, 0, NULL, ?, ?, ?, ?)`,
  );
  const insertMemory = db.prepare(
    `INSERT OR IGNORE INTO memories
       (id, partition_id, person_id, actor_person_id, scope, session_id, category, content,
        importance, confidence, source, status, tags, metadata, created_at, updated_at, expires_at, dreamed_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0.8, 'import', 'active', '[]', '{}', ?, ?, NULL, NULL)`,
  );

  const base = Date.now();
  const dayMs = 86_400_000;
  const personIds: string[] = new Array(options.persons);
  let memories = 0;
  let personsInserted = 0;

  const personsStarted = Date.now();
  for (let start = 0; start < options.persons; start += options.batch) {
    const end = Math.min(options.persons, start + options.batch);
    tx(db, () => {
      for (let index = start; index < end; index += 1) {
        const type = index % 50 === 0 ? 'service' : index % 10 === 0 ? 'agent' : 'human';
        const externalId = type === 'human' ? `user_${index}` : `${type}_${index}`;
        const displayName =
          type === 'human' ? `用户 ${index}` : type === 'agent' ? `智能体 ${index}` : `服务 ${index}`;
        const created = new Date(base - (index % 365) * dayMs).toISOString();
        const lastSeen = new Date(base - (index % 30) * dayMs - (index % 86_400) * 1_000).toISOString();
        insertPerson.run(
          `prs_seed_${index}`,
          partitionId,
          externalId,
          type,
          displayName,
          JSON.stringify({ seeded: true, index }),
          created,
          lastSeen,
          created,
          created,
        );
        personIds[index] = `prs_seed_${index}`;
        personsInserted += 1;
      }
    });
  }
  const personsMs = Date.now() - personsStarted;

  const memoriesStarted = Date.now();
  let memorySeq = 0;

  function writeMemoriesFor(personIndex: number): void {
    const personId = personIds[personIndex]!;
    const count = 1 + (personIndex % options.memoriesPerPerson);
    for (let offset = 0; offset < count; offset += 1) {
      const contentIndex = (personIndex * 7 + offset * 3) % MEMORY_TEXTS.length;
      const text = MEMORY_TEXTS[contentIndex]!;
      const scope = offset % 3 === 0 ? 'partition' : 'person';
      const createdAt = new Date(base - ((personIndex * 13 + offset) % 180) * dayMs).toISOString();
      insertMemory.run(
        `mem_seed_${memorySeq}`,
        partitionId,
        personId,
        personId,
        scope,
        'fact',
        `${text}（样本 ${personIndex}-${offset}）`,
        0.5,
        createdAt,
        createdAt,
      );
      memorySeq += 1;
      memories += 1;
    }
  }

  // 每 memoryEvery 人写一批记忆；按批事务提交。
  let pendingIndices: number[] = [];
  const flushMemories = (indices: number[]): void => {
    if (indices.length === 0) return;
    tx(db, () => {
      for (const index of indices) writeMemoriesFor(index);
    });
  };
  for (let index = 0; index < options.persons; index += 1) {
    if (index % options.memoryEvery !== 0) continue;
    pendingIndices.push(index);
    if (pendingIndices.length >= options.batch) {
      flushMemories(pendingIndices);
      pendingIndices = [];
    }
  }
  flushMemories(pendingIndices);
  if (options.heavyMemories > 0 && options.persons > 0) {
    const personId = personIds[0]!;
    tx(db, () => {
      for (let index = 0; index < options.heavyMemories; index += 1) {
        const at = new Date(base - index * 60_000).toISOString();
        insertMemory.run(
          `mem_heavy_${index}`,
          partitionId,
          personId,
          personId,
          'person',
          'fact',
          `重记忆 ${index}：分页与检索的性能样本`,
          0.5,
          at,
          at,
        );
        memories += 1;
      }
    });
  }
  const memoriesMs = Date.now() - memoriesStarted;

  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    /* checkpoint 失败不影响数据正确性 */
  }

  // 触发器计数 vs 实际 COUNT(*)（脚本内校验，允许慢）
  const stats = db.prepare('SELECT * FROM partition_stats WHERE partition_id = ?').get(partitionId) as unknown as {
    persons_total: number;
    memories_total: number;
    shared_total: number;
  };
  const actual = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM persons WHERE partition_id = ?) AS persons,
              (SELECT COUNT(*) FROM memories WHERE partition_id = ?) AS memories,
              (SELECT COUNT(*) FROM memories WHERE partition_id = ? AND scope = 'partition') AS shared`,
    )
    .get(partitionId, partitionId, partitionId) as unknown as { persons: number; memories: number; shared: number };

  const countsMatch =
    stats.persons_total === actual.persons &&
    stats.memories_total === actual.memories &&
    stats.shared_total === actual.shared;

  const result = {
    db: options.dbPath,
    orgId,
    partitionId,
    partitionSlug: options.slug,
    personsRequested: options.persons,
    personsInserted,
    memoriesInserted: memories,
    heavyMemories: options.heavyMemories,
    personsPerSecond: Math.round((personsInserted / Math.max(1, personsMs)) * 1000),
    schemaMs,
    personsMs,
    memoriesMs,
    totalMs: Date.now() - started,
    stats: {
      personsTotal: stats.persons_total,
      memoriesTotal: stats.memories_total,
      sharedTotal: stats.shared_total,
      countsMatch,
    },
  };
  db.close();
  return result;
}

try {
  const options = parseOptions();
  const result = seed(options);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[seed-scale] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export type { Options };
