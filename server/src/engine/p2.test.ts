import assert from 'node:assert/strict';
import test from 'node:test';
import type { MemorySearchHit } from '../../../shared/src/types.ts';
import { count, createPerson, addMemory, setup } from './test-helpers.ts';
import { extractEntities } from './index.ts';

/** v6.1 P2 引擎验收：关系图 / 附件 / PII / consent / 字段加密。 */

const KEY_ENV = 'MNEMOS_ENCRYPTION_KEY';

function auditCount(fx: ReturnType<typeof setup>, action: string): number {
  return count(fx.db, 'SELECT COUNT(*) AS c FROM audit_logs WHERE partition_id = ? AND action = ?', fx.partitionId, action);
}

test('P2 relations：同一记忆内实体两两 co_occurs，重复抽取幂等，删除记忆按 memory_id 清理', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  const memory = addMemory(fx, {
    personId: person.id,
    content: 'Alice 和 Bob 在 ProjectX 项目上合作',
    scope: 'partition',
  });
  extractEntities(fx.db, fx.partitionId, memory.id);
  assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entities WHERE memory_id = ?', memory.id), 3);
  assert.equal(
    count(fx.db, "SELECT COUNT(*) AS c FROM relations WHERE partition_id = ? AND relation = 'co_occurs'", fx.partitionId),
    3,
  );
  // 每条关系 weight=1、memory_id 指向来源记忆
  const rows = fx.db
    .prepare('SELECT source_entity_id, target_entity_id, relation, weight, memory_id FROM relations WHERE partition_id = ?')
    .all(fx.partitionId) as unknown as Array<Record<string, unknown>>;
  for (const row of rows) {
    assert.equal(row.relation, 'co_occurs');
    assert.equal(row.weight, 1);
    assert.equal(row.memory_id, memory.id);
    assert.notEqual(row.source_entity_id, row.target_entity_id);
  }
  // 幂等：重复抽取不新增 relations / memory_entities，mention_count 不翻倍
  extractEntities(fx.db, fx.partitionId, memory.id);
  assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM relations WHERE partition_id = ?', fx.partitionId), 3);
  assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entities WHERE memory_id = ?', memory.id), 3);
  const mentions = fx.db
    .prepare('SELECT mention_count FROM entities WHERE partition_id = ?')
    .all(fx.partitionId) as unknown as { mention_count: number }[];
  assert.deepEqual(mentions.map((row) => row.mention_count), [1, 1, 1]);

  // 删除记忆：relations / memory_entities 一并清理
  fx.svc.removeMemory(fx.partitionId, memory.id, fx.actor);
  assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM relations WHERE partition_id = ?', fx.partitionId), 0);
  assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entities WHERE memory_id = ?', memory.id), 0);
  fx.db.close();
});

