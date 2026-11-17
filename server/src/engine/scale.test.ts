import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/index.ts';
import { createMemoryService } from './index.ts';
import { nowIso } from '../lib/ids.ts';

/**
 * 5 万人规模断言（1M 为 scripts/seed-scale.ts 手动验收）：
 * 游标正确性、FTS 前缀搜索、触发器计数、分区隔离。
 */

const TOTAL = 50_000;

function seedPersons(): { db: DatabaseSync; svc: ReturnType<typeof createMemoryService>; partitionId: string } {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const at = nowIso();
  db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'org_scale',
    '规模组织',
    'scale-org',
    'enterprise',
    at,
  );
  const svc = createMemoryService(db);
  const partition = svc.upsertPartition('org_scale', { slug: 'scale', name: '规模分区' }, {
    type: 'user',
    id: 'u1',
    label: 'seed',
  });
  const insert = db.prepare(
    `INSERT INTO persons
       (id, partition_id, external_id, type, display_name, attributes, status,
        memory_count, shared_memory_count, session_count,
        last_memory_at, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'active', 0, 0, 0, NULL, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  for (let index = 0; index < TOTAL; index += 1) {
    const type = index % 10 === 0 ? 'agent' : 'human';
    const externalId = type === 'human' ? `user_${index}` : `agent_${index}`;
    const created = new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
    insert.run(`prs_${index}`, partition.id, externalId, type, `${type} ${index}`, created, created, created, created);
  }
  db.exec('COMMIT');
  return { db, svc, partitionId: partition.id };
}

test(`persons：${TOTAL} 人游标分页无重复无遗漏`, () => {
  const { db, svc, partitionId } = seedPersons();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let previousLastSeen = '';

  do {
    const page = svc.listPersons(partitionId, { limit: 200, cursor, sort: 'recent' });
    assert.equal(page.partitionStats?.personsTotal, TOTAL);
    for (const person of page.items) {
      assert.ok(!seen.has(person.id), `重复的人 ${person.id}`);
      seen.add(person.id);
      assert.ok(person.lastSeenAt <= previousLastSeen || previousLastSeen === '', 'recent 排序应单调递减');
      previousLastSeen = person.lastSeenAt;
    }
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages <= Math.ceil(TOTAL / 200) + 1);
  } while (cursor);

  assert.equal(seen.size, TOTAL);
  assert.equal(pages, TOTAL / 200);
  db.close();
});

test(`${TOTAL} 人：FTS 前缀搜索 + 类型筛选 + 计数 + 隔离`, () => {
  const { db, svc, partitionId } = seedPersons();

  const exact = svc.listPersons(partitionId, { q: 'user_49999' });
  assert.equal(exact.items.length, 1);
  assert.equal(exact.items[0]?.externalId, 'user_49999');

  const prefix = svc.listPersons(partitionId, { q: 'user_4999' });
  assert.equal(prefix.items.length, 10, 'user_4999 + user_49991..49999（49990 是 agent）');
  assert.ok(prefix.items.every((person) => person.externalId.startsWith('user_4999')));

  const agents = svc.listPersons(partitionId, { type: 'agent', limit: 200 });
  assert.equal(agents.partitionStats?.personsAgent, TOTAL / 10);
  assert.equal(agents.partitionStats?.personsHuman, TOTAL - TOTAL / 10);

  const stats = svc.partitionStats(partitionId);
  assert.equal(stats.personsTotal, TOTAL);
  assert.equal(stats.personsAgent, TOTAL / 10);
  assert.equal(stats.personsHuman, TOTAL - TOTAL / 10);

  // 另一个分区（同库）看不到
  const other = svc.upsertPartition('org_scale', { slug: 'other', name: 'Other' }, {
    type: 'user',
    id: 'u1',
    label: 'seed',
  });
  assert.equal(svc.listPersons(other.id, {}).items.length, 0);
  assert.equal(svc.partitionStats(other.id).personsTotal, 0);
  db.close();
});
