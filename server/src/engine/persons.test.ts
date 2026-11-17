/**
 * 中立记忆服务 v5：人（Person）与 scope 语义测试（node:test，内存 SQLite）。
 *
 * 覆盖：persons upsert/解析/列表统计、写入默认 scope 与自动建档、按人去重/检索隔离、
 * 人级 brief/context/dream、legacy user_id/agent_id 兼容、finishTask 人归属、v4→v5 迁移回填。
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { migrate } from '../db/index.ts';
import { DomainError } from './errors.ts';
import { getDreamStatus } from './dream.ts';
import { addMemory, setup, type Fixture } from './test-helpers.ts';

function isDomain(status: number) {
  return (error: unknown): boolean => error instanceof DomainError && error.status === status;
}

function personCount(fx: Fixture, externalId: string, type?: string): number {
  const row = fx.db
    .prepare(
      `SELECT COUNT(*) AS c FROM persons WHERE project_id = ? AND external_id = ?${type ? ' AND type = ?' : ''}`,
    )
    .get(fx.projectId, externalId, ...(type ? [type] : [])) as unknown as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

function memoryCount(fx: Fixture): number {
  const row = fx.db
    .prepare('SELECT COUNT(*) AS c FROM memories WHERE project_id = ?')
    .get(fx.projectId) as unknown as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

/* ------------------------------------------------------------------ */
/* persons：upsert / 解析 / 列表                                        */
/* ------------------------------------------------------------------ */

test('persons：upsert 幂等、同 external 不同类型并存、外部引用消歧', async () => {
  const fx = setup();

  const human = await fx.svc.upsertPerson(
    fx.projectId,
    { externalId: 'user-123', type: 'human', displayName: '张倩', attributes: { tier: 'gold' } },
    fx.actor,
  );
  assert.ok(human.id.startsWith('prs_'));
  assert.equal(human.partitionId, fx.projectId);
  assert.equal(human.externalId, 'user-123');
  assert.equal(human.type, 'human');
  assert.equal(human.displayName, '张倩');
  assert.deepEqual(human.attributes, { tier: 'gold' });
  assert.equal(human.status, 'active');
  assert.ok(human.firstSeenAt && human.lastSeenAt && human.createdAt && human.updatedAt);
  assert.equal(human.stats?.memories, 0);

  // 同 (project, human, external) 幂等：只更新 displayName，attributes 未传则保留
  const again = await fx.svc.upsertPerson(
    fx.projectId,
    { externalId: ' user-123 ', type: 'human', displayName: '张倩（华东）' },
    fx.actor,
  );
  assert.equal(again.id, human.id);
  assert.equal(again.displayName, '张倩（华东）');
  assert.deepEqual(again.attributes, { tier: 'gold' });
  assert.equal(personCount(fx, 'user-123', 'human'), 1);

  // 同一个 external_id 允许同时存在 agent 类型的人
  const agent = await fx.svc.upsertPerson(
    fx.projectId,
    { externalId: 'user-123', type: 'agent', displayName: '张倩的数字分身' },
    fx.actor,
  );
  assert.notEqual(agent.id, human.id);
  assert.equal(personCount(fx, 'user-123'), 2);

  // 内部 id 精确命中
  assert.equal((await fx.svc.person(fx.projectId, human.id))?.id, human.id);
  assert.equal((await fx.svc.person(fx.projectId, agent.id))?.type, 'agent');
  // external_id 命中 human + agent 两种类型 → 无法判定，返回 null
  assert.equal(await fx.svc.person(fx.projectId, 'user-123'), null);

  // 列表默认包含全部状态/类型，并按最近活跃排序
  const listed = await fx.svc.persons({ projectId: fx.projectId });
  assert.equal(listed.total, 2);
  assert.equal(listed.items.length, 2);

  // 写操作审计
  const audits = fx.db
    .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE project_id = ? AND action LIKE 'person.%'")
    .get(fx.projectId) as unknown as { c?: number };
  assert.equal(Number(audits.c ?? 0), 3); // create + upsert + create(agent)

  const updated = await fx.svc.updatePerson(
    fx.projectId,
    human.id,
    { displayName: '张倩（已归档）', attributes: { tier: 'platinum' }, status: 'archived' },
    fx.actor,
  );
  assert.equal(updated.displayName, '张倩（已归档）');
  assert.equal(updated.status, 'archived');
  assert.deepEqual(updated.attributes, { tier: 'platinum' });
  const updateAudit = fx.db
    .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE project_id = ? AND action = 'person.update'")
    .get(fx.projectId) as unknown as { c?: number };
  assert.equal(Number(updateAudit.c ?? 0), 1);

  await assert.rejects(() => fx.svc.updatePerson(fx.projectId, 'prs_missing', { displayName: 'x' }, fx.actor), isDomain(404));
  await assert.rejects(
    () => fx.svc.upsertPerson(fx.projectId, { externalId: '  ', type: 'human' }, fx.actor),
    isDomain(422),
  );
});

