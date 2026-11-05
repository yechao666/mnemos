import { createReadStream, statSync } from 'node:fs';
import { z } from 'zod';
import { APP_VERSION, ROLE_RANK } from '../../../../shared/src/constants.ts';
import type { OpsStatus } from '../../../../shared/src/types.ts';
import { SCHEMA_VERSION, getSchemaVersion, tableCount } from '../../db/index.ts';
import { parseSettings } from '../mappers.ts';
import { requireConsoleAuth, type ConsoleAuth } from '../middleware/auth.ts';
import { errors, sendError } from '../respond.ts';
import type { RequestContext } from '../context.ts';
import type { Router } from '../router.ts';
import { startOfUtcMonth } from '../../platform/quota.ts';

/**
 * 运维路由（组织 admin+）：
 *  - GET  /api/ops/status          运行状态快照（DB/WAL、schema、计数、配额、保留期、备份、维护、指标）
 *  - POST /api/ops/maintenance     手动维护（dryRun/vacuum）
 *  - GET  /api/ops/maintenance     维护历史
 *  - POST /api/ops/backup          立即备份
 *  - GET  /api/ops/backups         备份列表
 *  - GET  /api/ops/backups/:file   备份下载（仅文件名，防路径穿越）
 *  - GET  /metrics                 Prometheus 文本（无需鉴权，内网抓取）
 *  - GET  /healthz /readyz         存活 / 就绪探针
 */

const maintenanceBodySchema = z.object({
  dryRun: z.boolean().optional(),
  vacuum: z.boolean().optional(),
});

const maintenanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function requireOpsAdmin(rc: RequestContext): ConsoleAuth {
  const auth = requireConsoleAuth(rc);
  if (ROLE_RANK[auth.user.role] < ROLE_RANK.admin) {
    throw errors.forbidden('该操作需要组织管理员（admin）及以上角色');
  }
  return auth;
}

function actorLabel(auth: ConsoleAuth): string {
  return auth.user.name || auth.user.email;
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

interface QuotaSqlRow {
  id: string;
  name: string;
  settings: string;
  used: number;
  memories: number;
}

function quotaTable(db: RequestContext['app']['db'], orgId: string): OpsStatus['quotas'] {
  const monthStart = startOfUtcMonth().toISOString();
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.settings,
              COALESCE((SELECT SUM(u.memory_tokens) FROM usage_events u
                         WHERE u.project_id = p.id AND u.created_at >= ?), 0) AS used,
              (SELECT COUNT(*) FROM memories m
                WHERE m.project_id = p.id AND m.status = 'active') AS memories
         FROM projects p
        WHERE p.org_id = ?
        ORDER BY p.created_at ASC`,
    )
    .all(monthStart, orgId) as unknown as QuotaSqlRow[];

  return rows.map((row) => {
    const settings = parseSettings(row.settings);
    const quota = Number(settings.monthlyQuota ?? 0);
    const used = Number(row.used ?? 0);
    return {
      projectId: row.id,
      name: row.name,
      usedTokens: used,
      monthlyQuota: quota,
      usedPct: quota > 0 ? Math.round((used / quota) * 1_000) / 10 : 0,
      memories: Number(row.memories ?? 0),
    };
  });
}

interface RetentionSqlRow {
  id: string;
  name: string;
  settings: string;
}

function retentionTable(db: RequestContext['app']['db'], orgId: string): OpsStatus['retention'] {
  const rows = db
    .prepare('SELECT id, name, settings FROM projects WHERE org_id = ? ORDER BY created_at ASC')
    .all(orgId) as unknown as RetentionSqlRow[];

  return rows.map((row) => {
    const settings = parseSettings(row.settings);
    const retentionDays = Number(settings.retentionDays ?? 0);
    let expiredMemories = 0;
    if (retentionDays > 0) {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      const counted = db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories
            WHERE project_id = ? AND status = 'active' AND created_at < ?`,
        )
        .get(row.id, cutoff) as unknown as { c: number } | undefined;
      expiredMemories = counted?.c ?? 0;
    }
    return { projectId: row.id, name: row.name, retentionDays, expiredMemories };
  });
}

function rawResponse(rc: RequestContext, status: number, contentType: string, body: string): void {
  rc.res.statusCode = status;
  rc.res.setHeader('content-type', contentType);
  rc.res.setHeader('content-length', String(Buffer.byteLength(body)));
  rc.res.end(rc.req.method === 'HEAD' ? undefined : body);
}

