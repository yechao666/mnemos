import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { getSchemaVersion, migrate } from './index.ts';

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all() as unknown as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

test('schema v10：核心表 + v6.1/v6.2/v6.3/v6.4 新表存在、旧领域表不建、schema_version=10', () => {
  const db = fresh();
  const tables = tableNames(db);

  for (const table of [
    'orgs',
    'users',
    'user_sessions',
    'partitions',
    'persons',
    'memories',
    'sessions',
    'memory_briefs',
    'dream_runs',
    'api_keys',
    'partition_stats',
    'usage_events',
    'audit_logs',
    'maintenance_runs',
    'persons_fts',
    'memories_fts',
    /* v6.1 P0/P1/P2 */
    'memory_history',
    'memory_feedback',
    'memory_jobs',
    'person_facts',
    'person_profiles',
    'memory_attachments',
    'idempotency_keys',
    'entities',
    'memory_entities',
    'relations',
    /* v6.2 隐私规则域 */
    'privacy_rules',
    'memory_placeholders',
    /* v6.3 规则库分组 */
    'privacy_rule_groups',
    /* v6.4 大模型设置 */
    'llm_providers',
    'llm_stage_configs',
    'llm_calls',
  ]) {
    assert.ok(tables.has(table), `缺少表 ${table}`);
  }

  for (const oldTable of [
    'projects',
    'project_members',
    'agents',
    'tasks',
    'memory_terms',
    'webhooks',
    'webhook_deliveries',
  ]) {
    assert.ok(!tables.has(oldTable), `v6 不应存在旧表 ${oldTable}`);
  }

  assert.equal(getSchemaVersion(db), 10);
  db.close();
});

test('schema v6：迁移拒绝 v5 旧库', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '5')").run();
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
  assert.throws(() => migrate(db), /v5|旧数据|data-v6/);
  db.close();
});