test('persons：列表过滤 / 分页 / stats 聚合（按 memories.person_id）', async () => {
  const fx = setup();
  const alice = await fx.svc.upsertPerson(
    fx.projectId,
    { externalId: 'alice', type: 'human', displayName: 'Alice' },
    fx.actor,
  );
  const bob = await fx.svc.upsertPerson(
    fx.projectId,
    { externalId: 'bob', type: 'human', displayName: 'Bob', status: 'archived' },
    fx.actor,
  );
  const agent = await fx.svc.upsertPerson(
    fx.projectId,
    { externalId: 'agent-1', type: 'agent', displayName: '研发 Agent' },
    fx.actor,
  );

  await addMemory(fx, { text: 'Alice 的私有笔记：偏好简洁回复。', infer: false, personId: alice.id, scope: 'person' });
  await addMemory(fx, {
    text: 'Alice 的会话内上下文：今天在排查搜索延迟。',
    infer: false,
    personId: alice.id,
    scope: 'session',
    sessionId: 'sess-alice-1',
  });
  await addMemory(fx, {
    text: 'Alice 的第二个会话：确认检索阈值。',
    infer: false,
    personId: alice.id,
    scope: 'session',
    sessionId: 'sess-alice-2',
  });
  await addMemory(fx, {
    text: '关于 Alice 的分区共享记录：她负责华东区客户。',
    infer: false,
    personId: alice.id,
    scope: 'partition',
  });
  await addMemory(fx, { text: 'Bob 的一条私有记忆。', infer: false, personId: bob.id, scope: 'person' });
  void agent;

  const humans = await fx.svc.persons({ projectId: fx.projectId, type: 'human' });
  assert.equal(humans.total, 2);
  assert.ok(humans.items.every((person) => person.type === 'human'));

  const searchByName = await fx.svc.persons({ projectId: fx.projectId, q: 'Ali' });
  assert.equal(searchByName.total, 1);
  assert.equal(searchByName.items[0]?.id, alice.id);

  const activeOnly = await fx.svc.persons({ projectId: fx.projectId, status: 'active' });
  assert.equal(activeOnly.total, 2);
  assert.ok(activeOnly.items.every((person) => person.status === 'active'));

  const page1 = await fx.svc.persons({ projectId: fx.projectId, page: 1, pageSize: 1, sort: 'name' });
  const page2 = await fx.svc.persons({ projectId: fx.projectId, page: 2, pageSize: 1, sort: 'name' });
  assert.equal(page1.total, 3);
  assert.equal(page1.items.length, 1);
  assert.notEqual(page1.items[0]?.id, page2.items[0]?.id);

  const byMemories = await fx.svc.persons({ projectId: fx.projectId, sort: 'memories' });
  assert.equal(byMemories.items[0]?.id, alice.id, '记忆最多的人排最前');

  const aliceDetail = await fx.svc.person(fx.projectId, alice.id);
  assert.equal(aliceDetail?.stats?.memories, 4);
  assert.equal(aliceDetail?.stats?.sharedMemories, 1);
  assert.equal(aliceDetail?.stats?.sessions, 2);
  assert.ok(aliceDetail?.stats?.lastMemoryAt);
});

/* ------------------------------------------------------------------ */
/* add：scope / 自动建档 / session 校验                                 */
/* ------------------------------------------------------------------ */

