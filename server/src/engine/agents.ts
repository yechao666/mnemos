/**
 * Agent 注册表（Agent 原生模型的执行主体）。
 *
 * 一个 Agent 属于唯一项目，按 (project_id, name) 唯一；stats 由记忆与任务实时聚合：
 *  - memories       该 Agent 写入且仍为 active 的记忆数
 *  - privateMemories 其中 visibility='agent' 的私有记忆数
 *  - tasks          该 Agent 拥有、或在该任务下写入过记忆的任务数
 *  - lastTaskAt     上述任务的最近开始时间
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Actor, Agent, AgentInput, AgentStatus } from '../../../shared/src/types.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { conflict, notFound, unprocessable } from './errors.ts';

export interface AgentRow {
  id: string;
  project_id: string;
  name: string;
  role: string;
  model: string;
  description: string;
  capabilities: string;
  status: string;
  metadata: string;
  created_at: string;
  last_active_at: string | null;
}

const STATUSES: AgentStatus[] = ['active', 'idle', 'retired'];

function asStatus(value: unknown, fallback: AgentStatus): AgentStatus {
  return typeof value === 'string' && (STATUSES as string[]).includes(value) ? (value as AgentStatus) : fallback;
}

function parseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function cleanCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

interface AgentStatsRow {
  memories: number;
  private_memories: number;
}

interface AgentTaskStatsRow {
  tasks: number;
  last_task_at: string | null;
}

/** 实时聚合 Agent 统计（Agent 数量通常为几十级，逐条查询足够）。 */
export function loadAgentStats(db: DatabaseSync, projectId: string, agentId: string): Agent['stats'] {
  const memory = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS memories,
         COALESCE(SUM(CASE WHEN status = 'active' AND visibility = 'agent' THEN 1 ELSE 0 END), 0) AS private_memories
       FROM memories WHERE project_id = ? AND agent_id = ?`,
    )
    .get(projectId, agentId) as unknown as AgentStatsRow | undefined;

  const tasks = db
    .prepare(
      `SELECT COUNT(*) AS tasks, MAX(t.started_at) AS last_task_at
         FROM tasks t
        WHERE t.project_id = ?
          AND (t.owner_agent_id = ?
               OR EXISTS (SELECT 1 FROM memories m WHERE m.project_id = t.project_id AND m.task_id = t.id AND m.agent_id = ?))`,
    )
    .get(projectId, agentId, agentId) as unknown as AgentTaskStatsRow | undefined;

  return {
    memories: Number(memory?.memories ?? 0),
    privateMemories: Number(memory?.private_memories ?? 0),
    tasks: Number(tasks?.tasks ?? 0),
    lastTaskAt: tasks?.last_task_at ?? undefined,
  };
}

export function mapAgent(row: AgentRow, stats: Agent['stats']): Agent {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    role: row.role,
    model: row.model,
    description: row.description,
    capabilities: parseArray(row.capabilities),
    status: asStatus(row.status, 'active'),
    metadata: parseObject(row.metadata),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at ?? undefined,
    stats,
  };
}

function findAgentRow(db: DatabaseSync, projectId: string, agentId: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE project_id = ? AND id = ?').get(projectId, agentId) as unknown as
    | AgentRow
    | undefined;
}

export function listAgents(db: DatabaseSync, projectId: string): Agent[] {
  const rows = db
    .prepare(
      `SELECT * FROM agents WHERE project_id = ?
       ORDER BY last_active_at IS NULL, last_active_at DESC, created_at ASC, name ASC`,
    )
    .all(projectId) as unknown as AgentRow[];
  return rows.map((row) => mapAgent(row, loadAgentStats(db, projectId, row.id)));
}

export function getAgent(db: DatabaseSync, projectId: string, agentId: string): Agent | null {
  const row = findAgentRow(db, projectId, agentId);
  if (!row) return null;
  return mapAgent(row, loadAgentStats(db, projectId, row.id));
}

/** 创建 Agent；名称在项目内唯一，重复时抛 409。 */
export function createAgent(db: DatabaseSync, projectId: string, input: AgentInput, _actor: Actor): Agent {
  const name = (input.name ?? '').trim();
  if (!name) throw unprocessable('Agent 名称不能为空');
  if (input.status !== undefined && !(STATUSES as string[]).includes(input.status)) {
    throw unprocessable(`Agent status 不合法：${String(input.status)}`);
  }

  const existing = db.prepare('SELECT id FROM agents WHERE project_id = ? AND name = ?').get(projectId, name) as unknown as
    | { id: string }
    | undefined;
  if (existing) throw conflict(`Agent 名称已存在：${name}`);

  const at = nowIso();
  const id = newId('agent');
  db.prepare(
    `INSERT INTO agents (id, project_id, name, role, model, description, capabilities, status, metadata, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    name,
    input.role?.trim() || 'assistant',
    input.model?.trim() || 'deepseek-chat',
    (input.description ?? '').trim(),
    JSON.stringify(cleanCapabilities(input.capabilities)),
    asStatus(input.status, 'active'),
    JSON.stringify(input.metadata ?? {}),
    at,
    at,
  );

  const row = findAgentRow(db, projectId, id);
  if (!row) throw notFound('Agent 创建失败');
  return mapAgent(row, loadAgentStats(db, projectId, id));
}

/** 部分更新 Agent；只覆盖显式提供的字段。 */
export function updateAgent(db: DatabaseSync, projectId: string, agentId: string, input: Partial<AgentInput>, _actor: Actor): Agent {
  const row = findAgentRow(db, projectId, agentId);
  if (!row) throw notFound('Agent 不存在');

  const name = input.name === undefined ? row.name : input.name.trim();
  if (!name) throw unprocessable('Agent 名称不能为空');
  if (name !== row.name) {
    const clash = db.prepare('SELECT id FROM agents WHERE project_id = ? AND name = ? AND id <> ?').get(projectId, name, agentId) as unknown as
      | { id: string }
      | undefined;
    if (clash) throw conflict(`Agent 名称已存在：${name}`);
  }
  if (input.status !== undefined && !(STATUSES as string[]).includes(input.status)) {
    throw unprocessable(`Agent status 不合法：${String(input.status)}`);
  }

  const role = input.role === undefined ? row.role : input.role.trim() || 'assistant';
  const model = input.model === undefined ? row.model : input.model.trim() || 'deepseek-chat';
  const description = input.description === undefined ? row.description : input.description.trim();
  const capabilities = input.capabilities === undefined ? row.capabilities : JSON.stringify(cleanCapabilities(input.capabilities));
  const status = input.status === undefined ? row.status : asStatus(input.status, 'active');
  const metadata = input.metadata === undefined ? row.metadata : JSON.stringify(input.metadata ?? {});

  db.prepare(
    `UPDATE agents SET name = ?, role = ?, model = ?, description = ?, capabilities = ?, status = ?, metadata = ? WHERE project_id = ? AND id = ?`,
  ).run(name, role, model, description, capabilities, status, metadata, projectId, agentId);

  const updated = findAgentRow(db, projectId, agentId);
  if (!updated) throw notFound('Agent 不存在');
  return mapAgent(updated, loadAgentStats(db, projectId, agentId));
}

/** 记录 Agent 最近活跃时间（记忆写入/更新时调用；项目内不存在该 Agent 时静默忽略）。 */
export function touchAgent(db: DatabaseSync, projectId: string, agentId: string, at: string = nowIso()): void {
  db.prepare('UPDATE agents SET last_active_at = ? WHERE project_id = ? AND id = ?').run(at, projectId, agentId);
}
