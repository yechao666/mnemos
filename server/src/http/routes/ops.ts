import { createReadStream, statSync } from 'node:fs';
import { z } from 'zod';
import { APP_VERSION, ROLE_RANK } from '../../../../shared/src/constants.ts';
import type { OpsStatus } from '../../../../shared/src/types.ts';
import { SCHEMA_VERSION, getSchemaVersion, tableCount } from '../../db/index.ts';
import { parseSettings, type PartitionRow } from '../../engine/rows.ts';
import { processJobsAsync } from '../../engine/jobs.ts';
import { createLlmRouter } from '../../engine/llm.ts';
import { requireConsoleAuth, type ConsoleAuth } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { RequestContext } from '../context.ts';
import type { Router } from '../router.ts';
import { startOfUtcMonth } from '../../platform/quota.ts';

/**
 * 运维路由（组织 admin+）：
 *  - GET  /healthz /readyz       存活 / 就绪探针
 *  - GET  /metrics               Prometheus 文本（无需鉴权，内网抓取）
 *  - GET  /api/ops/status        运行状态快照
 *  - GET/POST /api/ops/maintenance
 *  - POST /api/ops/backup / GET /api/ops/backups / GET /api/ops/backups/:file
 */

const maintenanceBodySchema = z.object({
  dryRun: z.boolean().optional(),
  vacuum: z.boolean().optional(),
});

const maintenanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const jobsTickSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function requireOpsAdmin(rc: RequestContext): ConsoleAuth {
  const auth = requireConsoleAuth(rc);
  if (ROLE_RANK[auth.user.role] < ROLE_RANK.admin) {
    throw errors.forbidden('该操作需要组织管理员（admin）及以上角色');
  }
  return auth;
}

function fileSize(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function journalMode(db: RequestContext['app']['db']): string {
  try {
    const row = db.prepare('PRAGMA journal_mode').get() as unknown as Record<string, unknown> | undefined;
    if (!row) return 'unknown';
    const value = Object.values(row)[0];
    return value === undefined ? 'unknown' : String(value);
  } catch {
    return 'unknown';
  }
}

function quotaTable(rc: RequestContext, partitions: PartitionRow[]): OpsStatus['quotas'] {
  const monthStart = startOfUtcMonth().toISOString();
  return partitions
    .map((partition) => {
      const settings = parseSettings(partition.settings);
      if (settings.monthlyQuota <= 0) return null;
      const row = rc.app.db
        .prepare(
          `SELECT COALESCE(SUM(memory_tokens), 0) AS used FROM usage_events
            WHERE partition_id = ? AND created_at >= ?`,
        )
        .get(partition.id, monthStart) as unknown as { used: number };
      const memories = rc.app.db
        .prepare('SELECT COUNT(*) AS c FROM memories WHERE partition_id = ?')
        .get(partition.id) as unknown as { c: number };
      const used = row.used;
      return {
        partitionId: partition.id,
        name: partition.name,
        usedTokens: used,
        monthlyQuota: settings.monthlyQuota,
        usedPct: settings.monthlyQuota > 0 ? Math.min(100, Math.round((used / settings.monthlyQuota) * 1000) / 10) : 0,
        memories: memories.c,
      };
    })
    .filter((row): row is OpsStatus['quotas'][number] => row !== null);
}

function retentionTable(rc: RequestContext, partitions: PartitionRow[]): OpsStatus['retention'] {
  return partitions
    .map((partition) => {
      const settings = parseSettings(partition.settings);
      if (settings.retentionDays <= 0) return null;
      const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000).toISOString();
      const row = rc.app.db
        .prepare(
          "SELECT COUNT(*) AS c FROM memories WHERE partition_id = ? AND status = 'active' AND created_at < ?",
        )
        .get(partition.id, cutoff) as unknown as { c: number };
      return {
        partitionId: partition.id,
        name: partition.name,
        retentionDays: settings.retentionDays,
        expiredMemories: row.c,
      };
    })
    .filter((row): row is OpsStatus['retention'][number] => row !== null);
}

