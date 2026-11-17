import type { Actor, Partition } from '../../../../shared/src/types.ts';
import { actorForApiKey, actorForUser, type RequestContext } from '../context.ts';
import { assertQuota, evaluatePartitionQuota } from '../../platform/quota.ts';
import { requireApiKeyPartition, requireConsolePartition } from '../middleware/auth.ts';
import { HttpError } from '../respond.ts';

/** 路由层公共辅助：actor、分区解析、用量登记。 */

export function actorOf(rc: RequestContext): Actor {
  const auth = rc.auth;
  if (!auth) return { type: 'system', id: 'system', label: 'system' };
  if (auth.kind === 'user') return actorForUser(rc, auth.user);
  return actorForApiKey(rc, auth.key, auth.partition);
}

export function partitionOfPath(rc: RequestContext, name = 'partition'): Partition {
  const ref = rc.params[name];
  if (!ref) throw new HttpError(400, 'BAD_REQUEST', `缺少路径参数 ${name}`);
  if (rc.auth?.kind === 'api_key') return requireApiKeyPartition(rc, ref);
  return requireConsolePartition(rc, ref);
}

export function partitionOfPathForWrite(rc: RequestContext, name = 'partition'): Partition {
  const ref = rc.params[name];
  if (!ref) throw new HttpError(400, 'BAD_REQUEST', `缺少路径参数 ${name}`);
  if (rc.auth?.kind === 'api_key') return requireApiKeyPartition(rc, ref);
  return requireConsolePartition(rc, ref, 'developer');
}

export function markUsage(
  rc: RequestContext,
  partition: Partition,
  operation: string,
  channel: 'console' | 'api',
  resultCount = 0,
): void {
  rc.markUsage({ partitionId: partition.id, operation, channel, orgId: partition.orgId });
  rc.noteUsage(resultCount);
}

export function partitionRefOf(rc: RequestContext, name = 'partition'): string {
  return rc.params[name] ?? '';
}

/** 写入前检查月度 quota（memory_tokens）；超限抛 429 QUOTA_EXCEEDED。 */
export function enforceQuota(rc: RequestContext, partition: Partition): void {
  if (!rc.app.env.quotaEnforce) return;
  const state = evaluatePartitionQuota(rc.app.db, partition);
  if (!state.exceeded) return;
  rc.res.setHeader('retry-after', String(state.retryAfter));
  assertQuota(state);
}