test('add：defaultScope、personAutoCreate 与 scope=session 校验', async () => {
  // 消费类 App：默认 scope=person，首次写入自动建档
  const personDefault = setup({ slug: 'person-default', settings: { defaultScope: 'person' } });
  const privateResult = await addMemory(personDefault, {
    text: '用户偏好深色模式，每天早上九点看日报。',
    infer: false,
    personExternalId: 'user-123',
  });
  assert.equal(privateResult.results.length, 1);
  const privateMemory = privateResult.results[0];
  assert.equal(privateMemory.scope, 'person');
  assert.equal(privateMemory.visibility, 'agent');
  assert.ok(privateMemory.personId);
  assert.equal(privateMemory.personExternalId, 'user-123');
  assert.equal(personCount(personDefault, 'user-123', 'human'), 1);

  // 关闭自动建档：显式引用不存在 → 404
  const noAuto = setup({ slug: 'no-auto', settings: { personAutoCreate: false } });
  await assert.rejects(
    () =>
      addMemory(noAuto, {
        text: '这条记忆不应该被写入。',
        infer: false,
        personExternalId: 'ghost-user',
      }),
    isDomain(404),
  );
  assert.equal(memoryCount(noAuto), 0);
  // defaultScope=person 但未提供 person → 422
  const personDefault2 = setup({ slug: 'person-default-2', settings: { defaultScope: 'person' } });
  await assert.rejects(
    () => addMemory(personDefault2, { text: '缺少 person 的写入。', infer: false }),
    isDomain(422),
  );

  // 协作项目：默认 scope=partition（不建人）
  const fx = setup();
  const shared = await addMemory(fx, { text: '分区共享约定：所有 SQL 必须参数化。', infer: false });
  assert.equal(shared.results[0].scope, 'partition');
  assert.equal(shared.results[0].visibility, 'project');
  assert.equal(shared.results[0].personId, undefined);
  assert.equal((await fx.svc.persons({ projectId: fx.projectId })).total, 0);

  // scope=session 必须带 sessionId/taskId
  await assert.rejects(
    () => addMemory(fx, { text: '缺少会话的临时记忆。', infer: false, scope: 'session' }),
    isDomain(422),
  );
  await assert.rejects(
    () => addMemory(fx, { text: '旧 visibility=task 缺少 taskId。', infer: false, visibility: 'task' }),
    isDomain(422),
  );
  const session = await addMemory(fx, {
    text: '会话内临时上下文：今天排查搜索延迟。',
    infer: false,
    scope: 'session',
    sessionId: 'sess-1',
  });
  assert.equal(session.results[0].scope, 'session');
  assert.equal(session.results[0].sessionId, 'sess-1');
  assert.equal(session.results[0].visibility, 'task');
});

/* ------------------------------------------------------------------ */
/* 去重隔离                                                             */
/* ------------------------------------------------------------------ */

test('dedupe：scope=person 按 person 隔离，不同人的相同内容不会互相合并', async () => {
  const fx = setup({ settings: { extractionMode: 'consolidate', dedupeThreshold: 0.9 } });
  const first = await addMemory(fx, {
    text: '用户喜欢喝手冲咖啡。',
    infer: false,
    personExternalId: 'alice',
    scope: 'person',
  });
  const second = await addMemory(fx, {
    text: '用户喜欢喝手冲咖啡。',
    infer: false,
    personExternalId: 'bob',
    scope: 'person',
  });
  assert.equal(first.results.length, 1);
  assert.equal(first.merged, 0);
  assert.equal(second.results.length, 1);
  assert.equal(second.merged, 0);
  assert.equal(memoryCount(fx), 2);
  assert.notEqual(first.results[0].personId, second.results[0].personId);

  // 同一人的重复内容仍然合并
  const duplicate = await addMemory(fx, {
    text: '用户喜欢喝手冲咖啡。',
    infer: false,
    personExternalId: 'alice',
    scope: 'person',
  });
  assert.equal(duplicate.results.length, 0);
  assert.equal(duplicate.merged, 1);
  assert.equal(duplicate.events[0]?.type, 'MERGE');
  assert.equal(memoryCount(fx), 2);
});

/* ------------------------------------------------------------------ */
/* 检索 / 列表隔离                                                      */
/* ------------------------------------------------------------------ */

