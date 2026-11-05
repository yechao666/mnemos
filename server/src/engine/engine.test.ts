/**
 * 记忆引擎集成测试（node:test，内存 SQLite）。
 *
 * 覆盖：add（抽取 / 原文入库）、consolidate 去重、混合检索排序与信号分解、作用域隔离、
 * update/history、remove/bulk、graph、stats、中文检索命中，以及 600 条记忆的检索性能预算。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isoDaysAgo } from '../lib/ids.ts';
import { DIM, embedText, vectorToBlob } from './embed.ts';
import { termFrequencies } from './tokenize.ts';
import { ACTOR, addMemory, count, setCreatedAt, setup } from './test-helpers.ts';

/* ------------------------------------------------------------------ */
/* add                                                                 */
/* ------------------------------------------------------------------ */

test('add(infer=true)：抽取事实并写入记忆/向量/词项/实体/关系/历史', async () => {
  const fx = setup();
  const result = await addMemory(fx, {
    text: '我喜欢用 TypeScript 写后端，也常用 PostgreSQL。我在上海工作。',
    infer: true,
    userId: 'usr_1',
    tags: ['技术栈'],
  });

  assert.ok(result.results.length >= 2);
  assert.equal(result.extracted, result.results.length);
  assert.equal(result.merged, 0);
  assert.ok(result.tookMs >= 0);
  const preference = result.results.find((memory) => memory.content.includes('TypeScript'));
  assert.ok(preference);
  assert.equal(preference.category, 'preference');
  assert.deepEqual(preference.tags, ['技术栈']);
  assert.equal(preference.status, 'active');
  assert.equal(preference.userId, 'usr_1');

  const row = fx.db
    .prepare('SELECT embedding, dim, embedding_model FROM memories WHERE id = ?')
    .get(preference.id) as unknown as { embedding: Uint8Array; dim: number; embedding_model: string };
  assert.equal(row.dim, DIM);
  assert.equal(row.embedding.byteLength, DIM * 4);
  assert.equal(row.embedding_model, 'mnemos-hash-384');

  const terms = fx.db.prepare('SELECT term FROM memory_terms WHERE memory_id = ?').all(preference.id) as unknown as { term: string }[];
  assert.ok(terms.some((term) => term.term === 'typescript'));
  assert.ok(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entities WHERE memory_id = ?', preference.id) > 0);
  assert.ok(count(fx.db, "SELECT COUNT(*) AS c FROM memory_history WHERE memory_id = ? AND event = 'ADD'", preference.id) === 1);
  assert.ok(count(fx.db, 'SELECT COUNT(*) AS c FROM entities WHERE project_id = ?', fx.projectId) > 0);

  const history = await fx.svc.history(fx.projectId, preference.id);
  assert.equal(history[0].event, 'ADD');

  assert.equal(history[0].newContent, preference.content);
});

test('add(infer=false)：原文单条入库，metadata 覆盖分类/分数，索引仍完整', async () => {
  const fx = setup();
  const text = '张倩是 Aurora Cloud 企业版客户，公司为杭州星野零售，账号规模 240 个坐席。';
  const result = await addMemory(fx, {
    text,
    infer: false,
    userId: 'cust-1042',
    source: 'import',
    tags: ['企业版'],
    metadata: { category: 'identity', importance: 0.82, confidence: 0.86, channel: 'seed' },
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.extracted, 1);
  const memory = result.results[0];
  assert.equal(memory.content, text);
  assert.equal(memory.category, 'identity');
  assert.equal(memory.importance, 0.82);
  assert.equal(memory.confidence, 0.86);
  assert.equal(memory.source, 'import');
  assert.equal(memory.metadata.channel, 'seed');
  assert.deepEqual(memory.tags, ['企业版']);

  // 图谱与检索依赖的索引必须齐全
  assert.ok(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_terms WHERE memory_id = ?', memory.id) > 0);
  const entityRows = fx.db
    .prepare(
      `SELECT e.name, e.type FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE me.memory_id = ?`,
    )
    .all(memory.id) as unknown as { name: string; type: string }[];
  assert.ok(entityRows.some((entity) => entity.type === 'organization' && entity.name.includes('杭州星野零售')));
  assert.ok(count(fx.db, 'SELECT COUNT(*) AS c FROM relations WHERE project_id = ?', fx.projectId) > 0);

  const restored = fx.db.prepare('SELECT embedding, dim FROM memories WHERE id = ?').get(memory.id) as unknown as {
    embedding: Uint8Array;
    dim: number;
  };
  assert.equal(restored.dim, DIM);
  assert.equal(restored.embedding.byteLength, DIM * 4);
});

test('add(consolidate)：完全重复 MERGE、高相似 NOOP、低相似新建', async () => {
  const fx = setup({ settings: { extractionMode: 'consolidate', dedupeThreshold: 0.9 } });
  const first = await addMemory(fx, { text: '用户喜欢用 TypeScript 写后端', infer: false, userId: 'usr_1' });
  assert.equal(first.results.length, 1);

  const duplicate = await addMemory(fx, { text: '用户喜欢用 TypeScript 写后端', infer: false, userId: 'usr_1' });
  assert.equal(duplicate.results.length, 0);
  assert.equal(duplicate.merged, 1);
  assert.equal(duplicate.events[0].type, 'MERGE');
  assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memories WHERE project_id = ?', fx.projectId), 1);

  const nearDuplicate = await addMemory(fx, { text: '用户喜欢用 TypeScript 写后端服务', infer: false, userId: 'usr_1' });
  assert.equal(nearDuplicate.results.length, 0);
  assert.equal(nearDuplicate.merged, 1);
  assert.equal(nearDuplicate.events[0].type, 'NOOP');

  const row = fx.db
    .prepare('SELECT importance FROM memories WHERE project_id = ?')
    .get(fx.projectId) as unknown as { importance: number };
  assert.equal(row.importance, 0.54); // 0.5 + 0.02 + 0.02

  const events = fx.db
    .prepare('SELECT event FROM memory_history WHERE project_id = ? ORDER BY rowid ASC')
    .all(fx.projectId) as unknown as { event: string }[];
  assert.deepEqual(
    events.map((item) => item.event),
    ['ADD', 'MERGE', 'NOOP'],
  );

  const distinct = await addMemory(fx, { text: '用户喜欢喝手冲咖啡', infer: false, userId: 'usr_1' });
  assert.equal(distinct.results.length, 1);
  assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memories WHERE project_id = ?', fx.projectId), 2);

  // 其他作用域不会被误合并
  const otherScope = await addMemory(fx, { text: '用户喜欢用 TypeScript 写后端', infer: false, userId: 'usr_2' });
  assert.equal(otherScope.results.length, 1);
});

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

test('search：多信号打分、排序、阈值与访问计数', async () => {
  const fx = setup();
  const backend = await addMemory(fx, { text: '用户喜欢用 TypeScript 写后端服务', infer: false, userId: 'usr_1' });
  const coffee = await addMemory(fx, { text: '用户喜欢喝手冲咖啡', infer: false, userId: 'usr_1' });
  const company = await addMemory(fx, { text: '用户在杭州的团队有二十人', infer: false, userId: 'usr_1' });
  setCreatedAt(fx.db, coffee.results[0].id, isoDaysAgo(40));
  setCreatedAt(fx.db, company.results[0].id, isoDaysAgo(60));

  const response = await fx.svc.search({ projectId: fx.projectId, query: 'TypeScript 后端开发', userId: 'usr_1', topK: 5 });
  assert.ok(response.results.length >= 1);
  assert.equal(response.results[0].id, backend.results[0].id);
  assert.ok(response.queryTerms.includes('typescript'));
  assert.ok(response.strategy.startsWith('hybrid'));
  assert.ok(response.tookMs >= 0);

  const weightSum =
    response.weights.semantic + response.weights.keyword + response.weights.entity + response.weights.recency;
  assert.ok(Math.abs(weightSum - 1) < 1e-3);

  const hit = response.results[0];
  for (const key of ['semantic', 'keyword', 'entity', 'recency', 'importance'] as const) {
    assert.ok(hit.signals[key] >= 0 && hit.signals[key] <= 1, `${key} 超出 0..1：${hit.signals[key]}`);
  }
  assert.ok(hit.score > 0 && hit.score <= 1);
  assert.ok(hit.matchedOn.includes('keyword'));
  // recency：最新记忆更接近 1
  assert.ok(hit.signals.recency > 0.5);

  // all results above threshold；阈值收紧后无结果
  assert.ok(response.results.every((item) => item.score >= 0.12));
  const strict = await fx.svc.search({ projectId: fx.projectId, query: 'TypeScript 后端开发', userId: 'usr_1', threshold: 0.99 });
  assert.equal(strict.results.length, 0);
  assert.equal(strict.total, 0);

  const topOne = await fx.svc.search({ projectId: fx.projectId, query: '用户 喜欢', userId: 'usr_1', topK: 1 });
  assert.ok(topOne.results.length <= 1);

  // 命中后累加访问计数
  const accessed = fx.db
    .prepare('SELECT access_count, last_accessed_at FROM memories WHERE id = ?')
    .get(backend.results[0].id) as unknown as { access_count: number; last_accessed_at: string | null };
  assert.ok(accessed.access_count >= 1);
  assert.ok(accessed.last_accessed_at);
});

test('search：中文检索命中与实体信号', async () => {
  const fx = setup();
  await addMemory(fx, { text: '用户的编程偏好是用 TypeScript 写后端', infer: false, userId: 'usr_1' });
  await addMemory(fx, { text: '用户喜欢在周末徒步爬山', infer: false, userId: 'usr_1' });
  await addMemory(fx, { text: '林薇负责记忆平台项目', infer: true, userId: 'usr_1' });

  const byKeyword = await fx.svc.search({ projectId: fx.projectId, query: '编程偏好', userId: 'usr_1' });
  assert.ok(byKeyword.results.length >= 1);
  assert.ok(byKeyword.results[0].content.includes('TypeScript'));
  assert.ok(byKeyword.queryTerms.includes('编程'));

  const byEntity = await fx.svc.search({ projectId: fx.projectId, query: '林薇负责什么', userId: 'usr_1' });
  assert.ok(byEntity.results.length >= 1);
  const entityHit = byEntity.results.find((item) => item.content.includes('林薇'));
  assert.ok(entityHit);
  assert.ok(entityHit.signals.entity > 0);
  assert.ok(entityHit.matchedOn.includes('entity'));
  assert.ok(entityHit.entities.includes('林薇'));
  assert.ok(byEntity.strategy.includes('entity'));
});

test('search：作用域隔离（user / agent）', async () => {
  const fx = setup();
  await addMemory(fx, { text: '用户 A 的项目代号是 Aurora', infer: false, userId: 'usr_a' });
  await addMemory(fx, { text: '用户 B 的项目代号是 Borealis', infer: false, userId: 'usr_b' });
  await addMemory(fx, { text: '一线助手记住工单处理规则', infer: false, agentId: 'agent_x' });

  const resultA = await fx.svc.search({ projectId: fx.projectId, query: '项目代号', userId: 'usr_a' });
  assert.ok(resultA.results.length >= 1);
  assert.ok(resultA.results.every((item) => item.userId === 'usr_a'));
  assert.ok(resultA.results.some((item) => item.content.includes('Aurora')));

  const resultB = await fx.svc.search({ projectId: fx.projectId, query: '项目代号', userId: 'usr_b' });
  assert.ok(resultB.results.every((item) => item.userId === 'usr_b'));
  assert.ok(!resultB.results.some((item) => item.content.includes('Aurora')));

  const all = await fx.svc.search({ projectId: fx.projectId, query: '项目代号' });
  assert.ok(all.total >= 2);

  // agentId 是调用方身份，不是归属过滤：项目共享记忆对所有 Agent 可见
  await addMemory(fx, {
    text: '一线助手的私有笔记：值班口令是 42',
    infer: false,
    agentId: 'agent_x',
    visibility: 'agent',
  });

  const agentHit = await fx.svc.search({ projectId: fx.projectId, query: '工单处理规则', agentId: 'agent_x' });
  assert.ok(agentHit.results.length >= 1);
  assert.ok(agentHit.results.some((item) => item.content.includes('工单处理规则')));

  // 其他 Agent 能看到项目共享的规则，但看不到 agent_x 的私有笔记
  const otherAgent = await fx.svc.search({ projectId: fx.projectId, query: '工单处理规则', agentId: 'agent_y' });
  assert.ok(otherAgent.results.some((item) => item.content.includes('工单处理规则')));

  const privateAsOther = await fx.svc.search({ projectId: fx.projectId, query: '值班口令', agentId: 'agent_y' });
  assert.ok(privateAsOther.results.every((item) => !item.content.includes('值班口令')));

  const privateAsOwner = await fx.svc.search({ projectId: fx.projectId, query: '值班口令', agentId: 'agent_x' });
  assert.ok(privateAsOwner.results.some((item) => item.content.includes('值班口令')));

  // 控制台观测视角可以看到私有记忆
  const consoleView = await fx.svc.search({
    projectId: fx.projectId,
    query: '值班口令',
    includePrivate: true,
  });
  assert.ok(consoleView.results.some((item) => item.content.includes('值班口令')));

  // 归属过滤：只看某个 Agent 写入的记忆
  const writtenByX = await fx.svc.search({
    projectId: fx.projectId,
    query: '工单处理规则',
    writtenByAgentId: 'agent_x',
  });
  assert.ok(writtenByX.results.length >= 1);
  assert.ok(writtenByX.results.every((item) => item.agentId === 'agent_x'));
});

/* ------------------------------------------------------------------ */
/* update / remove / bulk / feedback                                   */
/* ------------------------------------------------------------------ */

test('update：内容变更重建词项与实体，并写入 UPDATE 历史', async () => {
  const fx = setup();
  const created = await addMemory(fx, { text: '用户喜欢用 TypeScript 写脚本', infer: false, userId: 'usr_1' });
  const memory = created.results[0];
  const before = fx.db.prepare('SELECT embedding FROM memories WHERE id = ?').get(memory.id) as unknown as {
    embedding: Uint8Array;
  };

  const updated = await fx.svc.update(
    fx.projectId,
    memory.id,
    { content: '用户喜欢用 Rust 写系统工具', tags: ['lang'], importance: 0.8 },
    ACTOR,
  );
  assert.equal(updated.content, '用户喜欢用 Rust 写系统工具');
  assert.equal(updated.importance, 0.8);
  assert.deepEqual(updated.tags, ['lang']);

  const history = await fx.svc.history(fx.projectId, memory.id);
  assert.equal(history[0].event, 'UPDATE');
  assert.equal(history[0].oldContent, '用户喜欢用 TypeScript 写脚本');
  assert.equal(history[0].newContent, '用户喜欢用 Rust 写系统工具');

  const terms = (fx.db.prepare('SELECT term FROM memory_terms WHERE memory_id = ?').all(memory.id) as unknown as {
    term: string;
  }[]).map((row) => row.term);
  assert.ok(terms.includes('rust'));
  assert.ok(!terms.includes('typescript'));

  const entityNames = (
    fx.db
      .prepare('SELECT e.name FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE me.memory_id = ?')
      .all(memory.id) as unknown as { name: string }[]
  ).map((row) => row.name);
  assert.ok(entityNames.includes('Rust'));
  assert.ok(!entityNames.includes('TypeScript'));

  const after = fx.db.prepare('SELECT embedding FROM memories WHERE id = ?').get(memory.id) as unknown as {
    embedding: Uint8Array;
  };
  assert.notEqual(Buffer.from(before.embedding).toString('base64'), Buffer.from(after.embedding).toString('base64'));

  const archived = await fx.svc.update(fx.projectId, memory.id, { category: 'skill', status: 'archived' }, ACTOR);
  assert.equal(archived.category, 'skill');
  assert.equal(archived.status, 'archived');

  await assert.rejects(() => fx.svc.update(fx.projectId, 'mem_missing', { importance: 0.5 }, ACTOR));
});

test('remove / bulk：软删除、归档、恢复与历史事件', async () => {
  const fx = setup();
  const first = (await addMemory(fx, { text: '用户偏好邮件通知', infer: false, userId: 'usr_1' })).results[0];
  const second = (await addMemory(fx, { text: '用户偏好短信通知', infer: false, userId: 'usr_1' })).results[0];

  await fx.svc.remove(fx.projectId, first.id, ACTOR);
  const detail = await fx.svc.get(fx.projectId, first.id);
  assert.equal(detail?.memory.status, 'deleted');
  const removedHistory = await fx.svc.history(fx.projectId, first.id);
  assert.equal(removedHistory[0].event, 'DELETE');

  const searchAfterRemove = await fx.svc.search({ projectId: fx.projectId, query: '通知', userId: 'usr_1' });
  assert.ok(!searchAfterRemove.results.some((item) => item.id === first.id));

  const archived = await fx.svc.bulk(fx.projectId, { action: 'archive', ids: [second.id] }, ACTOR);
  assert.equal(archived.affected, 1);
  assert.equal((await fx.svc.get(fx.projectId, second.id))?.memory.status, 'archived');
  const archivedList = await fx.svc.list({ projectId: fx.projectId, status: 'archived' });
  assert.equal(archivedList.total, 1);

  const restored = await fx.svc.bulk(fx.projectId, { action: 'restore', ids: [second.id] }, ACTOR);
  assert.equal(restored.affected, 1);
  assert.equal((await fx.svc.get(fx.projectId, second.id))?.memory.status, 'active');

  const deleted = await fx.svc.bulk(fx.projectId, { action: 'delete', ids: [second.id, 'mem_missing'] }, ACTOR);
  assert.equal(deleted.affected, 1);

  const bulkHistory = await fx.svc.history(fx.projectId, second.id);
  assert.ok(bulkHistory.some((entry) => entry.event === 'DELETE' || entry.meta.action === 'archive'));
});

/* ------------------------------------------------------------------ */
/* graph / stats / list                                                */
/* ------------------------------------------------------------------ */

test('graph：实体节点、关系边与统计', async () => {
  const fx = setup();
  await addMemory(fx, { text: '林薇在明远科技负责记忆平台，使用 TypeScript', infer: true, userId: 'usr_1' });
  await addMemory(fx, { text: '林薇喜欢 TypeScript', infer: true, userId: 'usr_1' });

  const graph = await fx.svc.graph(fx.projectId, 20);
  assert.ok(graph.nodes.length >= 3);
  const lin = graph.nodes.find((node) => node.label === '林薇');
  assert.ok(lin);
  assert.equal(lin?.memories, 2);
  assert.equal(lin?.weight, 1);
  assert.equal(lin?.type, 'person');
  assert.ok(graph.edges.length >= 1);
  assert.ok(graph.edges.every((edge) => edge.weight >= 0 && edge.weight <= 1));
  assert.equal(graph.stats.nodes, graph.nodes.length);
  assert.equal(graph.stats.edges, graph.edges.length);
  assert.ok(graph.stats.entities >= graph.nodes.length);
  assert.ok(graph.stats.density >= 0 && graph.stats.density <= 1);
  assert.ok(graph.stats.topTypes.some((entry) => entry.type === 'person'));

  const limited = await fx.svc.graph(fx.projectId, 1);
  assert.equal(limited.nodes.length, 1);
});

test('stats：ProjectStats 全字段与 usage_events 聚合', async () => {
  const fx = setup({ settings: { monthlyQuota: 10000 } });
  await addMemory(fx, { text: '用户的编程偏好是 TypeScript', infer: false, userId: 'usr_1' });
  await addMemory(fx, { text: '林薇负责记忆平台', infer: true, userId: 'usr_1' });
  await addMemory(fx, { text: '用户在杭州工作', infer: false, userId: 'usr_1' });

  const insertUsage = fx.db.prepare(
    `INSERT INTO usage_events
       (id, org_id, project_id, api_key_id, channel, operation, method, path, status, latency_ms, result_count, memory_tokens, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const at = new Date().toISOString();
  const usage = [
    ['use_1', 'search', 20, 2, 0, isoDaysAgo(1)],
    ['use_2', 'search', 40, 0, 0, isoDaysAgo(2)],
    ['use_3', 'search', 60, 3, 0, isoDaysAgo(3)],
    ['use_4', 'search', 80, 1, 0, isoDaysAgo(4)],
    ['use_5', 'search', 100, 5, 0, isoDaysAgo(5)],
    ['use_6', 'add', 15, 1, 100, at],
    ['use_7', 'add', 18, 1, 150, isoDaysAgo(1)],
    ['use_8', 'add', 12, 1, 0, isoDaysAgo(10)],
  ] as const;
  for (const [id, operation, latency, results, tokens, createdAt] of usage) {
    insertUsage.run(id, null, fx.projectId, null, 'api', operation, 'POST', '/v1/memories', 200, latency, results, tokens, 'test', createdAt);
  }

  const stats = await fx.svc.stats(fx.projectId);
  assert.equal(stats.memories, 3);
  assert.equal(stats.users, 1);
  assert.equal(stats.agents, 0);
  assert.ok(stats.entities > 0);
  assert.ok(stats.relations >= 0);
  assert.equal(stats.searches7d, 5);
  assert.equal(stats.adds7d, 2);
  assert.equal(stats.hitRate, 0.8); // 4/5 次搜索有结果
  assert.equal(stats.recallP50Ms, 60);
  assert.equal(stats.recallP95Ms, 100);
  assert.equal(stats.growthPct, 100);
  assert.ok(stats.storageBytes > 0);
  assert.ok(stats.lastActivityAt);

  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const expectedTokens = count(
    fx.db,
    'SELECT COALESCE(SUM(memory_tokens), 0) AS c FROM usage_events WHERE project_id = ? AND created_at >= ?',
    fx.projectId,
    monthStart,
  );
  assert.equal(stats.tokensSaved, expectedTokens);
  assert.equal(stats.quotaUsedPct, Math.round((expectedTokens / 10000) * 1000) / 10);
});

/* ------------------------------------------------------------------ */
/* 性能                                                                */
/* ------------------------------------------------------------------ */

test('性能：600 条记忆 / 2000+ 词项下 search < 150ms', async () => {
  const fx = setup();
  const at = new Date().toISOString();
  const topics = Array.from({ length: 200 }, (_, index) => `topic${index}`);
  const insertMemoryStmt = fx.db.prepare(
    `INSERT INTO memories
       (id, project_id, user_id, agent_id, run_id, app_id, content, normalized_hash, category, importance,
        confidence, source, status, tags, metadata, created_at, updated_at, last_accessed_at, access_count,
        expires_at, embedding, embedding_model, dim)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTermStmt = fx.db.prepare('INSERT OR REPLACE INTO memory_terms (memory_id, project_id, term, tf) VALUES (?, ?, ?, ?)');
  let termRows = 0;
  for (let i = 0; i < 600; i++) {
    const content = `用户 ${i} 关注 ${topics[i % topics.length]} 的检索质量与 ${topics[(i * 7 + 3) % topics.length]} 的稳定性`;
    const id = `mem_perf_${i}`;
    insertMemoryStmt.run(
      id,
      fx.projectId,
      'usr_1',
      null,
      null,
      null,
      content,
      `hash_${i}`,
      'fact',
      0.4 + (i % 50) / 100,
      0.8,
      'api',
      'active',
      '[]',
      '{}',
      at,
      at,
      null,
      0,
      null,
      vectorToBlob(embedText(content)),
      'mnemos-hash-384',
      DIM,
    );
    for (const [term, tf] of termFrequencies(content)) {
      insertTermStmt.run(id, fx.projectId, term, tf);
      termRows++;
    }
  }
  fx.db.prepare(
    `INSERT INTO entities (id, project_id, name, type, normalized, mention_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ent_perf', fx.projectId, 'TypeScript', 'technology', 'typescript', 600, at);

  assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memories WHERE project_id = ?', fx.projectId), 600);
  assert.ok(termRows >= 2000, `词项行数 ${termRows}`);

  const started = performance.now();
  const response = await fx.svc.search({ projectId: fx.projectId, query: 'topic17 检索质量', userId: 'usr_1', topK: 8 });
  const elapsed = performance.now() - started;
  assert.ok(response.results.length >= 1);
  assert.ok(response.results[0].content.includes('topic17'));
  assert.ok(elapsed < 150, `search 耗时 ${elapsed.toFixed(1)}ms，超过 150ms 预算`);
});
