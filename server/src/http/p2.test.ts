import assert from 'node:assert/strict';
import test from 'node:test';
import { processJobs } from '../engine/index.ts';
import { hashPassword } from '../lib/password.ts';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/** v6.1 P2 HTTP 验收：图/实体 API、附件、caption 检索、PII 开关、consent。 */

async function login(fx: HttpFixture, email = 'owner@test.dev', password = 'Demo123456'): Promise<string> {
  fx.db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), email);
  const res = await request(fx.baseUrl, 'POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'token'));
}

async function createPerson(fx: HttpFixture, externalId: string): Promise<string> {
  const res = await request(fx.baseUrl, 'PUT', `/v1/partitions/alpha/persons/${externalId}`, {
    key: fx.partitionKey,
    body: { type: 'human', display_name: externalId },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'id'));
}

function nodeNames(nodes: unknown): string[] {
  return (nodes as Array<Record<string, unknown>>).map((node) => String(node.label).toLowerCase());
}

test('P2 v1 graph/entities：关系图与实体列表形状（节点/边/stats）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');
  const created = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: { text: 'Alice 和 Bob 在「阿尔法项目」上合作', scope: 'partition' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  // 触发写管线（extract 任务）生成 entities / memory_entities / relations
  const jobs = processJobs(fx.db, { limit: 20 });
  assert.ok(jobs.processed >= 1);

  const graph = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/graph', { key: fx.partitionKey });
  assert.equal(graph.status, 200, JSON.stringify(graph.json));
  const nodes = field(graph.json, 'nodes') as Array<Record<string, unknown>>;
  assert.ok(nodes.length >= 3, JSON.stringify(nodes));
  for (const node of nodes) {
    assert.equal(typeof node.id, 'string');
    assert.equal(typeof node.label, 'string');
    assert.equal(typeof node.type, 'string');
    assert.equal(typeof node.weight, 'number');
    assert.equal(typeof node.memories, 'number');
  }
  assert.ok(nodeNames(nodes).includes('alice'));
  const edges = field(graph.json, 'edges') as Array<Record<string, unknown>>;
  assert.ok(edges.length >= 3, JSON.stringify(edges));
  for (const edge of edges) {
    assert.equal(typeof edge.id, 'string');
    assert.equal(typeof edge.source, 'string');
    assert.equal(typeof edge.target, 'string');
    assert.equal(edge.relation, 'co_occurs');
    assert.equal(edge.weight, 1);
  }
  assert.equal(field(graph.json, 'stats.nodes'), nodes.length);
  assert.equal(field(graph.json, 'stats.edges'), edges.length);
  const topTypes = field(graph.json, 'stats.top_types') as Array<Record<string, unknown>>;
  assert.equal(topTypes[0]?.type, 'concept');
  assert.equal(topTypes[0]?.count, nodes.length);

  // person_id 过滤（internal id 与 external id 都可）
  const personId = String(field(created.json, 'memory.person_id') ?? '');
  assert.ok(personId);
  const byPerson = await request(
    fx.baseUrl,
    'GET',
    `/v1/partitions/alpha/graph?person_id=${personId}&limit=10`,
    { key: fx.partitionKey },
  );
  assert.equal(byPerson.status, 200, JSON.stringify(byPerson.json));
  assert.equal((field(byPerson.json, 'nodes') as unknown[]).length, nodes.length);

  const entities = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/entities?q=Alice&limit=10', {
    key: fx.partitionKey,
  });
  assert.equal(entities.status, 200, JSON.stringify(entities.json));
  const items = field(entities.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.name, 'Alice');
  assert.equal(typeof items[0]?.mention_count, 'number');
  assert.equal(typeof items[0]?.memories, 'number');
  assert.equal(items[0]?.memories, 1);
  assert.equal(field(entities.json, 'next_cursor'), null);

  // 控制台 camelCase 同构
  const token = await login(fx);
  const consoleGraph = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/graph', { session: token });
  assert.equal(consoleGraph.status, 200, JSON.stringify(consoleGraph.json));
  assert.ok(Array.isArray(field(consoleGraph.json, 'nodes')));
  const consoleTopTypes = field(consoleGraph.json, 'stats.topTypes') as Array<Record<string, unknown>>;
  assert.equal(consoleTopTypes[0]?.type, 'concept');
  assert.equal(field(consoleGraph.json, 'stats.top_types'), undefined);

  const consoleEntities = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/entities?q=Alice', {
    session: token,
  });
  assert.equal(consoleEntities.status, 200, JSON.stringify(consoleEntities.json));
  const consoleItems = field(consoleEntities.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(consoleItems[0]?.mentionCount, 1);
  assert.equal(field(consoleEntities.json, 'nextCursor'), null);
});