test('persons FTS：插入/更新/删除同步', () => {
  const db = fresh();
  db.exec(`
    INSERT INTO orgs (id, name, slug, plan, created_at) VALUES ('org_1', 'O', 'o1', 'enterprise', '2026-01-01T00:00:00.000Z');
    INSERT INTO partitions (id, org_id, slug, name, description, status, settings, created_at, updated_at)
    VALUES ('ptn_1', 'org_1', 'p1', 'P1', '', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO persons (id, partition_id, external_id, type, display_name, attributes, status,
      memory_count, shared_memory_count, session_count, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES ('prs_1', 'ptn_1', 'user_1001', 'human', '张小明', '{}', 'active', 0, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  const search = (q: string) =>
    db.prepare('SELECT rowid FROM persons_fts WHERE persons_fts MATCH ?').all(q) as unknown as Array<{ rowid: number }>;
  assert.equal(search('"user"*').length, 1);
  assert.equal(search('"张小"*').length, 1);

  db.prepare("UPDATE persons SET display_name = '李雷' WHERE id = 'prs_1'").run();
  assert.equal(search('"小明"*').length, 0, '旧标题应被删除');
  assert.equal(search('"李雷"*').length, 1, '新标题应可检索');

  db.prepare("DELETE FROM persons WHERE id = 'prs_1'").run();
  assert.equal(search('"李雷"*').length, 0);
  db.close();
});

test('memories FTS：内容更新同步', () => {
  const db = fresh();
  db.exec(`
    INSERT INTO orgs (id, name, slug, plan, created_at) VALUES ('org_1', 'O', 'o1', 'enterprise', '2026-01-01T00:00:00.000Z');
    INSERT INTO partitions (id, org_id, slug, name, description, status, settings, created_at, updated_at)
    VALUES ('ptn_1', 'org_1', 'p1', 'P1', '', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO persons (id, partition_id, external_id, type, display_name, attributes, status,
      memory_count, shared_memory_count, session_count, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES ('prs_1', 'ptn_1', 'u1', 'human', 'U1', '{}', 'active', 0, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO memories (id, partition_id, person_id, scope, category, content, importance, confidence, source, status, tags, metadata, created_at, updated_at)
    VALUES ('mem_1', 'ptn_1', 'prs_1', 'person', 'fact', 'coffee americano', 0.5, 0.8, 'api', 'active', '[]', '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  const search = (q: string) =>
    db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').all(q) as unknown as Array<{ rowid: number }>;
  assert.equal(search('"americano"*').length, 1);
  db.prepare("UPDATE memories SET content = 'coffee latte' WHERE id = 'mem_1'").run();
  assert.equal(search('"americano"*').length, 0);
  assert.equal(search('"latte"*').length, 1);
  db.close();
});

test('计数触发器：persons / memories / sessions / partition_stats / 人计数', () => {
  const db = fresh();
  db.exec(`
    INSERT INTO orgs (id, name, slug, plan, created_at) VALUES ('org_1', 'O', 'o1', 'enterprise', '2026-01-01T00:00:00.000Z');
    INSERT INTO partitions (id, org_id, slug, name, description, status, settings, created_at, updated_at)
    VALUES ('ptn_1', 'org_1', 'p1', 'P1', '', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO persons (id, partition_id, external_id, type, display_name, attributes, status,
      memory_count, shared_memory_count, session_count, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES ('prs_1', 'ptn_1', 'u1', 'human', 'U1', '{}', 'active', 0, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO persons (id, partition_id, external_id, type, display_name, attributes, status,
      memory_count, shared_memory_count, session_count, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES ('prs_2', 'ptn_1', 'a1', 'agent', 'A1', '{}', 'active', 0, 0, 0,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  const stats = () =>
    db.prepare('SELECT * FROM partition_stats WHERE partition_id = ?').get('ptn_1') as unknown as Record<string, number>;

  assert.deepEqual(
    { total: stats().persons_total, human: stats().persons_human, agent: stats().persons_agent },
    { total: 2, human: 1, agent: 1 },
  );

  db.exec(`
    INSERT INTO memories (id, partition_id, person_id, scope, category, content, importance, confidence, source, status, tags, metadata, created_at, updated_at)
    VALUES ('m1', 'ptn_1', 'prs_1', 'person', 'fact', 'c1', 0.5, 0.8, 'api', 'active', '[]', '{}', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    INSERT INTO memories (id, partition_id, person_id, scope, category, content, importance, confidence, source, status, tags, metadata, created_at, updated_at)
    VALUES ('m2', 'ptn_1', 'prs_1', 'partition', 'fact', 'c2', 0.5, 0.8, 'api', 'active', '[]', '{}', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
  `);
  assert.equal(stats().memories_total, 2);
  assert.equal(stats().shared_total, 1);
  const person = db.prepare('SELECT * FROM persons WHERE id = ?').get('prs_1') as unknown as Record<string, unknown>;
  assert.equal(person.memory_count, 1);
  assert.equal(person.shared_memory_count, 1);
  assert.equal(person.last_memory_at, '2026-01-03T00:00:00.000Z');

  db.prepare("UPDATE memories SET scope = 'partition' WHERE id = 'm1'").run();
  const after = db.prepare('SELECT * FROM persons WHERE id = ?').get('prs_1') as unknown as Record<string, unknown>;
  assert.equal(after.memory_count, 0);
  assert.equal(after.shared_memory_count, 2);

  db.prepare("DELETE FROM memories WHERE id = 'm2'").run();
  assert.equal(stats().memories_total, 1);
  assert.equal(stats().shared_total, 1);

  db.exec(`
    INSERT INTO sessions (id, partition_id, person_id, title, status, started_at, metadata)
    VALUES ('s1', 'ptn_1', 'prs_1', '会话', 'active', '2026-01-04T00:00:00.000Z', '{}');
  `);
  assert.equal(stats().sessions_total, 1);
  const withSession = db.prepare('SELECT session_count FROM persons WHERE id = ?').get('prs_1') as unknown as {
    session_count: number;
  };
  assert.equal(withSession.session_count, 1);
  db.close();
});
