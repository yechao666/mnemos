/**
 * 记忆做梦（dream）：增量记忆巩固。
 *
 * 只处理 dreamed_at 为空的新记忆，归纳为高层洞见（category=insight、source=dream），
 * 随后把这些记忆标记为已做梦；不重放旧记忆、不执行任务。
 *
 * 隐私边界：做梦只巩固 `visibility='project'` 的项目共享记忆；
 * agent 私有 / task 任务记忆不参与归纳，避免私有内容被写成项目共享洞见。
 *
 * 无 LLM 时用确定性规则归并（每批最多 1 条洞见）；LLM 输出严格 JSON，
 * 失败/格式不符时静默回退。洞见写入走引擎 add 路径（索引/实体/历史一致）。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  CATEGORY_LABEL,
  DREAM_BATCH_SIZE,
  DREAM_DEFAULT_INTERVAL_MINUTES,
  DREAM_MAX_BATCH_SIZE,
  DREAM_MAX_INSIGHTS,
  DREAM_MAX_INTERVAL_MINUTES,
  DREAM_MIN_INSIGHT_CHARS,
  DREAM_MIN_INTERVAL_MINUTES,
} from '../../../shared/src/constants.ts';
import type {
  Actor,
  AddMemoryInput,
  AddMemoryResult,
  MemoryCategory,
  MemoryDreamRun,
  MemoryDreamRunStatus,
  MemoryDreamSettings,
  MemoryDreamSettingsInput,
  MemoryDreamStatus,
  MemoryDreamTrigger,
} from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { notFound, unprocessable } from './errors.ts';
import { llmText } from './llm.ts';
import { contentHash, mergeSettings } from './store.ts';

/** 做梦调度器/手动触发时写入记忆的 actor。 */
export const DREAM_ACTOR: Actor = { type: 'system', id: 'dream', label: '复盘总结' };

const LLM_TIMEOUT_MS = 25_000;
const FALLBACK_MAX_CHARS = 4_000;
const BOILERPLATE_RE = /^(?:没有|暂无|本批没有|无有效|无新)/;

export interface DreamDeps {
  db: DatabaseSync;
  llm?: LlmConfig | null;
  /** 引擎 add 的闭包（保持索引/实体/历史一致）；测试可注入会抛错的实现。 */
  addMemory: (input: AddMemoryInput) => Promise<AddMemoryResult>;
}

