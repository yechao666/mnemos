/**
 * 引擎测试夹具：内存 SQLite + 组织/分区行 + 服务实例。
 */

import { DatabaseSync } from 'node:sqlite';
import type { Actor, AddMemoryInput, MemoryService, Partition } from '../../../shared/src/types.ts';
import { migrate } from '../db/index.ts';
import { createMemoryService } from './index.ts';

export const ACTOR: Actor = { type: 'user', id: 'usr_test', label: '测试用户' };

export interface Fixture {
  db: DatabaseSync;
  svc: MemoryService;
  orgId: string;
  partitionId: string;
  partition: Partition;
  actor: Actor;
}

export function setup(options: { settings?: Record<string, unknown>; slug?: string; orgId?: string } = {}): Fixture {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const at = new Date().toISOString();
  const orgId = options.orgId ?? 'org_test';
  db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
    orgId,
    '测试组织',
    `test-org-${options.slug ?? 'test'}`,
    'enterprise',
    at,
  );
  const svc = createMemoryService(db);
  const partition = svc.upsertPartition(orgId, {
    slug: options.slug ?? 'test',
    name: '测试分区',
    settings: options.settings,
  }, ACTOR);
  return { db, svc, orgId, partitionId: partition.id, partition, actor: ACTOR };
}

/** 用默认 partitionId / actor 调 addMemory。 */
export function addMemory(
  fx: Fixture,
  input: Omit<AddMemoryInput, 'partitionId' | 'actor'> & { content: string },
) {
  return fx.svc.addMemory({ partitionId: fx.partitionId, actor: fx.actor, ...input });
}

export function createPerson(fx: Fixture, externalId: string, type: 'human' | 'agent' | 'service' = 'human') {
  return fx.svc.upsertPerson(fx.partitionId, { externalId, type, displayName: externalId }, fx.actor);
}

export function setCreatedAt(db: DatabaseSync, table: 'memories' | 'persons', id: string, iso: string): void {
  db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(iso, id);
}

/** 取单值聚合查询的数字结果。 */
export function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as unknown as Record<string, unknown> | undefined;
  return Number(row ? Object.values(row)[0] ?? 0 : 0);
}
