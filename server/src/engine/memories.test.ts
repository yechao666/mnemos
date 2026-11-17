import assert from 'node:assert/strict';
import test from 'node:test';
import { addMemory, count, createPerson, setup } from './test-helpers.ts';

test('memories：person 必填 + scope 缺省取分区设置 + 触发器计数', () => {
  const fx = setup({ settings: { defaultScope: 'person' } });
  const person = createPerson(fx, 'alice');

  assert.throws(() => fx.svc.addMemory({ partitionId: fx.partitionId, content: '无主记忆', actor: fx.actor }), /person/);

  const memory = addMemory(fx, { personId: person.id, content: 'Alice 喜欢美式咖啡', category: 'preference' });
  assert.equal(memory.scope, 'person');
  assert.equal(memory.personExternalId, 'alice');

  const stats = fx.svc.partitionStats(fx.partitionId);
  assert.equal(stats.memoriesTotal, 1);
  assert.equal(stats.sharedTotal, 0);
  const stored = fx.svc.getPerson(fx.partitionId, person.id);
  assert.equal(stored?.memoryCount, 1);
  assert.equal(stored?.sharedMemoryCount, 0);
  assert.ok(stored?.lastMemoryAt);
  fx.db.close();
});

test('memories：按 external_id 自动建档（personAutoCreate）', () => {
  const fx = setup({ settings: { personAutoCreate: true } });
  const memory = addMemory(fx, {
    personExternalId: 'bob',
    personType: 'agent',
    content: 'Bob 是后端工程师',
    scope: 'partition',
  });
  assert.equal(memory.personExternalId, 'bob');
  const person = fx.svc.getPerson(fx.partitionId, 'bob');
  assert.ok(person);
  assert.equal(person?.type, 'agent');
  assert.equal(person?.sharedMemoryCount, 1);

  // 关闭自动建档后拒绝
  const fx2 = setup({ settings: { personAutoCreate: false } });
  assert.throws(
    () => addMemory(fx2, { personExternalId: 'nobody', content: 'x' }),
    /人不存在/,
  );
  fx.db.close();
  fx2.db.close();
});

test('memories：session scope 校验与自动建会话', () => {
  const fx = setup();
  const person = createPerson(fx, 'carol');

  assert.throws(
    () => addMemory(fx, { personId: person.id, scope: 'session', content: '缺少 session' }),
    /session_id/,
  );

  const memory = addMemory(fx, {
    personId: person.id,
    scope: 'session',
    sessionId: 'conv_1',
    sessionTitle: '第一次对话',
    content: 'Carol 说要先看结论',
  });
  assert.equal(memory.sessionId, 'conv_1');
  assert.equal(fx.svc.partitionStats(fx.partitionId).sessionsTotal, 1);
  assert.equal(fx.svc.getPerson(fx.partitionId, person.id)?.sessionCount, 1);

  // 同一 session 复用不重复建
  addMemory(fx, { personId: person.id, scope: 'session', sessionId: 'conv_1', content: '第二条' });
  assert.equal(fx.svc.partitionStats(fx.partitionId).sessionsTotal, 1);

  // 其他分区复用同一 session id → 冲突
  const other = fx.svc.upsertPartition(fx.orgId, { slug: 'other', name: 'Other' }, fx.actor);
  const otherPerson = fx.svc.upsertPerson(other.id, { externalId: 'carol' }, fx.actor);
  assert.throws(
    () =>
      fx.svc.addMemory({
        partitionId: other.id,
        personId: otherPerson.id,
        scope: 'session',
        sessionId: 'conv_1',
        content: 'x',
        actor: fx.actor,
      }),
    /其他分区/,
  );
  fx.db.close();
});

test('memories：列表筛选、FTS、游标与隔离', () => {
  const fx = setup({ settings: { defaultScope: 'partition' } });
  const alice = createPerson(fx, 'alice');
  const bob = createPerson(fx, 'bob');
  addMemory(fx, { personId: alice.id, content: 'Alice 的私有偏好', category: 'preference', scope: 'person' });
  addMemory(fx, { personId: alice.id, content: '团队约定周一发布', category: 'decision', scope: 'partition' });
  addMemory(fx, { personId: bob.id, content: 'Bob 负责检索模块', category: 'fact', scope: 'partition' });
  addMemory(fx, { personId: bob.id, content: 'Bob 的私有笔记', category: 'context', scope: 'person' });

  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId }).items.length, 4);
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId, personId: alice.id }).items.length, 2);
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId, scope: 'partition' }).items.length, 2);
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId, category: 'fact' }).items.length, 1);
  assert.deepEqual(
    fx.svc.listMemories({ partitionId: fx.partitionId, q: '检索' }).items.map((m) => m.personExternalId),
    ['bob'],
  );
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId, personExternalId: 'alice' }).items.length, 2);
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId, personExternalId: 'ghost' }).items.length, 0);

  // 游标翻页
  const page1 = fx.svc.listMemories({ partitionId: fx.partitionId, limit: 2 });
  assert.equal(page1.items.length, 2);
  const page2 = fx.svc.listMemories({
    partitionId: fx.partitionId,
    limit: 2,
    cursor: page1.nextCursor ?? undefined,
  });
  assert.equal(page2.items.length, 2);
  assert.equal(new Set([...page1.items, ...page2.items].map((m) => m.id)).size, 4);

  // 隔离
  const other = fx.svc.upsertPartition(fx.orgId, { slug: 'other', name: 'Other' }, fx.actor);
  assert.equal(fx.svc.listMemories({ partitionId: other.id }).items.length, 0);
  fx.db.close();
});

test('memories：详情 / 更新 / 删除与计数回退', () => {
  const fx = setup();
  const person = createPerson(fx, 'dave');
  const memory = addMemory(fx, { personId: person.id, content: '旧内容', scope: 'partition', category: 'fact' });

  const detail = fx.svc.getMemory(fx.partitionId, memory.id);
  assert.equal(detail?.person?.externalId, 'dave');
  assert.equal(detail?.memory.content, '旧内容');

  const updated = fx.svc.updateMemory(
    fx.partitionId,
    memory.id,
    { content: '新内容拿铁', category: 'preference', importance: 0.9 },
    fx.actor,
  );
  assert.equal(updated.content, '新内容拿铁');
  assert.equal(updated.importance, 0.9);
  assert.equal(updated.category, 'preference');
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId, q: '拿铁' }).items.length, 1);
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId, q: '旧内容' }).items.length, 0);

  fx.svc.removeMemory(fx.partitionId, memory.id, fx.actor);
  assert.equal(fx.svc.getMemory(fx.partitionId, memory.id), null);
  assert.equal(fx.svc.partitionStats(fx.partitionId).memoriesTotal, 0);
  assert.equal(fx.svc.getPerson(fx.partitionId, person.id)?.sharedMemoryCount, 0);

  assert.throws(() => fx.svc.updateMemory(fx.partitionId, memory.id, { content: 'x' }, fx.actor), /不存在/);
  assert.throws(() => fx.svc.removeMemory(fx.partitionId, memory.id, fx.actor), /不存在/);
  fx.db.close();
});

test('memories：归档分区禁止写入', () => {
  const fx = setup();
  const person = createPerson(fx, 'erin');
  fx.svc.updatePartition(fx.orgId, fx.partitionId, { status: 'archived' }, fx.actor);
  assert.throws(
    () => addMemory(fx, { personId: person.id, content: '归档后写入' }),
    /已归档/,
  );
  fx.db.close();
});