test('search/list：按人过滤与调用方可见性（partition + 本人 person + 本会话）', async () => {
  const fx = setup();
  await addMemory(fx, { text: '分区共享：所有配置改动必须走 review。', infer: false, scope: 'partition' });
  const aliceMemory = await addMemory(fx, {
    text: 'Alice 的私有偏好：每天早上喝一杯美式。',
    infer: false,
    personExternalId: 'alice',
    scope: 'person',
  });
  const bobMemory = await addMemory(fx, {
    text: 'Bob 的私有偏好：每天早上喝一杯拿铁。',
    infer: false,
    personExternalId: 'bob',
    scope: 'person',
  });

  // 其他人（Bob）检索不到 Alice 的私有记忆
  const asBob = await fx.svc.search({ projectId: fx.projectId, query: '美式', personId: 'bob' });
  assert.ok(!asBob.results.some((memory) => memory.content.includes('美式')));

  // 本人视角：命中自己的 person 记忆，并带上 personExternalId
  const asAlice = await fx.svc.search({ projectId: fx.projectId, query: '美式', personId: 'alice' });
  assert.ok(asAlice.results.length >= 1);
  assert.equal(asAlice.results[0]?.id, aliceMemory.results[0].id);
  assert.equal(asAlice.results[0]?.personExternalId, 'alice');
  assert.equal(asAlice.results[0]?.scope, 'person');

  // 控制台 / 审计视角可见全部私有
  const consoleView = await fx.svc.search({ projectId: fx.projectId, query: '偏好', includePrivate: true });
  assert.ok(consoleView.results.some((memory) => memory.id === aliceMemory.results[0].id));
  assert.ok(consoleView.results.some((memory) => memory.id === bobMemory.results[0].id));

  // 列表：按人过滤 + scope 过滤
  const listAlice = await fx.svc.list({ projectId: fx.projectId, personId: 'alice' });
  assert.equal(listAlice.total, 1);
  assert.equal(listAlice.items[0]?.personExternalId, 'alice');
  const personScopeList = await fx.svc.list({ projectId: fx.projectId, scope: 'person', includePrivate: true });
  assert.equal(personScopeList.total, 2);
  const publicList = await fx.svc.list({ projectId: fx.projectId });
  assert.ok(publicList.items.every((memory) => memory.scope === 'partition'));

  // 不存在的 person 引用 → 404
  await assert.rejects(
    () => fx.svc.search({ projectId: fx.projectId, query: '偏好', personId: 'ghost' }),
    isDomain(404),
  );
});

/* ------------------------------------------------------------------ */
/* 人级 brief / context                                                 */
/* ------------------------------------------------------------------ */

test('brief：人级简报只含该人 person 记忆与相关分区记忆，并写入 person 缓存键', async () => {
  const fx = setup();
  const alice = await fx.svc.upsertPerson(
    fx.projectId,
    { externalId: 'alice', type: 'human', displayName: '张倩' },
    fx.actor,
  );
  const bob = await fx.svc.upsertPerson(fx.projectId, { externalId: 'bob', type: 'human', displayName: 'Bob' }, fx.actor);

  await addMemory(fx, {
    text: '张倩偏好把会议安排在每周一上午。',
    infer: false,
    personId: alice.id,
    scope: 'person',
  });
  await addMemory(fx, {
    text: '关于张倩的工作交接：她负责华东区客户。',
    infer: false,
    personId: alice.id,
    scope: 'partition',
  });
  await addMemory(fx, { text: '分区通用约定：所有 SQL 必须参数化。', infer: false, scope: 'partition' });
  await addMemory(fx, { text: 'Bob 的私有记忆：喜欢周末徒步。', infer: false, personId: bob.id, scope: 'person' });
  await addMemory(fx, {
    text: '关于 Bob 的分区共享记录：他负责华南区客户。',
    infer: false,
    personId: bob.id,
    scope: 'partition',
  });

  const brief = await fx.svc.brief({ projectId: fx.projectId, personId: 'alice' });
  assert.equal(brief.personId, alice.id);
  assert.equal(brief.projectId, fx.projectId);
  assert.ok(brief.count >= 2);
  assert.ok(brief.text.includes('会议安排在每周一上午'), '包含该人 person 记忆');
  assert.ok(brief.text.includes('负责华东区客户'), '包含与该人相关的分区记忆');
  assert.ok(brief.text.includes('所有 SQL 必须参数化'), '包含分区通用共享知识');
  assert.ok(!brief.text.includes('周末徒步'), '不包含其他人的私有记忆');
  assert.ok(!brief.text.includes('负责华南区客户'), '不包含其他人的分区记录');
  assert.ok(brief.recent.every((item) => item.scope === 'person' || item.scope === 'partition'));
  assert.ok(brief.recent.some((item) => item.personExternalId === 'alice'));

  const cache = fx.db
    .prepare('SELECT * FROM memory_briefs WHERE project_id = ? AND scope = ?')
    .get(fx.projectId, `person:${alice.id}`) as unknown as { person_id: string; text: string } | undefined;
  assert.ok(cache);
  assert.equal(cache.person_id, alice.id);

  const cached = await fx.svc.brief({ projectId: fx.projectId, personId: 'alice' });
  assert.equal(cached.cached, true);
  assert.equal(cached.personId, alice.id);

  await assert.rejects(() => fx.svc.brief({ projectId: fx.projectId, personId: 'ghost' }), isDomain(404));
});

