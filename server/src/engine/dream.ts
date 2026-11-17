import type { DatabaseSync } from 'node:sqlite';
import { CATEGORY_LABEL } from '../../../shared/src/constants.ts';
import type {
  Actor,
  Memory,
  MemoryDreamInput,
  MemoryDreamResult,
  MemoryDreamRun,
  MemoryDreamStatus,
} from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { EngineError, engineErrors } from './errors.ts';
import { llmText } from './llm.ts';
import {
  addMemory,
  markDreamed,
  pendingDreamCount,
  pendingDreamMemories,
} from './memories.ts';
import { findPartitionById } from './partition.ts';
import { findPersonRow, upsertPerson } from './persons.ts';
import { parseSettings, toDreamRun, type DreamRunRow } from './rows.ts';

const MAX_BATCH = 200;
const SYSTEM_PERSON_EXTERNAL_ID = 'mnemos-dream';

/** 进程内并发锁：同一分区/人同时只允许一次做梦。 */
const running = new Set<string>();

function scopeKey(partitionId: string, personId?: string): string {
  return `${partitionId}:${personId ?? 'partition'}`;
}

function insertRun(
  db: DatabaseSync,
  input: { partitionId: string; personId?: string; trigger: string },
): { id: string; startedAt: string } {
  const id = newId('drm');
  const startedAt = nowIso();
  db.prepare(
    `INSERT INTO dream_runs
       (id, partition_id, person_id, trigger, status, input_count, insight_count, summary, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, 'running', 0, 0, NULL, NULL, ?, NULL)`,
  ).run(id, input.partitionId, input.personId ?? null, input.trigger, startedAt);
  return { id, startedAt };
}

function finishRun(
  db: DatabaseSync,
  id: string,
  status: 'completed' | 'skipped' | 'failed',
  inputCount: number,
  insightCount: number,
  summary?: string,
  error?: string,
): void {
  db.prepare(
    `UPDATE dream_runs
        SET status = ?, input_count = ?, insight_count = ?, summary = ?, error = ?, finished_at = ?
      WHERE id = ?`,
  ).run(status, inputCount, insightCount, summary ?? null, error ?? null, nowIso(), id);
}

function insightText(memories: Memory[]): string {
  const lines = memories.map(
    (memory) =>
      `- [${CATEGORY_LABEL[memory.category] ?? memory.category}] ${memory.content.replace(/\s+/g, ' ').slice(0, 300)}`,
  );
  const body = lines.join('\n');
  const text = `做梦巩固（${memories.length} 条新记忆）：\n${body}`;
  return text.length > 6_000 ? text.slice(0, 6_000) : text;
}

async function polishInsight(llm: LlmConfig | null, memories: Memory[]): Promise<string> {
  const base = insightText(memories);
  if (!llm) return base;
  const polished = await llmText(llm, {
    system:
      '你是记忆巩固器。把用户提供的多条记忆合并为 3–8 条稳定洞见（事实、偏好、约束、决策、待办）。' +
      '不要编造，不要复述逐条原文；每条一行，以 "- " 开头。',
    prompt: base,
    maxChars: 2_000,
    timeoutMs: 20_000,
  });
  return polished || base;
}

/** 分区 / 人级做梦状态：设置、待巩固数、最近运行记录。 */
export function dreamStatus(db: DatabaseSync, partitionId: string, personId?: string): MemoryDreamStatus {
  const partition = findPartitionById(db, partitionId);
  if (!partition) throw engineErrors.notFound('分区不存在');
  const settings = parseSettings(partition.settings);
  const rows = personId
    ? (db
        .prepare(
          `SELECT * FROM dream_runs
            WHERE partition_id = ? AND person_id = ?
            ORDER BY started_at DESC, rowid DESC LIMIT 10`,
        )
        .all(partitionId, personId) as unknown as DreamRunRow[])
    : (db
        .prepare(
          `SELECT * FROM dream_runs
            WHERE partition_id = ? AND person_id IS NULL
            ORDER BY started_at DESC, rowid DESC LIMIT 10`,
        )
        .all(partitionId) as unknown as DreamRunRow[]);
  const runs = rows.map(toDreamRun);
  const lastRun = runs[0];
  return {
    settings: {
      enabled: settings.dreamEnabled,
      intervalMinutes: settings.dreamIntervalMinutes,
      lastAt: lastRun?.finishedAt ?? lastRun?.startedAt,
    },
    ...(personId ? { personId } : {}),
    pendingCount: pendingDreamCount(db, partitionId, personId),
    lastRun,
    runs,
  };
}

