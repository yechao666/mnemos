import assert from 'node:assert/strict';
import test from 'node:test';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/** v6.1 P1 HTTP 验收：画像 / facts / merge / archive / export / delete + as_of。 */

async function createPerson(fx: HttpFixture, externalId: string): Promise<string> {
  const res = await request(fx.baseUrl, 'PUT', `/v1/partitions/${fx.partitionSlug}/persons/${externalId}`, {
    key: fx.partitionKey,
    body: { type: 'human', display_name: externalId },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'id'));
}

async function addMemory(
  fx: HttpFixture,
  person: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await request(fx.baseUrl, 'POST', `/v1/partitions/${fx.partitionSlug}/persons/${person}/memories`, {
    key: fx.partitionKey,
    body,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json as Record<string, unknown>;
}

test('v6.1 P1 v1：profile / facts CRUD（版本化 + 缓存 + 软删）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');

  const empty = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/profile', {
    key: fx.partitionKey,
  });
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
  assert.deepEqual(field(empty.json, 'facts'), []);
  assert.equal(typeof field(empty.json, 'summary'), 'string');

  const put = await request(fx.baseUrl, 'PUT', '/v1/partitions/alpha/persons/alice/facts', {
    key: fx.partitionKey,
    body: { key: 'preference.language', value: '中文', confidence: 0.9 },
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const factId = String(field(put.json, 'fact.id'));
  assert.equal(field(put.json, 'fact.key'), 'preference.language');

  const idempotent = await request(fx.baseUrl, 'PUT', '/v1/partitions/alpha/persons/alice/facts', {
    key: fx.partitionKey,
    body: { key: 'preference.language', value: '中文', confidence: 0.95 },
  });
  assert.equal(field(idempotent.json, 'fact.id'), factId);

  const listed = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/facts', {
    key: fx.partitionKey,
  });
  assert.equal((field(listed.json, 'items') as unknown[]).length, 1);

  const versioned = await request(fx.baseUrl, 'PUT', '/v1/partitions/alpha/persons/alice/facts', {
    key: fx.partitionKey,
    body: { key: 'preference.language', value: 'English', confidence: 0.8 },
  });
  assert.notEqual(field(versioned.json, 'fact.id'), factId);
  const afterVersion = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/facts', {
    key: fx.partitionKey,
  });
  const items = field(afterVersion.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.value, 'English');

  // 缓存命中：generated_at 不变；facts 变化后命中失效
  const profile = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/profile', {
    key: fx.partitionKey,
  });
  assert.match(String(field(profile.json, 'summary')), /English/);
  const firstGeneratedAt = field(profile.json, 'generated_at');
  const cachedProfile = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/profile', {
    key: fx.partitionKey,
  });
  assert.equal(field(cachedProfile.json, 'cached'), true);
  assert.equal(field(cachedProfile.json, 'generated_at'), firstGeneratedAt);

  const forced = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/profile?force=true', {
    key: fx.partitionKey,
  });
  assert.equal(forced.status, 200);
  assert.equal(field(forced.json, 'cached'), false);

  // 批量 UPSERT
  const bulk = await request(fx.baseUrl, 'PUT', '/v1/partitions/alpha/persons/alice/facts', {
    key: fx.partitionKey,
    body: {
      facts: [
        { key: 'identity.role', value: 'engineer' },
        { key: 'location.city', value: 'Shanghai' },
      ],
    },
  });
  assert.equal((field(bulk.json, 'items') as unknown[]).length, 2);

  const remove = await request(
    fx.baseUrl,
    'DELETE',
    `/v1/partitions/alpha/persons/alice/facts/${items[0]?.id}`,
    { key: fx.partitionKey },
  );
  assert.equal(remove.status, 204);
  const removeAgain = await request(
    fx.baseUrl,
    'DELETE',
    `/v1/partitions/alpha/persons/alice/facts/${items[0]?.id}`,
    { key: fx.partitionKey },
  );
  assert.equal(removeAgain.status, 404);
  const finalFacts = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/facts', {
    key: fx.partitionKey,
  });
  assert.equal((field(finalFacts.json, 'items') as unknown[]).length, 2);
});