export function registerOpsRoutes(router: Router): void {
  /* ----------------------------- 探针 ----------------------------- */

  router.add({
    method: 'GET',
    path: '/healthz',
    auth: 'none',
    handler: (rc: RequestContext) => {
      rc.json({ ok: true, status: 'alive', uptimeMs: Date.now() - rc.app.startedAt });
    },
  });

  router.add({
    method: 'GET',
    path: '/readyz',
    auth: 'none',
    handler: (rc: RequestContext) => {
      let dbOk = true;
      let dbDetail = 'ok';
      try {
        rc.app.db.prepare('SELECT 1 AS ok').get();
      } catch (error) {
        dbOk = false;
        dbDetail = error instanceof Error ? error.message : String(error);
      }
      const schemaVersion = getSchemaVersion(rc.app.db);
      const schemaOk = schemaVersion >= SCHEMA_VERSION;
      const engine = rc.app.engine;
      const engineOk = typeof engine?.add === 'function' && typeof engine?.search === 'function';
      const ready = dbOk && schemaOk && engineOk;
      rc.json(
        {
          ok: ready,
          status: ready ? 'ready' : 'not_ready',
          version: APP_VERSION,
          uptimeMs: Date.now() - rc.app.startedAt,
          checks: {
            db: { ok: dbOk, detail: dbDetail },
            schema: { ok: schemaOk, detail: `v${schemaVersion}（期望 v${SCHEMA_VERSION}）` },
            engine: { ok: engineOk, detail: engineOk ? 'ok' : '引擎不可用' },
          },
        },
        ready ? 200 : 503,
      );
    },
  });

  /* ----------------------------- 指标 ----------------------------- */

  router.add({
    method: 'GET',
    path: '/metrics',
    auth: 'none',
    handler: (rc: RequestContext) => {
      if (!rc.app.env.metricsEnabled) throw errors.notFound('性能指标端点未启用');
      rawResponse(rc, 200, 'text/plain; version=0.0.4; charset=utf-8', rc.app.metrics.render());
    },
  });

  /* ----------------------------- 状态 ----------------------------- */

  router.add({
    method: 'GET',
    path: '/api/ops/status',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireOpsAdmin(rc);
      const app = rc.app;
      const dbPath = app.env.dbPath;
      const status: OpsStatus = {
        version: APP_VERSION,
        node: process.version,
        env: app.env.nodeEnv,
        startedAt: new Date(app.startedAt).toISOString(),
        uptimeMs: Date.now() - app.startedAt,
        database: {
          path: dbPath,
          sizeBytes: fileSize(dbPath),
          walSizeBytes: fileSize(`${dbPath}-wal`),
          schemaVersion: getSchemaVersion(app.db),
          journalMode: journalMode(app.db),
        },
        counts: {
          orgs: tableCount(app.db, 'orgs'),
          users: tableCount(app.db, 'users'),
          projects: tableCount(app.db, 'projects'),
          memories: tableCount(app.db, 'memories'),
          agents: tableCount(app.db, 'agents'),
          tasks: tableCount(app.db, 'tasks'),
          apiKeys: tableCount(app.db, 'api_keys'),
          auditEvents: tableCount(app.db, 'audit_logs'),
          usageEvents: tableCount(app.db, 'usage_events'),
        },
        quotas: quotaTable(app.db, auth.user.orgId),
        retention: retentionTable(app.db, auth.user.orgId),
        backups: app.platform.backups.list(),
        maintenance: app.platform.maintenance.history(10),
        metrics: app.platform.metrics.snapshot(),
      };
      rc.json(status);
    },
  });

  /* ----------------------------- 维护 ----------------------------- */

  router.add({
    method: 'POST',
    path: '/api/ops/maintenance',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireOpsAdmin(rc);
      const input = await rc.body(maintenanceBodySchema);
      const result = await rc.app.platform.maintenance.run(
        { dryRun: input.dryRun === true, vacuum: input.vacuum === true },
        actorLabel(auth),
      );
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

  /* ----------------------------- 备份 ----------------------------- */

  router.add({
    method: 'POST',
    path: '/api/ops/backup',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireOpsAdmin(rc);
      const info = await rc.app.platform.backups.create('manual', actorLabel(auth));
      rc.json(info);
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
    handler: async (rc: RequestContext) => {
      requireOpsAdmin(rc);
      const fileName = rc.params.file ?? '';
      const fullPath = rc.app.platform.backups.pathOf(fileName);
      if (!fullPath) throw errors.notFound('备份文件不存在');

      let size = 0;
      try {
        size = statSync(fullPath).size;
      } catch {
        throw errors.notFound('备份文件不存在');
      }
      const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
      const res = rc.res;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', `attachment; filename="${safeName}"`);
      res.setHeader('content-length', String(size));

      const stream = createReadStream(fullPath);
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        stream.once('error', (error) => {
          rc.app.logger.error('ops.backup_stream_failed', { file: fileName, error });
          if (!res.headersSent) {
            sendError(res, rc.requestId, errors.internal('备份文件读取失败'));
          } else {
            res.destroy();
          }
          done();
        });
        res.once('finish', done);
        res.once('close', done);
        stream.pipe(res);
      });
    },
  });
}
