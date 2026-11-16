/**
 * 任务简报（briefing）：Agent 接入的关键 API。
 *
 * 目标：新接手的 Agent 只调用一次即可拿到「项目背景 + 约定 + 决策 + 经验 + 事故 + 私有笔记 + 待办任务」，
 * 输出为可直接注入系统提示词的中文 Markdown，并在预算内做确定性截断。
 *
 * 记忆检索一律使用项目共享视角（不按调用方 agentId 过滤），私有记忆只会出现在 agent_notes 段落。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  Agent,
  Briefing,
  BriefingBrief,
  BriefingInput,
  BriefingSection,
  BriefingSectionKey,
  ListMemoriesInput,
  Memory,
  MemoryCategory,
  Paginated,
  SearchHit,
  SearchMemoryInput,
  SearchResponse,
  Task,
} from '../../../shared/src/types.ts';
import { nowIso } from '../lib/ids.ts';
import { estimateTokens } from '../lib/usage.ts';
import { getAgent } from './agents.ts';
import { buildBriefText } from './brief.ts';
import { notFound } from './errors.ts';
import { loadSettings } from './store.ts';
import { getTask, listTasks } from './tasks.ts';

export interface BriefingDeps {
  db: DatabaseSync;
  search: (input: SearchMemoryInput) => Promise<SearchResponse>;
  list: (input: ListMemoriesInput) => Promise<Paginated<Memory>>;
}

const DEFAULT_BUDGET_TOKENS = 1200;
const MIN_BUDGET_TOKENS = 80;
const MAX_CITATIONS = 20;
const OPEN_TASKS_LIMIT = 5;

interface ProjectBriefingSource {
  id: string;
  name: string;
  description: string;
}

interface SectionSpec {
  key: BriefingSectionKey;
  title: string;
  description: string;
  query: string;
  categories: MemoryCategory[];
  topK: number;
  /** 分类命中不足时用不限分类的检索补齐（conventions/decisions 用）。 */
  fill: boolean;
}

function uniqHits(hits: SearchHit[], topK: number): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const hit of hits) {
    const current = byId.get(hit.id);
    if (!current || hit.score > current.score) byId.set(hit.id, hit);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 按分类分别检索后合并去重；fill 时用一次不限分类检索补齐。 */
async function collectHits(
  deps: BriefingDeps,
  projectId: string,
  query: string,
  topK: number,
  categories: MemoryCategory[],
  fill: boolean,
  includePrivate: boolean,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for (const category of categories) {
    const response = await deps.search({ projectId, query, topK, includePrivate, filters: { category } });
    hits.push(...response.results);
  }
  if (categories.length === 0 || (fill && uniqHits(hits, topK).length < Math.min(3, topK))) {
    const response = await deps.search({ projectId, query, topK, includePrivate });
    hits.push(...response.results);
  }
  return uniqHits(hits, topK);
}

/** 最近写入的 Agent 私有记忆（列表查询，不参与混合检索）。 */
async function loadAgentNotes(
  deps: BriefingDeps,
  projectId: string,
  agentId: string,
): Promise<SearchHit[]> {
  const page = await deps.list({
    projectId,
    agentId,
    visibility: 'agent',
    includePrivate: true,
    sort: 'recent',
    page: 1,
    pageSize: OPEN_TASKS_LIMIT,
  });
  return page.items.map((memory) => toSyntheticHit(memory));
}

/** 私有笔记不参与检索打分：合成一个中性的 SearchHit，保持 DTO 一致。 */
function toSyntheticHit(memory: Memory): SearchHit {
  return {
    ...memory,
    score: 0,
    signals: { semantic: 0, keyword: 0, entity: 0, recency: 0, importance: memory.importance },
    matchedOn: ['recent'],
    entities: [],
  };
}

/** 本项目 open/active 任务（最多 5 条），用于 prompt 中的任务清单。 */
function loadOpenTasks(db: DatabaseSync, projectId: string): Task[] {
  const open = listTasks(db, projectId, { status: 'open', limit: OPEN_TASKS_LIMIT });
  const active = listTasks(db, projectId, { status: 'active', limit: OPEN_TASKS_LIMIT });
  return [...active, ...open]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))
    .slice(0, OPEN_TASKS_LIMIT);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sourceOf(hit: Memory): string {
  const agent = hit.agentId ?? 'project';
  const task = hit.taskId ?? 'project';
  const date = (hit.createdAt ?? '').slice(0, 10);
  return `from: ${agent} / ${task} / ${date}`;
}

