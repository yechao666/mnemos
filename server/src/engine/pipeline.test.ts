import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddMemoryInput } from '../../../shared/src/types.ts';
import { blobToEmbedding } from './embed.ts';
import {
  enqueueJob,
  processJobs,
  startMemoryJobWorker,
} from './jobs.ts';
import { addMemory, count, createPerson, setup, type Fixture } from './test-helpers.ts';

/**
 * v6.1 P0 写管线验收：NOOP / MERGE / SUPERSEDE / HISTORY / FEEDBACK / 异步任务。
 * 所有写入场景都通过 MemoryService（与 HTTP 层一致）而非直接 SQL。
 */

function add(fx: Fixture, input: Omit<AddMemoryInput, 'partitionId' | 'actor'>) {
  return fx.svc.addMemoryResult({ partitionId: fx.partitionId, actor: fx.actor, ...input });
}

test('写管线：完全重复 → NOOP，返回已有记忆并写 NOOP history', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  const first = add(fx, { personId: person.id, content: 'Alice 喜欢美式咖啡', scope: 'partition' });
  assert.equal(first.event, 'ADD');

  const second = add(fx, { personId: person.id, content: '  Alice 喜欢美式咖啡。 ', scope: 'partition' });
  assert.equal(second.event, 'NOOP');
  assert.equal(second.memory.id, first.memory.id);
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId }).items.length, 1);

  const history = fx.svc.memoryHistory(fx.partitionId, first.memory.id);
  assert.equal(history[0]?.event, 'NOOP');
  assert.ok(history.some((entry) => entry.event === 'ADD'));
  fx.db.close();
});

test('写管线：高相似 → MERGE（内容/重要度/标签/metadata + history MERGE）', () => {
  const fx = setup({ settings: { mergeThreshold: 0.85, dedupeThreshold: 0.995 } });
  const person = createPerson(fx, 'alice');
  const first = add(fx, {
    personId: person.id,
    content: 'Alice 喜欢美式咖啡',
    scope: 'partition',
    importance: 0.4,
    tags: ['drink'],
    metadata: { source: 'chat' },
  });
  const merged = add(fx, {
    personId: person.id,
    content: 'Alice 很喜欢喝美式咖啡',
    scope: 'partition',
    importance: 0.8,
    tags: ['coffee'],
    metadata: { channel: 'app' },
  });
  assert.equal(merged.event, 'MERGE');
  assert.equal(merged.memory.id, first.memory.id);
  assert.equal(merged.memory.content, 'Alice 很喜欢喝美式咖啡');
  assert.equal(merged.memory.importance, 0.8);
  assert.deepEqual([...merged.memory.tags].sort(), ['coffee', 'drink']);
  assert.equal(merged.memory.metadata.source, 'chat');
  assert.equal(merged.memory.metadata.channel, 'app');
  assert.equal(fx.svc.listMemories({ partitionId: fx.partitionId }).items.length, 1);

  const events = fx.svc.memoryHistory(fx.partitionId, first.memory.id).map((entry) => entry.event);
  assert.ok(events.includes('MERGE'));
  fx.db.close();
});

test('写管线：显式 supersedesId 与相同 factKey 取代旧记忆', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  const old = add(fx, { personId: person.id, content: 'Alice 偏好中文回答', scope: 'partition' });
  const fresh = add(fx, {
    personId: person.id,
    content: 'Alice 偏好英文回答',
    scope: 'partition',
    supersedesId: old.memory.id,
  });
  assert.equal(fresh.event, 'SUPERSEDE');
  assert.equal(fresh.memory.supersedes, old.memory.id);
  const oldDetail = fx.svc.getMemory(fx.partitionId, old.memory.id);
  assert.ok(oldDetail?.memory.validTo);
  assert.equal(oldDetail?.memory.supersededBy, fresh.memory.id);
  assert.ok(fx.svc.memoryHistory(fx.partitionId, old.memory.id).some((entry) => entry.event === 'SUPERSEDE'));

  // factKey 自动取代：新写入无需显式 supersedesId
  const zh = add(fx, {
    personId: person.id,
    content: 'Alice 的语言偏好是中文',
    scope: 'partition',
    factKey: 'preference.language',
  });
  const en = add(fx, {
    personId: person.id,
    content: 'Alice 的语言偏好是英文',
    scope: 'partition',
    factKey: 'preference.language',
  });
  assert.equal(en.event, 'SUPERSEDE');
  assert.equal(en.supersededId, zh.memory.id);
  assert.ok(fx.svc.getMemory(fx.partitionId, zh.memory.id)?.memory.validTo);
  fx.db.close();
});

test('写管线：update / remove 写 history', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  const created = add(fx, { personId: person.id, content: '旧内容', scope: 'partition' });

  const updated = fx.svc.updateMemory(fx.partitionId, created.memory.id, { content: '新内容拿铁' }, fx.actor);
  assert.equal(updated.content, '新内容拿铁');
  const updateHistory = fx.svc.memoryHistory(fx.partitionId, created.memory.id);
  const updateEntry = updateHistory.find((entry) => entry.event === 'UPDATE');
  assert.equal(updateEntry?.oldContent, '旧内容');
  assert.equal(updateEntry?.newContent, '新内容拿铁');

  fx.svc.removeMemory(fx.partitionId, created.memory.id, fx.actor);
  assert.equal(fx.svc.getMemory(fx.partitionId, created.memory.id), null);
  const afterRemove = fx.db
    .prepare("SELECT event FROM memory_history WHERE memory_id = ? ORDER BY created_at DESC")
    .all(created.memory.id) as unknown as { event: string }[];
  assert.ok(afterRemove.some((entry) => entry.event === 'DELETE'));
  fx.db.close();
});

