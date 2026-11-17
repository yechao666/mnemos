import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, createPerson, count } from './test-helpers.ts';

test('persons：按 partition+type+external_id 幂等 upsert', () => {
  const fx = setup();
  const first = createPerson(fx, 'alice');
  const again = fx.svc.upsertPerson(fx.partitionId, { externalId: 'alice', type: 'human', displayName: 'Alice' }, fx.actor);
  assert.equal(again.id, first.id);
  assert.equal(again.displayName, 'Alice');
  assert.equal(count(fx.db, 'SELECT COUNT(*) FROM persons WHERE partition_id = ?', fx.partitionId), 1);

  // 同 externalId 不同 type 是不同的人
  const agent = fx.svc.upsertPerson(fx.partitionId, { externalId: 'alice', type: 'agent', displayName: 'Alice Agent' }, fx.actor);
  assert.notEqual(agent.id, first.id);
  assert.equal(agent.type, 'agent');
  fx.db.close();
});

test('persons：更新资料与状态', () => {
  const fx = setup();
  const person = createPerson(fx, 'bob');
  const updated = fx.svc.updatePerson(
    fx.partitionId,
    'bob',
    { displayName: '鲍勃', attributes: { team: 'backend' }, status: 'archived' },
    fx.actor,
  );
  assert.equal(updated.id, person.id);
  assert.equal(updated.displayName, '鲍勃');
  assert.deepEqual(updated.attributes, { team: 'backend' });
  assert.equal(updated.status, 'archived');
  assert.equal(fx.svc.getPerson(fx.partitionId, person.id)?.displayName, '鲍勃');
  fx.db.close();
});

test('persons：游标分页无重复无遗漏（recent）', () => {
  const fx = setup();
  const total = 120;
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let index = 0; index < total; index += 1) {
    const externalId = `user_${String(index).padStart(4, '0')}`;
    const person = createPerson(fx, externalId);
    fx.db
      .prepare('UPDATE persons SET last_seen_at = ?, created_at = ? WHERE id = ?')
      .run(new Date(base + index * 60_000).toISOString(), new Date(base + index * 60_000).toISOString(), person.id);
  }

  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = fx.svc.listPersons(fx.partitionId, { limit: 50, cursor, sort: 'recent' });
    assert.ok(page.items.length <= 50);
    seen.push(...page.items.map((person) => person.externalId));
    assert.equal(page.partitionStats?.personsTotal, total);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages <= 10, '分页不应死循环');
  } while (cursor);

  assert.equal(pages, 3);
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  assert.equal(seen[0], 'user_0119');
  assert.equal(seen[seen.length - 1], 'user_0000');
  fx.db.close();
});

test('persons：三种排序与游标连续性（new / name）', () => {
  const fx = setup();
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const ids = ['charlie', 'alice', 'bob', 'dave'];
  for (const [index, externalId] of ids.entries()) {
    const person = fx.svc.upsertPerson(
      fx.partitionId,
      { externalId, type: 'human', displayName: externalId },
      fx.actor,
    );
    fx.db
      .prepare('UPDATE persons SET created_at = ?, last_seen_at = ? WHERE id = ?')
      .run(new Date(base + index * 1_000).toISOString(), new Date(base + index * 1_000).toISOString(), person.id);
  }

  const newPage = fx.svc.listPersons(fx.partitionId, { sort: 'new', limit: 2 });
  assert.deepEqual(newPage.items.map((p) => p.externalId), ['dave', 'bob']);
  const newPage2 = fx.svc.listPersons(fx.partitionId, {
    sort: 'new',
    limit: 2,
    cursor: newPage.nextCursor ?? undefined,
  });
  assert.deepEqual(newPage2.items.map((p) => p.externalId), ['alice', 'charlie']);

  const namePage = fx.svc.listPersons(fx.partitionId, { sort: 'name', limit: 2 });
  assert.deepEqual(namePage.items.map((p) => p.externalId), ['alice', 'bob']);
  const namePage2 = fx.svc.listPersons(fx.partitionId, {
    sort: 'name',
    limit: 2,
    cursor: namePage.nextCursor ?? undefined,
  });
  assert.deepEqual(namePage2.items.map((p) => p.externalId), ['charlie', 'dave']);

  // 游标与排序不匹配 → 400
  assert.throws(
    () => fx.svc.listPersons(fx.partitionId, { sort: 'name', cursor: newPage.nextCursor ?? undefined }),
    /游标/,
  );
  fx.db.close();
});

test('persons：FTS 前缀搜索 + 类型/状态筛选 + 分区隔离', () => {
  const fx = setup();
  createPerson(fx, 'user_1001');
  createPerson(fx, 'user_1002');
  fx.svc.upsertPerson(fx.partitionId, { externalId: 'agent_alpha', type: 'agent', displayName: '阿尔法' }, fx.actor);
  const archived = createPerson(fx, 'user_9999');
  fx.svc.updatePerson(fx.partitionId, archived.id, { status: 'archived' }, fx.actor);

  assert.deepEqual(
    fx.svc.listPersons(fx.partitionId, { q: 'user_100' }).items.map((p) => p.externalId).sort(),
    ['user_1001', 'user_1002'],
  );
  assert.deepEqual(
    fx.svc.listPersons(fx.partitionId, { q: '阿尔' }).items.map((p) => p.externalId),
    ['agent_alpha'],
  );
  assert.deepEqual(
    fx.svc.listPersons(fx.partitionId, { q: 'age' }).items.map((p) => p.externalId),
    ['agent_alpha'],
  );
  assert.equal(fx.svc.listPersons(fx.partitionId, { q: 'user_' }).items.length, 3);
  assert.deepEqual(
    fx.svc.listPersons(fx.partitionId, { type: 'agent' }).items.map((p) => p.externalId),
    ['agent_alpha'],
  );
  assert.deepEqual(
    fx.svc.listPersons(fx.partitionId, { status: 'archived' }).items.map((p) => p.externalId),
    ['user_9999'],
  );

  // 另一个分区看不到
  const other = fx.svc.upsertPartition(fx.orgId, { slug: 'other', name: 'Other' }, fx.actor);
  assert.equal(fx.svc.listPersons(other.id, { q: 'user' }).items.length, 0);
  assert.equal(fx.svc.listPersons(other.id, {}).partitionStats?.personsTotal, 0);
  fx.db.close();
});

test('persons：limit 默认 50、最大 200', () => {
  const fx = setup();
  for (let index = 0; index < 60; index += 1) createPerson(fx, `u_${index}`);
  const page = fx.svc.listPersons(fx.partitionId, {});
  assert.equal(page.items.length, 50);
  assert.ok(page.nextCursor);

  const capped = fx.svc.listPersons(fx.partitionId, { limit: 999 });
  assert.equal(capped.items.length, 60);
  fx.db.close();
});
