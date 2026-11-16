/**
 * 记忆做梦调度器：按固定 tick 扫描到期项目并顺序执行增量做梦。
 *
 * - MNEMOS_DREAM_SCHEDULER=0/'' 时直接返回空停止函数（不注册定时器）；
 * - 每轮最多处理 5 个到期项目，busy 时不重入；
 * - 单个项目失败只记 warn，不中断同轮其它项目；
 * - 定时器 unref()，不阻止进程退出。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Actor, MemoryService } from '../../../shared/src/types.ts';
import type { Logger, Metrics } from '../contracts.ts';
import type { Env } from '../env.ts';
import { dueDreamProjects } from './dream.ts';

export interface DreamSchedulerOptions {
  db: DatabaseSync;
  env: Pick<Env, 'dreamSchedulerEnabled' | 'dreamTickMs'>;
  engine: MemoryService;
  logger: Logger;
  metrics?: Metrics;
}

const SCHEDULER_ACTOR: Actor = { type: 'system', id: 'dream-scheduler', label: '做梦调度器' };
const MAX_PROJECTS_PER_TICK = 5;
const MIN_TICK_MS = 5_000;
const DEFAULT_TICK_MS = 60_000;

/** 启动调度器，返回停止函数（幂等）。 */
export function startDreamScheduler(options: DreamSchedulerOptions): () => void {
  if (!options.env.dreamSchedulerEnabled) return () => {};

  const tickMs = Math.max(MIN_TICK_MS, Math.floor(options.env.dreamTickMs || DEFAULT_TICK_MS));
  let busy = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = (): void => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const due = dueDreamProjects(options.db).slice(0, MAX_PROJECTS_PER_TICK);
        for (const projectId of due) {
          const result = await options.engine.dream({ projectId, trigger: 'schedule' }, SCHEDULER_ACTOR);
          const run = result.run;
          if (run?.status === 'completed') {
            options.metrics?.counter('mnemos_dream_runs_total', { status: 'completed' });
            options.logger.info('记忆做梦完成', {
              projectId,
              inputCount: run.inputCount,
              insightCount: run.insightCount,
            });
          } else if (run?.status === 'failed') {
            options.metrics?.counter('mnemos_dream_runs_total', { status: 'failed' });
            options.logger.warn('记忆做梦失败', { projectId, error: run.error });
          }
        }
      } catch (error) {
        options.logger.warn('做梦调度失败', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        busy = false;
      }
    })();
  };

  timer = setInterval(tick, tickMs);
  timer.unref();

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
