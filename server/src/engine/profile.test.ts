import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { LlmConfig } from '../env.ts';
import { refreshPersonProfile, runProfileJob } from './index.ts';
import { addMemory, createPerson, setup } from './test-helpers.ts';

/** v6.1 P1：结构化画像 / facts 版本化 / 画像缓存 / factKey 自动沉淀 / as_of。 */

function activeFacts(fx: ReturnType<typeof setup>, ref: string) {
  return fx.svc.listPersonFacts(fx.partitionId, ref);
}

function factRows(fx: ReturnType<typeof setup>, key?: string): Array<Record<string, unknown>> {
  const sql = key
    ? 'SELECT * FROM person_facts WHERE partition_id = ? AND key = ? ORDER BY valid_from ASC, id ASC'
    : 'SELECT * FROM person_facts WHERE partition_id = ? ORDER BY valid_from ASC, id ASC';
  const params = key ? [fx.partitionId, key] : [fx.partitionId];
  return fx.db.prepare(sql).all(...params) as unknown as Array<Record<string, unknown>>;
}

test('profile：facts 同 key 版本化 + 同值幂等 + 删除软关闭 + 审计', () => {
  const fx = setup();
  try {
    const alice = createPerson(fx, 'alice');

    const first = fx.svc.upsertPersonFact(
      fx.partitionId,
      alice.id,
      { key: 'preference.language', value: '中文', confidence: 0.9 },
      fx.actor,
    );
    assert.equal(first.key, 'preference.language');
    assert.equal(first.validTo, undefined);
    assert.equal(activeFacts(fx, 'alice').length, 1);

    // 同 key + 同 value：幂等（同一个 fact，不产生新版本）
    const again = fx.svc.upsertPersonFact(
      fx.partitionId,
      'alice',
      { key: 'preference.language', value: '中文', confidence: 0.95 },
      fx.actor,
    );
    assert.equal(again.id, first.id);
    assert.equal(factRows(fx).length, 1);

    // 同 key + 新 value：旧版本 valid_to 置为 now，新版本生效
    const second = fx.svc.upsertPersonFact(
      fx.partitionId,
      'alice',
      { key: 'preference.language', value: 'English', confidence: 0.8 },
      fx.actor,
    );
    assert.notEqual(second.id, first.id);
    const rows = factRows(fx);
    assert.equal(rows.length, 2);
    const old = rows.find((row) => row.id === first.id);
    assert.ok(old?.valid_to, '旧 fact 应被关闭');
    assert.equal(activeFacts(fx, alice.id).length, 1);
    assert.equal(activeFacts(fx, alice.id)[0]?.value, 'English');

    // 写审计
    const actions = (
      fx.db
        .prepare("SELECT action FROM audit_logs WHERE partition_id = ? AND resource_type = 'person_fact'")
        .all(fx.partitionId) as unknown as Array<{ action: string }>
    ).map((row) => row.action);
    assert.ok(actions.includes('person.fact.create'));
    assert.ok(actions.includes('person.fact.update'));

    // DELETE：软关闭（历史保留），再次删除 404
    fx.svc.removePersonFact(fx.partitionId, 'alice', second.id, fx.actor);
    assert.equal(activeFacts(fx, 'alice').length, 0);
    const closed = factRows(fx).find((row) => row.id === second.id);
    assert.ok(closed?.valid_to);
    assert.throws(
      () => fx.svc.removePersonFact(fx.partitionId, 'alice', second.id, fx.actor),
      /不存在|已失效/,
    );
  } finally {
    fx.db.close();
  }
});

test('profile：摘要缓存命中与失效（facts / 记忆任一变化）', () => {
  const fx = setup();
  try {
    createPerson(fx, 'bob');
    fx.svc.upsertPersonFact(
      fx.partitionId,
      'bob',
      { key: 'identity.role', value: '后端工程师', confidence: 0.9 },
      fx.actor,
    );

    const first = fx.svc.personProfile(fx.partitionId, 'bob');
    assert.equal(first.cached, false);
    assert.match(first.summary, /后端工程师/);
    assert.ok(first.generatedAt);
    assert.equal(first.facts.length, 1);

    const cached = fx.svc.personProfile(fx.partitionId, 'bob');
    assert.equal(cached.cached, true);
    assert.equal(cached.summary, first.summary);
    assert.equal(cached.generatedAt, first.generatedAt);

    // facts 变化 → sourceHash 变化 → 缓存失效
    fx.svc.upsertPersonFact(
      fx.partitionId,
      'bob',
      { key: 'identity.role', value: '架构师', confidence: 0.9 },
      fx.actor,
    );
    const afterFact = fx.svc.personProfile(fx.partitionId, 'bob');
    assert.equal(afterFact.cached, false);
    assert.match(afterFact.summary, /架构师/);

    // 记忆变化 → 缓存失效
    addMemory(fx, { personId: createPerson(fx, 'bob').id, content: 'Bob 负责检索模块' });
    const afterMemory = fx.svc.personProfile(fx.partitionId, 'bob');
    assert.equal(afterMemory.cached, false);
    assert.match(afterMemory.summary, /检索模块/);
  } finally {
    fx.db.close();
  }
});

