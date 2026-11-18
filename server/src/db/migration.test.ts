import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { getSchemaVersion, migrate, tableCount } from './index.ts';
import { memoryContentHash } from '../lib/text.ts';

/**
 * v6 → v7 迁移验收：
 *  - 旧库保留数据；补 memories 的 embedding/valid_from/…、persons 的 merged_into/consent/deleted_at；
 *  - 回填 normalized_hash 与 valid_from=created_at；embedding 留给异步 embed 任务；
 *  - 新表（memory_history/memory_jobs/...）幂等创建；迁移可重复执行。
 */

const V6_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'enterprise', created_at TEXT NOT NULL
);
CREATE TABLE partitions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
  settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived_at TEXT, UNIQUE (org_id, slug)
);
CREATE TABLE persons (
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, external_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'human', display_name TEXT NOT NULL DEFAULT '',
  attributes TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active',
  memory_count INTEGER NOT NULL DEFAULT 0, shared_memory_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0, last_memory_at TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE (partition_id, type, external_id)
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY, partition_id TEXT NOT NULL, person_id TEXT NOT NULL,
  actor_person_id TEXT, scope TEXT NOT NULL DEFAULT 'partition', session_id TEXT,
  category TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.8,
  source TEXT NOT NULL DEFAULT 'api', status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT, dreamed_at TEXT
);
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, content = 'memories', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

function makeV6Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(V6_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '6')").run();
  db.prepare("INSERT INTO orgs (id, name, slug, plan, created_at) VALUES ('org_1', 'O', 'o1', 'enterprise', '2025-01-01T00:00:00.000Z')").run();
  db.prepare(
    `INSERT INTO partitions (id, org_id, slug, name, description, status, settings, created_at, updated_at)
     VALUES ('ptn_1', 'org_1', 'p1', 'P1', '', 'active', '{}', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO persons (id, partition_id, external_id, type, display_name, attributes, status,
       memory_count, shared_memory_count, session_count, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES ('prs_1', 'ptn_1', 'alice', 'human', 'Alice', '{}', 'active', 0, 0, 0,
       '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO memories (id, partition_id, person_id, scope, category, content, importance, confidence,
       source, status, tags, metadata, created_at, updated_at, expires_at, dreamed_at)
     VALUES (?, 'ptn_1', 'prs_1', 'partition', 'fact', ?, 0.5, 0.8, 'api', 'active', '[]', '{}', ?, ?, NULL, NULL)`,
  );
  insert.run('mem_v6_1', 'Alice 喜欢美式咖啡', '2025-02-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z');
  insert.run('mem_v6_2', '团队周一发布', '2025-03-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z');
  return db;
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

test('迁移 v6→v8：保留数据、补列、回填 hash/valid_from、建新表', () => {
  const db = makeV6Database();
  migrate(db);
  assert.equal(getSchemaVersion(db), 8);

  const memoryColumns = columnsOf(db, 'memories');
  for (const column of [
    'normalized_hash',
    'embedding',
    'embedding_model',
    'dim',
    'valid_from',
    'valid_to',
    'superseded_by',
    'supersedes',
    'fact_key',
    'feedback_up',
    'feedback_down',
    'privacy_scanned_at',
  ]) {
    assert.ok(memoryColumns.has(column), `memories 缺少列 ${column}`);
  }
  const personColumns = columnsOf(db, 'persons');
  for (const column of ['merged_into', 'consent', 'deleted_at']) {
    assert.ok(personColumns.has(column), `persons 缺少列 ${column}`);
  }

  assert.equal(tableCount(db, 'memories'), 2);
  const rows = db
    .prepare('SELECT id, content, normalized_hash, embedding, valid_from, created_at, feedback_up FROM memories ORDER BY id')
    .all() as unknown as {
    id: string;
    content: string;
    normalized_hash: string | null;
    embedding: Uint8Array | null;
    valid_from: string | null;
    created_at: string;
    feedback_up: number;
  }[];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.normalized_hash, memoryContentHash(row.content));
    assert.equal(row.valid_from, row.created_at);
    assert.equal(row.feedback_up, 0);
    assert.equal(row.embedding, null, 'embedding 由异步任务/backfill 补齐');
  }

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  for (const table of [
    'memory_history',
    'memory_feedback',
    'memory_jobs',
    'idempotency_keys',
    'person_facts',
    'person_profiles',
    'memory_placeholders',
  ]) {
    assert.ok(tables.has(table), `${table} 应已创建`);
    assert.equal(tableCount(db, table), 0, `${table} 应为空`);
  }
  // v6.2：全局内置规则随迁移写入（4 regex + 4 prompt）
  assert.ok(tables.has('privacy_rules'), 'privacy_rules 应已创建');
  assert.equal(tableCount(db, 'privacy_rules'), 8);

  // 幂等：重复迁移不重复回填、不改版本
  migrate(db);
  assert.equal(getSchemaVersion(db), 8);
  assert.equal(tableCount(db, 'memories'), 2);
  db.close();
});
