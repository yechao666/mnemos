import assert from 'node:assert/strict';
import test from 'node:test';
import { addMemory, createPerson, setup } from './test-helpers.ts';

test('brief：人级包含本人记忆 + 分区共享；缓存命中与失效', async () => {
  const fx = setup();
  const alice = createPerson(fx, 'alice');
  const bob = createPerson(fx, 'bob');
  addMemory(fx, { personId: alice.id, scope: 'person', content: 'Alice 偏好简洁周报', category: 'preference' });
  addMemory(fx, { personId: alice.id, scope: 'person', content: 'Alice 负责感恩日记改版', category: 'fact' });
  addMemory(fx, { personId: bob.id, scope: 'partition', content: '团队周一发布', category: 'decision' });
  addMemory(fx, { personId: bob.id, scope: 'partition', content: '周五代码冻结', category: 'constraint' });

  const first = await fx.svc.brief({ partitionId: fx.partitionId, personId: alice.id });
  assert.equal(first.count, 4);
  assert.equal(first.cached, false);
  assert.match(first.text, /简洁周报/);
  assert.match(first.text, /周一发布/);
  assert.match(first.text, /（bob）/);
  assert.equal(first.personId, alice.id);
  assert.equal(first.scopeKey, `person:${alice.id}`);

  const second = await fx.svc.brief({ partitionId: fx.partitionId, personId: alice.id });
  assert.equal(second.cached, true);
  assert.equal(second.generatedAt, first.generatedAt);

  const forced = await fx.svc.brief({ partitionId: fx.partitionId, personId: alice.id, force: true });
  assert.equal(forced.cached, false);

  // 来源变化 → 重新生成
  addMemory(fx, { personId: alice.id, scope: 'person', content: 'Alice 新增一条计划', category: 'plan' });
  const afterChange = await fx.svc.brief({ partitionId: fx.partitionId, personId: alice.id });
  assert.equal(afterChange.cached, false);
  assert.match(afterChange.text, /新增一条计划/);
  fx.db.close();
});

test('brief：分区级只看 scope=partition，maxChars 截断', async () => {
  const fx = setup();
  const alice = createPerson(fx, 'alice');
  addMemory(fx, { personId: alice.id, scope: 'person', content: '私有记忆不应出现' });
  addMemory(fx, { personId: alice.id, scope: 'partition', content: '共享记忆 A' });
  addMemory(fx, { personId: alice.id, scope: 'partition', content: '共享记忆 B' });

  const brief = await fx.svc.brief({ partitionId: fx.partitionId, maxChars: 100 });
  assert.equal(brief.scopeKey, 'partition');
  assert.ok(brief.text.length <= 100);
  assert.match(brief.text, /共享记忆/);
  assert.doesNotMatch(brief.text, /私有记忆/);
  fx.db.close();
});

