import type { DatabaseSync } from 'node:sqlite';
import type {
  Actor,
  Memory,
  Person,
  PersonFact,
  PersonFactInput,
  PersonProfile,
} from '../../../shared/src/types.ts';
import { writeAudit } from '../lib/audit.ts';
import { newId, nowIso, sha256 } from '../lib/ids.ts';
import { tx } from '../db/index.ts';
import { engineErrors } from './errors.ts';
import { callLlm, type LlmLike } from './llm.ts';
import { resolvePerson } from './persons.ts';
import { toMemory, toPersonFact, type MemoryRow, type PersonFactRow } from './rows.ts';

/**
 * v6.1 P1 结构化画像：
 *
 * - person_facts 版本化：同 person+key 写入新值时关闭旧事实（valid_to=now）并插入新版本；
 *   同 key+同 value 视为幂等（不产生新版本，保证 job 重跑 / 读取触发沉淀不会刷版本）。
 * - 记忆 metadata.factKey 自动沉淀：jobs 的 profile 任务与画像读取都会调用
 *   syncFactsFromMemories（取同 key 最新有效记忆，confidence 继承）；已删除的 fact
 *   不会被同一条旧记忆重新创建（只有记忆 updated_at 更新后才重新生效）。
 * - 画像摘要：sourceHash = 当前 facts + 有效记忆 updated_at 的哈希；命中缓存直接返回。
 *   有 LLM 配置时优先 LLM（≤800 字中文），失败/未配置回退确定性拼接。
 */

const SYSTEM_ACTOR: Actor = { type: 'system', id: 'system', label: 'system' };
const SUMMARY_MAX_CHARS = 800;
const PROFILE_MEMORY_LIMIT = 30;
const FACT_KEY_MAX = 120;
const FACT_VALUE_MAX = 2_000;

