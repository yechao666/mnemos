import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { hashPassword } from '../lib/password.ts';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/** v6.4 大模型设置 HTTP 验收：权限 / 供应商 CRUD / 阶段 / 用量 / 状态 / 测试连接 / 审计。 */

async function login(fx: HttpFixture, email = 'owner@test.dev', password = 'Demo123456'): Promise<string> {
  fx.db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), email);
  const res = await request(fx.baseUrl, 'POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'token'));
}

interface FakeLlm {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startFakeLlm(
  response: { status?: number; body?: unknown } = {
    body: { choices: [{ message: { content: 'pong' } }] },
  },
): Promise<FakeLlm> {
  const server = createServer((_req, res) => {
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function providerPayload(fake: FakeLlm, overrides: Record<string, unknown> = {}) {
  return {
    name: 'OpenAI 生产',
    protocol: 'openai',
    baseUrl: `${fake.baseUrl}/v1`,
    apiKey: 'sk-live-secret-9999',
    defaultModel: 'gpt-4o-mini',
    inputPrice: 0.15,
    outputPrice: 0.6,
    ...overrides,
  };
}

test('llm HTTP：权限（owner/admin）、供应商 CRUD、重名 409、密钥不回显、stage 校验与审计', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const owner = await login(fx);
  const admin = await login(fx, 'admin@test.dev');
  const developer = await login(fx, 'developer@test.dev');
  const viewer = await login(fx, 'viewer@test.dev');

  for (const session of [viewer, developer]) {
    const res = await request(fx.baseUrl, 'GET', '/api/llm/providers', { session });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    const status = await request(fx.baseUrl, 'GET', '/api/llm/status', { session });
    assert.equal(status.status, 403);
    const create = await request(fx.baseUrl, 'POST', '/api/llm/providers', {
      session,
      body: { name: 'X', baseUrl: 'https://x.example.com/v1' },
    });
    assert.equal(create.status, 403);
  }

  const empty = await request(fx.baseUrl, 'GET', '/api/llm/providers', { session: admin });
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
  assert.deepEqual(field(empty.json, 'items'), []);

  // 参数校验
  const badUrl = await request(fx.baseUrl, 'POST', '/api/llm/providers', {
    session: admin,
    body: { name: 'Bad', baseUrl: 'ftp://example.com' },
  });
  assert.equal(badUrl.status, 400, JSON.stringify(badUrl.json));
  const badProtocol = await request(fx.baseUrl, 'POST', '/api/llm/providers', {
    session: admin,
    body: { name: 'Bad', baseUrl: 'https://example.com', protocol: 'gemini' },
  });
  assert.equal(badProtocol.status, 400, JSON.stringify(badProtocol.json));

  // 创建（admin 即可）
  const created = await request(fx.baseUrl, 'POST', '/api/llm/providers', {
    session: admin,
    body: {
      name: 'OpenAI 生产',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-live-secret-9999',
      defaultModel: 'gpt-4o-mini',
      inputPrice: 0.15,
      outputPrice: 0.6,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const provider = field(created.json, 'provider') as Record<string, unknown>;
  const providerId = String(provider.id);
  assert.equal(provider.name, 'OpenAI 生产');
  assert.equal(provider.protocol, 'openai');
  assert.equal(provider.hasApiKey, true);
  assert.equal(provider.apiKeyMasked, 'sk-…9999');
  assert.equal(provider.apiKey, undefined);
  assert.equal(JSON.stringify(created.json).includes('sk-live-secret-9999'), false);

  // 同名 409
  const duplicate = await request(fx.baseUrl, 'POST', '/api/llm/providers', {
    session: owner,
    body: { name: 'OpenAI 生产', baseUrl: 'https://api.openai.com/v1' },
  });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));

  const list = await request(fx.baseUrl, 'GET', '/api/llm/providers', { session: owner });
  const items = field(list.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.apiKey, undefined);

  // 更新：enabled + clearApiKey（apiKey 为空表示保持不变）
  const patched = await request(fx.baseUrl, 'PATCH', `/api/llm/providers/${providerId}`, {
    session: admin,
    body: { defaultModel: 'gpt-4o', clearApiKey: true },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(field(patched.json, 'provider.defaultModel'), 'gpt-4o');
  assert.equal(field(patched.json, 'provider.hasApiKey'), false);
  assert.equal(field(patched.json, 'provider.apiKeyMasked'), undefined);

  // 第二个供应商（anthropic）供阶段引用
  const anthropic = await request(fx.baseUrl, 'POST', '/api/llm/providers', {
    session: admin,
    body: {
      name: 'Claude',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-secret-abcd',
      defaultModel: 'claude-3-5-sonnet-latest',
    },
  });
  assert.equal(anthropic.status, 201, JSON.stringify(anthropic.json));
  const anthropicId = String(field(anthropic.json, 'provider.id'));

  // 阶段：默认 5 行 → upsert → 校验
  const stagesDefault = await request(fx.baseUrl, 'GET', '/api/llm/stages', { session: admin });
  assert.equal(stagesDefault.status, 200, JSON.stringify(stagesDefault.json));
  const stageItems = field(stagesDefault.json, 'items') as Array<Record<string, unknown>>;
  assert.deepEqual(
    stageItems.map((item) => item.stage),
    ['brief', 'dream', 'profile', 'privacy', 'extract'],
  );
  for (const item of stageItems) {
    assert.equal(item.temperature, 0.2);
    assert.equal(item.maxTokens, 1024);
    assert.equal(item.timeoutMs, 20_000);
    assert.equal(item.enabled, true);
  }

  const putStage = await request(fx.baseUrl, 'PUT', '/api/llm/stages/brief', {
    session: admin,
    body: {
      providerId: anthropicId,
      model: 'claude-3-5-haiku-latest',
      temperature: 0.4,
      maxTokens: 1500,
      timeoutMs: 8000,
      systemPrompt: '用一句话压缩记忆',
      enabled: true,
    },
  });
  assert.equal(putStage.status, 200, JSON.stringify(putStage.json));
  assert.equal(field(putStage.json, 'config.stage'), 'brief');
  assert.equal(field(putStage.json, 'config.providerId'), anthropicId);
  assert.equal(field(putStage.json, 'config.model'), 'claude-3-5-haiku-latest');
  assert.equal(field(putStage.json, 'config.temperature'), 0.4);

  const badStage = await request(fx.baseUrl, 'PUT', '/api/llm/stages/bogus', { session: admin, body: {} });
  assert.equal(badStage.status, 400, JSON.stringify(badStage.json));
  const badTemperature = await request(fx.baseUrl, 'PUT', '/api/llm/stages/brief', {
    session: admin,
    body: { temperature: 5 },
  });
  assert.equal(badTemperature.status, 400, JSON.stringify(badTemperature.json));
  const missingProvider = await request(fx.baseUrl, 'PUT', '/api/llm/stages/brief', {
    session: admin,
    body: { providerId: 'llm_missing' },
  });
  assert.equal(missingProvider.status, 404, JSON.stringify(missingProvider.json));

  // 用法聚合（直接插 llm_calls，含供应商价格）
  const at = new Date().toISOString();
  fx.db
    .prepare(
      `INSERT INTO llm_calls
         (id, stage, provider_id, model, protocol, prompt_tokens, completion_tokens,
          duration_ms, status, error, created_at)
       VALUES ('llc_http_1', 'brief', ?, 'claude-3-5-haiku-latest', 'anthropic', 1000000, 500000, 800, 'ok', NULL, ?)`,
    )
    .run(anthropicId, at);
  const usage = await request(fx.baseUrl, 'GET', '/api/llm/usage?days=30', { session: admin });
  assert.equal(usage.status, 200, JSON.stringify(usage.json));
  assert.equal(field(usage.json, 'days'), 30);
  const usageItems = field(usage.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(usageItems.length, 1);
  assert.equal(usageItems[0]?.stage, 'brief');
  assert.equal(usageItems[0]?.calls, 1);
  assert.equal(usageItems[0]?.promptTokens, 1_000_000);
  assert.equal(usageItems[0]?.completionTokens, 500_000);
  // 价格未设置（0）→ 成本 0；再设置价格验证公式。
  assert.equal(usageItems[0]?.estimatedCost, 0);
  await request(fx.baseUrl, 'PATCH', `/api/llm/providers/${anthropicId}`, {
    session: admin,
    body: { inputPrice: 3, outputPrice: 15 },
  });
  const usagePriced = await request(fx.baseUrl, 'GET', '/api/llm/usage?days=30', { session: admin });
  // 1000000*3/1e6 + 500000*15/1e6 = 3 + 7.5 = 10.5
  assert.equal(field(usagePriced.json, 'items.0.estimatedCost'), 10.5);

  const status = await request(fx.baseUrl, 'GET', '/api/llm/status', { session: admin });
  assert.equal(status.status, 200, JSON.stringify(status.json));
  assert.equal(field(status.json, 'providers'), 2);
  assert.equal(field(status.json, 'stages'), 1);
  assert.equal(field(status.json, 'envFallbackConfigured'), false);
  assert.equal(field(status.json, 'encryptionConfigured'), false);

  // 删除供应商 → 阶段引用被解除
  const deleted = await request(fx.baseUrl, 'DELETE', `/api/llm/providers/${anthropicId}`, { session: admin });
  assert.equal(deleted.status, 204);
  const stagesAfter = await request(fx.baseUrl, 'GET', '/api/llm/stages', { session: admin });
  const briefAfter = (field(stagesAfter.json, 'items') as Array<Record<string, unknown>>).find(
    (item) => item.stage === 'brief',
  );
  assert.equal(briefAfter?.providerId, undefined);
  const deleteMissing = await request(fx.baseUrl, 'DELETE', '/api/llm/providers/llm_missing', { session: admin });
  assert.equal(deleteMissing.status, 404);

  const actions = (
    fx.db.prepare('SELECT action FROM audit_logs ORDER BY rowid ASC').all() as unknown as { action: string }[]
  ).map((row) => row.action);
  for (const action of ['llm.provider.create', 'llm.provider.update', 'llm.provider.delete', 'llm.stage.update']) {
    assert.ok(actions.includes(action), `缺少审计 ${action}`);
  }
});

test('llm HTTP：测试连接（fake server）返回 ok/latencyMs/model；不可达返回 error；403/404', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const admin = await login(fx, 'admin@test.dev');
  const viewer = await login(fx, 'viewer@test.dev');
  const fake = await startFakeLlm();
  try {
    const created = await request(fx.baseUrl, 'POST', '/api/llm/providers', {
      session: admin,
      body: providerPayload(fake),
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const providerId = String(field(created.json, 'provider.id'));

    const forbidden = await request(fx.baseUrl, 'POST', `/api/llm/providers/${providerId}/test`, { session: viewer });
    assert.equal(forbidden.status, 403);

    const ok = await request(fx.baseUrl, 'POST', `/api/llm/providers/${providerId}/test`, { session: admin });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(field(ok.json, 'ok'), true);
    assert.equal(field(ok.json, 'model'), 'gpt-4o-mini');
    assert.equal(typeof field(ok.json, 'latencyMs'), 'number');

    await fake.close();
    const failed = await request(fx.baseUrl, 'POST', `/api/llm/providers/${providerId}/test`, { session: admin });
    assert.equal(failed.status, 200, JSON.stringify(failed.json));
    assert.equal(field(failed.json, 'ok'), false);
    assert.ok(String(field(failed.json, 'error')).length > 0);

    const missing = await request(fx.baseUrl, 'POST', '/api/llm/providers/llm_missing/test', { session: admin });
    assert.equal(missing.status, 404);

    const testAudits = (
      fx.db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'llm.provider.test'").get() as unknown as {
        c: number;
      }
    ).c;
    assert.equal(testAudits, 2);
  } finally {
    if (fake.baseUrl) await fake.close().catch(() => undefined);
  }
});
