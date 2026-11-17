/**
 * 记忆简报（brief）：取项目最近的活跃记忆/洞见，压缩成有字符上限、
 * 可直接注入 Agent 系统提示词的中文 Markdown。
 *
 * 两条路径：
 * - 确定性压缩 buildBriefText：纯本地、无网络、结果稳定，供任务简报热路径直接使用；
 * - 缓存 + 可选 LLM 润色 ensureBrief：控制台预览用，命中 memory_briefs 时复用，
 *   允许 LLM 时调用一次 chat/completions 润色，失败自动回退确定性文本。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  BRIEF_DEFAULT_CHARS,
  BRIEF_MAX_CHARS,
  BRIEF_MIN_CHARS,
  BRIEF_RECENT_LIMIT,
  CATEGORY_LABEL,
} from '../../../shared/src/constants.ts';
import type {
  MemoryBrief,
  MemoryBriefInput,
  MemoryBriefItem,
  MemoryCategory,
  MemoryScope,
} from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { nowIso, sha256 } from '../lib/ids.ts';
import { notFound } from './errors.ts';
import { llmText } from './llm.ts';
import { resolvePerson } from './persons.ts';
import { loadSettings } from './store.ts';

/** 确定性压缩使用的模型标识（不是真实 LLM 模型名）。 */
export const CONDENSE_MODEL = 'mnemos-condense';

const BRIEF_HEADER = '# 记忆简报（最近记忆与洞见）';
const LLM_TIMEOUT_MS = 20_000;

export interface BriefDeps {
  db: DatabaseSync;
  llm?: LlmConfig | null;
}

export interface BuildBriefOptions {
  maxChars: number;
  agentId?: string;
  /** true=控制台/审计视角（不过滤可见性）；false=按 agentId 可见性过滤 */
  includePrivate?: boolean;
  limit?: number;
  /** 人级简报：只取该人 scope=person 记忆 + 与其相关的 scope=partition 记忆 */
  subjectPersonId?: string;
  /** 调用方本人（person 内部 id），用于可见性：可见自己的 person 记忆 */
  callerPersonId?: string | null;
}

export interface BuiltBrief {
  text: string;
  count: number;
  items: MemoryBriefItem[];
}

interface BriefMemoryRow {
  id: string;
  content: string;
  category: string;
  importance: number;
  updated_at: string;
  task_id: string | null;
  agent_id: string | null;
  person_id: string | null;
  scope: string;
  person_external_id?: string | null;
}

interface BriefCacheRow {
  project_id: string;
  scope: string;
  person_id: string | null;
  text: string;
  max_chars: number;
  model: string;
  source_hash: string;
  generated_at: string;
}

/** 同 scope 的并发请求共享同一个 Promise（避免重复调 LLM / 重复写缓存）。 */
const inFlight = new Map<string, Promise<MemoryBrief>>();

export function clampBriefChars(value: number | undefined): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : BRIEF_DEFAULT_CHARS;
  return Math.max(BRIEF_MIN_CHARS, Math.min(BRIEF_MAX_CHARS, numeric));
}

/** 行内空白归一，保持简报紧凑（避免换行破坏列表结构）。 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clipLine(line: string, room: number): string {
  if (room <= 1) return '';
  return `${line.slice(0, room - 1).trimEnd()}…`;
}

/** 可见性过滤：控制台不过滤；Agent 视角只看项目共享 + 自己的私有记忆。 */
function visibilitySql(options: { includePrivate: boolean; agentId?: string; callerPersonId?: string | null }): {
  sql: string;
  params: string[];
} {
  if (options.includePrivate) return { sql: '', params: [] };
  const params: string[] = [];
  const own: string[] = [];
  if (options.agentId) {
    own.push('agent_id = ?');
    params.push(options.agentId);
  }
  if (options.callerPersonId) {
    own.push('person_id = ?');
    params.push(options.callerPersonId);
  }
  const clauses = ["visibility = 'project'"];
  if (own.length > 0) clauses.push(`(visibility = 'agent' AND (${own.join(' OR ')}))`);
  return { sql: ` AND (${clauses.join(' OR ')})`, params };
}

const BRIEF_SELECT = `SELECT m.id, m.content, m.category, m.importance, m.updated_at, m.task_id, m.agent_id,
          m.person_id, m.scope, p.external_id AS person_external_id
     FROM memories m LEFT JOIN persons p ON p.id = m.person_id`;

function toBriefItem(row: BriefMemoryRow): MemoryBriefItem {
  const category = row.category as MemoryCategory;
  const item: MemoryBriefItem = {
    id: row.id,
    content: row.content,
    category,
    importance: Number(row.importance),
    updatedAt: row.updated_at,
  };
  if (row.task_id) item.taskId = row.task_id;
  if (row.agent_id) item.agentId = row.agent_id;
  if (row.person_id) item.personId = row.person_id;
  if (row.person_external_id) item.personExternalId = row.person_external_id;
  item.scope = (row.scope as MemoryScope | undefined) ?? 'partition';
  return item;
}

