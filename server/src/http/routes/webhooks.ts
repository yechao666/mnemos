import { z } from 'zod';
import type {
  Actor,
  Project,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  WebhookTestResult,
  WebhookWithSecret,
} from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import { WEBHOOK_EVENT_TYPES } from '../../webhooks/events.ts';
import { toDelivery, toWebhook, toWebhookWithSecret, type WebhookDeliveryRow, type WebhookRow } from '../../webhooks/mappers.ts';
import { createWebhookService } from '../../webhooks/service.ts';
import { newWebhookSecret } from '../../webhooks/signature.ts';
import { assertWebhookUrl, WebhookUrlError } from '../../webhooks/ssrf.ts';
import {
  computeWebhookStats,
  getDeliveryRow,
  getWebhookRow,
  listDeliveryRows,
  listWebhookRows,
} from '../../webhooks/store.ts';
import { actorForApiKey, actorForUser, type RequestContext } from '../context.ts';
import { requireConsoleAuth, requireKeyAuth, requireProjectAccess } from '../middleware/auth.ts';
import { errors, paginate } from '../respond.ts';
import type { Router } from '../router.ts';

/**
 * Webhook 控制台 + 公开 v1 API。
 *
 *  - 控制台：会话鉴权；读取 viewer+，写入/轮换/测试/重放 admin+；
 *  - v1：API Key；admin scope 写，memories:read 读；snake_case 出入参；
 *  - 任何列表/详情响应都不含 secret（仅创建/轮换返回一次）。
 */

const EVENT_TYPE_VALUES = [
  'memory.created',
  'memory.updated',
  'memory.deleted',
  'task.finished',
  'agent.registered',
  'key.created',
  'key.revoked',
  'quota.exceeded',
] as const;

const webhookEventTypeSchema = z.enum(EVENT_TYPE_VALUES);
const deliveryStatusSchema = z.enum(['pending', 'delivering', 'success', 'failed', 'dead']);

const webhookCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2048),
  eventTypes: z.array(webhookEventTypeSchema).min(1).max(EVENT_TYPE_VALUES.length),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
});

const webhookUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
    eventTypes: z.array(webhookEventTypeSchema).min(1).max(EVENT_TYPE_VALUES.length).optional(),
    description: z.string().trim().max(500).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const deliveryListQuerySchema = z.object({
  status: deliveryStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(20)
    .transform((value) => Math.min(value, 100)),
});

const v1WebhookCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2048),
  event_types: z.array(webhookEventTypeSchema).min(1).max(EVENT_TYPE_VALUES.length),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
});

const v1WebhookUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
    event_types: z.array(webhookEventTypeSchema).min(1).max(EVENT_TYPE_VALUES.length).optional(),
    description: z.string().trim().max(500).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const v1DeliveryQuerySchema = z.object({
  status: deliveryStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(20)
    .transform((value) => Math.min(value, 100)),
});

interface WebhookFields {
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  description?: string;
  enabled?: boolean;
}

/* ------------------------------------------------------------------ */
/* 通用辅助                                                            */
/* ------------------------------------------------------------------ */

function normalizeUrl(raw: string, allowPrivate: boolean): string {
  try {
    assertWebhookUrl(raw, { allowPrivate });
  } catch (error) {
    if (error instanceof WebhookUrlError) throw errors.badRequest(error.message);
    throw error;
  }
  return raw.trim();
}

function auditWebhook(
  rc: RequestContext,
  input: { project: Project; actor: Actor; action: string; resourceId: string; detail: Record<string, unknown> },
): void {
  writeAudit(rc.app.db, {
    orgId: input.project.orgId,
    projectId: input.project.id,
    actor: input.actor,
    action: input.action,
    resourceType: 'webhook',
    resourceId: input.resourceId,
    detail: input.detail,
  });
}

function channelOf(actor: Actor): string {
  return actor.type === 'api_key' ? 'api' : 'console';
}