test('personContext：资料 + 简报 + 相关记忆 + 分区共享，组装可注入 prompt', async () => {
  const fx = setup();
  const alice = await fx.svc.upsertPerson(
    fx.projectId,
    { externalId: 'alice', type: 'human', displayName: '张倩', attributes: { tier: 'gold' } },
    fx.actor,
  );
  await fx.svc.upsertPerson(fx.projectId, { externalId: 'bob', type: 'human', displayName: 'Bob' }, fx.actor);
  await addMemory(fx, {
    text: '张倩喜欢简洁直接的回复风格。',
    infer: false,
    personId: alice.id,
    scope: 'person',
  });
  await addMemory(fx, { text: '分区共享：接口变更必须同步更新 OpenAPI。', infer: false, scope: 'partition' });
  await addMemory(fx, {
    text: 'Bob 的私有记忆：不要出现在张倩的上下文里。',
    infer: false,
    personExternalId: 'bob',
    scope: 'person',
  });

  const context = await fx.svc.personContext({
    projectId: fx.projectId,
    personRef: 'alice',
    query: '回复风格',
  });
  assert.equal(context.person.id, alice.id);
  assert.equal(context.person.displayName, '张倩');
  assert.deepEqual(context.person.attributes, { tier: 'gold' });
  assert.equal(context.brief.personId, alice.id);
  assert.ok(context.memories.length >= 1);
  assert.ok(context.memories.every((memory) => memory.personId === alice.id));
  assert.ok(context.shared.length >= 1);
  assert.ok(context.shared.every((memory) => memory.scope === 'partition'));
  assert.ok(context.prompt.includes('# 人的上下文：张倩'));
  assert.ok(context.prompt.includes('简洁直接'));
  assert.ok(context.prompt.includes('OpenAPI'));
  assert.ok(!context.prompt.includes('不要出现在张倩的上下文里'));
  assert.ok(context.tokenEstimate > 0);
  assert.ok(context.citations.includes(context.memories[0].id));
  assert.ok(context.builtAt);

  const withoutPartition = await fx.svc.personContext({
    projectId: fx.projectId,
    personRef: alice.id,
    includePartition: false,
  });
  assert.deepEqual(withoutPartition.shared, []);
  assert.ok(!withoutPartition.prompt.includes('## 分区共享知识'));

  await assert.rejects(
    () => fx.svc.personContext({ projectId: fx.projectId, personRef: 'ghost' }),
    isDomain(404),
  );
});

/* ------------------------------------------------------------------ */
/* 人级 dream                                                           */
/* ------------------------------------------------------------------ */