test('P2 graph/entities：分区图与人的子图（引擎层）', () => {
  const fx = setup();
  const alice = createPerson(fx, 'alice');
  const bob = createPerson(fx, 'bob');
  const first = addMemory(fx, {
    personId: alice.id,
    content: 'Alice 和 Carol 一起评审 ProjectX 方案',
    scope: 'partition',
  });
  const second = addMemory(fx, {
    personId: bob.id,
    content: 'Bob 和 Carol 讨论 ProjectY 排期',
    scope: 'partition',
  });
  extractEntities(fx.db, fx.partitionId, first.id);
  extractEntities(fx.db, fx.partitionId, second.id);

  const graph = fx.svc.entityGraph({ partitionId: fx.partitionId });
  assert.equal(graph.nodes.length, 5); // Alice / Carol / ProjectX / Bob / ProjectY
  assert.equal(graph.edges.length, 6); // 每个记忆 3 条共现边
  assert.equal(graph.stats.nodes, 5);
  assert.equal(graph.stats.edges, 6);
  assert.deepEqual(graph.stats.topTypes, [{ type: 'concept', count: 5 }]);
  const aliceNode = graph.nodes.find((node) => node.label.toLowerCase() === 'alice');
  assert.ok(aliceNode);
  assert.equal(aliceNode?.memories, 1);
  assert.ok((aliceNode?.weight ?? 0) >= 1);

  const personGraph = fx.svc.entityGraph({ partitionId: fx.partitionId, personId: alice.id });
  assert.equal(personGraph.nodes.length, 3); // Alice / Carol / ProjectX
  assert.equal(personGraph.edges.length, 3);
  assert.ok(!personGraph.nodes.some((node) => node.label.toLowerCase() === 'bob'));

  const byExternal = fx.svc.entityGraph({ partitionId: fx.partitionId, personId: 'alice' });
  assert.equal(byExternal.nodes.length, 3);

  const filtered = fx.svc.listEntities({ partitionId: fx.partitionId, q: 'Carol' });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0]?.name.toLowerCase(), 'carol');
  assert.equal(filtered.items[0]?.memories, 2);
  assert.equal(filtered.items[0]?.mentionCount, 2);
  assert.equal(filtered.nextCursor, null);

  const bobEntities = fx.svc.listEntities({ partitionId: fx.partitionId, personId: bob.id });
  const bobNames = bobEntities.items.map((item) => item.name.toLowerCase()).sort();
  assert.deepEqual(bobNames, ['bob', 'carol', 'projecty']);

  assert.throws(
    () => fx.svc.entityGraph({ partitionId: fx.partitionId, personId: 'nobody' }),
    /人不存在/,
  );
  fx.db.close();
});

test('P2 attachments：写入 / 详情读取 / 列表只带 count / 上限与校验', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  const memory = addMemory(fx, {
    personId: person.id,
    content: 'Alice 上传了登录页设计稿',
    scope: 'partition',
    attachments: [
      { kind: 'image', url: 'https://cdn.example.com/design/login.png', mime: 'image/png', size: 2048, caption: '登录页设计稿' },
      { kind: 'file', url: 'https://cdn.example.com/design/spec.pdf', caption: '交互说明' },
    ],
  });
  assert.equal(memory.attachmentCount, 2);

  const detail = fx.svc.getMemory(fx.partitionId, memory.id);
  assert.ok(detail);
  assert.equal(detail?.memory.attachments?.length, 2);
  assert.equal(detail?.memory.attachmentCount, 2);
  const [image, file] = detail?.memory.attachments ?? [];
  assert.equal(image?.kind, 'image');
  assert.equal(image?.url, 'https://cdn.example.com/design/login.png');
  assert.equal(image?.mime, 'image/png');
  assert.equal(image?.size, 2048);
  assert.equal(image?.caption, '登录页设计稿');
  assert.equal(file?.kind, 'file');
  assert.equal(file?.caption, '交互说明');

  // 批量列表只带 count，不带附件明细（控体积）
  const page = fx.svc.listMemories({ partitionId: fx.partitionId });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.attachmentCount, 2);
  assert.equal(page.items[0]?.attachments, undefined);

  // 重复内容（NOOP）仍可补充附件：附件是独立资源
  const replayed = fx.svc.addMemoryResult({
    partitionId: fx.partitionId,
    actor: fx.actor,
    personId: person.id,
    content: 'Alice 上传了登录页设计稿',
    scope: 'partition',
    attachments: [{ kind: 'audio', url: 'https://cdn.example.com/voice.m4a', caption: '语音备注' }],
  });
  assert.equal(replayed.event, 'NOOP');
  assert.equal(replayed.memory.attachmentCount, 3);
  assert.equal(fx.svc.getMemory(fx.partitionId, memory.id)?.memory.attachments?.length, 3);

  // 上限 ≤10、url ≤2000、kind 枚举
  const many = Array.from({ length: 11 }, (_, index) => ({
    kind: 'image' as const,
    url: `https://cdn.example.com/${index}.png`,
  }));
  assert.throws(
    () => addMemory(fx, { personId: person.id, content: '附件超限', attachments: many }),
    /最多 10 个/,
  );
  assert.throws(
    () =>
      addMemory(fx, {
        personId: person.id,
        content: 'URL 超长',
        attachments: [{ kind: 'image', url: `https://cdn.example.com/${'x'.repeat(2000)}.png` }],
      }),
    /最长 2000/,
  );
  assert.throws(
    () =>
      addMemory(fx, {
        personId: person.id,
        content: 'kind 非法',
        attachments: [{ kind: 'document' as never, url: 'https://cdn.example.com/a.bin' }],
      }),
    /kind 不合法/,
  );
  fx.db.close();
});