/** 读取 webhook 并校验当前调用方的项目权限。 */
function requireWebhook(
  rc: RequestContext,
  webhookId: string,
  minRole: 'viewer' | 'developer' | 'admin' | 'owner',
): { row: WebhookRow; project: Project } {
  const row = getWebhookRow(rc.app.db, webhookId);
  if (!row) throw errors.notFound('Webhook 不存在');
  const project = requireProjectAccess(rc, row.project_id, minRole);
  return { row, project };
}

function insertWebhook(
  rc: RequestContext,
  project: Project,
  input: WebhookFields,
  actor: Actor,
): WebhookWithSecret {
  const id = newId('whk');
  const secret = newWebhookSecret();
  const at = nowIso();
  const enabled = input.enabled === false ? 0 : 1;
  rc.app.db
    .prepare(
      `INSERT INTO webhooks
         (id, project_id, name, url, secret, event_types, enabled, description,
          created_by, created_at, updated_at, failure_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      project.id,
      input.name,
      normalizeUrl(input.url, rc.app.env.webhookAllowPrivate),
      secret,
      JSON.stringify(input.eventTypes),
      enabled,
      input.description ?? '',
      actor.id,
      at,
      at,
    );

  const row = getWebhookRow(rc.app.db, id);
  if (!row) throw errors.internal('Webhook 写入失败');

  auditWebhook(rc, {
    project,
    actor,
    action: 'webhook.create',
    resourceId: id,
    detail: {
      name: input.name,
      url: input.url,
      eventTypes: input.eventTypes,
      enabled: enabled === 1,
      channel: channelOf(actor),
    },
  });

  // secret 仅在此响应中出现一次。
  return toWebhookWithSecret(row);
}

function applyWebhookUpdate(
  rc: RequestContext,
  row: WebhookRow,
  project: Project,
  input: Partial<WebhookFields>,
  actor: Actor,
): Webhook {
  const at = nowIso();
  const name = input.name ?? row.name;
  const url = input.url !== undefined ? normalizeUrl(input.url, rc.app.env.webhookAllowPrivate) : row.url;
  const eventTypes = input.eventTypes ?? toWebhook(row).eventTypes;
  const description = input.description ?? row.description;

  let enabled = row.enabled;
  let failureCount = row.failure_count;
  let disabledAt = row.disabled_at;
  if (input.enabled === true && row.enabled === 0) {
    enabled = 1;
    failureCount = 0;
    disabledAt = null;
  } else if (input.enabled === false && row.enabled === 1) {
    enabled = 0;
    disabledAt = at;
  }

  rc.app.db
    .prepare(
      `UPDATE webhooks
          SET name = ?, url = ?, event_types = ?, enabled = ?, description = ?,
              updated_at = ?, failure_count = ?, disabled_at = ?
        WHERE id = ?`,
    )
    .run(
      name,
      url,
      JSON.stringify(eventTypes),
      enabled,
      description,
      at,
      failureCount,
      disabledAt,
      row.id,
    );

  const updated = getWebhookRow(rc.app.db, row.id);
  if (!updated) throw errors.internal('Webhook 更新失败');

  auditWebhook(rc, {
    project,
    actor,
    action: 'webhook.update',
    resourceId: row.id,
    detail: {
      fields: Object.keys(input),
      enabled: enabled === 1,
      eventTypes,
      channel: channelOf(actor),
    },
  });

  return toWebhook(updated);
}

function rotateWebhookSecret(
  rc: RequestContext,
  row: WebhookRow,
  project: Project,
  actor: Actor,
): WebhookWithSecret {
  const secret = newWebhookSecret();
  const at = nowIso();
  rc.app.db
    .prepare('UPDATE webhooks SET secret = ?, updated_at = ? WHERE id = ?')
    .run(secret, at, row.id);
  const updated = getWebhookRow(rc.app.db, row.id);
  if (!updated) throw errors.internal('Webhook 密钥轮换失败');

  auditWebhook(rc, {
    project,
    actor,
    action: 'webhook.rotate_secret',
    resourceId: row.id,
    detail: { rotatedAt: at, channel: channelOf(actor) },
  });

  // 新 secret 立即生效，旧 secret 不保留，仅此响应返回明文。
  // 注意：已入队/待重试的投递在发送时读取 webhook 当前 secret，因此订阅方必须在
  // 轮换后的第一个重试窗口（默认 5s 起）之前完成验签密钥切换，否则这些请求会验签失败。
  return toWebhookWithSecret(updated);
}

function removeWebhook(rc: RequestContext, row: WebhookRow, project: Project, actor: Actor): void {
  rc.app.db.prepare('DELETE FROM webhooks WHERE id = ?').run(row.id);
  auditWebhook(rc, {
    project,
    actor,
    action: 'webhook.delete',
    resourceId: row.id,
    detail: { name: row.name, channel: channelOf(actor) },
  });
}

async function testWebhook(
  rc: RequestContext,
  row: WebhookRow,
  project: Project,
  actor: Actor,
  actorLabel: string,
): Promise<WebhookTestResult> {
  const service = createWebhookService({
    db: rc.app.db,
    env: rc.app.env,
    logger: rc.app.logger,
    metrics: rc.app.metrics,
  });
  let result: WebhookTestResult;
  try {
    result = await service.sendTest(row, project.slug, actorLabel);
  } catch (error) {
    if (error instanceof WebhookUrlError) throw errors.badRequest(error.message);
    throw error;
  }
  auditWebhook(rc, {
    project,
    actor,
    action: 'webhook.test',
    resourceId: row.id,
    detail: {
      deliveryId: result.deliveryId,
      status: result.status,
      responseStatus: result.responseStatus ?? null,
      channel: channelOf(actor),
    },
  });
  return result;
}

function replayDelivery(
  rc: RequestContext,
  delivery: WebhookDeliveryRow,
  project: Project,
  actor: Actor,
): WebhookDelivery {
  rc.app.db
    .prepare(
      `UPDATE webhook_deliveries
          SET status = 'pending', attempts = 0, next_attempt_at = ?,
              response_status = NULL, response_body = NULL, latency_ms = NULL,
              error = NULL, delivered_at = NULL
        WHERE id = ?`,
    )
    .run(nowIso(), delivery.id);

  const updated = getDeliveryRow(rc.app.db, delivery.id);
  if (!updated) throw errors.internal('投递记录重放失败');

  auditWebhook(rc, {
    project,
    actor,
    action: 'webhook.replay',
    resourceId: delivery.webhook_id,
    detail: {
      deliveryId: delivery.id,
      eventType: delivery.event_type,
      channel: channelOf(actor),
    },
  });
  return toDelivery(updated);
}

/* ------------------------------------------------------------------ */
/* v1 snake_case 映射                                                  */
/* ------------------------------------------------------------------ */

function v1Webhook(webhook: Webhook): Record<string, unknown> {
  return {
    id: webhook.id,
    project_id: webhook.projectId,
    name: webhook.name,
    url: webhook.url,
    event_types: webhook.eventTypes,
    enabled: webhook.enabled,
    description: webhook.description,
    created_by: webhook.createdBy ?? null,
    created_at: webhook.createdAt,
    updated_at: webhook.updatedAt,
    last_delivery_at: webhook.lastDeliveryAt ?? null,
    last_status: webhook.lastStatus ?? null,
    failure_count: webhook.failureCount,
    disabled_at: webhook.disabledAt ?? null,
  };
}

function v1Delivery(delivery: WebhookDelivery): Record<string, unknown> {
  return {
    id: delivery.id,
    webhook_id: delivery.webhookId,
    project_id: delivery.projectId,
    event_type: delivery.eventType,
    event_id: delivery.eventId ?? null,
    status: delivery.status,
    attempts: delivery.attempts,
    max_attempts: delivery.maxAttempts,
    next_attempt_at: delivery.nextAttemptAt ?? null,
    response_status: delivery.responseStatus ?? null,
    response_body: delivery.responseBody ?? null,
    latency_ms: delivery.latencyMs ?? null,
    error: delivery.error ?? null,
    created_at: delivery.createdAt,
    delivered_at: delivery.deliveredAt ?? null,
  };
}

function toV1Fields(input: z.output<typeof v1WebhookUpdateSchema>): Partial<WebhookFields> {
  const fields: Partial<WebhookFields> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.url !== undefined) fields.url = input.url;
  if (input.event_types !== undefined) fields.eventTypes = input.event_types;
  if (input.description !== undefined) fields.description = input.description;
  if (input.enabled !== undefined) fields.enabled = input.enabled;
  return fields;
}

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

export function registerWebhookRoutes(router: Router): void {
  /* --- 控制台：项目维度 ------------------------------------------- */

  router.add({
    method: 'GET',
    path: '/api/projects/:id/webhooks',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    handler: (rc: RequestContext) => {
      const project = rc.project as Project;
      rc.json(listWebhookRows(rc.app.db, project.id).map(toWebhook));
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/webhooks/stats',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    handler: (rc: RequestContext) => {
      const project = rc.project as Project;
      rc.json(computeWebhookStats(rc.app.db, project.id));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/webhooks',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(webhookCreateSchema);
      const webhook = insertWebhook(
        rc,
        project,
        {
          name: input.name,
          url: input.url,
          eventTypes: input.eventTypes,
          description: input.description,
          enabled: input.enabled,
        },
        actorForUser(rc, auth.user),
      );
      rc.json(webhook, 201);
    },
  });

  /* --- 控制台：静态路径需在 :id 之前 ------------------------------ */

  router.add({
    method: 'GET',
    path: '/api/webhooks/event-types',
    auth: 'console',
    handler: (rc: RequestContext) => {
      rc.json(WEBHOOK_EVENT_TYPES);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/webhooks/deliveries/:deliveryId',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const delivery = getDeliveryRow(rc.app.db, rc.params.deliveryId ?? '');
      if (!delivery) throw errors.notFound('投递记录不存在');
      requireProjectAccess(rc, delivery.project_id, 'viewer');
      rc.json(toDelivery(delivery));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/webhooks/deliveries/:deliveryId/replay',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const delivery = getDeliveryRow(rc.app.db, rc.params.deliveryId ?? '');
      if (!delivery) throw errors.notFound('投递记录不存在');
      const project = requireProjectAccess(rc, delivery.project_id, 'admin');
      rc.json(replayDelivery(rc, delivery, project, actorForUser(rc, auth.user)));
    },
  });

  router.add({
    method: 'GET',
    path: '/api/webhooks/:id/deliveries',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const { row } = requireWebhook(rc, rc.params.id ?? '', 'viewer');
      const query = rc.query(deliveryListQuerySchema);
      const { rows, total } = listDeliveryRows(rc.app.db, row.id, {
        status: query.status,
        page: query.page,
        pageSize: query.pageSize,
      });
      rc.json(paginate(rows.map(toDelivery), query.page, query.pageSize, total));
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/webhooks/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const { row, project } = requireWebhook(rc, rc.params.id ?? '', 'admin');
      const input = await rc.body(webhookUpdateSchema);
      rc.json(applyWebhookUpdate(rc, row, project, input, actorForUser(rc, auth.user)));
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/webhooks/:id',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const { row, project } = requireWebhook(rc, rc.params.id ?? '', 'admin');
      removeWebhook(rc, row, project, actorForUser(rc, auth.user));
      rc.json({ ok: true });
    },
  });

  router.add({
    method: 'POST',
    path: '/api/webhooks/:id/rotate-secret',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const { row, project } = requireWebhook(rc, rc.params.id ?? '', 'admin');
      rc.json(rotateWebhookSecret(rc, row, project, actorForUser(rc, auth.user)));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/webhooks/:id/test',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const { row, project } = requireWebhook(rc, rc.params.id ?? '', 'admin');
      const result = await testWebhook(rc, row, project, actorForUser(rc, auth.user), auth.user.name || auth.user.email);
      rc.json(result);
    },
  });

  /* --- 公开 v1 ----------------------------------------------------- */

  router.add({
    method: 'GET',
    path: '/v1/webhooks',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'webhook',
    channel: 'api',
    handler: (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const webhooks = listWebhookRows(rc.app.db, project.id).map(toWebhook);
      rc.noteUsage(webhooks.length);
      rc.json(webhooks.map(v1Webhook));
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/webhooks',
    auth: 'apikey',
    scopes: ['admin'],
    operation: 'webhook',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const input = await rc.body(v1WebhookCreateSchema);
      const webhook = insertWebhook(
        rc,
        project,
        {
          name: input.name,
          url: input.url,
          eventTypes: input.event_types,
          description: input.description,
          enabled: input.enabled,
        },
        actorForApiKey(rc, key, project),
      );
      const payload = { ...v1Webhook(webhook), secret: webhook.secret };
      rc.noteUsage(1);
      rc.json(payload, 201);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/v1/webhooks/:id',
    auth: 'apikey',
    scopes: ['admin'],
    operation: 'webhook',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const row = getWebhookRow(rc.app.db, rc.params.id ?? '');
      if (!row) throw errors.notFound('Webhook 不存在');
      requireProjectAccess(rc, row.project_id, 'viewer');
      const input = await rc.body(v1WebhookUpdateSchema);
      const updated = applyWebhookUpdate(rc, row, project, toV1Fields(input), actorForApiKey(rc, key, project));
      rc.noteUsage(1);
      rc.json(v1Webhook(updated));
    },
  });

  router.add({
    method: 'DELETE',
    path: '/v1/webhooks/:id',
    auth: 'apikey',
    scopes: ['admin'],
    operation: 'webhook',
    channel: 'api',
    handler: (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const row = getWebhookRow(rc.app.db, rc.params.id ?? '');
      if (!row) throw errors.notFound('Webhook 不存在');
      requireProjectAccess(rc, row.project_id, 'viewer');
      removeWebhook(rc, row, project, actorForApiKey(rc, key, project));
      rc.json({ ok: true });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/webhooks/:id/rotate-secret',
    auth: 'apikey',
    scopes: ['admin'],
    operation: 'webhook',
    channel: 'api',
    handler: (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const row = getWebhookRow(rc.app.db, rc.params.id ?? '');
      if (!row) throw errors.notFound('Webhook 不存在');
      requireProjectAccess(rc, row.project_id, 'viewer');
      const rotated = rotateWebhookSecret(rc, row, project, actorForApiKey(rc, key, project));
      rc.json({ ...v1Webhook(rotated), secret: rotated.secret });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/webhooks/:id/deliveries',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'webhook',
    channel: 'api',
    handler: (rc: RequestContext) => {
      requireKeyAuth(rc);
      const row = getWebhookRow(rc.app.db, rc.params.id ?? '');
      if (!row) throw errors.notFound('Webhook 不存在');
      requireProjectAccess(rc, row.project_id, 'viewer');
      const query = rc.query(v1DeliveryQuerySchema);
      const { rows, total } = listDeliveryRows(rc.app.db, row.id, {
        status: query.status,
        page: query.page,
        pageSize: query.page_size,
      });
      const items = rows.map(toDelivery).map(v1Delivery);
      rc.noteUsage(rows.length);
      // v1 出入参统一 snake_case。
      rc.json({
        items,
        page: query.page,
        page_size: query.page_size,
        total,
        total_pages: Math.max(1, Math.ceil(total / query.page_size)),
      });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/webhook-deliveries/:id/replay',
    auth: 'apikey',
    scopes: ['admin'],
    operation: 'webhook',
    channel: 'api',
    handler: (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const delivery = getDeliveryRow(rc.app.db, rc.params.id ?? '');
      if (!delivery) throw errors.notFound('投递记录不存在');
      requireProjectAccess(rc, delivery.project_id, 'viewer');
      const updated = replayDelivery(rc, delivery, project, actorForApiKey(rc, key, project));
      rc.json(v1Delivery(updated));
    },
  });
}