test('dream：personId 只巩固该人 person 记忆，洞见归属该人且 run 记录 person_id', async () => {
  const fx = setup({ settings: { dreamEnabled: true } });
  const alice = await fx.svc.upsertPerson(fx.projectId, { externalId: 'alice', type: 'human', displayName: 'Alice' }, fx.actor);
  const bob = await fx.svc.upsertPerson(fx.projectId, { externalId: 'bob', type: 'human', displayName: 'Bob' }, fx.actor);

  const aliceMemory = await addMemory(fx, {
    text: 'Alice 偏好把周报放在周五下午写。',
    infer: false,
    personId: alice.id,
    scope: 'person',
  });
  const bobMemory = await addMemory(fx, {
    text: 'Bob 偏好把复盘放在周一上午做。',
    infer: false,
    personId: bob.id,
    scope: 'person',
  });
  const partitionMemory = await addMemory(fx, {
    text: '分区共享：需求评审必须提前一天通知。',
    infer: false,
    scope: 'partition',
  });

  assert.equal(getDreamStatus(fx.db, fx.projectId).pendingCount, 1, '分区级 pending 只看 partition');

  const result = await fx.svc.dream({ projectId: fx.projectId, personId: 'alice' }, fx.actor);
  assert.ok(result.run);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.inputCount, 1);
  assert.ok((result.run.insightCount ?? 0) >= 1);

  // run 记录 person_id
  const runRow = fx.db
    .prepare('SELECT person_id FROM memory_dream_runs WHERE id = ?')
    .get(result.run.id) as unknown as { person_id: string | null };
  assert.equal(runRow.person_id, alice.id);
  // 人级运行不进入分区状态面板
  assert.ok(!result.status.runs.some((run) => run.id === result.run?.id));

  const insights = fx.db
    .prepare(
      "SELECT * FROM memories WHERE project_id = ? AND category = 'insight' AND source = 'dream'",
    )
    .all(fx.projectId) as unknown as Array<{
    id: string;
    content: string;
    person_id: string | null;
    actor_person_id: string | null;
    scope: string;
    dreamed_at: string | null;
  }>;
  assert.equal(insights.length, result.run.insightCount);
  for (const insight of insights) {
    assert.equal(insight.person_id, alice.id);
    assert.equal(insight.scope, 'person');
    assert.ok(insight.actor_person_id, 'actor_person_id = 做梦系统 actor');
    assert.notEqual(insight.actor_person_id, alice.id);
    assert.ok(insight.dreamed_at);
    assert.ok(!insight.content.includes('周一上午'), '不应包含 Bob 的记忆');
    assert.ok(!insight.content.includes('需求评审'), '不应包含分区共享记忆');
  }
  const systemPerson = fx.db
    .prepare("SELECT type FROM persons WHERE project_id = ? AND external_id = 'mnemos-dream'")
    .get(fx.projectId) as unknown as { type: string } | undefined;
  assert.equal(systemPerson?.type, 'service');

  // 批次记忆 dreamed_at：只标记 Alice 的；Bob / 分区记忆不受影响
  const dreamed = fx.db
    .prepare('SELECT id, dreamed_at FROM memories WHERE project_id = ? AND category != \'insight\'')
    .all(fx.projectId) as unknown as Array<{ id: string; dreamed_at: string | null }>;
  const dreamedById = new Map(dreamed.map((row) => [row.id, row.dreamed_at]));
  assert.ok(dreamedById.get(aliceMemory.results[0].id));
  assert.equal(dreamedById.get(bobMemory.results[0].id), null);
  assert.equal(dreamedById.get(partitionMemory.results[0].id), null);

  // 再次人级做梦：没有新记忆 → skipped
  const again = await fx.svc.dream({ projectId: fx.projectId, personId: alice.id }, fx.actor);
  assert.equal(again.run?.status, 'skipped');

  // 分区级做梦仍可单独运行
  const partitionDream = await fx.svc.dream({ projectId: fx.projectId }, fx.actor);
  assert.equal(partitionDream.run?.status, 'completed');
  assert.equal(partitionDream.run?.inputCount, 1);
  assert.equal(getDreamStatus(fx.db, fx.projectId).runs.length, 1);
});

/* ------------------------------------------------------------------ */
/* legacy 兼容                                                          */
/* ------------------------------------------------------------------ */

test('legacy：user_id/agent_id 映射 person 并双写 visibility/scope，旧检索语义不变', async () => {
  const fx = setup();
  const userMemory = await addMemory(fx, {
    text: '用户 A 的项目代号是 Aurora。',
    infer: false,
    userId: 'usr_a',
  });
  assert.equal(userMemory.results[0].scope, 'partition');
  assert.equal(userMemory.results[0].visibility, 'project');
  assert.ok(userMemory.results[0].personId);
  assert.equal(userMemory.results[0].personExternalId, 'usr_a');
  assert.equal(personCount(fx, 'usr_a', 'human'), 1);

  const agentPrivate = await addMemory(fx, {
    text: 'Agent X 的私有技巧：先看 SQL 慢查询日志。',
    infer: false,
    agentId: 'agent-x',
    visibility: 'agent',
  });
  assert.equal(agentPrivate.results[0].scope, 'person');
  assert.equal(agentPrivate.results[0].visibility, 'agent');
  assert.equal(agentPrivate.results[0].personExternalId, 'agent-x');
  assert.equal(personCount(fx, 'agent-x', 'agent'), 1);

  // 旧 agentId 可见性语义：本人可见、他人不可见
  const own = await fx.svc.search({ projectId: fx.projectId, query: '慢查询 技巧', agentId: 'agent-x' });
  assert.ok(own.results.some((memory) => memory.content.includes('慢查询')));
  const other = await fx.svc.search({ projectId: fx.projectId, query: '慢查询 技巧', agentId: 'agent-y' });
  assert.ok(!other.results.some((memory) => memory.content.includes('慢查询')));

  // 旧 visibility 过滤映射到 scope
  const privateList = await fx.svc.list({ projectId: fx.projectId, agentId: 'agent-x', visibility: 'agent' });
  assert.equal(privateList.total, 1);
  assert.equal(privateList.items[0]?.visibility, 'agent');

  // 旧 userId 过滤仍然生效
  const byUser = await fx.svc.search({ projectId: fx.projectId, query: '项目代号', userId: 'usr_a' });
  assert.ok(byUser.results.length >= 1);
  assert.ok(byUser.results.every((memory) => memory.userId === 'usr_a'));
});

