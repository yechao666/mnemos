import assert from 'node:assert/strict';
import test from 'node:test';
import { addMemory, count, createPerson, setup } from './test-helpers.ts';

/** v6.1 P1：人生命周期（merge / archive / 软删 / 硬删 / export）。 */

function personRow(fx: ReturnType<typeof setup>, id: string): Record<string, unknown> | undefined {
  return fx.db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as unknown as Record<string, unknown> | undefined;
}

test('lifecycle：merge 迁移 memories/facts/feedback/sessions 并重算计数', () => {
  const fx = setup();
  try {
    const target = createPerson(fx, 'target');
    const source = createPerson(fx, 'source');

    const personal = addMemory(fx, { personId: source.id, content: 'source 的个人偏好：简洁', scope: 'person' });
    addMemory(fx, {
      personId: source.id,
      content: 'source 的会话记忆',
      scope: 'session',
      sessionId: 'sess_source',
    });
    fx.svc.feedback(fx.partitionId, personal.id, { helpful: true, query: '偏好' }, fx.actor);
    fx.svc.upsertPersonFact(
      fx.partitionId,
      source.id,
      { key: 'identity.team', value: 'infra', confidence: 0.8 },
      fx.actor,
    );
    // 目标人已有同 key 事实：合并后同一 key 只保留一条当前有效
    fx.svc.upsertPersonFact(
      fx.partitionId,
      target.id,
      { key: 'identity.team', value: 'platform', confidence: 0.9 },
      fx.actor,
    );

    const result = fx.svc.mergePersons(fx.partitionId, source.id, target.externalId, fx.actor);
    assert.equal(result.person.id, target.id);
    assert.equal(result.mergedFrom.id, source.id);
    assert.equal(result.movedMemories, 2);
    assert.equal(result.movedFacts, 1);

    // memories / feedback / sessions 迁移
    assert.equal(
      count(fx.db, 'SELECT COUNT(*) FROM memories WHERE partition_id = ? AND person_id = ?', fx.partitionId, source.id),
      0,
    );
    assert.equal(
      count(fx.db, 'SELECT COUNT(*) FROM memories WHERE partition_id = ? AND person_id = ?', fx.partitionId, target.id),
      2,
    );
    const feedback = fx.db
      .prepare('SELECT person_id FROM memory_feedback WHERE memory_id = ?')
      .get(personal.id) as unknown as { person_id: string };
    assert.equal(feedback.person_id, target.id);
    const session = fx.db
      .prepare("SELECT person_id FROM sessions WHERE id = 'sess_source'")
      .get() as unknown as { person_id: string };
    assert.equal(session.person_id, target.id);

    // facts 迁移 + 同 key 去重
    assert.equal(
      count(fx.db, 'SELECT COUNT(*) FROM person_facts WHERE partition_id = ? AND person_id = ?', fx.partitionId, source.id),
      0,
    );
    assert.equal(
      count(fx.db, 'SELECT COUNT(*) FROM person_facts WHERE partition_id = ? AND person_id = ?', fx.partitionId, target.id),
      2,
    );
    const activeTargetFacts = fx.svc.listPersonFacts(fx.partitionId, target.id);
    assert.equal(activeTargetFacts.filter((fact) => fact.key === 'identity.team').length, 1);

    // 源人：archived + merged_into，deleted_at 不动
    const mergedSource = personRow(fx, source.id);
    assert.equal(mergedSource?.status, 'archived');
    assert.equal(mergedSource?.merged_into, target.id);
    assert.equal(mergedSource?.deleted_at, null);

    // 解析跟随：getPerson / 搜索 / 列表
    assert.equal(fx.svc.getPerson(fx.partitionId, source.id)?.id, target.id);
    const hits = fx.svc.searchMemories({
      partitionId: fx.partitionId,
      query: '个人偏好',
      personId: source.id,
      topK: 5,
    });
    assert.ok(hits.hits.some((hit) => hit.content.includes('source 的个人偏好')));

    const listed = fx.svc.listPersons(fx.partitionId, {});
    assert.deepEqual(listed.items.map((person) => person.externalId), ['target']);
    const withMerged = fx.svc.listPersons(fx.partitionId, { includeMerged: true });
    assert.deepEqual(withMerged.items.map((person) => person.externalId).sort(), ['source', 'target']);
    assert.deepEqual(
      fx.svc.listPersons(fx.partitionId, { status: 'archived', includeMerged: true }).items.map(
        (person) => person.externalId,
      ),
      ['source'],
    );

    // 计数重算
    const targetAfter = fx.svc.getPerson(fx.partitionId, target.id) as NonNullable<
      ReturnType<typeof fx.svc.getPerson>
    >;
    assert.equal(targetAfter.memoryCount, 2);
    const sourceAfter = fx.svc.listPersons(fx.partitionId, { includeMerged: true }).items.find(
      (person) => person.id === source.id,
    );
    assert.equal(sourceAfter?.memoryCount, 0);

    // 审计
    const audit = fx.db
      .prepare("SELECT detail FROM audit_logs WHERE action = 'person.merge' AND partition_id = ?")
      .all(fx.partitionId) as unknown as Array<{ detail: string }>;
    assert.equal(audit.length, 1);
    assert.match(audit[0]?.detail ?? '', /movedMemories/);
  } finally {
    fx.db.close();
  }
});

