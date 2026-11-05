/**
 * 分词 / 嵌入 / 抽取单元测试，以及列表、反馈、过滤器等辅助能力测试。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isoDaysAgo } from '../lib/ids.ts';
import { DIM, blobToVector, cosine, embedText, vectorToBlob } from './embed.ts';
import { classify, extractEntities, extractFromMessages } from './extract.ts';
import { termFrequencies, tokenize } from './tokenize.ts';
import { ACTOR, addMemory, setup } from './test-helpers.ts';

/* ------------------------------------------------------------------ */
/* 分词 / 嵌入 / 抽取                                                  */
/* ------------------------------------------------------------------ */

test('tokenize：中英混合分词、大小写归一与词频', () => {
  const tokens = tokenize('我用 TypeScript 写记忆引擎，Memory-Engine 很重要。');
  assert.ok(tokens.includes('typescript'));
  assert.ok(tokens.includes('记忆'));
  assert.ok(tokens.includes('引擎'));
  assert.ok(tokens.includes('memory'));
  assert.ok(tokens.includes('engine'));
  // 去重
  assert.equal(new Set(tokens).size, tokens.length);
  // 停用词被过滤
  const stop = tokenize('的了是在和与');
  assert.equal(stop.length, 0);

  const freq = termFrequencies('记忆 记忆 引擎');
  assert.equal(freq.get('记忆'), 2);
  assert.equal(freq.get('引擎'), 1);
});