test('v6.1 P1 v1：merge 迁移 + 源人解析跟随 + 默认列表排除 + export', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const targetId = await createPerson(fx, 'target');
  const sourceId = await createPerson(fx, 'source');
  await addMemory(fx, 'source', { text: 'source 喜欢简洁周报', scope: 'person' });
  await request(fx.baseUrl, 'PUT', `/v1/partitions/alpha/persons/source/facts`, {
    key: fx.partitionKey,
    body: { key: 'identity.team', value: 'infra' },
  });

  const merge = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/source/merge', {
    key: fx.partitionKey,
    body: { target_id: targetId },
  });
  assert.equal(merge.status, 200, JSON.stringify(merge.json));
  assert.equal(field(merge.json, 'person.id'), targetId);
  assert.equal(field(merge.json, 'merged_from.id'), sourceId);
  assert.equal(field(merge.json, 'merged_from.status'), 'archived');
  assert.equal(field(merge.json, 'moved_memories'), 1);
  assert.equal(field(merge.json, 'moved_facts'), 1);

  // 源人路径解析到 canonical
  const resolved = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/source', {
    key: fx.partitionKey,
  });
  assert.equal(field(resolved.json, 'id'), targetId);
  assert.equal(field(resolved.json, 'merged_into'), null);

  // 列表默认排除 merged；include_merged=true 包含
  const defaultList = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons', { key: fx.partitionKey });
  assert.deepEqual(
    (field(defaultList.json, 'items') as Array<Record<string, unknown>>).map((item) => item.external_id),
    ['target'],
  );
  const withMerged = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons?include_merged=true', {
    key: fx.partitionKey,
  });
  assert.deepEqual(
    (field(withMerged.json, 'items') as Array<Record<string, unknown>>).map((item) => item.external_id).sort(),
    ['source', 'target'],
  );

  // 源人被合并后，按源人查记忆仍能命中
  const search = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/memories/search', {
    key: fx.partitionKey,
    body: { query: '周报', person_id: sourceId, top_k: 5 },
  });
  assert.ok((field(search.json, 'hits') as unknown[]).length >= 1);

  const exported = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/source/export', {
    key: fx.partitionKey,
  });
  assert.equal(exported.status, 200, JSON.stringify(exported.json));
  assert.equal(field(exported.json, 'person.id'), targetId);
  assert.equal((field(exported.json, 'memories') as unknown[]).length, 1);
  assert.equal((field(exported.json, 'facts') as unknown[]).length, 1);
  assert.equal(field(exported.json, 'truncated'), false);
  assert.ok(field(exported.json, 'exported_at'));

  // archive
  const archive = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/target/archive', {
    key: fx.partitionKey,
  });
  assert.equal(archive.status, 200);
  assert.equal(field(archive.json, 'status'), 'archived');
});

test('v6.1 P1 acl：硬删仅 owner（console）/ admin key（v1）；软删 + 列表排除', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'soft');
  await createPerson(fx, 'hard');
  await createPerson(fx, 'v1hard');

  // 软删：admin 可做；默认列表排除；status=deleted 可查
  const soft = await request(fx.baseUrl, 'DELETE', '/api/partitions/alpha/persons/soft', {
    session: fx.sessions.admin,
  });
  assert.equal(soft.status, 204);
  const defaultList = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons', {
    session: fx.sessions.viewer,
  });
  assert.deepEqual(
    (field(defaultList.json, 'items') as Array<Record<string, unknown>>).map((item) => item.externalId).sort(),
    ['hard', 'v1hard'],
  );
  const deletedList = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons?status=deleted', {
    session: fx.sessions.viewer,
  });
  assert.deepEqual(
    (field(deletedList.json, 'items') as Array<Record<string, unknown>>).map((item) => item.externalId),
    ['soft'],
  );

  // 硬删：developer / admin 403，owner 204
  for (const session of [fx.sessions.developer, fx.sessions.admin]) {
    const denied = await request(fx.baseUrl, 'DELETE', '/api/partitions/alpha/persons/hard?hard=true', { session });
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
  }
  const owner = await request(fx.baseUrl, 'DELETE', '/api/partitions/alpha/persons/hard?hard=true', {
    session: fx.sessions.owner,
  });
  assert.equal(owner.status, 204);
  const gone = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons/hard', {
    session: fx.sessions.owner,
  });
  assert.equal(gone.status, 404);

  // v1：只读 key 无 admin scope 403；分区 admin key 可硬删
  const readOnly = await request(fx.baseUrl, 'DELETE', '/v1/partitions/alpha/persons/v1hard?hard=true', {
    key: fx.partitionReadKey,
  });
  assert.equal(readOnly.status, 403);
  const v1Delete = await request(fx.baseUrl, 'DELETE', '/v1/partitions/alpha/persons/v1hard?hard=true', {
    key: fx.partitionKey,
  });
  assert.equal(v1Delete.status, 204);
});

