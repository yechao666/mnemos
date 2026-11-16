/**
 * 记忆简报（brief）单元测试：确定性压缩、缓存失效、可见性、设置校验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_PROJECT_SETTINGS } from '../../../shared/src/constants.ts';
import { buildBriefText } from './brief.ts';
import { addMemory, setup } from './test-helpers.ts';

function parseProjectSettings(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test('brief：空项目返回空文本，count=0，不注入内容', async () => {
  const fx = setup();
  const brief = await fx.svc.brief({ projectId: fx.projectId, includePrivate: true });

  assert.equal(brief.text, '');
  assert.equal(brief.count, 0);
  assert.deepEqual(brief.recent, []);
  assert.equal(brief.cached, false);
  assert.equal(brief.maxChars, DEFAULT_PROJECT_SETTINGS.briefMaxChars);
  assert.ok(brief.generatedAt);
});

test('brief：包含最近记忆，文本长度不超过 maxChars', async () => {
  const fx = setup();
  for (let index = 0; index < 3; index++) {
    await addMemory(fx, {
      text: `记忆 ${index}：项目统一使用 TypeScript 与 node:sqlite，保持离线可运行。`.repeat(2),
      infer: false,
      metadata: { category: 'fact' },
    });
  }

  const brief = await fx.svc.brief({ projectId: fx.projectId, includePrivate: true, maxChars: 260 });

  assert.equal(brief.maxChars, 260);
  assert.ok(brief.count >= 1);
  assert.ok(brief.text.startsWith('# 记忆简报（最近记忆与洞见）'));
  assert.ok(brief.text.length <= 260, `简报长度 ${brief.text.length} 超过 260`);
  assert.equal(brief.recent.length, brief.count);
  assert.equal(brief.model, 'mnemos-condense');
  assert.ok(brief.recent.every((item) => typeof item.id === 'string' && item.updatedAt.length > 0));
});

test('brief：缓存命中 cached=true，写入新记忆后重新生成', async () => {
  const fx = setup();
  await addMemory(fx, { text: '项目使用 SQLite 作为默认存储引擎。', infer: false });
  await addMemory(fx, { text: '检索默认返回 topK=8 条结果。', infer: false });

  const first = await fx.svc.brief({ projectId: fx.projectId, includePrivate: true });
  const second = await fx.svc.brief({ projectId: fx.projectId, includePrivate: true });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.equal(second.generatedAt, first.generatedAt);

  await addMemory(fx, { text: '新增记忆：做梦会把新记忆巩固为洞见。', infer: false });
  const third = await fx.svc.brief({ projectId: fx.projectId, includePrivate: true });

  assert.equal(third.cached, false);
  assert.ok(third.recent.some((item) => item.content.includes('做梦会把新记忆巩固为洞见')));

  // 强制刷新也必须重新生成
  const forced = await fx.svc.brief({ projectId: fx.projectId, includePrivate: true, force: true });
  assert.equal(forced.cached, false);
});

test('brief：可见性过滤（项目共享 / 本人私有 / 他人私有 / 控制台全量）', async () => {
  const fx = setup();
  await addMemory(fx, { text: '项目共享记忆：使用 TypeScript 原生运行。', infer: false, visibility: 'project' });
  await addMemory(fx, {
    text: 'Agent A 私有笔记：本地复现了 SQLite 锁冲突。',
    infer: false,
    agentId: 'agent_a',
    visibility: 'agent',
  });

  const sharedOnly = await fx.svc.brief({ projectId: fx.projectId, includePrivate: false, force: true });
  assert.ok(sharedOnly.text.includes('项目共享记忆'));
  assert.ok(!sharedOnly.text.includes('私有笔记'));

  const own = await fx.svc.brief({
    projectId: fx.projectId,
    agentId: 'agent_a',
    includePrivate: false,
    force: true,
  });
  assert.ok(own.text.includes('私有笔记'), 'Agent 本人应能看到自己的私有记忆');

  const other = await fx.svc.brief({
    projectId: fx.projectId,
    agentId: 'agent_b',
    includePrivate: false,
    force: true,
  });
  assert.ok(!other.text.includes('私有笔记'), '其他 Agent 不应看到 agent_a 的私有记忆');

  const consoleView = await fx.svc.brief({ projectId: fx.projectId, includePrivate: true, force: true });
  assert.ok(consoleView.text.includes('私有笔记'));
  assert.ok(consoleView.text.includes('项目共享记忆'));
});

test('updateBriefSettings：落库、保留其他设置、越界 clamp', async () => {
  const fx = setup({ settings: { topK: 12, locale: 'zh-CN' } });

  const lowered = await fx.svc.updateBriefSettings(fx.projectId, 40, fx.actor);
  assert.equal(lowered.maxChars, 100, '低于下限应 clamp 到 100');
  const afterLow = fx.db.prepare('SELECT settings FROM projects WHERE id = ?').get(fx.projectId) as unknown as {
    settings: string;
  };
  const settingsLow = parseProjectSettings(afterLow.settings);
  assert.equal(settingsLow.briefMaxChars, 100);
  assert.equal(settingsLow.topK, 12, '其他设置字段必须保留');
  assert.equal(settingsLow.locale, 'zh-CN');

  const raised = await fx.svc.updateBriefSettings(fx.projectId, 99_999, fx.actor);
  assert.equal(raised.maxChars, 5000, '高于上限应 clamp 到 5000');
  const afterHigh = fx.db.prepare('SELECT settings FROM projects WHERE id = ?').get(fx.projectId) as unknown as {
    settings: string;
  };
  assert.equal(parseProjectSettings(afterHigh.settings).briefMaxChars, 5000);
});

test('brief：确定性压缩在相同数据下稳定，且类别使用中文标签', async () => {
  const fx = setup();
  await addMemory(fx, { text: '洞察：合并重复记忆可以降低注入噪声。', infer: false, metadata: { category: 'insight' } });
  await addMemory(fx, { text: '约定：所有 SQL 使用参数化 prepared statement。', infer: false, metadata: { category: 'constraint' } });

  const first = buildBriefText(fx.db, fx.projectId, { maxChars: 500, includePrivate: true });
  const second = buildBriefText(fx.db, fx.projectId, { maxChars: 500, includePrivate: true });

  assert.deepEqual(second, first);
  assert.ok(first.text.includes('[洞见]'));
  assert.ok(first.text.includes('[约束]'));
  assert.ok(first.count >= 2);
});

test('briefing：briefEnabled 开启时注入记忆简报段落并返回 brief 快照', async () => {
  const fx = setup();
  await addMemory(fx, {
    text: '约定：所有服务端代码必须通过 typecheck。',
    infer: false,
    metadata: { category: 'constraint' },
  });

  const briefing = await fx.svc.briefing({ projectId: fx.projectId });
  assert.ok(briefing.brief, '开启 briefEnabled 时应返回 brief');
  assert.equal(briefing.brief?.count, 1);
  assert.equal(briefing.brief?.maxChars, DEFAULT_PROJECT_SETTINGS.briefMaxChars);
  assert.ok(briefing.prompt.includes('## 记忆简报（最近记忆与洞见）'));
  assert.ok(briefing.prompt.includes('所有服务端代码必须通过 typecheck'));
  // 段落顺序：当前任务之后、进行中任务之前
  assert.ok(
    briefing.prompt.indexOf('## 记忆简报') < briefing.prompt.indexOf('## 进行中任务'),
    '记忆简报应位于进行中任务之前',
  );

  const disabled = setup({ slug: 'brief-off', settings: { briefEnabled: false } });
  await addMemory(disabled, { text: '关闭简报项目的记忆不应出现在 prompt 中。', infer: false });
  const withoutBrief = await disabled.svc.briefing({ projectId: disabled.projectId });
  assert.equal(withoutBrief.brief, undefined);
  assert.ok(!withoutBrief.prompt.includes('## 记忆简报'));
});

