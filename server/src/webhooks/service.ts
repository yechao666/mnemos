import type { DatabaseSync } from 'node:sqlite';
import type {
  LiveEvent,
  WebhookDeliveryStatus,
  WebhookTestResult,
} from '../../../shared/src/types.ts';
import type { Logger, Metrics } from '../contracts.ts';
import { tx } from '../db/index.ts';
import type { Env } from '../env.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { attemptDelivery, type DeliveryAttemptResult } from './delivery.ts';
import {
  buildEventPayload,
  buildTestPayload,
  mapLiveEventType,
  parseEventTypes,
  WEBHOOK_TEST_EVENT,
} from './events.ts';
import type { WebhookDeliveryRow, WebhookRow } from './mappers.ts';
import { countQueuedDeliveries } from './store.ts';
import { assertUrlSafeForDelivery } from './ssrf.ts';

/**
 * Webhook 调度服务：事件入队、worker 轮次、单次测试投递。
 *
 * 单进程语义（SQLite）：领取投递用「条件 UPDATE + changes 检查」保证同一行不会被
 * 两轮并发处理；每轮最多 20 条。HTTP 重试状态全部落库，进程重启后可继续。
 */

/** 重试退避（毫秒），按已尝试次数取；超过长度后封顶 6h。 */
export const RETRY_BACKOFF_MS: number[] = [5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000];
/** 每轮投递上限。 */
export const DELIVERY_BATCH_SIZE = 20;
/** 连续失败达到该值自动禁用 webhook。 */
export const AUTO_DISABLE_FAILURES = 10;

export interface WebhookServiceDeps {
  db: DatabaseSync;
  env: Env;
  logger: Logger;
  metrics: Metrics;
}

export interface WebhookService {
  /** 把 LiveEvent 投递给匹配的 webhook，返回创建的投递行数。 */
  enqueue(event: LiveEvent): number;
  /** 执行一轮投递（内部防重入）。 */
  tick(): Promise<void>;
  /** 立即发送一次测试事件（不进入重试队列）。 */
  sendTest(
    webhook: WebhookRow,
    projectSlug: string | undefined,
    actorLabel: string,
  ): Promise<WebhookTestResult>;
}

export interface JoinedDeliveryRow extends WebhookDeliveryRow {
  webhook_url: string;
  webhook_secret: string;
  webhook_enabled: number;
  webhook_failure_count: number;
}

interface ProjectSlugRow {
  slug: string;
}

/** 第 attempts 次尝试失败后的等待时间（attempts 从 1 开始）。 */
export function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[index] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 21_600_000;
}

