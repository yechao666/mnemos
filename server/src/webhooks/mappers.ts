import type {
  Webhook,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEventType,
  WebhookWithSecret,
} from '../../../shared/src/types.ts';
import { parseEventTypes } from './events.ts';

/** SQLite 行 → 领域 DTO（webhooks / webhook_deliveries）。 */

export interface WebhookRow {
  id: string;
  project_id: string;
  name: string;
  url: string;
  secret: string;
  event_types: string;
  enabled: number;
  description: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_delivery_at: string | null;
  last_status: number | null;
  failure_count: number;
  disabled_at: string | null;
}

export interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  project_id: string;
  event_type: string;
  event_id: string | null;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  response_status: number | null;
  response_body: string | null;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    url: row.url,
    eventTypes: parseEventTypes(row.event_types),
    enabled: row.enabled === 1,
    description: row.description,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastDeliveryAt: row.last_delivery_at ?? undefined,
    lastStatus: row.last_status ?? undefined,
    failureCount: row.failure_count,
    disabledAt: row.disabled_at ?? undefined,
  };
}

/** 仅创建/轮换响应使用；任何列表/查询都不得调用。 */
export function toWebhookWithSecret(row: WebhookRow): WebhookWithSecret {
  return { ...toWebhook(row), secret: row.secret };
}

export function toDelivery(row: WebhookDeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    projectId: row.project_id,
    eventType: row.event_type as WebhookEventType | 'webhook.test',
    eventId: row.event_id ?? undefined,
    payload: row.payload && row.payload.length > 16_384 ? `${row.payload.slice(0, 16_384)}…` : row.payload,
    status: row.status as WebhookDeliveryStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    responseStatus: row.response_status ?? undefined,
    responseBody: row.response_body ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
  };
}
