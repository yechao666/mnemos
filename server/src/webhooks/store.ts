import type { DatabaseSync } from 'node:sqlite';
import type { WebhookDeliveryStatus, WebhookStats } from '../../../shared/src/types.ts';
import { isoDaysAgo } from '../lib/ids.ts';
import type { WebhookDeliveryRow, WebhookRow } from './mappers.ts';

/** Webhook 持久化查询（全部参数化 SQL；调用方负责权限校验）。 */

export function getWebhookRow(db: DatabaseSync, id: string): WebhookRow | null {
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as unknown as WebhookRow | undefined;
  return row ?? null;
}

export function listWebhookRows(db: DatabaseSync, projectId: string): WebhookRow[] {
  return db
    .prepare('SELECT * FROM webhooks WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(projectId) as unknown as WebhookRow[];
}

export function getDeliveryRow(db: DatabaseSync, id: string): WebhookDeliveryRow | null {
  const row = db
    .prepare('SELECT * FROM webhook_deliveries WHERE id = ?')
    .get(id) as unknown as WebhookDeliveryRow | undefined;
  return row ?? null;
}

export interface DeliveryListOptions {
  status?: WebhookDeliveryStatus;
  page: number;
  pageSize: number;
}

export function listDeliveryRows(
  db: DatabaseSync,
  webhookId: string,
  options: DeliveryListOptions,
): { rows: WebhookDeliveryRow[]; total: number } {
  const where = options.status ? 'webhook_id = ? AND status = ?' : 'webhook_id = ?';
  const params: (string | number)[] = options.status ? [webhookId, options.status] : [webhookId];
  const countRow = db
    .prepare(`SELECT COUNT(*) AS total FROM webhook_deliveries WHERE ${where}`)
    .get(...params) as unknown as { total: number } | undefined;
  const rows = db
    .prepare(
      `SELECT * FROM webhook_deliveries WHERE ${where}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, options.pageSize, (options.page - 1) * options.pageSize) as unknown as WebhookDeliveryRow[];
  return { rows, total: Number(countRow?.total ?? 0) };
}

interface StatsRow {
  total: number | null;
  success: number | null;
  failed: number | null;
  dead: number | null;
  pending: number | null;
  avg_latency: number | null;
}

/** 按项目汇总投递结果（项目内所有 webhook 合计）。 */
export function computeWebhookStats(db: DatabaseSync, projectId: string): WebhookStats {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) AS dead,
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END), 0) AS avg_latency
       FROM webhook_deliveries
       WHERE project_id = ?`,
    )
    .get(projectId) as unknown as StatsRow | undefined;

  const last24hRow = db
    .prepare('SELECT COUNT(*) AS total FROM webhook_deliveries WHERE project_id = ? AND created_at >= ?')
    .get(projectId, isoDaysAgo(1)) as unknown as { total: number } | undefined;

  return {
    total: Number(row?.total ?? 0),
    success: Number(row?.success ?? 0),
    failed: Number(row?.failed ?? 0),
    dead: Number(row?.dead ?? 0),
    pending: Number(row?.pending ?? 0),
    avgLatencyMs: Math.round(Number(row?.avg_latency ?? 0)),
    last24h: Number(last24hRow?.total ?? 0),
  };
}

/** 待投递队列深度（Gauge 用）：含待重试的 failed。 */
export function countQueuedDeliveries(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM webhook_deliveries WHERE status IN ('pending', 'failed')")
    .get() as unknown as { total: number } | undefined;
  return Number(row?.total ?? 0);
}