test('反馈：helpful/down 计数与 confidence ±0.05，写 FEEDBACK history', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  const created = add(fx, { personId: person.id, content: 'Alice 喜欢简洁周报', scope: 'partition' });

  let memory = fx.svc.feedback(fx.partitionId, created.memory.id, { helpful: true, query: '周报' }, fx.actor);
  assert.equal(memory.feedbackUp, 1);
  assert.equal(memory.confidence, 0.85);
  memory = fx.svc.feedback(fx.partitionId, created.memory.id, { helpful: true }, fx.actor);
  assert.equal(memory.feedbackUp, 2);
  assert.equal(memory.confidence, 0.9);
  memory = fx.svc.feedback(fx.partitionId, created.memory.id, { helpful: false, reason: '过时' }, fx.actor);
  assert.equal(memory.feedbackDown, 1);
  assert.equal(memory.confidence, 0.85);

  const feedbackRows = count(fx.db, 'SELECT COUNT(*) FROM memory_feedback WHERE memory_id = ?', created.memory.id);
  assert.equal(feedbackRows, 3);
  const events = fx.svc.memoryHistory(fx.partitionId, created.memory.id).map((entry) => entry.event);
  assert.equal(events.filter((event) => event === 'FEEDBACK').length, 3);
  fx.db.close();
});

test('异步任务：extract/embed/profile 入队并执行；失败退避到 failed', () => {
  const fx = setup();
  const person = createPerson(fx, 'alice');
  const created = add(fx, {
    personId: person.id,
    content: 'Alice 在「字节跳动」负责检索',
    scope: 'partition',
    factKey: 'person.company',
  });
  const queued = count(fx.db, 'SELECT COUNT(*) FROM memory_jobs WHERE status = ?', 'pending');
  assert.ok(queued >= 2, `应入队 extract/profile，实际 ${queued}`);

  const firstTick = processJobs(fx.db, { limit: 10 });
  assert.ok(firstTick.processed >= 2);
  assert.ok(count(fx.db, 'SELECT COUNT(*) FROM entities') >= 1);
  assert.equal(
    count(fx.db, 'SELECT COUNT(*) FROM entities WHERE partition_id = ? AND name = ?', fx.partitionId, '字节跳动'),
    1,
  );
  assert.equal(count(fx.db, 'SELECT COUNT(*) FROM person_facts WHERE person_id = ?', person.id), 1);
  assert.ok(count(fx.db, 'SELECT COUNT(*) FROM person_profiles WHERE person_id = ?', person.id) >= 1);

  // embed：清空后手动入队，worker tick 立即执行
  fx.db.prepare('UPDATE memories SET embedding = NULL, embedding_model = NULL, dim = NULL WHERE id = ?').run(
    created.memory.id,
  );
  const jobId = enqueueJob(fx.db, {
    partitionId: fx.partitionId,
    type: 'embed',
    payload: { memoryId: created.memory.id },
  });
  const worker = startMemoryJobWorker({ db: fx.db, tickMs: 1_000 });
  try {
    const result = worker.tick();
    assert.ok(result.processed >= 1);
  } finally {
    worker.stop();
  }
  const row = fx.db.prepare('SELECT embedding, normalized_hash FROM memories WHERE id = ?').get(created.memory.id) as unknown as {
    embedding: Uint8Array | null;
    normalized_hash: string | null;
  };
  assert.ok(row.embedding && row.embedding.length > 0);
  assert.ok(blobToEmbedding(row.embedding));
  assert.ok(row.normalized_hash);
  assert.equal(
    count(fx.db, 'SELECT COUNT(*) FROM memory_jobs WHERE id = ? AND status = ?', jobId, 'done'),
    1,
  );

  // 失败任务：重试一次后进入退避；持续推进 now 直到 attempts 用尽 → failed
  const badJob = enqueueJob(fx.db, {
    partitionId: fx.partitionId,
    type: 'embed',
    payload: { memoryId: 'mem_missing' },
  });
  const firstAttempt = processJobs(fx.db, { limit: 10 });
  assert.equal(firstAttempt.requeued, 1);
  const retryRow = fx.db.prepare('SELECT status, attempts, run_after FROM memory_jobs WHERE id = ?').get(badJob) as unknown as {
    status: string;
    attempts: number;
    run_after: string;
  };
  assert.equal(retryRow.status, 'pending');
  assert.equal(retryRow.attempts, 1);
  assert.ok(Date.parse(retryRow.run_after) > Date.now() - 1_000);

  let guard = 0;
  while (guard < 10) {
    const result = processJobs(fx.db, { limit: 10, now: Date.now() + (guard + 1) * 600_000 });
    guard += 1;
    const status = (
      fx.db.prepare('SELECT status FROM memory_jobs WHERE id = ?').get(badJob) as unknown as { status: string }
    ).status;
    if (status === 'failed' || result.processed === 0) break;
  }
  const finalStatus = (
    fx.db.prepare('SELECT status, attempts FROM memory_jobs WHERE id = ?').get(badJob) as unknown as {
      status: string;
      attempts: number;
    }
  );
  assert.equal(finalStatus.status, 'failed');
  assert.equal(finalStatus.attempts, 5);
  fx.db.close();
});