test('finishTask：决策归属到 Agent 对应 person，scope=partition', async () => {
  const fx = setup();
  const agent = await fx.svc.createAgent(fx.projectId, { name: '开发 Agent', role: 'developer' }, fx.actor);
  const task = await fx.svc.createTask(
    fx.projectId,
    { title: '支付回调幂等改造', ownerAgentId: agent.id },
    fx.actor,
  );

  const finished = await fx.svc.finishTask(
    fx.projectId,
    task.id,
    { decisions: ['采用幂等表保证回调只处理一次'], agentId: agent.id },
    fx.actor,
  );
  const decision = finished.memories.find((memory) => memory.content.includes('幂等表'));
  assert.ok(decision);
  assert.equal(decision.scope, 'partition');
  assert.equal(decision.visibility, 'project');
  assert.equal(decision.taskId, task.id);
  assert.ok(decision.personId);
  assert.equal(decision.personExternalId, agent.id);
  const person = await fx.svc.person(fx.projectId, decision.personExternalId!);
  assert.equal(person?.type, 'agent');
  assert.equal(person?.displayName, '开发 Agent');
});

/* ------------------------------------------------------------------ */
/* v4 → v5 迁移回填                                                     */
/* ------------------------------------------------------------------ */

function buildV4Database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.exec(
    `CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
       plan TEXT NOT NULL DEFAULT 'enterprise', created_at TEXT NOT NULL);`,
  );
  db.exec(
    `CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), slug TEXT NOT NULL,
       name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
       region TEXT NOT NULL DEFAULT 'cn-shanghai', env TEXT NOT NULL DEFAULT 'production',
       settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
       UNIQUE (org_id, slug));`,
  );
  db.exec(
    `CREATE TABLE api_keys (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
       name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
       scopes TEXT NOT NULL DEFAULT '[]', created_by TEXT, created_at TEXT NOT NULL,
       last_used_at TEXT, revoked_at TEXT, rate_limit_per_min INTEGER NOT NULL DEFAULT 600);`,
  );
  db.exec(
    `CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
       name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'assistant', model TEXT NOT NULL DEFAULT 'deepseek-chat',
       description TEXT NOT NULL DEFAULT '', capabilities TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
       metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, last_active_at TEXT, UNIQUE (project_id, name));`,
  );
  db.exec(
    `CREATE TABLE memories (
       id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
       user_id TEXT, agent_id TEXT, run_id TEXT, app_id TEXT, task_id TEXT,
       visibility TEXT NOT NULL DEFAULT 'project', content TEXT NOT NULL, normalized_hash TEXT NOT NULL,
       category TEXT NOT NULL DEFAULT 'fact', importance REAL NOT NULL DEFAULT 0.5,
       confidence REAL NOT NULL DEFAULT 0.8, source TEXT NOT NULL DEFAULT 'api',
       status TEXT NOT NULL DEFAULT 'active', tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}',
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_accessed_at TEXT,
       access_count INTEGER NOT NULL DEFAULT 0, expires_at TEXT, embedding BLOB,
       embedding_model TEXT, dim INTEGER, dreamed_at TEXT);`,
  );
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run();
  const at = new Date().toISOString();
  db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'org_v4',
    'v4 组织',
    'org-v4',
    'enterprise',
    at,
  );
  db.prepare(
    `INSERT INTO projects (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'active', 'cn-shanghai', 'production', '{}', ?, ?)`,
  ).run('proj_v4', 'org_v4', 'proj-v4', 'v4 项目', at, at);
  db.prepare(
    'INSERT INTO api_keys (id, project_id, name, prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('key_v4', 'proj_v4', 'v4 key', 'mnemos_live_v4', 'hash_v4', '["memories:read"]', at);
  db.prepare(
    'INSERT INTO agents (id, project_id, name, role, model, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('agent-a', 'proj_v4', '研发 Agent A', 'developer', 'deepseek-chat', at);

  const insert = db.prepare(
    `INSERT INTO memories (id, project_id, user_id, agent_id, run_id, task_id, visibility, content, normalized_hash,
       category, importance, confidence, source, status, tags, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fact', 0.5, 0.8, 'api', 'active', '[]', '{}', ?, ?)`,
  );
  insert.run('mem_agent_shared', 'proj_v4', null, 'agent-a', null, 'task-1', 'project', 'Agent A 的分区共享决策。', 'h1', at, at);
  insert.run('mem_agent_private', 'proj_v4', null, 'agent-a', null, null, 'agent', 'Agent A 的私有笔记。', 'h2', at, at);
  insert.run('mem_agent_task', 'proj_v4', null, 'agent-a', 'run-9', null, 'task', 'Agent A 的任务内上下文。', 'h3', at, at);
  insert.run('mem_human', 'proj_v4', 'user-123', null, null, 'task-2', 'project', '用户 123 的偏好。', 'h4', at, at);
  insert.run('mem_legacy', 'proj_v4', null, null, null, null, 'project', '没有归属的旧分区记忆。', 'h5', at, at);
  return db;
}

test('迁移 v4→v5：建人、回填 person_id/actor_person_id/scope/session_id 与 api_keys.org_id', () => {
  const db = buildV4Database();
  try {
    migrate(db);

    const version = (
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as { value: string }
    ).value;
    assert.equal(version, '5');

    const agentPerson = db
      .prepare("SELECT * FROM persons WHERE project_id = 'proj_v4' AND type = 'agent' AND external_id = 'agent-a'")
      .get() as unknown as { id: string; display_name: string; status: string } | undefined;
    assert.ok(agentPerson);
    assert.equal(agentPerson.display_name, '研发 Agent A');
    assert.equal(agentPerson.status, 'active');

    const humanPerson = db
      .prepare("SELECT * FROM persons WHERE project_id = 'proj_v4' AND type = 'human' AND external_id = 'user-123'")
      .get() as unknown as { id: string; display_name: string } | undefined;
    assert.ok(humanPerson);
    assert.equal(humanPerson.display_name, 'user-123');

    // 无归属的旧分区记忆不凭空造人
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS c FROM persons WHERE project_id = 'proj_v4'").get() as unknown as {
          c: number;
        }
      ).c,
      2,
    );

    const row = (id: string) =>
      db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as {
        person_id: string | null;
        actor_person_id: string | null;
        scope: string;
        session_id: string | null;
        visibility: string;
      };

    const shared = row('mem_agent_shared');
    assert.equal(shared.person_id, agentPerson.id);
    assert.equal(shared.actor_person_id, agentPerson.id);
    assert.equal(shared.scope, 'partition');
    assert.equal(shared.visibility, 'project');
    assert.equal(shared.session_id, 'task-1');

    const privateMemory = row('mem_agent_private');
    assert.equal(privateMemory.person_id, agentPerson.id);
    assert.equal(privateMemory.scope, 'person');

    const taskMemory = row('mem_agent_task');
    assert.equal(taskMemory.scope, 'session');
    assert.equal(taskMemory.session_id, 'run-9', 'session_id = COALESCE(task_id, run_id)');

    const humanMemory = row('mem_human');
    assert.equal(humanMemory.person_id, humanPerson.id);
    assert.equal(humanMemory.actor_person_id, humanPerson.id);
    assert.equal(humanMemory.scope, 'partition');
    assert.equal(humanMemory.session_id, 'task-2');

    const legacy = row('mem_legacy');
    assert.equal(legacy.person_id, null);
    assert.equal(legacy.actor_person_id, null);
    assert.equal(legacy.scope, 'partition');

    const key = db.prepare("SELECT * FROM api_keys WHERE id = 'key_v4'").get() as unknown as {
      org_id: string;
      kind: string;
    };
    assert.equal(key.org_id, 'org_v4');
    assert.equal(key.kind, 'project');

    // 迁移幂等：再次 migrate 不重复建人/不报错
    migrate(db);
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS c FROM persons WHERE project_id = 'proj_v4'").get() as unknown as {
          c: number;
        }
      ).c,
      2,
    );
  } finally {
    db.close();
  }
});