test('lifecycle：merge 不能合并自己；merged_into 循环安全', () => {
  const fx = setup();
  try {
    const alice = createPerson(fx, 'alice');
    const bob = createPerson(fx, 'bob');
    assert.throws(() => fx.svc.mergePersons(fx.partitionId, alice.id, alice.id, fx.actor), /同一人/);

    // 人为制造循环：A→B→A；解析不能死循环，返回其中一条。
    fx.db.prepare('UPDATE persons SET merged_into = ? WHERE id = ?').run(bob.id, alice.id);
    fx.db.prepare('UPDATE persons SET merged_into = ? WHERE id = ?').run(alice.id, bob.id);
    const resolved = fx.svc.getPerson(fx.partitionId, alice.id);
    assert.ok(resolved);
    assert.ok([alice.id, bob.id].includes(resolved.id));
  } finally {
    fx.db.close();
  }
});

test('lifecycle：archive 保留可读；软删 status=deleted + deletedAt 且默认列表排除', () => {
  const fx = setup();
  try {
    const person = createPerson(fx, 'carol');
    addMemory(fx, { personId: person.id, content: 'carol 的偏好', scope: 'person' });
    fx.svc.upsertPersonFact(
      fx.partitionId,
      person.id,
      { key: 'identity.role', value: 'designer' },
      fx.actor,
    );

    const archived = fx.svc.archivePerson(fx.partitionId, person.id, fx.actor);
    assert.equal(archived.status, 'archived');
    assert.equal(fx.svc.getPerson(fx.partitionId, person.id)?.status, 'archived');
    assert.equal(fx.svc.listPersonFacts(fx.partitionId, person.id).length, 1);

    fx.svc.deletePerson(fx.partitionId, person.id, {}, fx.actor);
    const soft = fx.svc.getPerson(fx.partitionId, person.id);
    assert.equal(soft?.status, 'deleted');
    assert.ok(soft?.deletedAt);
    assert.equal(soft?.mergedInto, undefined);
    // 记忆/facts 保留
    assert.equal(
      count(fx.db, 'SELECT COUNT(*) FROM memories WHERE partition_id = ? AND person_id = ?', fx.partitionId, person.id),
      1,
    );
    assert.equal(fx.svc.listPersonFacts(fx.partitionId, person.id).length, 1);

    // 默认列表排除 deleted；显式 status=deleted 可查
    assert.equal(fx.svc.listPersons(fx.partitionId, {}).items.length, 0);
    assert.deepEqual(
      fx.svc.listPersons(fx.partitionId, { status: 'deleted' }).items.map((item) => item.id),
      [person.id],
    );

    // 已删除的人不能 archive / merge
    assert.throws(() => fx.svc.archivePerson(fx.partitionId, person.id, fx.actor), /已删除/);
    const other = createPerson(fx, 'other');
    assert.throws(() => fx.svc.mergePersons(fx.partitionId, person.id, other.id, fx.actor), /已删除/);
  } finally {
    fx.db.close();
  }
});

