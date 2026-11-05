/**
 * 测试夹具：内存 SQLite + 组织/项目行 + 服务实例（供 engine*.test.ts 共用）。
 * 建 org/project 行是为了满足 memories.project_id 的外键约束。
 */

import { DatabaseSync } from 'node:sqlite';

import type { Actor, AddMemoryInput, MemoryService } from '../../../shared/src/types.ts';
import { migrate } from '../db/index.ts';
import { createMemoryService } from './index.ts';

export const ACTOR: Actor = { type: 'user', id: 'usr_test', label: '测试用户' };

export interface Fixture {
  db: DatabaseSync;
  svc: MemoryService;
  projectId: string;
  actor: Actor;
}

export function setup(options: { settings?: Record<string, unknown>; slug?: string } = {}): Fixture {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const at = new Date().toISOString();
  const projectId = `proj_${options.slug ?? 'test'}`;
  db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'org_test',
    '测试组织',
    `test-org-${options.slug ?? 'test'}`,
    'enterprise',
    at,
  );
  db.prepare(
    `INSERT INTO projects (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    'org_test',
    options.slug ?? 'test',
    '测试项目',
    '',
    'active',
    'cn-shanghai',
    'production',
    JSON.stringify(options.settings ?? {}),
    at,
    at,
  );
  return { db, svc: createMemoryService(db), projectId, actor: ACTOR };
}

/** 用默认 projectId / actor 调 add。 */
export async function addMemory(
  fx: Fixture,
  input: Omit<Partial<AddMemoryInput>, 'projectId' | 'actor'> & { text: string },
) {
  return fx.svc.add({ projectId: fx.projectId, actor: fx.actor, ...input });
}

export function setCreatedAt(db: DatabaseSync, id: string, iso: string): void {
  db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(iso, id);
}

/** 取单值聚合查询的数字结果。 */
export function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as unknown as Record<string, unknown> | undefined;
  return Number(row ? Object.values(row)[0] ?? 0 : 0);
}
