import type { DatabaseSync } from 'node:sqlite';
import type {
  CategoryCount,
  DashboardSummary,
  EntityRef,
  Org,
  Project,
  ProjectOverview,
  ProjectStats,
  ProjectSummary,
  User,
} from '../../../../shared/src/types.ts';
import type { AppContext } from '../../contracts.ts';
import { visibleProjects } from '../middleware/auth.ts';
import { toApiKey, toEntityRef, toMemory, type ApiKeyRow, type EntityRow, type MemoryRow } from '../mappers.ts';
import { projectAuditLogs, scopedAuditLogs } from './audit.ts';
import { computeProjectStats } from './stats.ts';
import { aggregateUsageTotals, usagePoints } from './usage.ts';

/** 面向控制台的聚合查询：项目摘要、项目概览、仪表盘。 */

function inClause(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function countRows(db: DatabaseSync, sql: string, ...args: Array<string | number>): number {
  const row = db.prepare(sql).get(...args) as unknown as { c: number } | undefined;
  return row?.c ?? 0;
}

export function projectMembersCount(db: DatabaseSync, projectId: string): number {
  return countRows(db, 'SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?', projectId);
}

export function projectActiveKeysCount(db: DatabaseSync, projectId: string): number {
  return countRows(
    db,
    'SELECT COUNT(*) AS c FROM api_keys WHERE project_id = ? AND revoked_at IS NULL',
    projectId,
  );
}

export function projectSummary(app: AppContext, project: Project): ProjectSummary {
  return {
    ...project,
    stats: computeProjectStats(app.db, project),
    members: projectMembersCount(app.db, project.id),
    keys: projectActiveKeysCount(app.db, project.id),
  };
}

export function projectSummaries(app: AppContext, projects: Project[]): ProjectSummary[] {
  return projects.map((project) => projectSummary(app, project));
}

export function categoryCounts(db: DatabaseSync, projectIds: string[]): CategoryCount[] {
  if (projectIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT category AS name, COUNT(*) AS count
         FROM memories
        WHERE status = 'active' AND project_id IN (${inClause(projectIds.length)})
        GROUP BY category
        ORDER BY count DESC`,
    )
    .all(...projectIds) as unknown as CategoryCount[];
  return rows;
}

export function topEntities(db: DatabaseSync, projectId: string, limit = 8): EntityRef[] {
  const rows = db
    .prepare('SELECT * FROM entities WHERE project_id = ? ORDER BY mention_count DESC, name ASC LIMIT ?')
    .all(projectId, limit) as unknown as EntityRow[];
  return rows.map(toEntityRef);
}

export function projectHealth(
  app: AppContext,
  stats: ProjectStats,
  activeKeys: number,
): ProjectOverview['health'] {
  let dbOk = true;
  let dbDetail = 'SQLite · WAL 正常';
  try {
    app.db.prepare('SELECT 1 AS ok').get();
  } catch (error) {
    dbOk = false;
    dbDetail = `SQLite 异常：${error instanceof Error ? error.message : String(error)}`;
  }
  const engineOk = typeof app.engine?.search === 'function' && typeof app.engine?.list === 'function';

  const checks: ProjectOverview['health']['checks'] = [
    { name: '数据库', ok: dbOk, detail: dbDetail },
    { name: '记忆引擎', ok: engineOk, detail: engineOk ? '混合检索引擎就绪' : '记忆引擎未就绪' },
    {
      name: '月度配额',
      ok: stats.quotaUsedPct < 90,
      detail: `已用 ${stats.quotaUsedPct}%`,
    },
    {
      name: 'API 密钥',
      ok: activeKeys > 0,
      detail: activeKeys > 0 ? `${activeKeys} 个可用密钥` : '尚未创建 API 密钥',
    },
  ];

  return { status: checks.every((check) => check.ok) ? 'healthy' : 'degraded', checks };
}

export function projectOverview(app: AppContext, project: Project): ProjectOverview {
  const stats = computeProjectStats(app.db, project);
  const keyRows = app.db
    .prepare(
      `SELECT * FROM api_keys WHERE project_id = ?
        ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 10`,
    )
    .all(project.id) as unknown as ApiKeyRow[];
  const memoryRows = app.db
    .prepare(
      `SELECT * FROM memories WHERE project_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 6`,
    )
    .all(project.id) as unknown as MemoryRow[];

  return {
    stats,
    usage: usagePoints(app.db, [project.id], 30),
    categories: categoryCounts(app.db, [project.id]),
    topEntities: topEntities(app.db, project.id, 8),
    recentActivity: projectAuditLogs(app.db, project.id, 8),
    recentMemories: memoryRows.map(toMemory),
    keys: keyRows.map(toApiKey),
    health: projectHealth(app, stats, keyRows.filter((row) => !row.revoked_at).length),
  };
}

export function dashboardSummary(app: AppContext, user: User, org: Org): DashboardSummary {
  const projects = visibleProjects(app, user);
  const summaries = projectSummaries(app, projects);
  const projectIds = projects.map((project) => project.id);
  const usageTotals = aggregateUsageTotals(app.db, projectIds);

  let users = 0;
  let agents = 0;
  if (projectIds.length > 0) {
    const scopeRow = app.db
      .prepare(
        `SELECT COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT agent_id) AS agents
           FROM memories
          WHERE status = 'active' AND project_id IN (${inClause(projectIds.length)})`,
      )
      .get(...projectIds) as unknown as { users: number; agents: number } | undefined;
    users = scopeRow?.users ?? 0;
    agents = scopeRow?.agents ?? 0;
  }

  const totals: DashboardSummary['totals'] = {
    projects: summaries.length,
    memories: summaries.reduce((sum, project) => sum + project.stats.memories, 0),
    users,
    agents,
    searches7d: usageTotals.searches7d,
    adds7d: usageTotals.adds7d,
    tokensSaved: usageTotals.tokensSaved,
    p50: usageTotals.p50,
    errorRate: usageTotals.errorRate,
  };

  const topProjects = [...summaries]
    .sort((a, b) => b.stats.memories - a.stats.memories)
    .slice(0, 5)
    .map((project) => ({
      id: project.id,
      name: project.name,
      memories: project.stats.memories,
      slug: project.slug,
    }));

  return {
    org,
    totals,
    usage: usagePoints(app.db, projectIds, 30),
    projects: summaries,
    // 仪表盘只展示有业务含义的近期操作，登录/登出属于噪音
    recentActivity: scopedAuditLogs(app.db, { projectIds, orgId: org.id, limit: 24 })
      .filter((log) => !log.action.startsWith('auth.'))
      .slice(0, 12),
    topProjects,
    categoryMix: categoryCounts(app.db, projectIds),
  };
}
