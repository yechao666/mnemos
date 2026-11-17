import type { DatabaseSync } from 'node:sqlite';
import type { MaintenanceRun, OpsMaintenanceInput, OpsMaintenanceResult } from '../../../shared/src/types.ts';
import type { Logger, MaintenanceController, Metrics } from '../contracts.ts';
import { tx } from '../db/index.ts';
import type { Env } from '../env.ts';
import { writeAudit } from '../lib/audit.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { parseSettings, type PartitionRow } from '../engine/rows.ts';

/**
 * 数据维护调度器（v6）：
 *  - 过期记忆（expires_at）归档；
 *  - 分区 retentionDays 之外的记忆归档；
 *  - 软删除（status=deleted）满 30 天物理清理；
 *  - 过期控制台会话（user_sessions）清理；
 *  - WAL checkpoint 与可选 VACUUM。
 */

const FIRST_RUN_DELAY_MS = 60_000;
const SOFT_DELETE_RETENTION_DAYS = 30;

export interface MaintenanceDeps {
  db: DatabaseSync;
  env: Env;
  logger: Logger;
  metrics: Metrics;
}

interface SummaryCounts {
  expiredArchived: number;
  retentionArchived: number;
  deletedPurged: number;
  sessionsPurged: number;
  walCheckpointed: boolean;
  vacuumed: boolean;
}

interface MaintenanceRow {
  id: string;
  kind: string;
  status: string;
  summary: string;
  actor: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function isoDaysAgo(days: number, from = Date.now()): string {
  return new Date(from - days * 86_400_000).toISOString();
}

function toRun(row: MaintenanceRow): MaintenanceRun {
  let summary: Record<string, unknown> = {};
  try {
    summary = JSON.parse(row.summary) as Record<string, unknown>;
  } catch {
    summary = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status === 'success' || row.status === 'failed' ? row.status : 'running',
    summary,
    actor: row.actor ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

export function createMaintenanceController(deps: MaintenanceDeps): MaintenanceController {
  const { db, env, logger, metrics } = deps;

  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function insertRun(id: string, kind: string, startedAt: string, actor?: string): void {
    db.prepare(
      `INSERT INTO maintenance_runs (id, kind, status, summary, actor, started_at)
       VALUES (?, ?, 'running', '{}', ?, ?)`,
    ).run(id, kind, actor ?? null, startedAt);
  }

  function finishRun(
    id: string,
    status: 'success' | 'failed',
    summary: Record<string, unknown>,
    error?: string,
  ): void {
    db.prepare(
      `UPDATE maintenance_runs SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?`,
    ).run(status, JSON.stringify(summary), error ?? null, nowIso(), id);
  }

  function auditRun(id: string, actor: string | undefined, result: OpsMaintenanceResult): void {
    try {
      writeAudit(db, {
        actor: actor
          ? { type: 'user', id: 'ops', label: actor }
          : { type: 'system', id: 'system', label: 'system' },
        action: 'ops.maintenance',
        resourceType: 'maintenance_run',
        resourceId: id,
        detail: { ...result },
      });
    } catch (error) {
      logger.warn('maintenance.audit_failed', { runId: id, error });
    }
  }

  function retentionPartitions(): PartitionRow[] {
    return db.prepare('SELECT * FROM partitions').all() as unknown as PartitionRow[];
  }

  function countExpired(now: string): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM memories
          WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <> '' AND expires_at < ?`,
      )
      .get(now) as unknown as { c: number } | undefined;
    return row?.c ?? 0;
  }

  function countRetention(now: string): number {
    let total = 0;
    for (const partition of retentionPartitions()) {
      const days = parseSettings(partition.settings).retentionDays;
      if (days <= 0) continue;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories
            WHERE partition_id = ? AND status = 'active' AND created_at < ?`,
        )
        .get(partition.id, isoDaysAgo(days, Date.parse(now))) as unknown as { c: number } | undefined;
      total += row?.c ?? 0;
    }
    return total;
  }

  function countDeleted(cutoff: string): number {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE status = 'deleted' AND updated_at < ?")
      .get(cutoff) as unknown as { c: number } | undefined;
    return row?.c ?? 0;
  }

  function countExpiredSessions(now: string): number {
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM user_sessions WHERE expires_at < ?')
      .get(now) as unknown as { c: number } | undefined;
    return row?.c ?? 0;
  }