test('P2 检索：附件 caption 并入候选，命中时 matchedOn 含 attachment', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  addMemory(fx, {
    personId: person.id,
    content: 'Alice 上传了季度物料',
    scope: 'person',
    attachments: [{ kind: 'image', url: 'https://cdn.example.com/poster.png', caption: '秋季新品发布会主视觉海报' }],
  });
  addMemory(fx, { personId: person.id, content: 'Alice 偏好简洁周报', scope: 'person' });

  const response = fx.svc.searchMemories({
    partitionId: fx.partitionId,
    query: '秋季新品',
    personId: person.id,
    topK: 5,
    mode: 'hybrid',
  });
  assert.equal(response.hits.length, 1);
  const hit = response.hits[0] as MemorySearchHit;
  assert.ok(hit.content.includes('季度物料'));
  assert.ok(hit.matchedOn.includes('attachment'), `matchedOn=${JSON.stringify(hit.matchedOn)}`);
  assert.ok(hit.signals.keyword > 0);
  assert.equal(hit.attachmentCount, 1);

  // keyword 模式同样能命中 caption
  const keyword = fx.svc.searchMemories({
    partitionId: fx.partitionId,
    query: '发布会主视觉',
    personId: person.id,
    topK: 5,
    mode: 'keyword',
  });
  assert.equal(keyword.hits.length, 1);
  assert.ok(keyword.hits[0]?.matchedOn.includes('attachment'));
  fx.db.close();
});

test('P2 检索 entity 信号：query 命中实体时 signals.entity>0 并计入融合权重', () => {
  const fx = setup({
    settings: { retrievalWeights: { vector: 0, keyword: 1, recency: 0, importance: 0, entity: 1 } },
  });
  const person = createPerson(fx, 'alice');
  const memory = addMemory(fx, {
    personId: person.id,
    content: 'Alice 负责 ProjectX 检索模块',
    scope: 'person',
  });
  extractEntities(fx.db, fx.partitionId, memory.id);
  const response = fx.svc.searchMemories({
    partitionId: fx.partitionId,
    query: 'Alice',
    personId: person.id,
    topK: 5,
  });
  assert.ok(response.hits.length >= 1);
  const hit = response.hits.find((item) => item.id === memory.id);
  assert.ok(hit, '应命中含实体的记忆');
  assert.ok((hit?.signals.entity ?? 0) > 0, `entity=${hit?.signals.entity}`);
  assert.ok(hit?.matchedOn.includes('entity'));
  fx.db.close();
});

