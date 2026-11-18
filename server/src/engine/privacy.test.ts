import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmConfig } from '../env.ts';
import {
  applyPrivacyToMemory,
  createMemoryService,
  maskPrivacyValue,
  processJobsAsync,
  startMemoryJobWorker,
} from './index.ts';
import { ACTOR, addMemory, count, createPerson, setup } from './test-helpers.ts';

/** v6.2 隐私规则域引擎验收：规则合并 / mask / 占位符 / prompt LLM / dream / 重扫。 */

const KEY_ENV = 'MNEMOS_ENCRYPTION_KEY';

async function withEnv<T>(key: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env[KEY_ENV];
  try {
    if (key === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = key;
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = saved;
  }
}

const FAKE_LLM: LlmConfig = {
  baseUrl: 'http://fake-llm.local',
  apiKey: 'test-key',
  model: 'fake-model',
  embeddingModel: 'fake-embedding',
};

function llmResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function withFetch<T>(handler: (body: string) => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    return handler(String(init?.body ?? ''));
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function userPrompt(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
    return parsed.messages?.find((message) => message.role === 'user')?.content ?? '';
  } catch {
    return '';
  }
}

function scanReply(entities: Array<{ code: string; value: string }>): Response {
  return llmResponse(JSON.stringify({ entities }));
}

function enablePromptRule(
  fx: ReturnType<typeof setup>,
  code: string,
  extra: Record<string, unknown> = {},
): void {
  fx.svc.createPrivacyRule(
    'partition',
    fx.partitionId,
    {
      code,
      name: `分区 ${code}`,
      kind: 'prompt',
      instruction: `抽取 ${code}`,
      enabled: true,
      priority: 100,
      ...extra,
    },
    fx.actor,
  );
}

test('privacy 规则：内置种子 + 全局/分区合并（同 code 覆盖）+ 校验/删除限制', () => {
  const fx = setup();
  const globals = fx.svc.listPrivacyRules();
  assert.equal(globals.length, 8);
  assert.deepEqual(
    globals.map((rule) => rule.code),
    ['email', 'id_card', 'phone', 'bank_card', 'name', 'address', 'credential', 'medical'],
  );
  assert.equal(globals.filter((rule) => rule.kind === 'regex').every((rule) => rule.enabled), true);
  assert.equal(globals.filter((rule) => rule.kind === 'prompt').every((rule) => !rule.enabled), true);
  assert.equal(globals.every((rule) => rule.scope === 'global' && rule.builtin), true);

  const employee = fx.svc.createPrivacyRule(
    'partition',
    fx.partitionId,
    {
      code: 'employee_id',
      name: '工号',
      kind: 'regex',
      pattern: String.raw`EMP-\d{6}`,
      action: 'mask',
      maskMode: 'keepLast',
      maskKeepLast: 2,
      priority: 5,
    },
    fx.actor,
  );
  assert.equal(employee.scope, 'partition');
  assert.equal(employee.partitionId, fx.partitionId);
  assert.equal(employee.builtin, false);

  const phoneOverride = fx.svc.createPrivacyRule(
    'partition',
    fx.partitionId,
    {
      code: 'phone',
      name: '分区手机号',
      kind: 'regex',
      pattern: String.raw`1[3-9]\d{9}`,
      action: 'placeholder',
      priority: 6,
    },
    fx.actor,
  );
  assert.equal(phoneOverride.action, 'placeholder');

  const merged = fx.svc.listPrivacyRules(fx.partitionId);
  assert.equal(merged.filter((rule) => rule.code === 'phone').length, 1);
  assert.equal(merged.find((rule) => rule.code === 'phone')?.action, 'placeholder');
  assert.equal(merged.find((rule) => rule.code === 'phone')?.name, '分区手机号');
  assert.equal(merged[0]?.code, 'employee_id');

  assert.throws(
    () =>
      fx.svc.createPrivacyRule(
        'partition',
        fx.partitionId,
        { code: 'Bad Code', name: 'bad', kind: 'regex', pattern: 'x' },
        fx.actor,
      ),
    /code/,
  );
  assert.throws(
    () =>
      fx.svc.createPrivacyRule(
        'partition',
        fx.partitionId,
        { code: 'broken_re', name: '坏正则', kind: 'regex', pattern: '(' },
        fx.actor,
      ),
    /正则/,
  );
  assert.throws(
    () =>
      fx.svc.createPrivacyRule(
        'partition',
        fx.partitionId,
        { code: 'no_instruction', name: '缺指令', kind: 'prompt' },
        fx.actor,
      ),
    /instruction/,
  );

  const email = globals.find((rule) => rule.code === 'email');
  assert.ok(email);
  assert.throws(() => fx.svc.deletePrivacyRule(email.id, fx.actor), /内置/);
  const updated = fx.svc.updatePrivacyRule(email.id, { enabled: false, action: 'placeholder' }, fx.actor);
  assert.equal(updated.enabled, false);
  assert.equal(updated.action, 'placeholder');
  assert.equal(fx.svc.listPrivacyRules(fx.partitionId).find((rule) => rule.code === 'email')?.enabled, false);

  fx.svc.deletePrivacyRule(employee.id, fx.actor);
  assert.equal(fx.svc.listPrivacyRules(fx.partitionId).some((rule) => rule.code === 'employee_id'), false);
  fx.db.close();
});

test('privacy mask：四种 maskMode 与自定义 regex 写入命中', () => {
  assert.equal(
    maskPrivacyValue('alice@example.com', { maskMode: 'email', maskKeepFirst: 0, maskKeepLast: 0 }),
    'a***@example.com',
  );
  assert.equal(
    maskPrivacyValue('110101199001011234', { maskMode: 'keepFirstLast', maskKeepFirst: 6, maskKeepLast: 4 }),
    '110101********1234',
  );
  assert.equal(
    maskPrivacyValue('13912345678', { maskMode: 'keepLast', maskKeepFirst: 3, maskKeepLast: 4 }),
    '*******5678',
  );
  assert.equal(maskPrivacyValue('secret', { maskMode: 'full', maskKeepFirst: 0, maskKeepLast: 4 }), '******');

  const fx = setup({ settings: { piiRedaction: 'basic' } });
  fx.svc.createPrivacyRule(
    'partition',
    fx.partitionId,
    {
      code: 'employee_id',
      name: '工号',
      kind: 'regex',
      pattern: String.raw`EMP-\d{6}`,
      action: 'mask',
      maskMode: 'keepLast',
      maskKeepLast: 2,
      priority: 5,
    },
    fx.actor,
  );
  const person = createPerson(fx, 'alice');
  const memory = addMemory(fx, { personId: person.id, content: '员工 EMP-123456 的工号' });
  assert.equal(memory.content, '员工 ********56 的工号');
  assert.equal(memory.metadata.piiRedacted, true);
  assert.ok(memory.privacyScannedAt);
  const events = fx.svc.memoryHistory(fx.partitionId, memory.id).map((entry) => entry.event);
  assert.ok(events.includes('PRIVACY'), JSON.stringify(events));

  // 总开关 off：不执行规则
  const off = setup();
  off.svc.createPrivacyRule(
    'partition',
    off.partitionId,
    {
      code: 'employee_id',
      name: '工号',
      kind: 'regex',
      pattern: String.raw`EMP-\d{6}`,
      action: 'mask',
      maskMode: 'keepLast',
      maskKeepLast: 2,
    },
    off.actor,
  );
  const offPerson = createPerson(off, 'bob');
  const untouched = addMemory(off, { personId: offPerson.id, content: '员工 EMP-123456 的工号' });
  assert.equal(untouched.content, '员工 EMP-123456 的工号');
  assert.equal(untouched.metadata.piiRedacted, undefined);
  assert.equal(off.svc.memoryPlaceholders(off.partitionId, untouched.id).length, 0);
  fx.db.close();
  off.db.close();
});

test('privacy 占位符：正文 token + 映射存储 + reveal + brief/context 还原（明文模式）', async () => {
  await withEnv(undefined, async () => {
    const fx = setup();
    const person = createPerson(fx, 'bob');
    const memory = addMemory(fx, {
      personId: person.id,
      content: '手机 {{phone_a1b2}}，邮箱 {{mail_c3d4}}。',
      placeholders: {
        phone_a1b2: '18334423321',
        mail_c3d4: 'zhangsan@example.com',
        unused_key: '应被忽略',
      },
    });
    assert.equal(memory.content, '手机 {{phone_a1b2}}，邮箱 {{mail_c3d4}}。');
    assert.equal(memory.metadata.placeholderCount, 2);
    assert.equal(memory.placeholderCount, 2);

    const keys = fx.svc.memoryPlaceholders(fx.partitionId, memory.id, false);
    assert.deepEqual(keys.map((item) => item.placeholder), ['phone_a1b2', 'mail_c3d4']);
    assert.equal(keys.every((item) => item.encrypted === false), true);
    assert.equal(keys.every((item) => item.value === undefined), true);
    const revealed = fx.svc.memoryPlaceholders(fx.partitionId, memory.id, true);
    assert.equal(revealed[0]?.value, '18334423321');
    assert.equal(revealed[1]?.value, 'zhangsan@example.com');
    assert.equal(fx.svc.memoryPlaceholders(fx.partitionId, memory.id).some((item) => item.placeholder === 'unused_key'), false);

    const detail = fx.svc.getMemory(fx.partitionId, memory.id);
    assert.deepEqual(detail?.placeholders?.map((item) => item.placeholder), ['phone_a1b2', 'mail_c3d4']);
    assert.equal(detail?.placeholders?.every((item) => item.value === undefined), true);

    const list = fx.svc.listMemories({ partitionId: fx.partitionId });
    assert.equal(list.items[0]?.placeholderCount, 2);
    assert.equal(JSON.stringify(list.items[0]).includes('18334423321'), false);
    const search = fx.svc.searchMemories({ partitionId: fx.partitionId, query: '手机' });
    assert.equal(JSON.stringify(search.hits).includes('18334423321'), false);

    const brief = await fx.svc.brief({ partitionId: fx.partitionId, personId: person.id, allowLlm: false });
    assert.ok(brief.text.includes('18334423321'), brief.text);
    assert.ok(brief.text.includes('zhangsan@example.com'), brief.text);
    assert.equal(brief.text.includes('{{'), false);
    const context = await fx.svc.context({ partitionId: fx.partitionId, personId: person.id });
    assert.ok(context.prompt.includes('18334423321'));
    assert.equal(context.prompt.includes('{{'), false);

    // 缺映射 / 非法 key / 非法 token
    assert.throws(
      () => addMemory(fx, { personId: person.id, content: '缺少 {{missing_key}}' }),
      /缺少映射/,
    );
    assert.throws(
      () =>
        addMemory(fx, {
          personId: person.id,
          content: '{{bad key}}',
          placeholders: { 'bad key': 'x' },
        }),
      /不合法/,
    );
    assert.throws(
      () =>
        addMemory(fx, {
          personId: person.id,
          content: '{{good_key}}',
          placeholders: { good_key: '' },
        }),
      /不能为空/,
    );
    fx.db.close();
  });
});

test('privacy 占位符：配置密钥后 AES-256-GCM 落库并可解密', async () => {
  await withEnv('privacy-test-encryption-key', async () => {
    const fx = setup();
    const person = createPerson(fx, 'carol');
    const memory = addMemory(fx, {
      personId: person.id,
      content: '卡号 {{card_x9y8}}',
      placeholders: { card_x9y8: '6222021234567890123' },
    });
    const row = fx.db
      .prepare('SELECT value_cipher, encrypted FROM memory_placeholders WHERE memory_id = ?')
      .get(memory.id) as unknown as { value_cipher: string; encrypted: number };
    assert.equal(row.encrypted, 1);
    assert.ok(row.value_cipher.startsWith('v1:'));
    assert.equal(row.value_cipher.includes('6222021234567890123'), false);

    const listed = fx.svc.memoryPlaceholders(fx.partitionId, memory.id, false);
    assert.equal(listed[0]?.encrypted, true);
    assert.equal(listed[0]?.value, undefined);
    const revealed = fx.svc.memoryPlaceholders(fx.partitionId, memory.id, true);
    assert.equal(revealed[0]?.value, '6222021234567890123');

    const brief = await fx.svc.brief({ partitionId: fx.partitionId, personId: person.id, allowLlm: false });
    assert.ok(brief.text.includes('6222021234567890123'));
    fx.db.close();
  });
});

test('privacy prompt 规则：fake LLM 抽取 + 幻觉过滤 + 失败回退 + 幂等', async () => {
  const fx = setup({ settings: { piiRedaction: 'basic', privacyLlmEnabled: true } });
  enablePromptRule(fx, 'name', {
    action: 'mask',
    maskMode: 'keepFirstLast',
    maskKeepFirst: 1,
    maskKeepLast: 1,
  });
  const person = createPerson(fx, 'alice');
  const memory = addMemory(fx, {
    personId: person.id,
    content: '张三说项目下周上线，电话 13912345678',
  });
  assert.ok(memory.content.includes('张三'));
  assert.ok(memory.content.includes('139****5678'));
  assert.equal(fx.svc.listPrivacyRules(fx.partitionId).find((rule) => rule.code === 'name')?.enabled, true);

  const worker = startMemoryJobWorker({ db: fx.db, llm: FAKE_LLM, tickMs: 60_000, batchSize: 20 });
  let result;
  try {
    result = await withFetch(
      (body) => {
        const prompt = userPrompt(body);
        if (prompt.includes('待扫描文本')) {
          return scanReply([
            { code: 'name', value: '张三' },
            { code: 'name', value: '李四' }, // 幻觉：原文没有，必须丢弃
          ]);
        }
        return llmResponse('- 洞见');
      },
      () => worker.tickAsync(),
    );
  } finally {
    worker.stop();
  }
  assert.ok(result.processed >= 1, JSON.stringify(result));

  const detail = fx.svc.getMemory(fx.partitionId, memory.id);
  assert.equal(detail?.memory.content.includes('张三'), false);
  assert.ok(detail?.memory.content.includes('张*'), detail?.memory.content);
  assert.equal(detail?.memory.content.includes('李四'), false);
  assert.equal(detail?.memory.metadata.piiRedacted, true);
  const events = fx.svc.memoryHistory(fx.partitionId, memory.id).map((entry) => entry.event);
  assert.ok(events.includes('PRIVACY'));

  // 幂等：已打码正文不再命中；再次扫描不产生变更
  const again = await withFetch(
    (body) => (userPrompt(body).includes('待扫描文本') ? scanReply([{ code: 'name', value: '张*' }]) : llmResponse('-')),
    () =>
      applyPrivacyToMemory(fx.db, FAKE_LLM, fx.partitionId, memory.id, {
        reason: 'privacy:job',
        allowPrompt: true,
      }),
  );
  assert.equal(again.changed, false);

  // LLM 失败：回退 regex（手机号已由写入路径处理，姓名保持原样）
  const fx2 = setup({ settings: { piiRedaction: 'basic', privacyLlmEnabled: true } });
  enablePromptRule(fx2, 'name');
  const person2 = createPerson(fx2, 'bob');
  const memory2 = addMemory(fx2, { personId: person2.id, content: '王五电话 13812345678' });
  await withFetch(
    () => {
      throw new Error('llm down');
    },
    () => processJobsAsync(fx2.db, FAKE_LLM, { limit: 20 }),
  );
  const fallback = fx2.svc.getMemory(fx2.partitionId, memory2.id)?.memory;
  assert.ok(fallback?.content.includes('王五'));
  assert.ok(fallback?.content.includes('138****5678'));
  fx.db.close();
  fx2.db.close();
});

test('privacy dream：批次输入被 regex+LLM 扫描、history PRIVACY、summary 统计', async () => {
  const fx = setup();
  const person = createPerson(fx, 'dora');
  const memory = addMemory(fx, {
    personId: person.id,
    content: '张三住在北京市朝阳区建国路88号',
    scope: 'person',
  });
  assert.ok(memory.content.includes('张三'));

  fx.svc.updatePartition(
    fx.orgId,
    fx.partitionId,
    { settings: { piiRedaction: 'basic', privacyLlmEnabled: true } },
    fx.actor,
  );
  enablePromptRule(fx, 'name', {
    action: 'mask',
    maskMode: 'keepFirstLast',
    maskKeepFirst: 1,
    maskKeepLast: 1,
  });
  enablePromptRule(fx, 'address', { action: 'mask', maskMode: 'full' });

  const result = await withFetch(
    (body) => {
      const prompt = userPrompt(body);
      if (prompt.includes('待扫描文本')) {
        return scanReply([
          { code: 'name', value: '张三' },
          { code: 'address', value: '北京市朝阳区建国路88号' },
        ]);
      }
      return llmResponse('- 洞见：用户位于北京');
    },
    () =>
      createMemoryService(fx.db, { llm: FAKE_LLM }).dream(
        { partitionId: fx.partitionId, personId: person.id, trigger: 'manual', batchSize: 10 },
        fx.actor,
      ),
  );

  assert.ok((result.privacyRedacted ?? 0) >= 1);
  assert.ok((result.privacyHits ?? 0) >= 2);
  assert.ok(result.run?.summary?.includes('隐私脱敏'), result.run?.summary);
  const updated = fx.svc.getMemory(fx.partitionId, memory.id)?.memory;
  assert.equal(updated?.content.includes('张三'), false);
  assert.equal(updated?.content.includes('北京市朝阳区建国路88号'), false);
  const events = fx.svc.memoryHistory(fx.partitionId, memory.id).map((entry) => entry.event);
  assert.ok(events.includes('PRIVACY'), JSON.stringify(events));
  assert.ok(updated?.privacyScannedAt);
  fx.db.close();
});

test('privacy 重扫：开关打开后补扫历史记忆并写审计', async () => {
  const fx = setup();
  const person = createPerson(fx, 'erin');
  const memory = addMemory(fx, { personId: person.id, content: '电话 13812345678' });
  assert.ok(memory.content.includes('13812345678'));

  fx.svc.updatePartition(fx.orgId, fx.partitionId, { settings: { piiRedaction: 'basic' } }, fx.actor);
  const result = await fx.svc.rescanPrivacy?.(fx.partitionId, { limit: 10 }, fx.actor);
  assert.equal(result?.scanned, 1);
  assert.equal(result?.changed, 1);
  assert.ok((result?.hits ?? 0) >= 1);
  const updated = fx.svc.getMemory(fx.partitionId, memory.id)?.memory;
  assert.equal(updated?.content.includes('13812345678'), false);
  assert.ok(updated?.content.includes('138****5678'));
  assert.equal(
    count(fx.db, 'SELECT COUNT(*) FROM audit_logs WHERE action = ?', 'memory.privacy.scan'),
    1,
  );
  fx.db.close();
});