test('P2 attachments：v1/console 写入 + 详情返回 + 列表只带 count + caption 检索', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');
  const created = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: {
      text: 'Alice 上传了登录页设计稿',
      scope: 'person',
      attachments: [
        { kind: 'image', url: 'https://cdn.example.com/login.png', mime: 'image/png', size: 1024, caption: '秋季新品发布会主视觉' },
        { kind: 'file', url: 'https://cdn.example.com/spec.pdf', caption: '交互说明' },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(field(created.json, 'memory.attachment_count'), 2);
  const memoryId = String(field(created.json, 'memory.id'));

  const detail = await request(fx.baseUrl, 'GET', `/v1/partitions/alpha/memories/${memoryId}`, {
    key: fx.partitionKey,
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  const attachments = field(detail.json, 'memory.attachments') as Array<Record<string, unknown>>;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0]?.kind, 'image');
  assert.equal(attachments[0]?.url, 'https://cdn.example.com/login.png');
  assert.equal(attachments[0]?.mime, 'image/png');
  assert.equal(attachments[0]?.size, 1024);
  assert.equal(attachments[0]?.caption, '秋季新品发布会主视觉');
  assert.equal(attachments[0]?.memory_id, memoryId);

  const list = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/memories', { key: fx.partitionKey });
  const items = field(list.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.attachment_count, 2);
  assert.equal(items[0]?.attachments, undefined);

  // caption 参与检索：查询词只出现在附件 caption
  const search = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/memories/search', {
    key: fx.partitionKey,
    body: { query: '发布会主视觉', top_k: 5 },
  });
  assert.equal(search.status, 200, JSON.stringify(search.json));
  const hits = field(search.json, 'hits') as Array<Record<string, unknown>>;
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]?.id, memoryId);
  assert.ok((hits[0]?.matched_on as string[]).includes('attachment'));
  assert.equal(hits[0]?.attachment_count, 2);

  // 控制台同构（camelCase）
  const token = await login(fx);
  const consoleCreated = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/memories', {
    session: token,
    body: {
      text: 'Alice 上传了控制台附件',
      attachments: [{ kind: 'video', url: 'https://cdn.example.com/demo.mp4', caption: '演示视频' }],
    },
  });
  assert.equal(consoleCreated.status, 201, JSON.stringify(consoleCreated.json));
  assert.equal(field(consoleCreated.json, 'memory.attachmentCount'), 1);
  const consoleMemoryId = String(field(consoleCreated.json, 'memory.id'));
  const consoleDetail = await request(fx.baseUrl, 'GET', `/api/partitions/alpha/memories/${consoleMemoryId}`, {
    session: token,
  });
  assert.equal(consoleDetail.status, 200);
  const consoleAttachments = field(consoleDetail.json, 'memory.attachments') as Array<Record<string, unknown>>;
  assert.equal(consoleAttachments[0]?.kind, 'video');
  assert.equal(consoleAttachments[0]?.url, 'https://cdn.example.com/demo.mp4');
  assert.equal(consoleAttachments[0]?.memoryId, consoleMemoryId);

  // 上限校验：11 个附件 → 400
  const tooMany = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: {
      text: '附件超限',
      attachments: Array.from({ length: 11 }, (_, index) => ({
        kind: 'image',
        url: `https://cdn.example.com/${index}.png`,
      })),
    },
  });
  assert.equal(tooMany.status, 400, JSON.stringify(tooMany.json));
});

test('P2 PII：分区开关 off→basic 生效、metadata 标记 + 审计 memory.pii_redacted', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');
  const token = await login(fx);

  // 默认 off：明文落库
  const plain = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: { text: '联系 alice@example.com 或 13812345678' },
  });
  assert.equal(plain.status, 201, JSON.stringify(plain.json));
  assert.ok(String(field(plain.json, 'memory.content')).includes('alice@example.com'));

  // 控制台开启 basic（console camelCase + v1 snake_case 都可读）
  const patched = await request(fx.baseUrl, 'PATCH', '/api/partitions/alpha', {
    session: token,
    body: { settings: { piiRedaction: 'basic' } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(field(patched.json, 'settings.piiRedaction'), 'basic');
  const v1Partition = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha', { key: fx.partitionKey });
  assert.equal(field(v1Partition.json, 'settings.pii_redaction'), 'basic');

  const redacted = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: { text: '新联系人 bob@example.com / 13912345678 / 身份证 110101199001011237 / 卡号 6222021234567890128' },
  });
  assert.equal(redacted.status, 201, JSON.stringify(redacted.json));
  const content = String(field(redacted.json, 'memory.content'));
  assert.ok(!content.includes('bob@example.com'));
  assert.ok(content.includes('b***@example.com'));
  assert.ok(content.includes('139****5678'));
  assert.ok(content.includes('110101********1237'));
  assert.ok(content.endsWith('0128'));
  assert.equal(field(redacted.json, 'memory.metadata.piiRedacted'), true);

  const audit = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/audit?limit=50', { session: token });
  assert.equal(audit.status, 200, JSON.stringify(audit.json));
  const actions = (field(audit.json, 'items') as Array<Record<string, unknown>>).map((item) => item.action);
  assert.ok(actions.includes('memory.pii_redacted'), JSON.stringify(actions));
});

test('P2 consent：console/v1 PATCH 同意标记并审计 person.consent', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');
  const token = await login(fx);

  const v1 = await request(fx.baseUrl, 'PATCH', '/v1/partitions/alpha/persons/alice', {
    key: fx.partitionKey,
    body: { consent: { marketing: false, analytics: true, version: '2026-01' } },
  });
  assert.equal(v1.status, 200, JSON.stringify(v1.json));
  assert.equal(field(v1.json, 'consent.marketing'), false);
  assert.equal(field(v1.json, 'consent.analytics'), true);
  assert.equal(field(v1.json, 'consent.version'), '2026-01');

  const consolePatch = await request(fx.baseUrl, 'PATCH', '/api/partitions/alpha/persons/alice', {
    session: token,
    body: { consent: { marketing: true, analytics: false, version: '2026-02' } },
  });
  assert.equal(consolePatch.status, 200, JSON.stringify(consolePatch.json));
  assert.equal(field(consolePatch.json, 'consent.marketing'), true);

  const detail = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice', { key: fx.partitionKey });
  assert.equal(field(detail.json, 'consent.version'), '2026-02');

  const audit = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/audit?limit=50', { session: token });
  const actions = (field(audit.json, 'items') as Array<Record<string, unknown>>).map((item) => item.action);
  assert.ok(actions.includes('person.consent'), JSON.stringify(actions));
});
