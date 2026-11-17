import type { Project } from '../../../shared/src/types.ts';
import type { RequestContext } from './context.ts';
import { requireApiKeyPartition } from './middleware/auth.ts';

/**
 * `/v1/partitions/:partition/...` 的公共入口：
 * 1) 按 id 或 slug 解析分区（project key 仅自身分区，org key 任意本组织分区）；
 * 2) 把分区挂到请求上下文（配额/用量/审计都依赖 rc.project）；
 * 3) 登记本次 API 用量（新路由不使用 router meta 的自动用量，因为分区在 handler 才确定）。
 */
export function bindPartition(rc: RequestContext, ref: string, operation: string): Project {
  const partition = requireApiKeyPartition(rc, ref);
  rc.project = partition;
  rc.markUsage({ projectId: partition.id, operation, channel: 'api', orgId: partition.orgId });
  return partition;
}
