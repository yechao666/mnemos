import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Actor, LlmStageConfig } from '../../../shared/src/types.ts';
import { migrate } from '../db/index.ts';
import {
  createLlmRouter,
  createMemoryService,
  llmStatus,
  llmUsage,
  testLlmProvider,
} from './index.ts';
import type { EngineError } from './errors.ts';

/** v6.4 大模型设置引擎验收：CRUD / 加密 / 阶段路由 / 协议 / 降级 / 用量。 */

const ACTOR: Actor = { type: 'user', id: 'usr_llm', label: '测试管理员' };
const ENCRYPTION_ENV = 'MNEMOS_ENCRYPTION_KEY';

interface FakeRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface FakeResponse {
  status?: number;
  body?: unknown;
  raw?: string;
}

const OPENAI_OK: FakeResponse = {
  body: {
    choices: [{ message: { content: 'POLISHED' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
};

async function startFakeLlm(
  response: FakeResponse | ((request: FakeRequest) => FakeResponse) = OPENAI_OK,
): Promise<{ baseUrl: string; requests: FakeRequest[]; close: () => Promise<void> }> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { raw };
      }
      const request: FakeRequest = { path: req.url ?? '', headers: req.headers, body };
      requests.push(request);
      const planned = typeof response === 'function' ? response(request) : response;
      res.writeHead(planned.status ?? 200, { 'content-type': 'application/json' });
      if (planned.raw !== undefined) res.end(planned.raw);
      else res.end(JSON.stringify(planned.body ?? { choices: [{ message: { content: 'FAKE' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

async function withEncryptionKey<T>(key: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env[ENCRYPTION_ENV];
  try {
    if (key === undefined) delete process.env[ENCRYPTION_ENV];
    else process.env[ENCRYPTION_ENV] = key;
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[ENCRYPTION_ENV];
    else process.env[ENCRYPTION_ENV] = saved;
  }
}

function engineErrorOf(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (error) {
    return error as EngineError;
  }
  throw new Error('期望抛出 EngineError，实际未抛错');
}

function auditActions(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT action FROM audit_logs ORDER BY rowid ASC').all() as unknown as {
    action: string;
  }[];
  return rows.map((row) => row.action);
}

function callRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM llm_calls ORDER BY rowid ASC').all() as unknown as Array<
    Record<string, unknown>
  >;
}

test('provider CRUD：创建/列表/更新/删除、重名 409、密钥永不回显、审计', async () => {
  await withEncryptionKey(undefined, async () => {
    const db = freshDb();
    const svc = createMemoryService(db);

    const provider = svc.createLlmProvider(
      {
        name: 'OpenAI',
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-secret-1234567890',
        defaultModel: 'gpt-4o-mini',
        inputPrice: 0.15,
        outputPrice: 0.6,
      },
      ACTOR,
    );
    assert.equal(provider.name, 'OpenAI');
    assert.equal(provider.protocol, 'openai');
    assert.equal(provider.hasApiKey, true);
    assert.equal(provider.apiKeyMasked, 'sk-…7890');
    assert.equal((provider as unknown as Record<string, unknown>).apiKey, undefined);
    assert.equal(JSON.stringify(provider).includes('sk-secret-1234567890'), false);
    assert.equal(provider.enabled, true);

    // 未配置加密密钥：明文存储 + api_key_encrypted=0。
    const stored = db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(provider.id) as unknown as {
      api_key_cipher: string;
      api_key_encrypted: number;
    };
    assert.equal(stored.api_key_cipher, 'sk-secret-1234567890');
    assert.equal(stored.api_key_encrypted, 0);

    assert.equal(svc.listLlmProviders().length, 1);

    const conflict = engineErrorOf(() =>
      svc.createLlmProvider({ name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }, ACTOR),
    );
    assert.equal(conflict.code, 'CONFLICT');
    assert.equal(conflict.status, 409);

    // 更新：不传 apiKey 保持原值；改名生效。
    const renamed = svc.updateLlmProvider(provider.id, { name: 'OpenAI 主账号' }, ACTOR);
    assert.equal(renamed.name, 'OpenAI 主账号');
    assert.equal(renamed.hasApiKey, true);

    // clearApiKey 清除。
    const cleared = svc.updateLlmProvider(provider.id, { clearApiKey: true }, ACTOR);
    assert.equal(cleared.hasApiKey, false);
    assert.equal(cleared.apiKeyMasked, undefined);

    // 删除后阶段引用解除。
    svc.upsertLlmStage('brief', { providerId: provider.id }, ACTOR);
    assert.equal(svc.listLlmStages().find((item) => item.stage === 'brief')?.providerId, provider.id);
    svc.deleteLlmProvider(provider.id, ACTOR);
    assert.equal(svc.listLlmProviders().length, 0);
    assert.equal(svc.listLlmStages().find((item) => item.stage === 'brief')?.providerId, undefined);

    const actions = auditActions(db);
    for (const action of ['llm.provider.create', 'llm.provider.update', 'llm.provider.delete', 'llm.stage.update']) {
      assert.ok(actions.includes(action), `缺少审计 ${action}`);
    }
    // 审计不落明文密钥。
    const auditDetail = db.prepare("SELECT detail FROM audit_logs WHERE action = 'llm.provider.create'").get() as unknown as {
      detail: string;
    };
    assert.equal(auditDetail.detail.includes('sk-secret-1234567890'), false);
    db.close();
  });
});

test('provider 密钥：配置 MNEMOS_ENCRYPTION_KEY 时 AES 加密存储，读取只给掩码', async () => {
  await withEncryptionKey('unit-test-encryption-key', async () => {
    const db = freshDb();
    const svc = createMemoryService(db);
    const provider = svc.createLlmProvider(
      {
        name: 'Anthropic',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-secret-abcdef',
        defaultModel: 'claude-3-5-sonnet-latest',
      },
      ACTOR,
    );
    assert.equal(provider.hasApiKey, true);
    assert.equal(provider.apiKeyMasked, 'sk-…cdef');
    const stored = db.prepare('SELECT api_key_cipher, api_key_encrypted FROM llm_providers WHERE id = ?').get(provider.id) as unknown as {
      api_key_cipher: string;
      api_key_encrypted: number;
    };
    assert.equal(stored.api_key_encrypted, 1);
    assert.match(stored.api_key_cipher, /^v1:/);
    assert.equal(stored.api_key_cipher.includes('sk-ant-secret-abcdef'), false);
    assert.equal(JSON.stringify(svc.listLlmProviders()).includes('sk-ant-secret-abcdef'), false);
    assert.equal(llmStatus(db, null).encryptionConfigured, true);
    db.close();
  });
});

test('stage：默认 5 行补全、upsert 校验、非法枚举/范围 400、供应商不存在 404', async () => {
  await withEncryptionKey(undefined, async () => {
    const db = freshDb();
    const svc = createMemoryService(db);
    const provider = svc.createLlmProvider(
      { name: 'P1', baseUrl: 'https://api.example.com/v1', defaultModel: 'm1' },
      ACTOR,
    );

    const defaults = svc.listLlmStages();
    assert.deepEqual(
      defaults.map((item) => item.stage),
      ['brief', 'dream', 'profile', 'privacy', 'extract'],
    );
    for (const item of defaults) {
      assert.equal(item.temperature, 0.2);
      assert.equal(item.maxTokens, 1024);
      assert.equal(item.timeoutMs, 20_000);
      assert.equal(item.enabled, true);
      assert.equal(item.providerId, undefined);
    }

    const updated: LlmStageConfig = svc.upsertLlmStage(
      'brief',
      {
        providerId: provider.id,
        model: 'stage-model',
        temperature: 0.5,
        maxTokens: 2048,
        timeoutMs: 5000,
        systemPrompt: '自定义简报系统提示词',
        enabled: true,
      },
      ACTOR,
    );
    assert.equal(updated.stage, 'brief');
    assert.equal(updated.providerId, provider.id);
    assert.equal(updated.model, 'stage-model');
    assert.equal(updated.temperature, 0.5);
    assert.equal(updated.maxTokens, 2048);
    assert.equal(updated.timeoutMs, 5000);
    assert.equal(updated.systemPrompt, '自定义简报系统提示词');

    // 部分更新保留其余字段。
    const partial = svc.upsertLlmStage('brief', { temperature: 0.7 }, ACTOR);
    assert.equal(partial.temperature, 0.7);
    assert.equal(partial.model, 'stage-model');

    assert.equal(engineErrorOf(() => svc.upsertLlmStage('nope' as never, {}, ACTOR)).status, 400);
    assert.equal(engineErrorOf(() => svc.upsertLlmStage('brief', { temperature: 3 }, ACTOR)).status, 400);
    assert.equal(engineErrorOf(() => svc.upsertLlmStage('brief', { maxTokens: 0 }, ACTOR)).status, 400);
    assert.equal(engineErrorOf(() => svc.upsertLlmStage('brief', { maxTokens: 9000 }, ACTOR)).status, 400);
    assert.equal(engineErrorOf(() => svc.upsertLlmStage('brief', { timeoutMs: 500 }, ACTOR)).status, 400);
    assert.equal(engineErrorOf(() => svc.upsertLlmStage('brief', { timeoutMs: 999_999 }, ACTOR)).status, 400);
    assert.equal(engineErrorOf(() => svc.upsertLlmStage('brief', { providerId: 'llm_missing' }, ACTOR)).status, 404);

    const status = svc.llmStatus();
    assert.equal(status.providers, 1);
    assert.equal(status.stages, 1);
    assert.equal(status.envFallbackConfigured, false);
    db.close();
  });
});

test('router openai：stage 模型覆盖 / 温度 / max_tokens / system + llm_calls 记录', async () => {
  const fake = await startFakeLlm(OPENAI_OK);
  try {
    const db = freshDb();
    const svc = createMemoryService(db);
    const provider = svc.createLlmProvider(
      {
        name: 'OpenAI',
        baseUrl: `${fake.baseUrl}/v1`,
        apiKey: 'sk-router-key',
        defaultModel: 'provider-default',
      },
      ACTOR,
    );
    svc.upsertLlmStage(
      'brief',
      { providerId: provider.id, model: 'stage-model-x', temperature: 0.3, maxTokens: 123, timeoutMs: 5000 },
      ACTOR,
    );
    const router = createLlmRouter(db, null);
    assert.equal(router.modelOf?.('brief'), 'stage-model-x');

    const text = await router.text('brief', { prompt: '原始记忆', system: '内置简报提示词', maxChars: 8 });
    assert.equal(text, 'POLISHED');

    assert.equal(fake.requests.length, 1);
    const request = fake.requests[0]!;
    assert.equal(request.path, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sk-router-key');
    assert.equal(request.body.model, 'stage-model-x');
    assert.equal(request.body.temperature, 0.3);
    assert.equal(request.body.max_tokens, 123);
    const messages = request.body.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user']);
    assert.equal(messages[0]?.content, '内置简报提示词');
    assert.equal(messages[1]?.content, '原始记忆');

    const rows = callRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.stage, 'brief');
    assert.equal(rows[0]?.provider_id, provider.id);
    assert.equal(rows[0]?.model, 'stage-model-x');
    assert.equal(rows[0]?.protocol, 'openai');
    assert.equal(rows[0]?.prompt_tokens, 10);
    assert.equal(rows[0]?.completion_tokens, 5);
    assert.equal(rows[0]?.status, 'ok');
    assert.ok(Number(rows[0]?.duration_ms) >= 0);
    db.close();
  } finally {
    await fake.close();
  }
});

test('router anthropic：/v1/messages + x-api-key/anthropic-version + system 覆盖 + content 解析', async () => {
  const fake = await startFakeLlm({
    body: { content: [{ type: 'text', text: 'ANTHROPIC_TEXT' }], usage: { input_tokens: 21, output_tokens: 7 } },
  });
  try {
    const db = freshDb();
    const svc = createMemoryService(db);
    const provider = svc.createLlmProvider(
      {
        name: 'Claude',
        protocol: 'anthropic',
        baseUrl: fake.baseUrl,
        apiKey: 'sk-ant-key',
        defaultModel: 'claude-x',
      },
      ACTOR,
    );
    svc.upsertLlmStage(
      'privacy',
      { providerId: provider.id, maxTokens: 456, timeoutMs: 5000, systemPrompt: '阶段系统提示词' },
      ACTOR,
    );
    const router = createLlmRouter(db, null);
    const text = await router.text('privacy', { prompt: '待抽取文本', system: '内置提示词' });
    assert.equal(text, 'ANTHROPIC_TEXT');

    assert.equal(fake.requests.length, 1);
    const request = fake.requests[0]!;
    assert.equal(request.path, '/v1/messages');
    assert.equal(request.headers['x-api-key'], 'sk-ant-key');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.body.model, 'claude-x');
    assert.equal(request.body.system, '阶段系统提示词');
    assert.equal(request.body.max_tokens, 456);
    assert.equal(request.body.temperature, 0.2);
    const messages = request.body.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(messages, [{ role: 'user', content: '待抽取文本' }]);

    const rows = callRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.protocol, 'anthropic');
    assert.equal(rows[0]?.prompt_tokens, 21);
    assert.equal(rows[0]?.completion_tokens, 7);
    db.close();
  } finally {
    await fake.close();
  }
});

test('降级：无阶段配置回退 env、stage/provider 禁用不调、无配置返回空', async () => {
  const fake = await startFakeLlm(OPENAI_OK);
  try {
    // 1) 无阶段配置 → 回退 env fallback（OpenAI 协议），llm_calls provider_id 为空。
    const db = freshDb();
    const fallback = {
      baseUrl: `${fake.baseUrl}/v1`,
      apiKey: 'env-key',
      model: 'env-model',
      embeddingModel: 'env-embedding',
    };
    const router = createLlmRouter(db, fallback);
    assert.equal(router.modelOf?.('dream'), 'env-model');
    const text = await router.text('dream', { prompt: '记忆批次', maxChars: 100 });
    assert.equal(text, 'POLISHED');
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]?.body.model, 'env-model');
    assert.equal(fake.requests[0]?.body.max_tokens, 256);
    assert.equal(fake.requests[0]?.headers.authorization, 'Bearer env-key');
    const rows = callRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.provider_id, null);
    assert.equal(rows[0]?.model, 'env-model');

    // 2) 无任何配置 → 空串，不记录。
    const emptyRouter = createLlmRouter(freshDb(), null);
    assert.equal(await emptyRouter.text('brief', { prompt: 'x' }), '');

    // 3) 供应商禁用 → 不调（也不回退 env）。
    const svc = createMemoryService(db, { llm: fallback });
    const disabledProvider = svc.createLlmProvider(
      { name: 'Disabled', baseUrl: `${fake.baseUrl}/v1`, apiKey: 'k', defaultModel: 'disabled-model', enabled: false },
      ACTOR,
    );
    svc.upsertLlmStage('brief', { providerId: disabledProvider.id }, ACTOR);
    const before = fake.requests.length;
    assert.equal(await createLlmRouter(db, fallback).text('brief', { prompt: 'x' }), '');
    assert.equal(fake.requests.length, before);

    // 4) 阶段禁用 → 不调。
    svc.upsertLlmStage('brief', { enabled: false }, ACTOR);
    assert.equal(await createLlmRouter(db, fallback).text('brief', { prompt: 'x' }), '');
    assert.equal(fake.requests.length, before);

    // 5) 阶段启用但供应商不存在（配置不完整）→ 回退 env。
    svc.updateLlmProvider(disabledProvider.id, { enabled: true }, ACTOR);
    svc.deleteLlmProvider(disabledProvider.id, ACTOR);
    svc.upsertLlmStage('brief', { enabled: true }, ACTOR);
    const fallbackText = await createLlmRouter(db, fallback).text('brief', { prompt: 'x' });
    assert.equal(fallbackText, 'POLISHED');
    assert.equal(fake.requests.length, before + 1);
    db.close();
  } finally {
    await fake.close();
  }
});

test('失败静默：非 2xx / 非法 JSON 返回空串并记录 error 状态', async () => {
  const failing = await startFakeLlm({ status: 500, body: { error: 'boom' } });
  const malformed = await startFakeLlm({ raw: 'not-json' });
  try {
    const db = freshDb();
    const svc = createMemoryService(db);
    const p1 = svc.createLlmProvider(
      { name: 'Fail500', baseUrl: failing.baseUrl, apiKey: 'k', defaultModel: 'm' },
      ACTOR,
    );
    const p2 = svc.createLlmProvider(
      { name: 'BadJson', baseUrl: malformed.baseUrl, apiKey: 'k', defaultModel: 'm' },
      ACTOR,
    );
    svc.upsertLlmStage('brief', { providerId: p1.id, timeoutMs: 5000 }, ACTOR);
    svc.upsertLlmStage('profile', { providerId: p2.id, timeoutMs: 5000 }, ACTOR);

    const router = createLlmRouter(db, null);
    assert.equal(await router.text('brief', { prompt: 'x' }), '');
    assert.equal(await router.text('profile', { prompt: 'x' }), '');

    const rows = callRows(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.status, 'error');
    assert.equal(rows[0]?.error, 'HTTP 500');
    assert.equal(rows[0]?.prompt_tokens, 0);
    assert.equal(rows[1]?.status, 'error');
    assert.equal(typeof rows[1]?.error, 'string');
    db.close();
  } finally {
    await failing.close();
    await malformed.close();
  }
});

test('usage：按 stage 聚合 calls/tokens/成本（供应商价格），排除过期与 test 记录', async () => {
  const db = freshDb();
  const svc = createMemoryService(db);
  const provider = svc.createLlmProvider(
    { name: 'Priced', baseUrl: 'https://api.example.com/v1', inputPrice: 2, outputPrice: 4 },
    ACTOR,
  );
  const at = new Date().toISOString();
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const insert = db.prepare(
    `INSERT INTO llm_calls
       (id, stage, provider_id, model, protocol, prompt_tokens, completion_tokens,
        duration_ms, status, error, created_at)
     VALUES (?, ?, ?, 'm', 'openai', ?, ?, 10, ?, NULL, ?)`,
  );
  insert.run('llc_1', 'brief', provider.id, 500_000, 100_000, 'ok', at);
  insert.run('llc_2', 'brief', provider.id, 0, 0, 'error', at);
  insert.run('llc_3', 'dream', null, 1_000, 2_000, 'ok', at);
  insert.run('llc_4', 'brief', provider.id, 999_999, 999_999, 'ok', old);
  insert.run('llc_5', 'test', provider.id, 100, 100, 'ok', at);

  const usage = llmUsage(db, 30);
  assert.deepEqual(usage.map((item) => item.stage), ['brief', 'dream']);
  const brief = usage[0]!;
  assert.equal(brief.calls, 2);
  assert.equal(brief.promptTokens, 500_000);
  assert.equal(brief.completionTokens, 100_000);
  // 500000*2/1e6 + 100000*4/1e6 = 1.4
  assert.equal(brief.estimatedCost, 1.4);
  const dream = usage[1]!;
  assert.equal(dream.calls, 1);
  assert.equal(dream.estimatedCost, 0);

  // 已删除供应商的历史调用仍计入 calls/tokens，成本按 0（LEFT JOIN）。
  svc.deleteLlmProvider(provider.id, ACTOR);
  const afterDelete = llmUsage(db, 30);
  assert.equal(afterDelete[0]?.calls, 2);
  assert.equal(afterDelete[0]?.estimatedCost, 0);
  db.close();
});

test('status：env fallback / 供应商数 / 已配置阶段数 / 加密状态', async () => {
  await withEncryptionKey(undefined, async () => {
    const db = freshDb();
    const svc = createMemoryService(db);
    assert.deepEqual(svc.llmStatus(), {
      envFallbackConfigured: false,
      providers: 0,
      stages: 0,
      encryptionConfigured: false,
    });
    svc.createLlmProvider({ name: 'A', baseUrl: 'https://a.example.com/v1' }, ACTOR);
    svc.upsertLlmStage('brief', { temperature: 0.4 }, ACTOR);
    const withFallback = createMemoryService(db, {
      llm: { baseUrl: 'https://env.example.com/v1', apiKey: 'k', model: 'env-model', embeddingModel: 'e' },
    });
    assert.deepEqual(withFallback.llmStatus(), {
      envFallbackConfigured: true,
      providers: 1,
      stages: 1,
      encryptionConfigured: false,
    });
    db.close();
  });
});

test('testProvider：最小请求返回 ok/latencyMs/model，失败返回 error', async () => {
  const fake = await startFakeLlm(OPENAI_OK);
  const db = freshDb();
  const provider = createMemoryService(db).createLlmProvider(
    { name: 'Test', baseUrl: `${fake.baseUrl}/v1`, apiKey: 'sk-test', defaultModel: 'test-model' },
    ACTOR,
  );
  try {
    const ok = await testLlmProvider(db, provider.id);
    assert.equal(ok.ok, true);
    assert.equal(ok.model, 'test-model');
    assert.equal(typeof ok.latencyMs, 'number');
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]?.path, '/v1/chat/completions');
    assert.equal(fake.requests[0]?.body.max_tokens, 8);

    await fake.close();
    const failed = await testLlmProvider(db, provider.id);
    assert.equal(failed.ok, false);
    assert.equal(typeof failed.error, 'string');
    assert.ok((failed.error ?? '').length > 0);

    // 无 key 直接失败，不发请求。
    const noKey = createMemoryService(db).createLlmProvider(
      { name: 'NoKey', baseUrl: `${fake.baseUrl}/v1` },
      ACTOR,
    );
    const noKeyResult = await testLlmProvider(db, noKey.id);
    assert.equal(noKeyResult.ok, false);
    assert.match(noKeyResult.error ?? '', /API Key/);

    await assert.rejects(
      () => testLlmProvider(db, 'llm_missing'),
      (error: EngineError) => error.status === 404,
    );
  } finally {
    if (fake.requests.length === 0) await fake.close();
    // fake 可能已在上面关闭；重复 close 安全。
    db.close();
  }
});