test('P2 PII：piiRedaction=basic 时脱敏手机号/邮箱/身份证/银行卡，标记 metadata 并审计', () => {
  const fx = setup({ settings: { piiRedaction: 'basic' } });
  const person = createPerson(fx, 'alice');
  const result = fx.svc.addMemoryResult({
    partitionId: fx.partitionId,
    actor: fx.actor,
    personId: person.id,
    content: '联系 alice@example.com 或 13812345678；身份证 110101199001011237；银行卡 6222021234567890128',
    scope: 'partition',
  });
  assert.equal(result.piiRedacted, true);
  const memory = result.memory;
  assert.ok(!memory.content.includes('alice@example.com'));
  assert.ok(memory.content.includes('a***@example.com'));
  assert.ok(!memory.content.includes('13812345678'));
  assert.ok(memory.content.includes('138****5678'));
  assert.ok(memory.content.includes('110101********1237'));
  assert.ok(!memory.content.includes('6222021234567890128'));
  assert.ok(memory.content.endsWith('0128'));
  assert.equal(memory.metadata.piiRedacted, true);
  assert.equal(auditCount(fx, 'memory.pii_redacted'), 1);

  // 默认 off：原样落库、不标记
  const off = setup();
  const offPerson = createPerson(off, 'bob');
  const untouched = addMemory(off, {
    personId: offPerson.id,
    content: '联系 bob@example.com 或 13912345678',
    scope: 'partition',
  });
  assert.ok(untouched.content.includes('bob@example.com'));
  assert.ok(untouched.content.includes('13912345678'));
  assert.equal(untouched.metadata.piiRedacted, undefined);
  assert.equal(auditCount(off, 'memory.pii_redacted'), 0);

  // 更新内容同样脱敏
  const updated = fx.svc.updateMemory(
    fx.partitionId,
    memory.id,
    { content: '改联系 carol@example.com' },
    fx.actor,
  );
  assert.ok(updated.content.includes('c***@example.com'));
  assert.equal(updated.metadata.piiRedacted, true);
  assert.ok(auditCount(fx, 'memory.pii_redacted') >= 2);
  fx.db.close();
  off.db.close();
});

test('P2 consent：PATCH 人同意标记并审计', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  const updated = fx.svc.updatePerson(
    fx.partitionId,
    person.id,
    { consent: { marketing: false, analytics: true, version: '2026-01' } },
    fx.actor,
  );
  assert.equal(updated.consent?.marketing, false);
  assert.equal(updated.consent?.analytics, true);
  assert.equal(fx.svc.getPerson(fx.partitionId, 'alice')?.consent?.version, '2026-01');
  assert.equal(auditCount(fx, 'person.consent'), 1);
  // 不传 consent 的更新不会清空既有同意标记
  const renamed = fx.svc.updatePerson(fx.partitionId, person.id, { displayName: 'Alice' }, fx.actor);
  assert.equal(renamed.consent?.analytics, true);
  fx.db.close();
});

test('P2 加密开关：配置 MNEMOS_ENCRYPTION_KEY 时附件 url 密文落库、读取解密', () => {
  const saved = process.env[KEY_ENV];
  try {
    process.env[KEY_ENV] = 'p2-engine-test-key';
    const fx = setup();
    const person = createPerson(fx, 'alice');
    const url = 'https://cdn.example.com/private/report.pdf';
    const memory = addMemory(fx, {
      personId: person.id,
      content: 'Alice 上传了私密报告',
      scope: 'person',
      attachments: [{ kind: 'file', url, caption: '季度报告' }],
    });
    const row = fx.db.prepare('SELECT url FROM memory_attachments WHERE memory_id = ?').get(memory.id) as unknown as {
      url: string;
    };
    assert.ok(row.url.startsWith('v1:'), '落库应为 v1 密文');
    assert.ok(!row.url.includes('report.pdf'));
    const detail = fx.svc.getMemory(fx.partitionId, memory.id);
    assert.equal(detail?.memory.attachments?.[0]?.url, url);
    fx.db.close();

    // 未配置密钥：明文落库
    delete process.env[KEY_ENV];
    const plain = setup();
    const plainPerson = createPerson(plain, 'bob');
    const plainMemory = addMemory(plain, {
      personId: plainPerson.id,
      content: 'Bob 上传了公开图片',
      attachments: [{ kind: 'image', url: 'https://cdn.example.com/public.png' }],
    });
    const plainRow = plain.db
      .prepare('SELECT url FROM memory_attachments WHERE memory_id = ?')
      .get(plainMemory.id) as unknown as { url: string };
    assert.equal(plainRow.url, 'https://cdn.example.com/public.png');
    plain.db.close();
  } finally {
    if (saved === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = saved;
  }
});
