import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from './ids.ts';

export interface UsageInput {
  orgId?: string;
  projectId: string;
  apiKeyId?: string;
  channel: 'console' | 'api' | 'playground' | 'system';
  operation: string;
  method?: string;
  path?: string;
  status?: number;
  latencyMs?: number;
  resultCount?: number;
  memoryTokens?: number;
  actor?: string;
}

export function recordUsage(db: DatabaseSync, input: UsageInput): void {
  db.prepare(
    `INSERT INTO usage_events
      (id, org_id, project_id, api_key_id, channel, operation, method, path,
       status, latency_ms, result_count, memory_tokens, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('use'),
    input.orgId ?? null,
    input.projectId,
    input.apiKeyId ?? null,
    input.channel,
    input.operation,
    input.method ?? 'POST',
    input.path ?? '',
    input.status ?? 200,
    Math.max(0, Math.round(input.latencyMs ?? 0)),
    input.resultCount ?? 0,
    input.memoryTokens ?? 0,
    input.actor ?? 'system',
    nowIso(),
  );
}

/** 粗略 token 估算：中文按 1.5 字符/token，英文按 4 字符/token。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.round(cjk / 1.5 + rest / 4));
}
