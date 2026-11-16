/**
 * 记忆做梦（dream）单元测试：增量批次、洞见写入、去重、设置校验、调度到期与失败分支。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CATEGORY_LABEL } from '../../../shared/src/constants.ts';
import { dueDreamProjects, getDreamStatus, runDream, type DreamDeps } from './dream.ts';
import { addMemory, setup } from './test-helpers.ts';

function depsOf(fx: ReturnType<typeof setup>): DreamDeps {
  return { db: fx.db, addMemory: (input) => fx.svc.add(input) };
}

function count(fx: ReturnType<typeof setup>, where: string, ...params: string[]): number {
  const row = fx.db
    .prepare(`SELECT COUNT(*) AS c FROM memories WHERE project_id = ?${where}`)
    .get(fx.projectId, ...params) as unknown as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

test('dream：没有新记忆时返回 skipped 并记录运行', async () => {
  const fx = setup();
  const run = await runDream(depsOf(fx), fx.projectId, 'manual');

  assert.ok(run);
  assert.equal(run?.status, 'skipped');
  assert.equal(run?.summary, '没有需要整理的新记忆');
  assert.equal(run?.inputCount, 0);
  assert.equal(run?.insightCount, 0);
  assert.ok(run?.finishedAt);

  const status = getDreamStatus(fx.db, fx.projectId);
  assert.equal(status.runs.length, 1);
  assert.equal(status.lastRun?.id, run?.id);
  assert.equal(status.pendingCount, 0);
});

test('dream：有记忆时 completed，写入 insight 记忆并把批次标记为已做梦', async () => {
  const fx = setup({ settings: { dreamEnabled: true, dreamIntervalMinutes: 60 } });
  await addMemory(fx, {
    text: '决策：支付回调先写幂等表再发货，失败重试进入死信队列。',
    infer: false,
    metadata: { category: 'fact' },
  });
  await addMemory(fx, {
    text: '经验：SQLite 写入要控制事务大小，避免长事务长时间持有写锁。',
    infer: false,
    metadata: { category: 'constraint' },
  });

  const before = getDreamStatus(fx.db, fx.projectId);
  assert.equal(before.pendingCount, 2);
  assert.equal(before.runs.length, 0);

  const run = await runDream(depsOf(fx), fx.projectId, 'manual');
  assert.ok(run);
  assert.equal(run?.status, 'completed');
  assert.equal(run?.inputCount, 2);
  assert.ok((run?.insightCount ?? 0) >= 1);
  assert.ok(run?.summary && run.summary.length > 0);
  assert.ok(run?.finishedAt);

  const insights = fx.db
    .prepare("SELECT * FROM memories WHERE project_id = ? AND source = 'dream' AND category = 'insight'")
    .all(fx.projectId) as unknown as Array<{ id: string; content: string; dreamed_at: string | null; metadata: string }>;
  assert.equal(insights.length, run?.insightCount);
  assert.ok(insights.length >= 1);
  for (const row of insights) {
    assert.ok(row.dreamed_at, '洞见自身也必须标记 dreamed_at');
    assert.ok(row.content.length >= 20);
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.equal(metadata.category, 'insight');
    assert.equal(metadata.dreamRunId, run?.id);
    assert.ok(Array.isArray(metadata.sourceMemoryIds) && metadata.sourceMemoryIds.length === 2);
    assert.ok(typeof metadata.dreamTitle === 'string');
  }

  // 批次记忆全部标记 dreamed_at，pending 归零
  assert.equal(count(fx, " AND status = 'active' AND dreamed_at IS NULL AND category != 'insight'"), 0);
  const after = getDreamStatus(fx.db, fx.projectId);
  assert.equal(after.pendingCount, 0);
  assert.equal(after.lastRun?.id, run?.id);
  assert.equal(after.runs.length, 1);
});

test('dream：相同内容的洞见不会重复写入', async () => {
  const fx = setup();
  const sourceContent = '项目默认使用 SQLite 与 node:sqlite，保持离线可运行。';
  await addMemory(fx, { text: sourceContent, infer: false, metadata: { category: 'fact' } });

  // 预先写入与确定性回退洞见完全相同的记忆（模拟上一轮已生成过），并标记为已做梦。
  const expectedInsight = `[${CATEGORY_LABEL.fact}] ${sourceContent}`;
  await addMemory(fx, { text: expectedInsight, infer: false, metadata: { category: 'fact' } });
  fx.db.prepare('UPDATE memories SET dreamed_at = ? WHERE project_id = ? AND content = ?').run(
    new Date().toISOString(),
    fx.projectId,
    expectedInsight,
  );

  const before = count(fx, " AND category = 'insight'");
  assert.equal(before, 0);

  const run = await runDream(depsOf(fx), fx.projectId, 'manual');
  assert.equal(run?.status, 'completed');
  assert.equal(run?.inputCount, 1);
  assert.equal(run?.insightCount, 0, '相同内容应跳过');
  assert.equal(run?.summary, '本批没有形成有效洞见');
  assert.equal(count(fx, " AND category = 'insight'"), 0);

  // 即便没写入洞见，批次也要标记为已做梦，避免反复重试。
  const row = fx.db
    .prepare('SELECT dreamed_at FROM memories WHERE project_id = ? AND content = ?')
    .get(fx.projectId, sourceContent) as unknown as { dreamed_at: string | null };
  assert.ok(row.dreamed_at);
  assert.equal(getDreamStatus(fx.db, fx.projectId).pendingCount, 0);
});

test('updateDreamSettings：区间校验抛错，合法值落库并保留其他设置', async () => {
  const fx = setup({ settings: { topK: 7 } });

  await assert.rejects(
    () => fx.svc.updateDreamSettings(fx.projectId, { intervalMinutes: 0 }, fx.actor),
    /复盘总结间隔/,
  );
  await assert.rejects(
    () => fx.svc.updateDreamSettings(fx.projectId, { intervalMinutes: 43_201 }, fx.actor),
    /复盘总结间隔/,
  );

  const status = await fx.svc.updateDreamSettings(
    fx.projectId,
    { enabled: false, intervalMinutes: 30 },
    fx.actor,
  );
  assert.equal(status.settings.enabled, false);
  assert.equal(status.settings.intervalMinutes, 30);

  const row = fx.db.prepare('SELECT settings FROM projects WHERE id = ?').get(fx.projectId) as unknown as {
    settings: string;
  };
  const settings = JSON.parse(row.settings) as Record<string, unknown>;
  assert.equal(settings.dreamEnabled, false);
  assert.equal(settings.dreamIntervalMinutes, 30);
  assert.equal(settings.topK, 7, '其他设置必须保留');

  // 关闭后不参与调度
  await addMemory(fx, { text: '关闭做梦后的新记忆不应进入调度批次。', infer: false });
  assert.deepEqual(dueDreamProjects(fx.db), []);
});

test('dream：只巩固项目共享记忆，Agent 私有 / 任务记忆不参与', async () => {
  const fx = setup({ settings: { dreamEnabled: true } });
  await addMemory(fx, { text: '项目共享：API 网关统一走 mTLS 双向认证。', infer: false, visibility: 'project' });
  await addMemory(fx, {
    text: 'Agent A 私有笔记：本地调试时临时关闭了鉴权。',
    infer: false,
    agentId: 'agent_a',
    visibility: 'agent',
  });
  await addMemory(fx, {
    text: '任务私有记录：本次任务的临时排查过程。',
    infer: false,
    taskId: 'task_x',
    visibility: 'task',
  });

  assert.equal(getDreamStatus(fx.db, fx.projectId).pendingCount, 1, '私有/任务记忆不计入 pending');
  assert.deepEqual(dueDreamProjects(fx.db), [fx.projectId]);

  const run = await runDream(depsOf(fx), fx.projectId, 'manual');
  assert.equal(run?.status, 'completed');
  assert.equal(run?.inputCount, 1, '批次只包含项目共享记忆');

  const insights = fx.db
    .prepare("SELECT content FROM memories WHERE project_id = ? AND category = 'insight'")
    .all(fx.projectId) as unknown as Array<{ content: string }>;
  assert.ok(insights.length >= 1);
  for (const row of insights) {
    assert.ok(!row.content.includes('临时关闭了鉴权'), '私有内容不得进入洞见');
    assert.ok(!row.content.includes('临时排查过程'), '任务内容不得进入洞见');
  }

  for (const visibility of ['agent', 'task']) {
    const row = fx.db
      .prepare('SELECT dreamed_at FROM memories WHERE project_id = ? AND visibility = ?')
      .get(fx.projectId, visibility) as unknown as { dreamed_at: string | null };
    assert.equal(row.dreamed_at, null, `${visibility} 记忆不应被标记为已做梦`);
  }
});

test('dream：不足 10 字的记忆不计入 pending，也不触发调度', async () => {
  const fx = setup({ settings: { dreamEnabled: true } });
  await addMemory(fx, { text: '收到', infer: false });

  assert.equal(getDreamStatus(fx.db, fx.projectId).pendingCount, 0);
  assert.deepEqual(dueDreamProjects(fx.db), [], '只有短记忆时不应被调度');

  const run = await runDream(depsOf(fx), fx.projectId, 'manual');
  assert.equal(run?.status, 'skipped');
});

test('dueDreamProjects：归档/暂停项目不再参与调度', async () => {
  const fx = setup({ settings: { dreamEnabled: true } });
  await addMemory(fx, { text: '归档项目待处理记忆：不应继续被调度。', infer: false });
  assert.deepEqual(dueDreamProjects(fx.db), [fx.projectId]);

  fx.db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(fx.projectId);
  assert.deepEqual(dueDreamProjects(fx.db), [], '归档项目不再做梦');

  fx.db.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run(fx.projectId);
  assert.deepEqual(dueDreamProjects(fx.db), [], '暂停项目不再做梦');
});

test('dueDreamProjects：无待处理/未到期/已到期三种情况', async () => {
  const fx = setup({ settings: { dreamEnabled: true, dreamIntervalMinutes: 60 } });
  assert.deepEqual(dueDreamProjects(fx.db), [], '没有待处理记忆时不到期');

  await addMemory(fx, { text: '第一条待处理的记忆：需要被巩固成洞见。', infer: false });
  assert.deepEqual(dueDreamProjects(fx.db), [fx.projectId], '存在待处理记忆且从未运行 → 到期');

  await runDream(depsOf(fx), fx.projectId, 'manual');
  await addMemory(fx, { text: '第二条待处理的记忆：间隔未到不应立刻运行。', infer: false });
  assert.deepEqual(dueDreamProjects(fx.db), [], '刚运行过且间隔未到 → 不到期');

  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  fx.db.prepare('UPDATE memory_dream_runs SET started_at = ? WHERE project_id = ?').run(twoHoursAgo, fx.projectId);
  assert.deepEqual(dueDreamProjects(fx.db), [fx.projectId], '超过 intervalMinutes → 到期');

  // 关闭做梦的项目永不参与调度
  const disabled = setup({ slug: 'disabled', settings: { dreamEnabled: false } });
  await addMemory(disabled, { text: '关闭做梦的项目记忆不应被调度。', infer: false });
  assert.deepEqual(dueDreamProjects(disabled.db), []);
});

test('dream：并发时第二次返回 null，完成后可再次运行', async () => {
  const fx = setup();
  await addMemory(fx, { text: '并发测试记忆：一次只允许一个做梦任务。', infer: false });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: DreamDeps = {
    db: fx.db,
    addMemory: async (input) => {
      await gate;
      return fx.svc.add(input);
    },
  };

  const firstPromise = runDream(slow, fx.projectId, 'manual');
  const second = await runDream(depsOf(fx), fx.projectId, 'manual');
  assert.equal(second, null, '正在做梦时应返回 null');

  release();
  const first = await firstPromise;
  assert.equal(first?.status, 'completed');

  const third = await runDream(depsOf(fx), fx.projectId, 'manual');
  assert.ok(third, '上一次结束后应可再次运行');
  assert.equal(third?.status, 'skipped');
});

test('dream：addMemory 抛错时 schedule 记 failed 不抛，manual 重抛', async () => {
  const fx = setup();
  await addMemory(fx, { text: '失败分支测试记忆：addMemory 会主动抛错。', infer: false });

  const failing: DreamDeps = {
    db: fx.db,
    addMemory: async () => {
      throw new Error('boom-add');
    },
  };

  const scheduled = await runDream(failing, fx.projectId, 'schedule');
  assert.equal(scheduled?.status, 'failed');
  assert.match(scheduled?.error ?? '', /boom-add/);
  assert.ok(scheduled?.finishedAt);

  await assert.rejects(() => runDream(failing, fx.projectId, 'manual'), /boom-add/);

  const status = getDreamStatus(fx.db, fx.projectId);
  assert.equal(status.runs[0]?.status, 'failed');
  assert.match(status.runs[0]?.error ?? '', /boom-add/);
});