function clamp01(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function trimSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 解析 / 校验 fact 入参。 */
export function normalizeFactInput(input: PersonFactInput): {
  key: string;
  value: string;
  confidence: number;
  sourceMemoryId: string | null;
} {
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  if (!key) throw engineErrors.validation('fact key 不能为空');
  if (key.length > FACT_KEY_MAX) throw engineErrors.validation(`fact key 最长 ${FACT_KEY_MAX} 字符`);
  const value = typeof input.value === 'string' ? input.value.trim() : '';
  if (!value) throw engineErrors.validation('fact value 不能为空');
  if (value.length > FACT_VALUE_MAX) throw engineErrors.validation(`fact value 最长 ${FACT_VALUE_MAX} 字符`);
  const sourceMemoryId =
    typeof input.sourceMemoryId === 'string' && input.sourceMemoryId.trim()
      ? input.sourceMemoryId.trim().slice(0, 128)
      : null;
  return { key, value, confidence: clamp01(input.confidence, 0.7), sourceMemoryId };
}

function orgOfPartition(db: DatabaseSync, partitionId: string): string | undefined {
  const row = db.prepare('SELECT org_id FROM partitions WHERE id = ?').get(partitionId) as unknown as
    | { org_id: string }
    | undefined;
  return row?.org_id;
}

function auditFact(
  db: DatabaseSync,
  input: {
    partitionId: string;
    actor: Actor;
    action: 'person.fact.create' | 'person.fact.update' | 'person.fact.delete';
    factId: string;
    detail?: Record<string, unknown>;
  },
): void {
  try {
    writeAudit(db, {
      orgId: orgOfPartition(db, input.partitionId),
      partitionId: input.partitionId,
      actor: input.actor,
      action: input.action,
      resourceType: 'person_fact',
      resourceId: input.factId,
      detail: input.detail,
    });
  } catch {
    /* 审计失败不影响主流程 */
  }
}

function activeFacts(db: DatabaseSync, partitionId: string, personId: string): PersonFactRow[] {
  return db
    .prepare(
      `SELECT * FROM person_facts
        WHERE partition_id = ? AND person_id = ? AND valid_to IS NULL
        ORDER BY key ASC, id ASC`,
    )
    .all(partitionId, personId) as unknown as PersonFactRow[];
}

function latestFactOfKey(
  db: DatabaseSync,
  partitionId: string,
  personId: string,
  key: string,
): PersonFactRow | null {
  const row = db
    .prepare(
      `SELECT * FROM person_facts
        WHERE partition_id = ? AND person_id = ? AND key = ?
        ORDER BY valid_from DESC, created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(partitionId, personId, key) as unknown as PersonFactRow | undefined;
  return row ?? null;
}

/**
 * 内部写入：同 key 关闭当前有效 fact（value 不同才版本化）；同 value 幂等返回。
 * 返回是否真正产生了新版本。
 */
function writeFact(
  db: DatabaseSync,
  partitionId: string,
  personId: string,
  input: ReturnType<typeof normalizeFactInput>,
  actor: Actor,
): { fact: PersonFact; versioned: boolean } {
  return tx(db, () => {
    const at = nowIso();
    const current = db
      .prepare(
        `SELECT * FROM person_facts
          WHERE partition_id = ? AND person_id = ? AND key = ? AND valid_to IS NULL
          ORDER BY valid_from DESC, id DESC LIMIT 1`,
      )
      .get(partitionId, personId, input.key) as unknown as PersonFactRow | undefined;

    if (current && current.value === input.value) {
      // 幂等：同 key+同 value 不产生新版本。
      // 仅当显式调整置信度 / 来源记忆时才轻量更新（会改变画像 sourceHash，属预期编辑语义）。
      const nextSource = input.sourceMemoryId ?? current.source_memory_id;
      if (
        Math.abs(current.confidence - input.confidence) > 1e-9 ||
        nextSource !== current.source_memory_id
      ) {
        db.prepare('UPDATE person_facts SET confidence = ?, source_memory_id = ?, updated_at = ? WHERE id = ?').run(
          input.confidence,
          nextSource,
          at,
          current.id,
        );
        auditFact(db, {
          partitionId,
          actor,
          action: 'person.fact.update',
          factId: current.id,
          detail: { key: input.key, confidence: input.confidence, sourceMemoryId: nextSource ?? undefined },
        });
        const row = db.prepare('SELECT * FROM person_facts WHERE id = ?').get(current.id) as unknown as PersonFactRow;
        return { fact: toPersonFact(row), versioned: false };
      }
      return { fact: toPersonFact(current), versioned: false };
    }
    if (current) {
      db.prepare('UPDATE person_facts SET valid_to = ?, updated_at = ? WHERE id = ?').run(at, at, current.id);
    }
    const id = newId('fact');
    db.prepare(
      `INSERT INTO person_facts
         (id, partition_id, person_id, key, value, confidence, valid_from, valid_to, source_memory_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      id,
      partitionId,
      personId,
      input.key,
      input.value,
      input.confidence,
      at,
      input.sourceMemoryId,
      at,
      at,
    );
    auditFact(db, {
      partitionId,
      actor,
      action: current ? 'person.fact.update' : 'person.fact.create',
      factId: id,
      detail: {
        key: input.key,
        value: input.value,
        confidence: input.confidence,
        sourceMemoryId: input.sourceMemoryId ?? undefined,
        replacedFactId: current?.id,
      },
    });
    const row = db.prepare('SELECT * FROM person_facts WHERE id = ?').get(id) as unknown as PersonFactRow;
    return { fact: toPersonFact(row), versioned: true };
  });
}

/** GET /facts：当前有效 facts（canonical person）。 */
export function listPersonFacts(db: DatabaseSync, partitionId: string, personRef: string): PersonFact[] {
  const person = resolvePerson(db, partitionId, personRef);
  return activeFacts(db, partitionId, person.id).map(toPersonFact);
}

/** PUT /facts：显式维护（同 key 版本化）。 */
export function upsertPersonFact(
  db: DatabaseSync,
  partitionId: string,
  personRef: string,
  input: PersonFactInput,
  actor: Actor,
): PersonFact {
  const person = resolvePerson(db, partitionId, personRef);
  const normalized = normalizeFactInput(input);
  return writeFact(db, partitionId, person.id, normalized, actor).fact;
}