test('brief 集成：阶段路由后 MemoryBrief.model 使用阶段模型，失败回退确定性压缩', async () => {
  const fake = await startFakeLlm({ body: { choices: [{ message: { content: '阶段润色后的简报' } }] } });
  try {
    const db = freshDb();
    const svc = createMemoryService(db);
    const provider = svc.createLlmProvider(
      { name: 'BriefProvider', baseUrl: `${fake.baseUrl}/v1`, apiKey: 'k', defaultModel: 'brief-default' },
      ACTOR,
    );
    svc.upsertLlmStage('brief', { providerId: provider.id, model: 'brief-stage-model' }, ACTOR);
    const org = 'org_llm';
    db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
      org,
      'LLM 组织',
      'llm-org',
      'enterprise',
      new Date().toISOString(),
    );
    const partition = svc.upsertPartition(org, { slug: 'llm-test', name: 'LLM 分区' }, ACTOR);
    const person = svc.upsertPerson(partition.id, { externalId: 'alice', type: 'human' }, ACTOR);
    svc.addMemory({
      partitionId: partition.id,
      actor: ACTOR,
      personId: person.id,
      content: 'Alice 偏好简洁周报',
      category: 'preference',
      scope: 'partition',
    });
    const brief = await svc.brief({ partitionId: partition.id, allowLlm: true, force: true });
    assert.equal(brief.text, '阶段润色后的简报');
    assert.equal(brief.model, 'brief-stage-model');

    // 供应商不可达：回退确定性压缩，不抛错。
    await fake.close();
    const fallback = await svc.brief({ partitionId: partition.id, allowLlm: true, force: true });
    assert.match(fallback.text, /简洁周报/);
    assert.equal(fallback.model, 'mnemos-condense');
    db.close();
  } finally {
    if (fake.requests.length === 0) await fake.close();
  }
});