test('context：资料 + 简报 + 记忆 + 共享，按预算截断', async () => {
  const fx = setup();
  const alice = createPerson(fx, 'alice');
  addMemory(fx, { personId: alice.id, scope: 'person', content: 'Alice 喜欢 TypeScript', category: 'skill' });
  addMemory(fx, { personId: alice.id, scope: 'partition', content: '项目使用 SQLite 与 TypeScript', category: 'fact' });

  const context = await fx.svc.context({ partitionId: fx.partitionId, personId: alice.id, query: 'TypeScript' });
  assert.equal(context.person.externalId, 'alice');
  assert.ok(context.brief.text.length > 0);
  assert.ok(context.memories.length >= 1);
  assert.ok(context.shared.length >= 1);
  assert.match(context.prompt, /## 人物资料/);
  assert.match(context.prompt, /## 记忆简报/);
  assert.match(context.prompt, /## 分区共享知识/);
  assert.ok(context.tokenEstimate > 0);
  assert.ok(context.citations.includes(context.memories[0]!.id));

  const small = await fx.svc.context({ partitionId: fx.partitionId, personId: alice.id, budgetTokens: 60 });
  assert.ok(small.prompt.length <= context.prompt.length);

  const noShared = await fx.svc.context({
    partitionId: fx.partitionId,
    personId: alice.id,
    includePartition: false,
  });
  assert.equal(noShared.shared.length, 0);
  assert.doesNotMatch(noShared.prompt, /分区共享知识/);
  fx.db.close();
});

test('dream：人级增量巩固，洞见归属该人', async () => {
  const fx = setup();
  const alice = createPerson(fx, 'alice');
  const bob = createPerson(fx, 'bob');
  addMemory(fx, { personId: alice.id, scope: 'person', content: 'Alice 偏好一', category: 'preference' });
  addMemory(fx, { personId: alice.id, scope: 'person', content: 'Alice 偏好二', category: 'preference' });
  addMemory(fx, { personId: bob.id, scope: 'partition', content: '共享约定', category: 'decision' });

  const status0 = fx.svc.dreamStatus({ partitionId: fx.partitionId, personId: alice.id });
  assert.equal(status0.pendingCount, 2);
  assert.equal(status0.lastRun, undefined);

  const result = await fx.svc.dream({ partitionId: fx.partitionId, personId: alice.id, trigger: 'manual' }, fx.actor);
  assert.equal(result.run?.status, 'completed');
  assert.equal(result.run?.inputCount, 2);
  assert.equal(result.run?.insightCount, 1);
  assert.equal(result.status.pendingCount, 0);
  assert.equal(result.status.runs.length, 1);

  const insights = fx.svc.listMemories({ partitionId: fx.partitionId, personId: alice.id, category: 'insight' });
  assert.equal(insights.items.length, 1);
  assert.equal(insights.items[0]?.scope, 'person');
  assert.equal(insights.items[0]?.source, 'dream');
  assert.equal(insights.items[0]?.personId, alice.id);
  assert.ok(insights.items[0]?.dreamedAt, '洞见自身标记为已巩固');

  // 已巩固的输入不再进入下一批
  const second = await fx.svc.dream({ partitionId: fx.partitionId, personId: alice.id }, fx.actor);
  assert.equal(second.run?.status, 'skipped');
  assert.equal(second.status.pendingCount, 0);

  // 分区级仍有共享记忆待巩固
  assert.equal(fx.svc.dreamStatus({ partitionId: fx.partitionId }).pendingCount, 1);
  // 人级洞见本身标记为已巩固，不会再次进入下一批
  fx.db.close();
});

test('dream：分区级洞见归属系统人且 scope=partition', async () => {
  const fx = setup();
  const alice = createPerson(fx, 'alice');
  addMemory(fx, { personId: alice.id, scope: 'partition', content: '共享事实一', category: 'fact' });
  addMemory(fx, { personId: alice.id, scope: 'partition', content: '共享事实二', category: 'fact' });

  const result = await fx.svc.dream({ partitionId: fx.partitionId, trigger: 'manual' }, fx.actor);
  assert.equal(result.run?.status, 'completed');
  assert.equal(result.run?.inputCount, 2);
  assert.equal(result.run?.personId, undefined);

  const insights = fx.svc.listMemories({ partitionId: fx.partitionId, scope: 'partition', category: 'insight' });
  assert.equal(insights.items.length, 1);
  const insight = insights.items[0]!;
  const owner = fx.svc.getPerson(fx.partitionId, insight.personId);
  assert.equal(owner?.externalId, 'mnemos-dream');
  assert.equal(owner?.type, 'service');

  // 分区级洞见自身标记为已巩固，不会再次进入下一批
  const second = await fx.svc.dream({ partitionId: fx.partitionId }, fx.actor);
  assert.equal(second.run?.status, 'skipped');
  fx.db.close();
});

test('reconcile：批量导入后校准计数', () => {
  const fx = setup();
  const alice = createPerson(fx, 'alice');
  addMemory(fx, { personId: alice.id, scope: 'person', content: 'a' });
  addMemory(fx, { personId: alice.id, scope: 'partition', content: 'b' });

  // 人为破坏计数（模拟批量导入绕过触发器）
  fx.db.prepare('UPDATE partition_stats SET persons_total = 999, memories_total = 0 WHERE partition_id = ?').run(fx.partitionId);
  fx.db.prepare('UPDATE persons SET memory_count = 0, shared_memory_count = 0 WHERE id = ?').run(alice.id);

  const result = fx.svc.reconcileCounts(fx.partitionId);
  assert.equal(result.personsTotal, 1);
  assert.equal(result.memoriesTotal, 2);
  assert.equal(result.sharedTotal, 1);
  assert.equal(result.updatedPersons, 1);

  const stats = fx.svc.partitionStats(fx.partitionId);
  assert.equal(stats.personsTotal, 1);
  assert.equal(stats.memoriesTotal, 2);
  assert.equal(stats.sharedTotal, 1);
  const person = fx.svc.getPerson(fx.partitionId, alice.id);
  assert.equal(person?.memoryCount, 1);
  assert.equal(person?.sharedMemoryCount, 1);
  fx.db.close();
});