test('lifecycle：硬删物理清理 memories/facts/feedback/sessions 并修悬空 merged_into', () => {
  const fx = setup();
  try {
    const keeper = createPerson(fx, 'keeper');
    const doomed = createPerson(fx, 'doomed');
    const memory = addMemory(fx, { personId: doomed.id, content: 'doomed 的记忆', scope: 'person' });
    addMemory(fx, {
      personId: doomed.id,
      content: 'doomed 的会话',
      scope: 'session',
      sessionId: 'sess_doomed',
    });
    fx.svc.feedback(fx.partitionId, memory.id, { helpful: false }, fx.actor);
    fx.svc.upsertPersonFact(
      fx.partitionId,
      doomed.id,
      { key: 'identity.team', value: 'gone' },
      fx.actor,
    );
    // keeper 合并到 doomed 后，硬删 doomed 应把 keeper.merged_into 置空（不留悬空引用）
    fx.svc.mergePersons(fx.partitionId, keeper.id, doomed.id, fx.actor);
    assert.equal(personRow(fx, keeper.id)?.merged_into, doomed.id);

    fx.svc.deletePerson(fx.partitionId, doomed.id, { hard: true }, fx.actor);

    assert.equal(personRow(fx, doomed.id), undefined);
    const stats = (sql: string) => count(fx.db, sql, fx.partitionId, doomed.id);
    assert.equal(stats('SELECT COUNT(*) FROM memories WHERE partition_id = ? AND person_id = ?'), 0);
    assert.equal(stats('SELECT COUNT(*) FROM person_facts WHERE partition_id = ? AND person_id = ?'), 0);
    assert.equal(stats('SELECT COUNT(*) FROM person_profiles WHERE partition_id = ? AND person_id = ?'), 0);
    assert.equal(stats('SELECT COUNT(*) FROM sessions WHERE partition_id = ? AND person_id = ?'), 0);
    const feedback = fx.db
      .prepare('SELECT COUNT(*) AS c FROM memory_feedback WHERE memory_id = ?')
      .get(memory.id) as unknown as { c: number };
    assert.equal(feedback.c, 0);
    const keeperAfter = personRow(fx, keeper.id);
    assert.equal(keeperAfter?.merged_into, null);
    // 分区统计重算
    assert.equal(fx.svc.partitionStats(fx.partitionId).memoriesTotal, 0);
  } finally {
    fx.db.close();
  }
});

test('lifecycle：export 形状 + memories 截断标记', () => {
  const fx = setup();
  try {
    const person = createPerson(fx, 'dave');
    addMemory(fx, { personId: person.id, content: 'dave 喜欢美式咖啡' });
    addMemory(fx, { personId: person.id, content: 'dave 负责检索模块的重构' });
    addMemory(fx, { personId: person.id, content: 'dave 每周一发布版本' });
    fx.svc.upsertPersonFact(fx.partitionId, person.id, { key: 'a', value: '1' }, fx.actor);
    fx.svc.upsertPersonFact(fx.partitionId, person.id, { key: 'a', value: '2' }, fx.actor);

    const exported = fx.svc.exportPerson(fx.partitionId, person.id);
    assert.equal(exported.person.id, person.id);
    assert.equal(exported.memories.length, 3);
    assert.equal(exported.facts.length, 2, 'facts 含历史版本');
    assert.ok(exported.exportedAt);
    assert.notEqual(exported.truncated, true);

    // 超过上限：直接插入 10001 条（绕过写管线，只为验证截断）
    const at = new Date().toISOString();
    const insert = fx.db.prepare(
      `INSERT INTO memories
         (id, partition_id, person_id, actor_person_id, scope, session_id, category, content,
          importance, confidence, source, status, tags, metadata, created_at, updated_at,
          valid_from, normalized_hash)
       VALUES (?, ?, ?, NULL, 'person', NULL, 'fact', ?, 0.5, 0.8, 'import', 'active', '[]', '{}', ?, ?, ?, NULL)`,
    );
    fx.db.exec('BEGIN');
    try {
      for (let index = 0; index < 10_001; index += 1) {
        insert.run(`mem_bulk_${index}`, fx.partitionId, person.id, `bulk ${index}`, at, at, at);
      }
      fx.db.exec('COMMIT');
    } catch (error) {
      fx.db.exec('ROLLBACK');
      throw error;
    }
    const truncated = fx.svc.exportPerson(fx.partitionId, person.id);
    assert.equal(truncated.memories.length, 10_000);
    assert.equal(truncated.truncated, true);
  } finally {
    fx.db.close();
  }
});