export function registerOpsRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/healthz',
    auth: 'none',
    handler: (rc: RequestContext) => rc.json({ ok: true }),
  });

  router.add({
    method: 'GET',
    path: '/readyz',
    auth: 'none',
    handler: (rc: RequestContext) => {
      try {
        rc.app.db.prepare('SELECT 1 AS ok').get();
        rc.json({ ok: true });
      } catch {
        rc.json({ ok: false }, 503);
      }
    },
  });

  router.add({
    method: 'GET',
    path: '/metrics',
    auth: 'none',
    handler: (rc: RequestContext) => {
      rc.res.statusCode = 200;
      rc.res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      rc.res.end(rc.app.metrics.render());
    },
  });

  router.add({
    method: 'GET',
    path: '/api/ops/status',
    auth: 'console',
    handler: (rc: RequestContext) => {
      requireOpsAdmin(rc);
      const dbPath = rc.app.env.dbPath;
      const partitions = rc.app.db.prepare('SELECT * FROM partitions ORDER BY created_at ASC').all() as unknown as PartitionRow[];
      const status: OpsStatus = {
        version: APP_VERSION,
        node: process.version,
        env: rc.app.env.nodeEnv,
        startedAt: new Date(rc.app.startedAt).toISOString(),
        uptimeMs: Date.now() - rc.app.startedAt,
        database: {
          path: dbPath,
          sizeBytes: fileSize(dbPath),
          walSizeBytes: fileSize(`${dbPath}-wal`),
          schemaVersion: getSchemaVersion(rc.app.db) || SCHEMA_VERSION,
          journalMode: journalMode(rc.app.db),
        },
        counts: {
          orgs: tableCount(rc.app.db, 'orgs'),
          users: tableCount(rc.app.db, 'users'),
          partitions: tableCount(rc.app.db, 'partitions'),
          persons: tableCount(rc.app.db, 'persons'),
          memories: tableCount(rc.app.db, 'memories'),
          apiKeys: tableCount(rc.app.db, 'api_keys'),
          auditEvents: tableCount(rc.app.db, 'audit_logs'),
          usageEvents: tableCount(rc.app.db, 'usage_events'),
        },
        quotas: quotaTable(rc, partitions),
        retention: retentionTable(rc, partitions),
        backups: rc.app.platform.backups.list(),
        maintenance: rc.app.platform.maintenance.history(10),
        metrics: rc.app.metrics.snapshot(),
      };
      rc.json(status);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/ops/maintenance',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireOpsAdmin(rc);
      const body = await rc.body(maintenanceBodySchema);
      const result = await rc.app.platform.maintenance.run(body, auth.user.email);
      rc.json(result);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/ops/maintenance',
    auth: 'console',
    handler: (rc: RequestContext) => {
      requireOpsAdmin(rc);
      const query = rc.query(maintenanceQuerySchema);
      rc.json(rc.app.platform.maintenance.history(query.limit ?? 20));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/ops/jobs/tick',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      requireOpsAdmin(rc);
      const body = await rc.body(jobsTickSchema);
      const result = await processJobsAsync(rc.app.db, createLlmRouter(rc.app.db, rc.app.env.llm), { limit: body.limit ?? 10 });
      rc.json({ ...result, at: new Date().toISOString() });
    },
  });

  router.add({
    method: 'POST',
    path: '/api/ops/backup',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireOpsAdmin(rc);
      const info = await rc.app.platform.backups.create('manual', auth.user.email);
      rc.json(info, 201);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/ops/backups',
    auth: 'console',
    handler: (rc: RequestContext) => {
      requireOpsAdmin(rc);
      rc.json(rc.app.platform.backups.list());
    },
  });

  router.add({
    method: 'GET',
    path: '/api/ops/backups/:file',
    auth: 'console',
    handler: (rc: RequestContext) => {
      requireOpsAdmin(rc);
      const file = rc.params.file ?? '';
      const resolved = rc.app.platform.backups.pathOf(file);
      if (!resolved) throw errors.notFound('备份文件不存在');
      const stat = statSync(resolved);
      rc.res.statusCode = 200;
      rc.res.setHeader('content-type', 'application/octet-stream');
      rc.res.setHeader('content-length', String(stat.size));
      rc.res.setHeader('content-disposition', `attachment; filename="${file}"`);
      createReadStream(resolved).pipe(rc.res);
    },
  });
}