  async function execute(
    input: OpsMaintenanceInput,
    actor: string | undefined,
    kind: string,
  ): Promise<OpsMaintenanceResult> {
    const startedWall = Date.now();
    const startedAt = nowIso();
    const dryRun = input.dryRun === true;
    const runId = newId('mnt');
    insertRun(runId, kind, startedAt, actor);

    try {
      const counts: SummaryCounts = dryRun
        ? {
            expiredArchived: countExpired(startedAt),
            retentionArchived: countRetention(startedAt),
            deletedPurged: countDeleted(isoDaysAgo(SOFT_DELETE_RETENTION_DAYS, Date.parse(startedAt))),
            sessionsPurged: countExpiredSessions(startedAt),
            walCheckpointed: false,
            vacuumed: false,
          }
        : tx(db, () => {
            const now = nowIso();
            const expiredArchived = Number(
              db
                .prepare(
                  `UPDATE memories SET status = 'archived', updated_at = ?
                    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <> '' AND expires_at < ?`,
                )
                .run(now, now).changes,
            );

            let retentionArchived = 0;
            for (const partition of retentionPartitions()) {
              const days = parseSettings(partition.settings).retentionDays;
              if (days <= 0) continue;
              retentionArchived += Number(
                db
                  .prepare(
                    `UPDATE memories SET status = 'archived', updated_at = ?
                      WHERE partition_id = ? AND status = 'active' AND created_at < ?`,
                  )
                  .run(now, partition.id, isoDaysAgo(days, Date.parse(now))).changes,
              );
            }

            const deletedPurged = Number(
              db
                .prepare("DELETE FROM memories WHERE status = 'deleted' AND updated_at < ?")
                .run(isoDaysAgo(SOFT_DELETE_RETENTION_DAYS, Date.parse(now))).changes,
            );
            const sessionsPurged = Number(
              db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(now).changes,
            );

            return {
              expiredArchived,
              retentionArchived,
              deletedPurged,
              sessionsPurged,
              walCheckpointed: false,
              vacuumed: false,
            };
          });

      if (!dryRun) {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          counts.walCheckpointed = true;
        } catch (error) {
          logger.warn('maintenance.wal_checkpoint_failed', { runId, error });
        }
        if (input.vacuum === true) {
          try {
            db.exec('VACUUM');
            counts.vacuumed = true;
          } catch (error) {
            logger.warn('maintenance.vacuum_failed', { runId, error });
          }
        }
      }

      const durationMs = Date.now() - startedWall;
      const result: OpsMaintenanceResult = {
        runId,
        dryRun,
        expiredArchived: counts.expiredArchived + counts.retentionArchived,
        deletedPurged: counts.deletedPurged,
        sessionsPurged: counts.sessionsPurged,
        walCheckpointed: counts.walCheckpointed,
        vacuumed: counts.vacuumed,
        durationMs,
      };
      const summary: Record<string, unknown> = {
        ...result,
        expiredByTtl: counts.expiredArchived,
        archivedByRetention: counts.retentionArchived,
        softDeleteRetentionDays: SOFT_DELETE_RETENTION_DAYS,
      };
      finishRun(runId, 'success', summary);
      metrics.counter('mnemos_maintenance_runs_total', { status: 'success', dryRun: String(dryRun) });
      metrics.gauge('mnemos_maintenance_last_duration_ms', durationMs);
      if (!dryRun) auditRun(runId, actor, result);
      logger.info('maintenance.completed', {
        runId,
        kind,
        dryRun,
        durationMs,
        expiredArchived: result.expiredArchived,
        deletedPurged: result.deletedPurged,
        sessionsPurged: result.sessionsPurged,
        walCheckpointed: result.walCheckpointed,
        vacuumed: result.vacuumed,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        finishRun(runId, 'failed', { durationMs: Date.now() - startedWall }, message);
      } catch {
        /* 数据库可能已不可用 */
      }
      metrics.counter('mnemos_maintenance_runs_total', { status: 'failed', dryRun: String(dryRun) });
      logger.error('maintenance.failed', { runId, kind, error });
      throw error;
    }
  }

  async function tick(kind: string): Promise<void> {
    if (running) return;
    running = true;
    try {
      await execute({}, undefined, kind);
    } catch {
      /* 失败已写入 maintenance_runs 与日志，调度器继续运行 */
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (intervalTimer || initialTimer) return;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      void tick('scheduled');
    }, FIRST_RUN_DELAY_MS);
    initialTimer.unref();
    intervalTimer = setInterval(() => {
      void tick('scheduled');
    }, Math.max(60_000, env.maintenanceIntervalMs));
    intervalTimer.unref();
    logger.info('maintenance.scheduled', { intervalMs: env.maintenanceIntervalMs, firstRunDelayMs: FIRST_RUN_DELAY_MS });
  }

  function stop(): void {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  function history(limit = 20): MaintenanceRun[] {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
    const rows = db
      .prepare('SELECT * FROM maintenance_runs ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(safeLimit) as unknown as MaintenanceRow[];
    return rows.map(toRun);
  }

  async function run(input: OpsMaintenanceInput = {}, actor?: string): Promise<OpsMaintenanceResult> {
    const kind = input.dryRun === true ? 'dry-run' : 'manual';
    return execute(input, actor, kind);
  }

  return { start, stop, run, history };
}