test('profile：factKey 记忆自动沉淀为 fact（confidence 继承、幂等、自动新版本）', () => {
  const fx = setup();
  try {
    const carol = createPerson(fx, 'carol');
    const memory = addMemory(fx, {
      personId: carol.id,
      content: 'Carol 的职业是产品经理',
      factKey: 'identity.job',
      confidence: 0.92,
    });
    runProfileJob(fx.db, fx.partitionId, { personId: carol.id });
    let facts = activeFacts(fx, carol.id);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.key, 'identity.job');
    assert.equal(facts[0]?.value, 'Carol 的职业是产品经理');
    assert.equal(facts[0]?.confidence, 0.92);
    assert.equal(facts[0]?.sourceMemoryId, memory.id);
    assert.equal(factRows(fx).length, 1);

    // 重跑 job：幂等，不刷版本
    runProfileJob(fx.db, fx.partitionId, { personId: carol.id });
    runProfileJob(fx.db, fx.partitionId, { personId: carol.id });
    assert.equal(factRows(fx).length, 1);
    assert.equal(activeFacts(fx, carol.id)[0]?.id, facts[0]?.id);

    // 新 factKey 记忆：旧 fact 关闭，新版本生效
    addMemory(fx, {
      personId: carol.id,
      content: 'Carol 的职业是产品总监',
      factKey: 'identity.job',
      confidence: 0.88,
    });
    runProfileJob(fx.db, fx.partitionId, { personId: carol.id });
    facts = activeFacts(fx, carol.id);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.value, 'Carol 的职业是产品总监');
    assert.equal(facts[0]?.confidence, 0.88);
    assert.equal(factRows(fx).length, 2);
    const closed = factRows(fx).filter((row) => row.valid_to !== null);
    assert.equal(closed.length, 1);

    // 删除 fact 后，旧记忆不会在下次 profile 读取时复活
    fx.svc.removePersonFact(fx.partitionId, carol.id, facts[0]?.id ?? '', fx.actor);
    fx.svc.personProfile(fx.partitionId, carol.id);
    assert.equal(activeFacts(fx, carol.id).length, 0);
  } finally {
    fx.db.close();
  }
});

test('profile：确定性摘要 ≤800 字（超长 facts / 记忆裁剪）', () => {
  const fx = setup();
  try {
    const dave = createPerson(fx, 'dave');
    for (let index = 0; index < 20; index += 1) {
      fx.svc.upsertPersonFact(
        fx.partitionId,
        dave.id,
        { key: `fact.${index}`, value: '很长的值'.repeat(200) },
        fx.actor,
      );
    }
    for (let index = 0; index < 5; index += 1) {
      addMemory(fx, { personId: dave.id, content: `记忆内容 ${index} ${'细节'.repeat(200)}` });
    }
    const profile = fx.svc.personProfile(fx.partitionId, dave.id);
    assert.ok(profile.summary.length > 0);
    assert.ok(profile.summary.length <= 800, `summary 长度 ${profile.summary.length} 应 ≤800`);
  } finally {
    fx.db.close();
  }
});

test('profile：as_of 返回历史事实（默认只返回当前有效）', () => {
  const fx = setup();
  try {
    const erin = createPerson(fx, 'erin');
    addMemory(fx, {
      personId: erin.id,
      content: 'Erin 目前住在上海',
      factKey: 'location.city',
      validFrom: '2025-01-01T00:00:00.000Z',
    });
    addMemory(fx, {
      personId: erin.id,
      content: 'Erin 目前住在北京',
      factKey: 'location.city',
      validFrom: '2025-12-01T00:00:00.000Z',
    });

    const current = fx.svc.searchMemories({ partitionId: fx.partitionId, query: '住在', topK: 5 });
    assert.equal(current.hits.filter((hit) => hit.content.includes('上海')).length, 0);
    assert.ok(current.hits.some((hit) => hit.content.includes('北京')));

    const historical = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '住在',
      asOf: '2025-06-01T00:00:00.000Z',
      topK: 5,
    });
    assert.ok(historical.hits.some((hit) => hit.content.includes('上海')), 'as_of 应回看已失效事实');
    assert.ok(!historical.hits.some((hit) => hit.content.includes('北京')));

    const superseded = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '上海',
      includeSuperseded: true,
      topK: 5,
    });
    assert.ok(superseded.hits.some((hit) => hit.content.includes('上海')));
  } finally {
    fx.db.close();
  }
});


test('profile：配置 LLM 时优先 LLM 摘要，缓存命中不重复调用，失败回退确定性摘要', async () => {
  const fx = setup();
  let calls = 0;
  const server = createServer((_req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'LLM 画像：Alice 偏好简洁直接的沟通。' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const llm: LlmConfig = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'test-key',
    model: 'test-model',
    embeddingModel: 'test-embedding',
  };
  try {
    createPerson(fx, 'llm-alice');
    fx.svc.upsertPersonFact(
      fx.partitionId,
      'llm-alice',
      { key: 'identity.role', value: 'engineer', confidence: 0.9 },
      fx.actor,
    );

    const first = await refreshPersonProfile(fx.db, llm, fx.partitionId, 'llm-alice');
    assert.equal(first.summary, 'LLM 画像：Alice 偏好简洁直接的沟通。');
    assert.equal(first.cached, false);
    assert.equal(calls, 1);

    const cached = await refreshPersonProfile(fx.db, llm, fx.partitionId, 'llm-alice');
    assert.equal(cached.cached, true);
    assert.equal(cached.summary, first.summary);
    assert.equal(calls, 1, 'sourceHash 未变化时不应再次调用 LLM');

    const forced = await refreshPersonProfile(fx.db, llm, fx.partitionId, 'llm-alice', { force: true });
    assert.equal(forced.cached, false);
    assert.equal(calls, 2);

    // LLM 不可达：回退确定性摘要（含 facts 内容），不抛错。
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const fallback = await refreshPersonProfile(fx.db, llm, fx.partitionId, 'llm-alice', { force: true });
    assert.equal(fallback.cached, false);
    assert.match(fallback.summary, /engineer/);
    assert.match(fallback.summary, /identity\.role/);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    fx.db.close();
  }
});
