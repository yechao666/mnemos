import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertEnv, loadEnv, validateEnv } from '../env.ts';
import { field, request, setupHttpFixture } from './test-helpers.ts';

/**
 * v6.5 本地免密模式（MNEMOS_DEV_NO_API_KEY=1）：
 * 开启时 v1 无 Authorization 也能建分区/读写记忆；关闭时仍 401；生产启动拒绝。
 */

test('MNEMOS_DEV_NO_API_KEY=1：v1 无 API Key 可建分区 / 写人 / 写记忆 / 搜索 / 详情 / 简报', async (t) => {
  const fx = await setupHttpFixture({ env: { devNoApiKey: true } });
  t.after(() => fx.close());

  // 公开探针不受影响
  const health = await request(fx.baseUrl, 'GET', '/health');
  assert.equal(health.status, 200);

  // 无 Authorization：创建分区（org key + admin 才能做）
  const created = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    body: { slug: 'nokey', name: '免密分区' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(field(created.json, 'slug'), 'nokey');

  // 无 key：upsert person
  const person = await request(fx.baseUrl, 'PUT', '/v1/partitions/nokey/persons/alice', {
    body: { type: 'human', display_name: 'Alice' },
  });
  assert.equal(person.status, 200, JSON.stringify(person.json));
  assert.equal(field(person.json, 'external_id'), 'alice');

  // 无 key：写记忆
  const added = await request(fx.baseUrl, 'POST', '/v1/partitions/nokey/persons/alice/memories', {
    body: { text: 'Alice 喜欢美式咖啡', scope: 'person', category: 'preference' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  const memoryId = String(field(added.json, 'memory.id'));
  assert.ok(memoryId);

  // 无 key：列表 / 搜索
  const list = await request(fx.baseUrl, 'GET', '/v1/partitions/nokey/memories?q=美式');
  assert.equal(list.status, 200);
  assert.equal((field(list.json, 'items') as unknown[]).length, 1);

  const search = await request(fx.baseUrl, 'POST', '/v1/partitions/nokey/memories/search', {
    body: { query: '咖啡', top_k: 5 },
  });
  assert.equal(search.status, 200, JSON.stringify(search.json));
  assert.ok((field(search.json, 'hits') as unknown[]).length >= 1);
  // 合成 key 仍带限流头（rateLimitPerMin=100000）
  assert.equal(search.headers.get('x-ratelimit-limit'), '100000');

  // 无 key：记忆详情
  const detail = await request(fx.baseUrl, 'GET', `/v1/partitions/nokey/memories/${memoryId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(field(detail.json, 'memory.id'), memoryId);

  // 无 key：简报
  const brief = await request(fx.baseUrl, 'GET', '/v1/partitions/nokey/persons/alice/brief');
  assert.equal(brief.status, 200, JSON.stringify(brief.json));
  assert.ok(Number(field(brief.json, 'count')) >= 1);
});

test('MNEMOS_DEV_NO_API_KEY 关闭时：v1 无 Authorization 仍返回 401', async (t) => {
  const fx = await setupHttpFixture({ env: { devNoApiKey: false } });
  t.after(() => fx.close());

  const missing = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons');
  assert.equal(missing.status, 401);
  assert.equal(field(missing.json, 'error.code'), 'INVALID_API_KEY');

  const create = await request(fx.baseUrl, 'POST', '/v1/partitions', { body: { slug: 'nokey' } });
  assert.equal(create.status, 401);
});

test('MNEMOS_DEV_NO_API_KEY=1 但库中无用户：返回 503 而非 500', async (t) => {
  const fx = await setupHttpFixture({ env: { devNoApiKey: true } });
  t.after(() => fx.close());

  fx.db.prepare('DELETE FROM user_sessions').run();
  fx.db.prepare('DELETE FROM users').run();

  const res = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons');
  assert.equal(res.status, 503);
  assert.equal(field(res.json, 'error.code'), 'SERVICE_UNAVAILABLE');
});

test('MNEMOS_DEV_NO_API_KEY：生产环境校验拒绝，development 允许', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemos-nokey-'));
  const base = {
    dataDir: dir,
    backupDir: join(dir, 'backups'),
    demoMode: false,
  };

  const prod = loadEnv({ ...base, nodeEnv: 'production', devNoApiKey: true });
  const problems = validateEnv(prod);
  assert.ok(
    problems.some((problem) => problem.includes('生产环境禁止 MNEMOS_DEV_NO_API_KEY=1')),
    problems.join('\n'),
  );
  assert.throws(() => assertEnv(prod), /MNEMOS_DEV_NO_API_KEY/);

  const dev = loadEnv({ ...base, nodeEnv: 'development', devNoApiKey: true });
  const devProblems = validateEnv(dev);
  assert.ok(
    !devProblems.some((problem) => problem.includes('MNEMOS_DEV_NO_API_KEY')),
    devProblems.join('\n'),
  );
  assert.doesNotThrow(() => assertEnv(dev));
});