/** DELETE /facts/:factId：软关闭（保留历史版本）。 */
export function removePersonFact(
  db: DatabaseSync,
  partitionId: string,
  personRef: string,
  factId: string,
  actor: Actor,
): void {
  const person = resolvePerson(db, partitionId, personRef);
  const row = db
    .prepare(
      `SELECT * FROM person_facts
        WHERE id = ? AND partition_id = ? AND person_id = ? AND valid_to IS NULL`,
    )
    .get(factId, partitionId, person.id) as unknown as PersonFactRow | undefined;
  if (!row) throw engineErrors.notFound('事实不存在或已失效');
  const at = nowIso();
  db.prepare('UPDATE person_facts SET valid_to = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
  auditFact(db, {
    partitionId,
    actor,
    action: 'person.fact.delete',
    factId: row.id,
    detail: { key: row.key, value: row.value, softDelete: true },
  });
}

/**
 * 把同 person 的 factKey 记忆沉淀为 facts（取每个 key 最新有效记忆，confidence 继承）。
 * 幂等：已存在同 key+同 value 的当前事实则不动；删除过的事实不会被旧记忆复活。
 */
export function syncFactsFromMemories(
  db: DatabaseSync,
  partitionId: string,
  personId: string,
  actor: Actor = SYSTEM_ACTOR,
): number {
  const memories = db
    .prepare(
      `SELECT id, fact_key, content, confidence, updated_at
         FROM memories
        WHERE partition_id = ? AND person_id = ? AND fact_key IS NOT NULL
          AND status = 'active' AND valid_to IS NULL
        ORDER BY updated_at DESC, created_at DESC, id DESC`,
    )
    .all(partitionId, personId) as unknown as {
    id: string;
    fact_key: string;
    content: string;
    confidence: number;
    updated_at: string;
  }[];

  const seen = new Set<string>();
  let changed = 0;
  for (const memory of memories) {
    const key = memory.fact_key.trim().slice(0, FACT_KEY_MAX);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const latest = latestFactOfKey(db, partitionId, personId, key);
    if (latest && latest.value === memory.content) {
      if (latest.valid_to === null) continue;
      // 已删除的事实：同一条旧记忆不复活；记忆在该事实删除后更新过才重新生效。
      if (memory.updated_at <= latest.updated_at) continue;
    }
    if (!memory.content.trim()) continue;
    const result = writeFact(
      db,
      partitionId,
      personId,
      {
        key,
        value: memory.content.trim().slice(0, FACT_VALUE_MAX),
        confidence: clamp01(memory.confidence, 0.7),
        sourceMemoryId: memory.id,
      },
      actor,
    );
    if (result.versioned) changed += 1;
  }
  return changed;
}

function recentMemories(db: DatabaseSync, partitionId: string, personId: string, limit = PROFILE_MEMORY_LIMIT): Memory[] {
  const rows = db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m JOIN persons p ON p.id = m.person_id
        WHERE m.partition_id = ? AND m.person_id = ? AND m.status = 'active' AND m.valid_to IS NULL
        ORDER BY m.importance DESC, m.updated_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(partitionId, personId, limit) as unknown as MemoryRow[];
  return rows.map(toMemory);
}

/** 确定性画像摘要（无 LLM / LLM 失败时使用），≤800 字。 */
export function buildDeterministicSummary(facts: PersonFact[], memories: Memory[]): string {
  const parts: string[] = [];
  if (facts.length > 0) {
    const lines = facts
      .slice(0, 20)
      .map((fact) => `- ${fact.key}：${oneLine(fact.value, 80)}`);
    parts.push(`【结构化事实】\n${lines.join('\n')}`);
  }
  if (memories.length > 0) {
    const lines = memories.map((memory) => `- [${memory.category}] ${oneLine(memory.content, 120)}`);
    parts.push(`【近期记忆】\n${lines.join('\n')}`);
  }
  if (parts.length === 0) return '';
  return trimSummary(parts.join('\n'));
}

/** facts + 有效记忆 updated_at 的稳定哈希；任一变化都会使画像缓存失效。 */
export function profileSourceHash(db: DatabaseSync, partitionId: string, personId: string): string {
  const facts = db
    .prepare(
      `SELECT id, key, value, confidence, valid_from, updated_at FROM person_facts
        WHERE partition_id = ? AND person_id = ? AND valid_to IS NULL
        ORDER BY key ASC, id ASC`,
    )
    .all(partitionId, personId) as unknown as {
    id: string;
    key: string;
    value: string;
    confidence: number;
    valid_from: string;
    updated_at: string;
  }[];
  const memories = db
    .prepare(
      `SELECT id, updated_at FROM memories
        WHERE partition_id = ? AND person_id = ? AND status = 'active' AND valid_to IS NULL
        ORDER BY id ASC`,
    )
    .all(partitionId, personId) as unknown as { id: string; updated_at: string }[];
  const factPart = facts
    .map((fact) => `${fact.id}:${fact.key}:${fact.updated_at}:${fact.valid_from}:${fact.value}:${fact.confidence}`)
    .join('|');
  const memoryPart = memories.map((memory) => `${memory.id}:${memory.updated_at}`).join('|');
  return sha256(`${factPart}#${memoryPart}`);
}

interface CachedProfile {
  summary: string;
  source_hash: string;
  generated_at: string;
}

function readCache(db: DatabaseSync, partitionId: string, personId: string): CachedProfile | null {
  const row = db
    .prepare('SELECT summary, source_hash, generated_at FROM person_profiles WHERE partition_id = ? AND person_id = ?')
    .get(partitionId, personId) as unknown as CachedProfile | undefined;
  return row ?? null;
}

function writeCache(
  db: DatabaseSync,
  partitionId: string,
  personId: string,
  summary: string,
  sourceHash: string,
  generatedAt: string,
): void {
  db.prepare(
    `INSERT INTO person_profiles (partition_id, person_id, summary, source_hash, generated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(partition_id, person_id)
     DO UPDATE SET summary = excluded.summary, source_hash = excluded.source_hash, generated_at = excluded.generated_at`,
  ).run(partitionId, personId, summary, sourceHash, generatedAt);
}

function profileOf(
  db: DatabaseSync,
  person: Person,
  facts: PersonFact[],
  summary: string,
  generatedAt: string,
  cached: boolean,
): PersonProfile {
  return { person, facts, summary, generatedAt, cached };
}

/**
 * 同步画像（契约 MemoryService.personProfile）：确定性摘要 + 缓存。
 * 有 LLM 时由 refreshPersonProfile（HTTP 路由）异步生成并对缓存回填。
 */
export function getPersonProfile(db: DatabaseSync, partitionId: string, personRef: string): PersonProfile {
  const person = resolvePerson(db, partitionId, personRef);
  syncFactsFromMemories(db, partitionId, person.id);
  const facts = activeFacts(db, partitionId, person.id).map(toPersonFact);
  const hash = profileSourceHash(db, partitionId, person.id);
  const cached = readCache(db, partitionId, person.id);
  if (cached && cached.source_hash === hash) {
    return profileOf(db, person, facts, cached.summary, cached.generated_at, true);
  }
  const summary = buildDeterministicSummary(facts, recentMemories(db, partitionId, person.id));
  const at = nowIso();
  writeCache(db, partitionId, person.id, summary, hash, at);
  return profileOf(db, person, facts, summary, at, false);
}

function buildProfilePrompt(person: Person, facts: PersonFact[], memories: Memory[]): string {
  const factLines = facts.length
    ? facts.map((fact) => `- ${fact.key}: ${oneLine(fact.value, 200)}（置信度 ${fact.confidence.toFixed(2)}）`).join('\n')
    : '（暂无结构化事实）';
  const memoryLines = memories.length
    ? memories.map((memory) => `- [${memory.category}] ${oneLine(memory.content, 200)}`).join('\n')
    : '（暂无记忆）';
  return [
    `请根据以下资料，为「${person.displayName || person.externalId}」写一段不超过 800 字的中文人物画像。`,
    '要求：只基于给定资料，不编造；覆盖偏好、身份、目标、关系、约束；用紧凑的段落或分点，不要客套话。',
    '',
    '【结构化事实】',
    factLines,
    '',
    '【近期记忆】',
    memoryLines,
  ].join('\n');
}

/**
 * 按需生成画像（HTTP GET /profile）：命中缓存且未 force 时直接返回；
 * 有 LLM 配置时优先 LLM，失败/未配置回退确定性摘要。
 */
export async function refreshPersonProfile(
  db: DatabaseSync,
  llm: LlmLike,
  partitionId: string,
  personRef: string,
  options: { force?: boolean } = {},
): Promise<PersonProfile> {
  const person = resolvePerson(db, partitionId, personRef);
  syncFactsFromMemories(db, partitionId, person.id);
  const facts = activeFacts(db, partitionId, person.id).map(toPersonFact);
  const hash = profileSourceHash(db, partitionId, person.id);
  const cached = readCache(db, partitionId, person.id);
  if (!options.force && cached && cached.source_hash === hash) {
    return profileOf(db, person, facts, cached.summary, cached.generated_at, true);
  }

  const memories = recentMemories(db, partitionId, person.id);
  let summary = buildDeterministicSummary(facts, memories);
  if (llm) {
    const text = await callLlm(llm, 'profile', {
      system: '你是企业记忆系统的画像归纳助手。只输出中文画像正文，不输出标题或解释，不编造资料之外的信息。',
      prompt: buildProfilePrompt(person, facts, memories),
      maxChars: SUMMARY_MAX_CHARS,
    });
    if (text) summary = trimSummary(text);
  }
  const at = nowIso();
  writeCache(db, partitionId, person.id, summary, hash, at);
  return profileOf(db, person, facts, summary, at, false);
}