test('embed：确定性 384 维单位向量，BLOB 往返无损', () => {
  const a = embedText('用户喜欢用 TypeScript 写后端');
  const b = embedText('用户喜欢用 TypeScript 写后端');
  assert.equal(a.length, DIM);
  assert.deepEqual([...a], [...b]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  const c = embedText('用户在上海工作');
  assert.ok(cosine(a, c) < 0.9);
  const restored = blobToVector(vectorToBlob(a));
  assert.equal(restored.length, DIM);
  for (let i = 0; i < DIM; i++) assert.ok(Math.abs(a[i] - restored[i]) < 1e-9);
  // 零文本
  assert.equal(cosine(embedText(''), embedText('')), 0);
});

test('extract：分句、寒暄过滤、代词归一、分类与实体', () => {
  const facts = extractFromMessages([
    { role: 'user', content: '你好呀！' },
    { role: 'user', content: '我喜欢用 TypeScript 写后端，也常用 PostgreSQL。我在上海工作。' },
    { role: 'assistant', content: '你可以试试 Rust。' },
    { role: 'assistant', content: '当然可以，这是示例代码。' },
  ]);
  assert.ok(facts.length >= 3);
  assert.ok(!facts.some((fact) => fact.content.includes('你好')));

  const preference = facts.find((fact) => fact.content.includes('TypeScript'));
  assert.ok(preference);
  assert.equal(preference.category, 'preference');
  assert.equal(preference.content.startsWith('用户'), true);
  assert.ok(preference.entities.some((entity) => entity.type === 'technology' && entity.name === 'TypeScript'));
  assert.ok(preference.importance > 0.5 && preference.importance <= 1);
  assert.ok(preference.confidence > 0.5 && preference.confidence <= 1);

  const locationFact = facts.find((fact) => fact.content.includes('上海'));
  assert.ok(locationFact?.entities.some((entity) => entity.type === 'location' && entity.name === '上海'));

  // 助手消息：「你」→「用户」
  const assistantFact = facts.find((fact) => fact.content.includes('Rust'));
  assert.equal(assistantFact?.content, '用户可以试试 Rust');

  assert.equal(classify('不要使用 jQuery').category, 'constraint');
  assert.equal(classify('我叫林薇').category, 'identity');
  const entities = extractEntities('林薇在明远科技负责记忆平台，使用 TypeScript 与 PostgreSQL');
  const names = entities.map((entity) => entity.name);
  assert.ok(names.includes('林薇'));
  assert.ok(names.includes('明远科技'));
  assert.ok(names.includes('TypeScript'));
});

test('search：category / tags / minImportance / metadata 过滤', async () => {
  const fx = setup();
  await addMemory(fx, {
    text: '用户偏好深色主题',
    infer: false,
    userId: 'usr_1',
    tags: ['ui'],
    metadata: { category: 'preference', channel: 'web', importance: 0.9 },
  });
  await addMemory(fx, {
    text: '用户偏好浅色主题',
    infer: false,
    userId: 'usr_1',
    tags: ['ui', 'legacy'],
    metadata: { category: 'preference', channel: 'mobile', importance: 0.3 },
  });
  await addMemory(fx, { text: '用户的主题色是蓝色', infer: false, userId: 'usr_1', tags: ['design'] });

  const byTag = await fx.svc.search({ projectId: fx.projectId, query: '主题', filters: { tags: ['legacy'] } });
  assert.equal(byTag.total, 1);
  assert.ok(byTag.results[0].content.includes('浅色'));

  const byMetadata = await fx.svc.search({ projectId: fx.projectId, query: '主题', filters: { metadata: { channel: 'web' } } });
  assert.equal(byMetadata.total, 1);
  assert.ok(byMetadata.results[0].content.includes('深色'));

  const byCategory = await fx.svc.search({ projectId: fx.projectId, query: '主题', filters: { category: 'preference' } });
  assert.equal(byCategory.total, 2);

  const byImportance = await fx.svc.search({ projectId: fx.projectId, query: '主题', filters: { minImportance: 0.9 } });
  assert.equal(byImportance.total, 1);

  const byTime = await fx.svc.search({
    projectId: fx.projectId,
    query: '主题',
    filters: { createdAfter: isoDaysAgo(1) },
  });
  assert.equal(byTime.total, 3);
});

test('feedback：helpful 提升、not helpful 降低 importance 并写 feedback 历史', async () => {
  const fx = setup();
  const memory = (await addMemory(fx, { text: '用户偏好每季度对账', infer: false, userId: 'usr_1' })).results[0];
  assert.equal(memory.importance, 0.5);

  const helpful = await fx.svc.feedback(fx.projectId, memory.id, { helpful: true, query: '对账周期' }, ACTOR);
  assert.equal(helpful.importance, 0.58);

  const unhelpful = await fx.svc.feedback(fx.projectId, memory.id, { helpful: false }, ACTOR);
  assert.equal(unhelpful.importance, 0.46);

  const history = await fx.svc.history(fx.projectId, memory.id);
  assert.equal(history[0].reason, 'feedback');
  assert.equal(history[0].event, 'UPDATE');
});

test('list：分页、排序、搜索与状态过滤', async () => {
  const fx = setup();
  const low = (await addMemory(fx, { text: '用户偏好一', infer: false, metadata: { importance: 0.3 } })).results[0];
  const high = (await addMemory(fx, { text: '用户偏好二', infer: false, metadata: { importance: 0.9 } })).results[0];
  const mid = (await addMemory(fx, { text: '用户偏好三', infer: false, metadata: { importance: 0.6 } })).results[0];
  fx.db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(new Date().toISOString(), mid.id);

  const page1 = await fx.svc.list({ projectId: fx.projectId, page: 1, pageSize: 2 });
  assert.equal(page1.page, 1);
  assert.equal(page1.pageSize, 2);
  assert.equal(page1.total, 3);
  assert.equal(page1.totalPages, 2);
  assert.equal(page1.items.length, 2);

  const page2 = await fx.svc.list({ projectId: fx.projectId, page: 2, pageSize: 2 });
  assert.equal(page2.items.length, 1);

  const byImportance = await fx.svc.list({ projectId: fx.projectId, sort: 'importance' });
  assert.equal(byImportance.items[0].id, high.id);
  assert.equal(byImportance.items[2].id, low.id);

  const byAccessed = await fx.svc.list({ projectId: fx.projectId, sort: 'accessed' });
  assert.equal(byAccessed.items[0].id, mid.id);

  const searched = await fx.svc.list({ projectId: fx.projectId, q: '偏好二' });
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].id, high.id);

  const archived = await fx.svc.list({ projectId: fx.projectId, status: 'archived' });
  assert.equal(archived.total, 0);
});
