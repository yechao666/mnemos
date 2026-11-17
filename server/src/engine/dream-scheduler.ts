import type { DatabaseSync } from 'node:sqlite';
import type { MemoryService } from '../../../shared/src/types.ts';
import type { Logger } from '../contracts.ts';
import { parseSettings, type PartitionRow } from './rows.ts';

export interface DreamSchedulerDeps {
  db: DatabaseSync;
  engine: MemoryService;
  logger: Logger;
  /** tick 间隔（毫秒，默认 60s） */
  tickMs?: number;
}

/**
 * 分区级做梦调度：按分区的 dreamEnabled / dreamIntervalMinutes 触发。
 * 单人级不做调度（由人的活跃度驱动，按需 run）。启动后首个 tick 延迟一个周期。
 */
export function startDreamScheduler(deps: DreamSchedulerDeps): () => void {
  const { db, engine, logger } = deps;
  const tickMs = Math.max(5_000, deps.tickMs ?? 60_000);
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const partitions = db.prepare("SELECT * FROM partitions WHERE status = 'active'").all() as unknown as PartitionRow[];
      const now = Date.now();
      for (const partition of partitions) {
        const settings = parseSettings(partition.settings);
        if (!settings.dreamEnabled) continue;
        const last = db
          .prepare(
            `SELECT finished_at FROM dream_runs
              WHERE partition_id = ? AND person_id IS NULL AND status IN ('completed', 'skipped')
              ORDER BY started_at DESC, rowid DESC LIMIT 1`,
          )
          .get(partition.id) as unknown as { finished_at: string | null } | undefined;
        if (last?.finished_at) {
          const lastMs = Date.parse(last.finished_at);
          if (Number.isFinite(lastMs) && now - lastMs < settings.dreamIntervalMinutes * 60_000) continue;
        }
        try {
          const result = await engine.dream(
            { partitionId: partition.id, trigger: 'schedule' },
            { type: 'system', id: 'system', label: '做梦调度' },
          );
          if (result.run && result.run.status === 'completed') {
            logger.info('dream.scheduled_completed', {
              partitionId: partition.id,
              runId: result.run.id,
              inputCount: result.run.inputCount,
            });
          }
        } catch (error) {
          logger.warn('dream.scheduled_failed', {
            partitionId: partition.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn('dream.scheduler_tick_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => void tick(), tickMs);
  timer.unref();

  return () => clearInterval(timer);
}
