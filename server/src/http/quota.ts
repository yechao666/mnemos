import { assertQuota, evaluateProjectQuota } from '../platform/quota.ts';
import type { RequestContext } from './context.ts';

/**
 * 分区级写入配额检查。
 *
 * `server.ts` 只在路由 meta.operation='add' 时做自动检查（旧 v1 / 控制台路径）；
 * 中立 v1 的分区在 handler 内才解析出来，因此在 add handler 里显式调用本函数。
 * 配额口径与统计页一致（usage_events 本月 memory_tokens）。
 */
export function enforceProjectQuota(rc: RequestContext): void {
  if (!rc.app.env.quotaEnforce || !rc.project) return;
  const state = evaluateProjectQuota(rc.app.db, rc.project);
  if (!state.exceeded) return;
  rc.res.setHeader('retry-after', String(state.retryAfter));
  rc.app.metrics.counter('mnemos_quota_rejected_total');
  assertQuota(state);
}
