/**
 * 任务会话（Task）。
 *
 * 任务是一段有开始/结束的 Agent 工作上下文：记忆通过 task_id 归因到任务，
 * 任务结束时把决策/经验/备注沉淀为项目共享记忆（见 service.finishTask）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Actor, Task, TaskInput, TaskStatus } from '../../../shared/src/types.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { notFound, unprocessable } from './errors.ts';

export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  status: string;
  owner_agent_id: string | null;
  branch: string | null;
  summary: string | null;
  metadata: string;
  created_at: string;
  started_at: string;
  ended_at: string | null;
  memory_count?: number;
  agent_count?: number;
  owner_name?: string | null;
}

const STATUSES: TaskStatus[] = ['open', 'active', 'done', 'abandoned'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 任务查询：附带记忆数、参与 Agent 数与 owner 名称（避免路由层再做 N+1）。 */
const TASK_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM memories m
      WHERE m.project_id = t.project_id AND m.task_id = t.id AND m.status = 'active') AS memory_count,
    (SELECT COUNT(DISTINCT m.agent_id) FROM memories m
      WHERE m.project_id = t.project_id AND m.task_id = t.id AND m.status = 'active' AND m.agent_id IS NOT NULL) AS agent_count,
    (SELECT a.name FROM agents a WHERE a.project_id = t.project_id AND a.id = t.owner_agent_id) AS owner_name
  FROM tasks t`;

function asStatus(value: unknown, fallback: TaskStatus): TaskStatus {
  return typeof value === 'string' && (STATUSES as string[]).includes(value) ? (value as TaskStatus) : fallback;
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    status: asStatus(row.status, 'open'),
    ownerAgentId: row.owner_agent_id ?? undefined,
    ownerAgentName: row.owner_name ?? undefined,
    branch: row.branch ?? undefined,
    summary: row.summary ?? undefined,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    memoryCount: Number(row.memory_count ?? 0),
    agentCount: Number(row.agent_count ?? 0),
  };
}

export function findTaskRow(db: DatabaseSync, projectId: string, taskId: string): TaskRow | undefined {
  return db.prepare(`${TASK_SELECT} WHERE t.project_id = ? AND t.id = ?`).get(projectId, taskId) as unknown as
    | TaskRow
    | undefined;
}

export function listTasks(
  db: DatabaseSync,
  projectId: string,
  params: { status?: TaskStatus; agentId?: string; limit?: number } = {},
): Task[] {
  const where: string[] = ['t.project_id = ?'];
  const args: (string | number)[] = [projectId];
  if (params.status) {
    where.push('t.status = ?');
    args.push(params.status);
  }
  if (params.agentId) {
    where.push(
      `(t.owner_agent_id = ?
        OR EXISTS (SELECT 1 FROM memories m WHERE m.project_id = t.project_id AND m.task_id = t.id AND m.agent_id = ?))`,
    );
    args.push(params.agentId, params.agentId);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
  const rows = db
    .prepare(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.started_at DESC, t.created_at DESC, t.id DESC LIMIT ?`)
    .all(...args, limit) as unknown as TaskRow[];
  return rows.map(mapTask);
}

export function getTask(db: DatabaseSync, projectId: string, taskId: string): Task | null {
  const row = findTaskRow(db, projectId, taskId);
  return row ? mapTask(row) : null;
}

function requireOwnerAgent(db: DatabaseSync, projectId: string, ownerAgentId: string): void {
  const row = db.prepare('SELECT id FROM agents WHERE project_id = ? AND id = ?').get(projectId, ownerAgentId) as unknown as
    | { id: string }
    | undefined;
  if (!row) throw unprocessable(`ownerAgentId 不存在于该项目：${ownerAgentId}`);
}

export function createTask(db: DatabaseSync, projectId: string, input: TaskInput, _actor: Actor): Task {
  const title = (input.title ?? '').trim();
  if (!title) throw unprocessable('任务标题不能为空');
  if (input.status !== undefined && !(STATUSES as string[]).includes(input.status)) {
    throw unprocessable(`任务 status 不合法：${String(input.status)}`);
  }
  if (input.ownerAgentId) requireOwnerAgent(db, projectId, input.ownerAgentId);

  const at = nowIso();
  const status = asStatus(input.status, 'active');
  const endedAt = status === 'done' || status === 'abandoned' ? at : null;
  const id = newId('task');
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, goal, status, owner_agent_id, branch, summary, metadata, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    title,
    (input.goal ?? '').trim(),
    status,
    input.ownerAgentId ?? null,
    input.branch?.trim() || null,
    null,
    JSON.stringify(input.metadata ?? {}),
    at,
    at,
    endedAt,
  );

  const row = findTaskRow(db, projectId, id);
  if (!row) throw notFound('任务创建失败');
  return mapTask(row);
}

export interface TaskPatch {
  title?: string;
  goal?: string;
  status?: TaskStatus;
  branch?: string | null;
  ownerAgentId?: string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
}

/** 应用任务字段更新（updateTask / finishTask 共用）。调用方负责事务边界。 */
export function applyTaskPatch(db: DatabaseSync, projectId: string, taskId: string, patch: TaskPatch): void {
  const row = findTaskRow(db, projectId, taskId);
  if (!row) throw notFound('任务不存在');

  const title = patch.title === undefined ? row.title : patch.title.trim();
  if (!title) throw unprocessable('任务标题不能为空');
  if (patch.status !== undefined && !(STATUSES as string[]).includes(patch.status)) {
    throw unprocessable(`任务 status 不合法：${String(patch.status)}`);
  }
  if (patch.ownerAgentId) requireOwnerAgent(db, projectId, patch.ownerAgentId);

  const status = patch.status ?? asStatus(row.status, 'open');
  let endedAt = row.ended_at;
  if (status === 'done' || status === 'abandoned') {
    if (!endedAt) endedAt = nowIso();
  } else {
    endedAt = null;
  }

  const goal = patch.goal === undefined ? row.goal : patch.goal.trim();
  const branch = patch.branch === undefined ? row.branch : patch.branch?.trim() || null;
  const ownerAgentId = patch.ownerAgentId === undefined ? row.owner_agent_id : patch.ownerAgentId;
  const summary = patch.summary === undefined ? row.summary : patch.summary;
  const metadata = patch.metadata === undefined ? row.metadata : JSON.stringify(patch.metadata ?? {});

  db.prepare(
    `UPDATE tasks SET title = ?, goal = ?, status = ?, owner_agent_id = ?, branch = ?, summary = ?, metadata = ?, ended_at = ?
     WHERE project_id = ? AND id = ?`,
  ).run(title, goal, status, ownerAgentId, branch, summary, metadata, endedAt, projectId, taskId);
}

export function updateTask(
  db: DatabaseSync,
  projectId: string,
  taskId: string,
  input: Partial<TaskInput> & { summary?: string },
  _actor: Actor,
): Task {
  applyTaskPatch(db, projectId, taskId, {
    title: input.title,
    goal: input.goal,
    status: input.status,
    branch: input.branch,
    ownerAgentId: input.ownerAgentId,
    summary: input.summary,
    metadata: input.metadata,
  });
  const row = findTaskRow(db, projectId, taskId);
  if (!row) throw notFound('任务不存在');
  return mapTask(row);
}