function systemActor(): Actor {
  return { type: 'system', id: 'system', label: '做梦调度' };
}

/**
 * 增量做梦：
 * - 人级：巩固该人 scope=person/session 的未巩固记忆，洞见归属该人；
 * - 分区级：巩固 scope=partition 的未巩固记忆，洞见归属分区系统人（mnemos-dream）。
 * 输入记忆写 dreamed_at，洞见写 category=insight / source=dream；单批默认 50、最大 200。
 */
export async function runDream(
  db: DatabaseSync,
  llm: LlmConfig | null,
  input: MemoryDreamInput,
  actor: Actor,
): Promise<MemoryDreamResult> {
  const partition = findPartitionById(db, input.partitionId);
  if (!partition) throw engineErrors.notFound('分区不存在');
  if (input.personId) {
    const person = findPersonRow(db, input.partitionId, input.personId);
    if (!person) throw engineErrors.notFound('人不存在');
  }

  const trigger = input.trigger === 'schedule' ? 'schedule' : 'manual';
  const batchSize = Math.min(MAX_BATCH, Math.max(1, Math.trunc(input.batchSize ?? 50)));
  const key = scopeKey(input.partitionId, input.personId);
  if (running.has(key)) throw engineErrors.dreamRunning();
  running.add(key);

  const { id: runId } = insertRun(db, {
    partitionId: input.partitionId,
    personId: input.personId,
    trigger,
  });

  try {
    const memories = pendingDreamMemories(db, input.partitionId, input.personId, batchSize);
    if (memories.length === 0) {
      finishRun(db, runId, 'skipped', 0, 0, '没有待巩固的记忆');
      const row = db.prepare('SELECT * FROM dream_runs WHERE id = ?').get(runId) as unknown as DreamRunRow;
      return { run: toDreamRun(row), status: dreamStatus(db, input.partitionId, input.personId) };
    }

    const content = await polishInsight(llm, memories);
    const importance = Math.max(0.7, ...memories.map((memory) => memory.importance));

    let ownerPersonId = input.personId;
    if (!ownerPersonId) {
      const existing = db
        .prepare("SELECT * FROM persons WHERE partition_id = ? AND type = 'service' AND external_id = ?")
        .get(input.partitionId, SYSTEM_PERSON_EXTERNAL_ID) as unknown as { id: string } | undefined;
      ownerPersonId = existing
        ? existing.id
        : upsertPerson(
            db,
            input.partitionId,
            {
              externalId: SYSTEM_PERSON_EXTERNAL_ID,
              type: 'service',
              displayName: 'Mnemos 做梦',
              attributes: { system: true },
            },
            actor,
          ).id;
    }

    const insight = addMemory(db, {
      partitionId: input.partitionId,
      personId: ownerPersonId,
      scope: input.personId ? 'person' : 'partition',
      category: 'insight',
      content,
      importance,
      confidence: 0.8,
      source: 'dream',
      metadata: { dreamRunId: runId, sourceCount: memories.length },
      actor,
    }).memory;

    const finishedAt = nowIso();
    markDreamed(
      db,
      memories.map((memory) => memory.id),
      finishedAt,
    );
    // 洞见本身也是「已巩固」，否则下一轮会把自己当输入无限循环。
    db.prepare('UPDATE memories SET dreamed_at = ? WHERE id = ?').run(finishedAt, insight.id);
    finishRun(db, runId, 'completed', memories.length, 1, `已巩固 ${memories.length} 条记忆并生成 1 条洞见`);

    const row = db.prepare('SELECT * FROM dream_runs WHERE id = ?').get(runId) as unknown as DreamRunRow;
    return { run: toDreamRun(row), status: dreamStatus(db, input.partitionId, input.personId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      finishRun(db, runId, 'failed', 0, 0, undefined, message);
    } catch {
      /* ignore */
    }
    if (error instanceof EngineError) throw error;
    throw new EngineError('INTERNAL', `做梦失败：${message}`, 500);
  } finally {
    running.delete(key);
  }
}

/** 测试辅助：清理并发锁（不同测试共用一个进程时）。 */
export function resetDreamLocks(): void {
  running.clear();
}