function safeMetric(fn: () => void): void {
  try {
    fn();
  } catch {
    /* 指标失败不影响投递 */
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitDeliveryMetrics(deps: WebhookServiceDeps, status: WebhookDeliveryStatus, latencyMs: number): void {
  safeMetric(() =>
    deps.metrics.counter('mnemos_webhook_deliveries_total', { status }),
  );
  safeMetric(() =>
    deps.metrics.histogram('mnemos_webhook_delivery_duration_milliseconds', latencyMs, { status }),
  );
}

export function enqueueEvent(deps: WebhookServiceDeps, event: LiveEvent): number {
  const type = mapLiveEventType(event.type);
  if (!type || !event.projectId) return 0;

  const db = deps.db;
  const project = db.prepare('SELECT slug FROM projects WHERE id = ?').get(event.projectId) as unknown as
    | ProjectSlugRow
    | undefined;

  const webhooks = db
    .prepare('SELECT * FROM webhooks WHERE project_id = ? AND enabled = 1')
    .all(event.projectId) as unknown as WebhookRow[];
  const matched = webhooks.filter((webhook) => parseEventTypes(webhook.event_types).includes(type));
  if (matched.length === 0) return 0;

  const payload = buildEventPayload(event, type, event.projectId, project?.slug);
  const body = JSON.stringify(payload);
  const createdAt = nowIso();
  const maxAttempts = Math.max(1, deps.env.webhookMaxAttempts);

  tx(db, () => {
    const insert = db.prepare(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, project_id, event_type, event_id, payload, status,
          attempts, max_attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    );
    for (const webhook of matched) {
      insert.run(
        newId('whd'),
        webhook.id,
        event.projectId ?? '',
        type,
        payload.id,
        body,
        maxAttempts,
        createdAt,
        createdAt,
      );
    }
  });

  deps.logger.debug('webhook.enqueued', {
    eventType: type,
    projectId: event.projectId,
    deliveries: matched.length,
  });
  return matched.length;
}

/** 记录一次尝试结果：更新投递行 + webhook 汇总状态。 */
function recordAttempt(
  deps: WebhookServiceDeps,
  row: JoinedDeliveryRow,
  attempt: number,
  result: DeliveryAttemptResult,
): void {
  const db = deps.db;
  const at = nowIso();
  const ok = result.ok;
  const willRetry = !ok && attempt < row.max_attempts;
  const status: WebhookDeliveryStatus = ok ? 'success' : willRetry ? 'failed' : 'dead';
  const nextAttemptAt = willRetry ? new Date(Date.now() + retryDelayMs(attempt)).toISOString() : null;
  const responseStatus = result.responseStatus ?? null;
  const responseBody = result.responseBody ?? null;
  const error = ok ? null : (result.error ?? '投递失败').slice(0, 1_000);

  if (ok) {
    db.prepare(
      `UPDATE webhook_deliveries
          SET status = 'success', attempts = ?, response_status = ?, response_body = ?,
              latency_ms = ?, error = NULL, next_attempt_at = NULL, delivered_at = ?
        WHERE id = ?`,
    ).run(attempt, responseStatus, responseBody, result.latencyMs, at, row.id);
    db.prepare(
      `UPDATE webhooks
          SET last_delivery_at = ?, last_status = ?, failure_count = 0
        WHERE id = ?`,
    ).run(at, responseStatus, row.webhook_id);
  } else {
    db.prepare(
      `UPDATE webhook_deliveries
          SET status = ?, attempts = ?, response_status = ?, response_body = ?,
              latency_ms = ?, error = ?, next_attempt_at = ?, delivered_at = NULL
        WHERE id = ?`,
    ).run(status, attempt, responseStatus, responseBody, result.latencyMs, error, nextAttemptAt, row.id);

    const failures = row.webhook_failure_count + 1;
    if (failures >= AUTO_DISABLE_FAILURES && row.webhook_enabled === 1) {
      db.prepare(
        `UPDATE webhooks
            SET last_delivery_at = ?, last_status = ?, failure_count = ?, enabled = 0, disabled_at = ?
          WHERE id = ?`,
      ).run(at, responseStatus, failures, at, row.webhook_id);
      deps.logger.warn('webhook.auto_disabled', {
        webhookId: row.webhook_id,
        failureCount: failures,
      });
    } else {
      db.prepare(
        `UPDATE webhooks
            SET last_delivery_at = ?, last_status = ?, failure_count = ?
          WHERE id = ?`,
      ).run(at, responseStatus, failures, row.webhook_id);
    }
  }

  emitDeliveryMetrics(deps, status, result.latencyMs);

  const fields = {
    webhookId: row.webhook_id,
    deliveryId: row.id,
    eventType: row.event_type,
    attempt,
    maxAttempts: row.max_attempts,
    status,
    latencyMs: result.latencyMs,
    responseStatus,
  };
  if (ok) {
    deps.logger.info('webhook.delivered', fields);
  } else {
    deps.logger.warn('webhook.delivery_failed', { ...fields, error });
  }
}

async function runDeliveryTick(deps: WebhookServiceDeps): Promise<void> {
  const db = deps.db;
  const due = db
    .prepare(
      `SELECT d.*,
              w.url          AS webhook_url,
              w.secret       AS webhook_secret,
              w.enabled      AS webhook_enabled,
              w.failure_count AS webhook_failure_count
         FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
        WHERE d.status IN ('pending', 'failed')
          AND d.attempts < d.max_attempts
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
        ORDER BY d.next_attempt_at ASC, d.created_at ASC
        LIMIT ?`,
    )
    .all(nowIso(), DELIVERY_BATCH_SIZE) as unknown as JoinedDeliveryRow[];

  for (const row of due) {
    // 条件更新领取：只有仍待投递（pending / 待重试的 failed）的行会被处理，避免重复投递。
    const claim = db
      .prepare(
        `UPDATE webhook_deliveries
            SET status = 'delivering', attempts = attempts + 1
          WHERE id = ? AND status IN ('pending', 'failed')`,
      )
      .run(row.id);
    if (Number(claim.changes) !== 1) continue;

    const attempt = row.attempts + 1;
    try {
      const result = await attemptDelivery({
        url: row.webhook_url,
        secret: row.webhook_secret,
        eventType: row.event_type,
        deliveryId: row.id,
        projectId: row.project_id,
        payload: row.payload,
        timeoutMs: deps.env.webhookTimeoutMs,
        allowPrivate: deps.env.webhookAllowPrivate,
      });
      recordAttempt(deps, row, attempt, result);
    } catch (error) {
      // 记录阶段异常：避免卡在 delivering，退化为失败并重新排期。
      deps.logger.error('webhook.delivery_crashed', {
        deliveryId: row.id,
        error: errorText(error),
      });
      try {
        const exhausted = attempt >= row.max_attempts;
        db.prepare(
          `UPDATE webhook_deliveries
              SET status = ?, error = ?, next_attempt_at = ?
            WHERE id = ?`,
        ).run(
          exhausted ? 'dead' : 'failed',
          errorText(error).slice(0, 1_000),
          exhausted ? null : new Date(Date.now() + retryDelayMs(attempt)).toISOString(),
          row.id,
        );
      } catch {
        /* 数据库异常时只能放弃本轮 */
      }
    }
  }

  safeMetric(() => deps.metrics.gauge('mnemos_webhook_queue_depth', countQueuedDeliveries(db)));
}

/** 立即执行一次测试投递；SSRF 不合规时抛出 WebhookUrlError（路由映射 400）。 */
export async function sendTestWebhook(
  deps: WebhookServiceDeps,
  webhook: WebhookRow,
  projectSlug: string | undefined,
  actorLabel: string,
): Promise<WebhookTestResult> {
  // 先做完整 SSRF 校验：被拒绝的地址不留下投递记录。
  await assertUrlSafeForDelivery(webhook.url, { allowPrivate: deps.env.webhookAllowPrivate });

  const deliveryId = newId('whd');
  const at = nowIso();
  const payload = buildTestPayload({
    id: newId('evt'),
    at,
    projectId: webhook.project_id,
    projectSlug,
    actor: actorLabel,
    webhookName: webhook.name,
  });
  const body = JSON.stringify(payload);

  // 直接以 delivering 落库：worker 只领取 pending，因此测试事件不会进入重试队列。
  deps.db
    .prepare(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, project_id, event_type, event_id, payload, status,
          attempts, max_attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'delivering', 0, 1, NULL, ?)`,
    )
    .run(deliveryId, webhook.id, webhook.project_id, WEBHOOK_TEST_EVENT, payload.id, body, at);

  const result = await attemptDelivery({
    url: webhook.url,
    secret: webhook.secret,
    eventType: WEBHOOK_TEST_EVENT,
    deliveryId,
    projectId: webhook.project_id,
    payload: body,
    timeoutMs: deps.env.webhookTimeoutMs,
    allowPrivate: deps.env.webhookAllowPrivate,
  });

  const status: WebhookDeliveryStatus = result.ok ? 'success' : 'failed';
  const deliveredAt = result.ok ? nowIso() : null;
  deps.db
    .prepare(
      `UPDATE webhook_deliveries
          SET status = ?, attempts = 1, response_status = ?, response_body = ?,
              latency_ms = ?, error = ?, next_attempt_at = NULL, delivered_at = ?
        WHERE id = ?`,
    )
    .run(
      status,
      result.responseStatus ?? null,
      result.responseBody ?? null,
      result.latencyMs,
      result.ok ? null : (result.error ?? '测试投递失败').slice(0, 1_000),
      deliveredAt,
      deliveryId,
    );

  // 测试事件只刷新最近一次投递状态，不计入 failure_count / 自动禁用。
  deps.db
    .prepare('UPDATE webhooks SET last_delivery_at = ?, last_status = ? WHERE id = ?')
    .run(nowIso(), result.responseStatus ?? null, webhook.id);

  emitDeliveryMetrics(deps, status, result.latencyMs);
  deps.logger.info('webhook.test_delivery', {
    webhookId: webhook.id,
    deliveryId,
    status,
    latencyMs: result.latencyMs,
    responseStatus: result.responseStatus ?? null,
  });

  return {
    deliveryId,
    status,
    responseStatus: result.responseStatus,
    latencyMs: result.latencyMs,
    error: result.ok ? undefined : result.error,
  };
}

export function createWebhookService(deps: WebhookServiceDeps): WebhookService {
  let inFlight = false;

  return {
    enqueue(event: LiveEvent): number {
      return enqueueEvent(deps, event);
    },
    async tick(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        await runDeliveryTick(deps);
      } finally {
        inFlight = false;
      }
    },
    async sendTest(
      webhook: WebhookRow,
      projectSlug: string | undefined,
      actorLabel: string,
    ): Promise<WebhookTestResult> {
      return sendTestWebhook(deps, webhook, projectSlug, actorLabel);
    },
  };
}