interface DreamRunRow {
  id: string;
  project_id: string;
  trigger: string;
  status: string;
  input_count: number;
  insight_count: number;
  summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

interface DreamMemoryRow {
  id: string;
  content: string;
  category: string;
  created_at: string;
}

interface InsightDraft {
  title: string;
  content: string;
}

interface ProjectSettingsRow {
  id: string;
  settings: string;
}

/** 正在进行中的项目（进程内防并发）。 */
const runningProjects = new Set<string>();

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clampInterval(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DREAM_DEFAULT_INTERVAL_MINUTES;
  return Math.max(DREAM_MIN_INTERVAL_MINUTES, Math.min(DREAM_MAX_INTERVAL_MINUTES, numeric));
}

function clampBatch(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DREAM_BATCH_SIZE;
  return Math.max(1, Math.min(DREAM_MAX_BATCH_SIZE, numeric));
}

function mapRun(row: DreamRunRow): MemoryDreamRun {
  const run: MemoryDreamRun = {
    id: row.id,
    projectId: row.project_id,
    trigger: row.trigger as MemoryDreamTrigger,
    status: row.status as MemoryDreamRunStatus,
    inputCount: Number(row.input_count),
    insightCount: Number(row.insight_count),
    startedAt: row.started_at,
  };
  if (row.summary) run.summary = row.summary;
  if (row.error) run.error = row.error;
  if (row.finished_at) run.finishedAt = row.finished_at;
  return run;
}

function readRun(db: DatabaseSync, runId: string): MemoryDreamRun | undefined {
  const row = db.prepare('SELECT * FROM memory_dream_runs WHERE id = ?').get(runId) as unknown as DreamRunRow | undefined;
  return row ? mapRun(row) : undefined;
}

function parseSettingsJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 尚未做梦、且满足做梦批次条件的活跃记忆数（洞见本身不参与）。
 * 条件必须与 runDream 的批次查询一致：
 * - 只巩固 `visibility='project'` 的项目共享记忆（私有/任务记忆不参与，避免外泄）；
 * - 正文去空白后至少 10 个字符，否则 <10 字的记忆会让 pendingCount 永远 >0、
 *   调度器反复产生 skipped run。
 */
export function pendingDreamCount(db: DatabaseSync, projectId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM memories
        WHERE project_id = ? AND status = 'active' AND dreamed_at IS NULL AND category != 'insight'
          AND visibility = 'project' AND length(trim(content)) >= 10`,
    )
    .get(projectId) as unknown as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

/** 最近 10 次运行（新 → 旧）。 */
function recentRuns(db: DatabaseSync, projectId: string): MemoryDreamRun[] {
  const rows = db
    .prepare('SELECT * FROM memory_dream_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 10')
    .all(projectId) as unknown as DreamRunRow[];
  return rows.map(mapRun);
}

export function getDreamStatus(db: DatabaseSync, projectId: string): MemoryDreamStatus {
  const settings = mergeSettings(parseSettingsJson(readProjectSettings(db, projectId)));
  const runs = recentRuns(db, projectId);
  const dreamSettings: MemoryDreamSettings = {
    enabled: settings.dreamEnabled,
    intervalMinutes: clampInterval(settings.dreamIntervalMinutes),
  };
  if (runs[0]) dreamSettings.lastAt = runs[0].startedAt;

  const status: MemoryDreamStatus = {
    settings: dreamSettings,
    pendingCount: pendingDreamCount(db, projectId),
    runs,
  };
  if (runs[0]) status.lastRun = runs[0];
  return status;
}

function readProjectSettings(db: DatabaseSync, projectId: string): string | null {
  const row = db.prepare('SELECT settings FROM projects WHERE id = ?').get(projectId) as unknown as
    | { settings?: string }
    | undefined;
  return row?.settings ?? null;
}

/** 更新做梦开关与周期（写回 projects.settings JSON，保留其他字段）。 */
export function updateDreamSettings(
  db: DatabaseSync,
  projectId: string,
  input: MemoryDreamSettingsInput,
): MemoryDreamStatus {
  const row = db.prepare('SELECT id, settings FROM projects WHERE id = ?').get(projectId) as unknown as
    | ProjectSettingsRow
    | undefined;
  if (!row) throw notFound('项目不存在');

  const current = mergeSettings(parseSettingsJson(row.settings));
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : current.dreamEnabled;
  const interval = input.intervalMinutes === undefined ? clampInterval(current.dreamIntervalMinutes) : input.intervalMinutes;
  if (!Number.isInteger(interval) || interval < DREAM_MIN_INTERVAL_MINUTES || interval > DREAM_MAX_INTERVAL_MINUTES) {
    throw unprocessable(
      `复盘总结间隔必须在 ${DREAM_MIN_INTERVAL_MINUTES} 到 ${DREAM_MAX_INTERVAL_MINUTES} 分钟之间`,
    );
  }

  const settings = parseSettingsJson(row.settings);
  settings.dreamEnabled = enabled;
  settings.dreamIntervalMinutes = interval;
  db.prepare('UPDATE projects SET settings = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(settings),
    nowIso(),
    projectId,
  );
  return getDreamStatus(db, projectId);
}

/** 确定性回退：把有意义的记忆归并成 1 条洞见（≤4000 字）。 */
function fallbackInsights(rows: DreamMemoryRow[]): InsightDraft[] {
  const meaningful = rows.filter((row) => oneLine(row.content).length >= 10);
  if (meaningful.length === 0) return [];
  const lines = meaningful.map((row) => {
    const category = row.category as MemoryCategory;
    const label = CATEGORY_LABEL[category] ?? row.category;
    // 用「；」串成散文摘要：洞见正文本身会成为项目记忆/简报列表的一行，
    // 不再带「- 」前缀，避免在简报与表格里出现嵌套项目符号。
    return `[${label}] ${oneLine(row.content)}`;
  });
  return [
    {
      title: `记忆巩固 · ${nowIso().slice(0, 10)}`,
      content: lines.join('；').slice(0, FALLBACK_MAX_CHARS),
    },
  ];
}

function cleanJson(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function insightLines(rows: DreamMemoryRow[]): string {
  return rows
    .map((row) => {
      const category = row.category as MemoryCategory;
      const label = CATEGORY_LABEL[category] ?? row.category;
      return `- [${label}] ${oneLine(row.content)}`;
    })
    .join('\n');
}

interface Synthesis {
  summary: string;
  insights: InsightDraft[];
}

/** LLM 归纳；无 LLM / 失败 / 格式不符时回退确定性归并。 */
async function synthesize(deps: DreamDeps, rows: DreamMemoryRow[]): Promise<Synthesis> {
  const fallbackSummary = `已整理 ${rows.length} 条新记忆`;
  const fallback = fallbackInsights(rows);
  if (!deps.llm) return { summary: fallbackSummary, insights: fallback };

  const prompt = [
    '你在做项目记忆巩固（“做梦”）。只根据给定新记忆，归纳可复用的高层洞见。',
    '不要调用工具，不要编造未出现的事实。合并重复、指出决策与经验。',
    '只输出 JSON，格式：',
    '{"summary":"一句话总结","insights":[{"title":"短标题","content":"洞见正文"}]}',
    `最多 ${DREAM_MAX_INSIGHTS} 条 insights，content 至少 ${DREAM_MIN_INSIGHT_CHARS} 个字符。`,
    '没有跨任务可复用的有效洞见时返回空数组 []，不要为了凑数生成泛泛总结。',
    '',
    '新记忆：',
    insightLines(rows).slice(0, 30_000),
  ].join('\n');

  const output = await llmText(deps.llm, {
    prompt,
    system: '你是严谨的项目记忆巩固助手，只输出约定的 JSON。',
    maxChars: 30_000,
    timeoutMs: LLM_TIMEOUT_MS,
  });
  if (!output) return { summary: fallbackSummary, insights: fallback };

  try {
    const parsed = JSON.parse(cleanJson(output)) as { summary?: unknown; insights?: unknown };
    const insights = Array.isArray(parsed.insights)
      ? parsed.insights
          .filter((item): item is { title?: unknown; content?: unknown } => Boolean(item && typeof item === 'object'))
          .map((item) => ({
            title:
              typeof item.title === 'string' && item.title.trim()
                ? item.title.trim().slice(0, 200)
                : '记忆洞见',
            content: typeof item.content === 'string' ? item.content.trim() : '',
          }))
          .filter((item) => item.content.length >= DREAM_MIN_INSIGHT_CHARS)
          .filter((item) => !BOILERPLATE_RE.test(item.content))
          .slice(0, DREAM_MAX_INSIGHTS)
      : [];
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallbackSummary;
    return { summary, insights };
  } catch {
    return { summary: fallbackSummary, insights: fallback };
  }
}

/** 相同内容（归一化后）的活动记忆是否已存在 → 跳过重复洞见。 */
function duplicateInsight(db: DatabaseSync, projectId: string, content: string): boolean {
  const hash = contentHash(content);
  const row = db
    .prepare("SELECT 1 AS x FROM memories WHERE project_id = ? AND status = 'active' AND normalized_hash = ? LIMIT 1")
    .get(projectId, hash) as unknown as { x?: number } | undefined;
  return Boolean(row);
}

function markDreamed(db: DatabaseSync, projectId: string, ids: string[], at: string): void {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return;
  const placeholders = unique.map(() => '?').join(', ');
  db.prepare(`UPDATE memories SET dreamed_at = ? WHERE project_id = ? AND id IN (${placeholders})`).run(
    at,
    projectId,
    ...unique,
  );
}

/**
 * 执行一次增量做梦。同项目并发时返回 null（路由层转 409）。
 * trigger='manual' 失败会 rethrow；'schedule' 只记录 failed run，不抛。
 */
export async function runDream(
  deps: DreamDeps,
  projectId: string,
  trigger: MemoryDreamTrigger = 'manual',
  batchSize?: number,
): Promise<MemoryDreamRun | null> {
  if (runningProjects.has(projectId)) return null;
  runningProjects.add(projectId);

  const runId = newId('dream');
  const startedAt = nowIso();
  try {
    deps.db
      .prepare(
        `INSERT INTO memory_dream_runs (id, project_id, trigger, status, input_count, insight_count, started_at)
         VALUES (?, ?, ?, 'running', 0, 0, ?)`,
      )
      .run(runId, projectId, trigger, startedAt);

    // 只巩固项目共享记忆：agent/task 可见性的私有内容不得被归纳成项目共享洞见。
    const rows = deps.db
      .prepare(
        `SELECT id, content, category, created_at FROM memories
          WHERE project_id = ? AND status = 'active' AND dreamed_at IS NULL AND category != 'insight'
            AND visibility = 'project' AND length(trim(content)) >= 10
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(projectId, clampBatch(batchSize)) as unknown as DreamMemoryRow[];

    if (rows.length === 0) {
      const finishedAt = nowIso();
      deps.db
        .prepare("UPDATE memory_dream_runs SET status = 'skipped', summary = ?, finished_at = ? WHERE id = ?")
        .run('没有需要整理的新记忆', finishedAt, runId);
      return readRun(deps.db, runId) ?? null;
    }

    const synthesis = await synthesize(deps, rows);
    const now = nowIso();
    const insightMemoryIds: string[] = [];
    let insightCount = 0;
    for (const insight of synthesis.insights) {
      const content = insight.content.trim();
      if (content.length < DREAM_MIN_INSIGHT_CHARS) continue;
      if (BOILERPLATE_RE.test(content)) continue;
      if (duplicateInsight(deps.db, projectId, content)) continue;
      const result = await deps.addMemory({
        projectId,
        actor: DREAM_ACTOR,
        text: content,
        infer: false,
        source: 'dream',
        visibility: 'project',
        metadata: {
          category: 'insight',
          importance: 0.78,
          confidence: 0.8,
          dreamRunId: runId,
          sourceMemoryIds: rows.map((row) => row.id),
          dreamTitle: insight.title,
        },
      });
      if (result.results.length > 0) {
        insightCount += 1;
        insightMemoryIds.push(...result.results.map((memory) => memory.id));
      }
    }

    // 批次记忆与本次新增洞见都标记为已做梦，避免下次重复处理。
    markDreamed(deps.db, projectId, [...rows.map((row) => row.id), ...insightMemoryIds], now);

    const summary = insightCount > 0 ? synthesis.summary : '本批没有形成有效洞见';
    deps.db
      .prepare(
        `UPDATE memory_dream_runs
            SET status = 'completed', input_count = ?, insight_count = ?, summary = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(rows.length, insightCount, summary, now, runId);
    return readRun(deps.db, runId) ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = nowIso();
    try {
      deps.db
        .prepare("UPDATE memory_dream_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(message, finishedAt, runId);
    } catch {
      /* run 行可能尚未写入；忽略 */
    }
    if (trigger === 'manual') throw error;
    return readRun(deps.db, runId) ?? null;
  } finally {
    runningProjects.delete(projectId);
  }
}

/**
 * 调度器使用：开启做梦、存在可巩固的项目共享记忆、且距最近一次运行 ≥ intervalMinutes 的项目。
 * 只考虑 status='active' 的项目；归档/暂停项目不再做梦。
 */
export function dueDreamProjects(db: DatabaseSync, now: Date = new Date()): string[] {
  const rows = db
    .prepare("SELECT id, settings FROM projects WHERE status = 'active'")
    .all() as unknown as ProjectSettingsRow[];
  const pendingStmt = db.prepare(
    `SELECT 1 AS x FROM memories
      WHERE project_id = ? AND status = 'active' AND dreamed_at IS NULL AND category != 'insight'
        AND visibility = 'project' AND length(trim(content)) >= 10
      LIMIT 1`,
  );
  const lastStmt = db.prepare(
    'SELECT started_at FROM memory_dream_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1',
  );

  const due: string[] = [];
  for (const row of rows) {
    const settings = mergeSettings(parseSettingsJson(row.settings));
    if (!settings.dreamEnabled) continue;
    if (!pendingStmt.get(row.id)) continue;
    const last = lastStmt.get(row.id) as unknown as { started_at?: string } | undefined;
    if (last?.started_at) {
      const lastMs = Date.parse(last.started_at);
      if (Number.isFinite(lastMs) && now.getTime() - lastMs < clampInterval(settings.dreamIntervalMinutes) * 60_000) {
        continue;
      }
    }
    due.push(row.id);
  }
  return due;
}

/** 测试辅助：清空进程内并发集合（异常场景清理）。 */
export function resetDreamInFlight(): void {
  runningProjects.clear();
}
