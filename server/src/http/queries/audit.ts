import type { DatabaseSync } from 'node:sqlite';
import type { AuditLog, Paginated } from '../../../../shared/src/types.ts';
import { paginate } from '../respond.ts';
import { toAuditLog, type AuditRow } from '../mappers.ts';

/** 审计日志查询：项目分页列表 + 仪表盘/概览的最近活动。 */

export interface AuditQuery {
  projectId: string;
  page: number;
  pageSize: number;
  action?: string;
  actor?: string;
}

interface WhereParts {
  sql: string;
  args: Array<string | number>;
}

function buildWhere(query: Omit<AuditQuery, 'page' | 'pageSize'>): WhereParts {
  const clauses: string[] = ['project_id = ?'];
  const args: Array<string | number> = [query.projectId];
  if (query.action) {
    clauses.push('action LIKE ?');
    args.push(`${query.action}%`);
  }
  if (query.actor) {
    clauses.push('(actor_label LIKE ? OR actor_id = ?)');
    args.push(`%${query.actor}%`, query.actor);
  }
  return { sql: clauses.join(' AND '), args };
}

export function queryAuditLogs(db: DatabaseSync, query: AuditQuery): Paginated<AuditLog> {
  const where = buildWhere(query);
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE ${where.sql}`).get(...where.args) as unknown as
    | { c: number }
    | undefined;
  const total = totalRow?.c ?? 0;

  const rows = db
    .prepare(`SELECT * FROM audit_logs WHERE ${where.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...where.args, query.pageSize, (query.page - 1) * query.pageSize) as unknown as AuditRow[];

  return paginate(rows.map(toAuditLog), query.page, query.pageSize, total);
}

export function projectAuditLogs(db: DatabaseSync, projectId: string, limit = 12): AuditLog[] {
  const rows = db
    .prepare('SELECT * FROM audit_logs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(projectId, limit) as unknown as AuditRow[];
  return rows.map(toAuditLog);
}

/** 仪表盘：可见项目 + 组织级（无项目归属）审计。 */
export function scopedAuditLogs(
  db: DatabaseSync,
  options: { projectIds: string[]; orgId: string; limit: number },
): AuditLog[] {
  const { projectIds, orgId, limit } = options;
  let rows: AuditRow[];
  if (projectIds.length === 0) {
    rows = db
      .prepare(
        'SELECT * FROM audit_logs WHERE project_id IS NULL AND org_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(orgId, limit) as unknown as AuditRow[];
  } else {
    const placeholders = projectIds.map(() => '?').join(', ');
    rows = db
      .prepare(
        `SELECT * FROM audit_logs
          WHERE (project_id IN (${placeholders}) OR (project_id IS NULL AND org_id = ?))
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...projectIds, orgId, limit) as unknown as AuditRow[];
  }
  return rows.map(toAuditLog);
}