function hitLine(hit: Memory): string {
  return `- [${hit.id}] ${oneLine(hit.content)}（${sourceOf(hit)}）`;
}

function openTaskLine(task: Task): string {
  const owner = task.ownerAgentName ?? task.ownerAgentId ?? '未指派';
  return `- ${task.id} · ${oneLine(task.title)}（owner: ${owner}，${task.status}）`;
}

export async function buildBriefing(deps: BriefingDeps, input: BriefingInput): Promise<Briefing> {
  const started = performance.now();
  const builtAt = nowIso();
  const project = deps.db
    .prepare('SELECT id, name, description FROM projects WHERE id = ?')
    .get(input.projectId) as unknown as ProjectBriefingSource | undefined;
  if (!project) throw notFound('项目不存在');

  const agent: Agent | null = input.agentId ? getAgent(deps.db, input.projectId, input.agentId) : null;
  if (input.agentId && !agent) throw notFound('Agent 不存在');
  const task: Task | null = input.taskId ? getTask(deps.db, input.projectId, input.taskId) : null;
  if (input.taskId && !task) throw notFound('任务不存在');

  const includePrivate = input.includePrivate === true;
  const experienceQuery =
    input.query?.trim() ||
    (task ? [task.title, task.goal].filter((part) => part.length > 0).join(' ') : '') ||
    '项目经验 实践 复盘';

  // 记忆简报：项目开启 briefEnabled 时，把最近记忆/洞见压缩成一段固定格式文本，
  // 同时注入 prompt（不调 LLM、不写缓存）并出现在响应 brief 字段里。
  const settings = loadSettings(deps.db, input.projectId);
  let brief: BriefingBrief | undefined;
  if (settings.briefEnabled !== false) {
    const built = buildBriefText(deps.db, input.projectId, {
      maxChars: settings.briefMaxChars,
      agentId: input.agentId,
      includePrivate: input.includePrivate ?? false,
    });
    if (built.count > 0) {
      brief = { text: built.text, maxChars: settings.briefMaxChars, count: built.count };
    }
  }

  const specs: SectionSpec[] = [
    {
      key: 'project',
      title: '项目背景',
      description: '项目描述、目标与必须遵守的边界',
      query: '项目背景与目标',
      categories: ['identity', 'constraint'],
      topK: 5,
      fill: true,
    },
    {
      key: 'conventions',
      title: '编码约定',
      description: '编码规范、流程、测试与命名约束',
      query: '编码规范 约定 流程 测试 命名',
      categories: ['constraint'],
      topK: 4,
      fill: true,
    },
    {
      key: 'decisions',
      title: '架构决策',
      description: '已确定的架构方案、技术选型与计划',
      query: '架构决策 方案 选型',
      categories: ['decision', 'fact', 'plan'],
      topK: 5,
      fill: true,
    },
    {
      key: 'experience',
      title: '相关经验',
      description: '与当前任务/查询最相关的项目内经验',
      query: experienceQuery,
      categories: [],
      topK: 5,
      fill: false,
    },
    {
      key: 'incidents',
      title: '事故与故障',
      description: '线上事故、故障、回滚与告警记录',
      query: '故障 事故 回滚 告警 线上问题',
      categories: ['event'],
      topK: 3,
      fill: false,
    },
  ];

  const sections: BriefingSection[] = [];
  for (const spec of specs) {
    const hits = await collectHits(deps, input.projectId, spec.query, spec.topK, spec.categories, spec.fill, includePrivate);
    sections.push({ key: spec.key, title: spec.title, description: spec.description, hits });
  }

  if (agent) {
    const notes = await loadAgentNotes(deps, input.projectId, agent.id);
    sections.push({
      key: 'agent_notes',
      title: 'Agent 私有笔记',
      description: '该 Agent 的私有记忆（仅本人可见）',
      hits: notes,
    });
  } else {
    sections.push({
      key: 'agent_notes',
      title: 'Agent 私有笔记',
      description: '该 Agent 的私有记忆（仅本人可见）',
      hits: [],
    });
  }

  const openTasks = loadOpenTasks(deps.db, input.projectId);
  sections.push({
    key: 'open_tasks',
    title: '进行中任务',
    description: '项目内 open/active 任务清单',
    hits: [],
  });

  /* ---------------- prompt 组装（按 token 预算确定性截断） ---------------- */

  const budget = Math.max(MIN_BUDGET_TOKENS, Math.round(input.budgetTokens ?? DEFAULT_BUDGET_TOKENS));
  const lines: string[] = [];
  const citations: string[] = [];

  function pushLine(line: string): boolean {
    const next = lines.length === 0 ? line : `${lines.join('\n')}\n${line}`;
    if (estimateTokens(next) > budget && lines.length > 0) return false;
    lines.push(line);
    return true;
  }

  function pushTruncated(text: string): void {
    let value = text;
    while (value.length > 0) {
      if (pushLine(value)) return;
      value = value.slice(0, Math.floor(value.length / 2));
    }
  }

  pushLine(`# 项目简报：${project.name}`);
  pushLine('');
  pushTruncated(project.description.trim() ? oneLine(project.description) : '（暂无项目描述）');
  pushLine('');
  pushLine(`- 生成时间：${builtAt}`);
  pushLine(agent ? `- Agent：${agent.name}（${agent.role} · ${agent.model}）` : '- Agent：未指定');
  pushLine(
    task
      ? `- 当前任务：${task.title}（${task.id}）· ${task.status}${task.goal ? ` · ${oneLine(task.goal)}` : ''}`
      : '- 当前任务：未指定',
  );

  if (brief) {
    pushLine('');
    pushLine('## 记忆简报（最近记忆与洞见）');
    // 简报正文自带 `# 记忆简报…` 标题，这里去掉首行避免重复，其余按原文逐行注入。
    const body = brief.text.split('\n');
    if (body[0]?.startsWith('# 记忆简报')) body.shift();
    for (const line of body) {
      if (!pushLine(line)) break;
    }
  }

  const tasksSection = sections.find((section) => section.key === 'open_tasks');
  if (tasksSection) {
    pushLine('');
    pushLine(`## ${tasksSection.title}`);
    if (openTasks.length === 0) {
      pushLine('- （暂无进行中任务）');
    } else {
      for (const item of openTasks) pushLine(openTaskLine(item));
    }
  }

  for (const section of sections) {
    if (section.key === 'open_tasks') continue;
    const collected = section.hits;
    const kept: SearchHit[] = [];
    pushLine('');
    pushLine(`## ${section.title}`);
    if (collected.length === 0) {
      pushLine('- （暂无）');
    } else {
      for (const hit of collected) {
        if (!pushLine(hitLine(hit))) break;
        kept.push(hit);
        if (citations.length < MAX_CITATIONS && !citations.includes(hit.id)) citations.push(hit.id);
      }
    }
    section.hits = kept;
  }

  const prompt = lines.join('\n');
  const tookMs = Math.round((performance.now() - started) * 10) / 10;

  const result: Briefing = {
    project: { id: project.id, name: project.name, description: project.description },
    sections,
    prompt,
    tokenEstimate: estimateTokens(prompt),
    citations,
    builtAt,
    tookMs,
  };
  if (agent) result.agent = agent;
  if (task) result.task = task;
  if (brief) result.brief = brief;
  return result;
}
