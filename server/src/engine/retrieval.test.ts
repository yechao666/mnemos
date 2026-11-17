import assert from 'node:assert/strict';
import test from 'node:test';
import { addMemory, createPerson, setup } from './test-helpers.ts';

/**
 * v6.1 P0 检索验收：
 *  - 12 组同义/改写查询：hybrid recall@5 ≥ 0.8 且严格高于 keyword-only；
 *  - signals / matchedOn / mode / strategy 可解释；
 *  - as_of 时间点回看、includeSuperseded、embedding 缺失退化、隐私隔离、topK 夹取。
 */

const CASES: { content: string; query: string }[] = [
  { content: 'Alice 喜欢美式咖啡', query: '偏好拿铁' },
  { content: 'Bob 打算周五上线检索模块', query: '计划发布搜索功能' },
  { content: 'Carol 住在上海', query: '居住城市是上海' },
  { content: 'Dave 的手机号是 13800138000', query: '联系方式号码' },
  { content: 'Eve 对花生过敏', query: '忌口花生' },
  { content: '团队例会改到周三', query: '开会时间调整' },
  { content: '预算控制在二十万', query: '成本开销上限' },
  { content: '项目截止日期是下月十号', query: '期限 deadline' },
  { content: 'Grace 的昵称是小G', query: '名字称呼' },
  { content: 'Henry 负责发布流程', query: '上线部署' },
  { content: 'Ivy 的公司是字节跳动', query: '企业在哪' },
  { content: 'Frank 的职业是后端工程师', query: '工作岗位' },
];

const DISTRACTORS = [
  '今天天气晴朗',
  '服务器磁盘使用率告警',
  '周报模板已经更新',
  '客户满意度调查结果',
  '接口平均耗时下降',
  '办公室绿植需要浇水',
  '季度目标已确认',
  '下载速度提升明显',
  '数据库备份完成',
  '前端页面改版评审',
  '年度团建地点投票',
  '打印机缺纸',
];

test('检索：同义/改写 recall@5 hybrid ≥ 0.8 且高于 keyword', () => {
  const fx = setup();
  const person = createPerson(fx, 'retrieval');
  for (const item of CASES) {
    addMemory(fx, { personId: person.id, content: item.content, scope: 'partition', category: 'fact' });
  }
  for (const content of DISTRACTORS) {
    addMemory(fx, { personId: person.id, content, scope: 'partition', category: 'context' });
  }

  let hybridHits = 0;
  let keywordHits = 0;
  for (const item of CASES) {
    const hybrid = fx.svc.searchMemories({ partitionId: fx.partitionId, query: item.query, topK: 5 });
    if (hybrid.hits.some((hit) => hit.content === item.content)) hybridHits += 1;
    const keyword = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: item.query,
      topK: 5,
      mode: 'keyword',
    });
    if (keyword.hits.some((hit) => hit.content === item.content)) keywordHits += 1;
  }

  const hybridRecall = hybridHits / CASES.length;
  assert.ok(hybridRecall >= 0.8, `hybrid recall@5=${hybridRecall.toFixed(2)} 低于 0.8`);
  assert.ok(hybridHits > keywordHits, `hybrid=${hybridHits} 应严格高于 keyword=${keywordHits}`);

  const sample = fx.svc.searchMemories({ partitionId: fx.partitionId, query: '偏好拿铁', topK: 5 });
  assert.equal(sample.mode, 'hybrid');
  assert.ok(sample.strategy.startsWith('hybrid'), sample.strategy);
  assert.ok(sample.tookMs >= 0);
  const hit = sample.hits[0];
  assert.ok(hit, '至少一条命中');
  assert.ok(hit.signals.vector >= 0 && hit.signals.vector <= 1);
  assert.ok(hit.signals.keyword >= 0 && hit.signals.keyword <= 1);
  assert.ok(hit.matchedOn.includes('vector') || hit.matchedOn.includes('keyword'));
  fx.db.close();
});