/** 人级简报取数：该人 scope=person 记忆 + 与其相关的分区共享记忆（person_id 相同或为空）。 */
function selectPersonBriefRows(
  db: DatabaseSync,
  projectId: string,
  subjectPersonId: string,
  limit: number,
): BriefMemoryRow[] {
  return db
    .prepare(
      `${BRIEF_SELECT}
        WHERE m.project_id = ?
          AND m.status = 'active'
          AND (m.expires_at IS NULL OR m.expires_at > ?)
          AND (
            (m.scope = 'person' AND m.person_id = ?)
            OR (m.scope = 'partition' AND (m.person_id IS ? OR m.person_id IS NULL))
          )
        ORDER BY m.updated_at DESC, m.created_at DESC
        LIMIT ?`,
    )
    .all(projectId, nowIso(), subjectPersonId, subjectPersonId, limit) as unknown as BriefMemoryRow[];
}

/**
 * 确定性压缩最近记忆为简报文本（不调 LLM、不写缓存）。
 * 超字符预算时截断当前行并停止，保证 text.length ≤ maxChars。
 */
export function buildBriefText(db: DatabaseSync, projectId: string, options: BuildBriefOptions): BuiltBrief {
  const maxChars = clampBriefChars(options.maxChars);
  const limit = Math.max(1, Math.min(BRIEF_RECENT_LIMIT, Math.floor(options.limit ?? BRIEF_RECENT_LIMIT)));
  let rows: BriefMemoryRow[];
  if (options.subjectPersonId) {
    rows = selectPersonBriefRows(db, projectId, options.subjectPersonId, limit);
  } else {
    const visibility = visibilitySql({
      includePrivate: options.includePrivate === true,
      agentId: options.agentId,
      callerPersonId: options.callerPersonId,
    });
    rows = db
      .prepare(
        `${BRIEF_SELECT}
          WHERE m.project_id = ?
            AND m.status = 'active'
            AND (m.expires_at IS NULL OR m.expires_at > ?)${visibility.sql}
          ORDER BY m.updated_at DESC, m.created_at DESC
          LIMIT ?`,
      )
      .all(projectId, nowIso(), ...visibility.params, limit) as unknown as BriefMemoryRow[];
  }

  let text = '';
  let count = 0;
  const items: MemoryBriefItem[] = [];

  for (const row of rows) {
    const content = oneLine(row.content);
    if (!content) continue;
    const category = row.category as MemoryCategory;
    const label = CATEGORY_LABEL[category] ?? row.category;
    const line = `- [${label}] ${content}`;

    const base = count === 0 ? BRIEF_HEADER : text;
    const room = maxChars - base.length - 1;
    if (room <= 1) break;

    let accepted = false;
    const candidate = `${base}\n${line}`;
    if (candidate.length <= maxChars) {
      text = candidate;
      accepted = true;
    } else {
      const clipped = clipLine(line, room);
      if (clipped.length > 0) {
        text = `${base}\n${clipped}`;
        accepted = true;
      }
    }
    if (!accepted) break;

    count += 1;
    items.push(toBriefItem(row));

    // 已截断（candidate 放不下）→ 停止，保持预算内。
    if (text.length >= maxChars || candidate.length > maxChars) break;
  }

  return { text: count > 0 ? text : '', count, items };
}

/** 缓存键：人级简报用 person:<personId>，其余沿用旧分区/Agent scope。 */
function scopeOf(input: MemoryBriefInput, subjectPersonId?: string): string {
  if (subjectPersonId) return `person:${subjectPersonId}`;
  return input.includePrivate === true ? 'project' : `agent:${input.agentId ?? '-'}`;
}

/** 缓存指纹：字符上限 + 每条记忆 id/更新时间/内容长度。 */
function sourceHashOf(maxChars: number, items: MemoryBriefItem[]): string {
  const source = [
    String(maxChars),
    ...items.map((item) => `${item.id}:${item.updatedAt}:${String(item.content.length)}`),
  ].join('|');
  return sha256(source);
}

function readCache(db: DatabaseSync, projectId: string, scope: string): BriefCacheRow | undefined {
  return db
    .prepare('SELECT * FROM memory_briefs WHERE project_id = ? AND scope = ?')
    .get(projectId, scope) as unknown as BriefCacheRow | undefined;
}

function saveCache(
  db: DatabaseSync,
  projectId: string,
  scope: string,
  personId: string | null,
  text: string,
  maxChars: number,
  model: string,
  sourceHash: string,
  generatedAt: string,
): void {
  db.prepare(
    `INSERT INTO memory_briefs (project_id, scope, person_id, text, max_chars, model, source_hash, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, scope) DO UPDATE SET
       person_id = excluded.person_id,
       text = excluded.text,
       max_chars = excluded.max_chars,
       model = excluded.model,
       source_hash = excluded.source_hash,
       generated_at = excluded.generated_at`,
  ).run(projectId, scope, personId, text, maxChars, model, sourceHash, generatedAt);
}