test('v6.1 P1 console：profile / facts / search as_of + includeSuperseded（camelCase）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');

  const put = await request(fx.baseUrl, 'PUT', '/api/partitions/alpha/persons/alice/facts', {
    session: fx.sessions.developer,
    body: { key: 'identity.role', value: 'backend', confidence: 0.9, sourceMemoryId: 'mem_x' },
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(field(put.json, 'fact.key'), 'identity.role');

  const profile = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons/alice/profile', {
    session: fx.sessions.viewer,
  });
  assert.equal(profile.status, 200, JSON.stringify(profile.json));
  assert.match(String(field(profile.json, 'summary')), /backend/);
  assert.equal((field(profile.json, 'facts') as unknown[]).length, 1);
  assert.ok(field(profile.json, 'generatedAt'));

  const exported = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons/alice/export', {
    session: fx.sessions.viewer,
  });
  assert.equal(field(exported.json, 'person.externalId'), 'alice');
  assert.equal(field(exported.json, 'truncated'), false);

  // as_of / includeSuperseded：控制台 search
  await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/memories', {
    session: fx.sessions.developer,
    body: {
      text: 'alice 目前住在上海',
      scope: 'partition',
      factKey: 'location.city',
      validFrom: '2025-01-01T00:00:00.000Z',
    },
  });
  await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/memories', {
    session: fx.sessions.developer,
    body: {
      text: 'alice 目前住在北京',
      scope: 'partition',
      factKey: 'location.city',
      validFrom: '2025-12-01T00:00:00.000Z',
    },
  });

  const historical = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/memories/search', {
    session: fx.sessions.viewer,
    body: { query: '住在', asOf: '2025-06-01T00:00:00.000Z', topK: 5 },
  });
  const historicalHits = field(historical.json, 'hits') as Array<Record<string, unknown>>;
  assert.ok(historicalHits.some((hit) => String(hit.content).includes('上海')));
  assert.ok(!historicalHits.some((hit) => String(hit.content).includes('北京')));

  const withSuperseded = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/memories/search', {
    session: fx.sessions.viewer,
    body: { query: '上海', includeSuperseded: true, topK: 5 },
  });
  assert.ok(
    (field(withSuperseded.json, 'hits') as Array<Record<string, unknown>>).some((hit) =>
      String(hit.content).includes('上海'),
    ),
  );

  // v1 同样生效
  const v1Historical = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/memories/search', {
    key: fx.partitionKey,
    body: { query: '住在', as_of: '2025-06-01T00:00:00.000Z', top_k: 5 },
  });
  assert.ok(
    (field(v1Historical.json, 'hits') as Array<Record<string, unknown>>).some((hit) =>
      String(hit.content).includes('上海'),
    ),
  );

  // merge 权限：developer 403，admin 200
  await createPerson(fx, 'merge_target');
  const denied = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/merge', {
    session: fx.sessions.developer,
    body: { targetId: 'merge_target' },
  });
  assert.equal(denied.status, 403);
  const merged = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/merge', {
    session: fx.sessions.admin,
    body: { targetId: 'merge_target' },
  });
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  assert.equal(field(merged.json, 'mergedFrom.externalId'), 'alice');
});