test('检索：keyword 只走 FTS/子串，vector 走余弦', () => {
  const fx = setup();
  const person = createPerson(fx, 'modes');
  addMemory(fx, { personId: person.id, content: 'Bob 负责检索模块', scope: 'partition' });
  addMemory(fx, { personId: person.id, content: '团队周一发布', scope: 'partition' });

  const keyword = fx.svc.searchMemories({ partitionId: fx.partitionId, query: '检索', mode: 'keyword', topK: 5 });
  assert.equal(keyword.mode, 'keyword');
  assert.ok(keyword.hits.some((hit) => hit.content.includes('检索模块')));
  assert.ok(keyword.strategy.startsWith('keyword'));

  const vector = fx.svc.searchMemories({ partitionId: fx.partitionId, query: '发布上线', mode: 'vector', topK: 5 });
  assert.equal(vector.mode, 'vector');
  assert.ok(vector.strategy.startsWith('vector'));
  assert.ok(vector.hits.length > 0);
  assert.ok(vector.hits.some((hit) => hit.content.includes('发布')));
  fx.db.close();
});

test('检索：as_of 回看历史事实 + 默认排除被取代 + includeSuperseded', () => {
  const fx = setup();
  const person = createPerson(fx, 'temporal');
  const old = fx.svc.addMemoryResult({
    partitionId: fx.partitionId,
    actor: fx.actor,
    personId: person.id,
    content: 'Alice 偏好中文回答',
    scope: 'partition',
    category: 'preference',
    factKey: 'preference.language',
    validFrom: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(old.event, 'ADD');
  const fresh = fx.svc.addMemoryResult({
    partitionId: fx.partitionId,
    actor: fx.actor,
    personId: person.id,
    content: 'Alice 偏好英文回答',
    scope: 'partition',
    category: 'preference',
    factKey: 'preference.language',
  });
  assert.equal(fresh.event, 'SUPERSEDE');
  assert.equal(fresh.supersededId, old.memory.id);

  const current = fx.svc.searchMemories({ partitionId: fx.partitionId, query: 'Alice 偏好', topK: 5 });
  assert.ok(current.hits.some((hit) => hit.id === fresh.memory.id));
  assert.ok(!current.hits.some((hit) => hit.id === old.memory.id), '默认不应返回被取代记忆');

  const historical = fx.svc.searchMemories({
    partitionId: fx.partitionId,
    query: 'Alice 偏好',
    topK: 5,
    asOf: '2021-01-01T00:00:00.000Z',
  });
  assert.ok(historical.hits.some((hit) => hit.id === old.memory.id), 'as_of 应返回当时有效的事实');
  assert.ok(!historical.hits.some((hit) => hit.id === fresh.memory.id));

  const all = fx.svc.searchMemories({
    partitionId: fx.partitionId,
    query: 'Alice 偏好',
    topK: 5,
    includeSuperseded: true,
  });
  assert.equal(all.hits.filter((hit) => hit.id === old.memory.id || hit.id === fresh.memory.id).length, 2);
  fx.db.close();
});

test('检索：embedding 缺失 hybrid 退化为 keyword', () => {
  const fx = setup();
  const person = createPerson(fx, 'noembed');
  const memory = addMemory(fx, { personId: person.id, content: '旧数据没有向量也能搜索', scope: 'partition' });
  fx.db.prepare('UPDATE memories SET embedding = NULL, embedding_model = NULL, dim = NULL WHERE id = ?').run(memory.id);

  const response = fx.svc.searchMemories({ partitionId: fx.partitionId, query: '旧数据 向量', topK: 5 });
  assert.ok(response.strategy.includes('keyword-fallback'), response.strategy);
  assert.ok(response.hits.some((hit) => hit.id === memory.id));
  assert.ok(response.hits.every((hit) => hit.signals.vector === 0));
  fx.db.close();
});

test('检索：人级隐私隔离与 topK 夹取', () => {
  const fx = setup();
  const alice = createPerson(fx, 'alice');
  const bob = createPerson(fx, 'bob');
  addMemory(fx, { personId: alice.id, content: 'Alice 的私人偏好是早起', scope: 'person' });
  addMemory(fx, { personId: bob.id, content: 'Bob 的私人偏好是熬夜', scope: 'person' });
  addMemory(fx, { personId: bob.id, content: '团队共享的私人偏好讨论约定', scope: 'partition' });

  const scoped = fx.svc.searchMemories({
    partitionId: fx.partitionId,
    query: '私人偏好',
    personId: alice.id,
    topK: 10,
  });
  assert.ok(scoped.hits.some((hit) => hit.content.includes('Alice')));
  assert.ok(!scoped.hits.some((hit) => hit.content.includes('Bob 的私人')));
  assert.ok(scoped.hits.some((hit) => hit.content.includes('团队共享')));

  const clamped = fx.svc.searchMemories({ partitionId: fx.partitionId, query: '私人偏好', topK: 0 });
  assert.equal(clamped.hits.length, 1);
  fx.db.close();
});