function clipGenerated(text: string, maxChars: number): string {
  let value = text.trim();
  value = value.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  if (!value) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function polishPrompt(text: string, maxChars: number): string {
  return [
    `你是 Mnemos 的项目记忆整理器。请把下面的最近项目记忆与洞见整理成一段不超过 ${maxChars} 个字符的中文记忆简报。`,
    '只保留跨任务可复用的决策、约定、领域事实、架构关系、踩坑与流程；删去任务流水、重复内容和一次性细节。',
    '直接输出简报正文，不要标题、不要 Markdown 代码块、不要解释，不要调用工具。',
    '',
    '最近记忆与洞见：',
    text.slice(0, 12_000),
  ].join('\n');
}

interface BriefContext {
  /** 人级简报的主体（内部 id） */
  subjectPersonId?: string;
  /** 调用方本人（内部 id，用于可见性） */
  callerPersonId?: string | null;
}

function withPerson(result: MemoryBrief, personId?: string): MemoryBrief {
  if (personId) result.personId = personId;
  return result;
}

async function generateBrief(
  deps: BriefDeps,
  input: MemoryBriefInput,
  scope: string,
  context: BriefContext,
): Promise<MemoryBrief> {
  const includePrivate = input.includePrivate === true;
  const settings = loadSettings(deps.db, input.projectId);
  const maxChars = clampBriefChars(input.maxChars ?? settings.briefMaxChars);
  const built = buildBriefText(deps.db, input.projectId, {
    maxChars,
    agentId: input.agentId,
    includePrivate,
    subjectPersonId: context.subjectPersonId,
    callerPersonId: context.callerPersonId ?? null,
  });
  const sourceHash = sourceHashOf(maxChars, built.items);
  const cacheRow = readCache(deps.db, input.projectId, scope);

  if (!input.force && cacheRow && cacheRow.max_chars === maxChars && cacheRow.source_hash === sourceHash) {
    return withPerson(
      {
        projectId: input.projectId,
        text: cacheRow.text,
        maxChars,
        count: built.count,
        model: cacheRow.model,
        cached: true,
        generatedAt: cacheRow.generated_at,
        recent: built.items,
      },
      context.subjectPersonId,
    );
  }

  const generatedAt = nowIso();
  if (built.count === 0) {
    saveCache(deps.db, input.projectId, scope, context.subjectPersonId ?? null, '', maxChars, CONDENSE_MODEL, sourceHash, generatedAt);
    return withPerson(
      {
        projectId: input.projectId,
        text: '',
        maxChars,
        count: 0,
        model: CONDENSE_MODEL,
        cached: false,
        generatedAt,
        recent: [],
      },
      context.subjectPersonId,
    );
  }

  let text = built.text;
  let model = CONDENSE_MODEL;
  if (input.allowLlm === true && deps.llm) {
    const generated = await llmText(deps.llm, {
      prompt: polishPrompt(built.text, maxChars),
      system: '你是严谨的中文记忆整理助手，只输出简报正文。',
      maxChars: maxChars + 200,
      timeoutMs: LLM_TIMEOUT_MS,
    });
    const polished = clipGenerated(generated, maxChars);
    if (polished) {
      text = polished;
      model = deps.llm.model;
    }
  }

  saveCache(
    deps.db,
    input.projectId,
    scope,
    context.subjectPersonId ?? null,
    text,
    maxChars,
    model,
    sourceHash,
    generatedAt,
  );
  return withPerson(
    {
      projectId: input.projectId,
      text,
      maxChars,
      count: built.count,
      model,
      cached: false,
      generatedAt,
      recent: built.items,
    },
    context.subjectPersonId,
  );
}

/** 读取（必要时重新生成）记忆简报；同 scope 并发去重。 */
export async function ensureBrief(deps: BriefDeps, input: MemoryBriefInput): Promise<MemoryBrief> {
  const personRef = typeof input.personId === 'string' ? input.personId.trim() : '';
  const subject = personRef ? resolvePerson(deps.db, input.projectId, personRef) : null;
  if (personRef && !subject) throw notFound('人不存在');
  const caller = input.agentId ? resolvePerson(deps.db, input.projectId, input.agentId, { type: 'agent' }) : null;

  const context: BriefContext = {
    subjectPersonId: subject?.id,
    callerPersonId: caller?.id ?? null,
  };
  const scope = scopeOf(input, subject?.id);
  const key = `${input.projectId}:${scope}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = generateBrief(deps, input, scope, context);
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

/** 供测试/诊断使用：清空进程内并发去重表（不影响数据库缓存）。 */
export function resetBriefInFlight(): void {
  inFlight.clear();
}

/** 缓存指纹算法（导出便于测试断言确定性）。 */
export const briefSourceHash = sourceHashOf;
