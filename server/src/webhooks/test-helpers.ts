import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { LiveEvent } from '../../../shared/src/types.ts';
import type { Logger, Metrics } from '../contracts.ts';
import { migrate } from '../db/index.ts';
import { newId, nowIso, sha256 } from '../lib/ids.ts';
import { newWebhookSecret } from './signature.ts';

/**
 * Webhook 测试夹具：内存 SQLite、日志/指标替身、本地 HTTP 接收端。
 * 只被 *.test.ts 引用。
 */

export interface TestMetrics extends Metrics {
  counters: { name: string; labels?: Record<string, string>; value: number }[];
  histograms: { name: string; value: number; labels?: Record<string, string> }[];
  gauges: { name: string; value: number; labels?: Record<string, string> }[];
}

export function createTestMetrics(): TestMetrics {
  const metrics: TestMetrics = {
    counters: [],
    histograms: [],
    gauges: [],
    counter(name, labels, value = 1) {
      this.counters.push({ name, labels, value });
    },
    histogram(name, value, labels) {
      this.histograms.push({ name, value, labels });
    },
    gauge(name, value, labels) {
      this.gauges.push({ name, value, labels });
    },
    incGauge(name, labels, delta = 1) {
      this.gauges.push({ name, labels, value: delta });
    },
    render: () => '',
    snapshot: () => ({
      requestsTotal: 0,
      errorsTotal: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      sseClients: 0,
      rateLimitedTotal: 0,
      authFailuresTotal: 0,
    }),
  };
  return metrics;
}

export interface TestLogger extends Logger {
  lines: { level: string; message: string; fields?: Record<string, unknown> }[];
}

export function createTestLogger(): TestLogger {
  const logger: TestLogger = {
    lines: [],
    debug(message, fields) {
      logger.lines.push({ level: 'debug', message, fields });
    },
    info(message, fields) {
      logger.lines.push({ level: 'info', message, fields });
    },
    warn(message, fields) {
      logger.lines.push({ level: 'warn', message, fields });
    },
    error(message, fields) {
      logger.lines.push({ level: 'error', message, fields });
    },
    child() {
      return logger;
    },
  };
  return logger;
}

export interface SeededProject {
  orgId: string;
  projectId: string;
}

/** 建一条 org + project（满足外键约束）。 */
export function createOrgAndProject(db: DatabaseSync, slug = 'test'): SeededProject {
  migrate(db);
  const orgId = 'org_test';
  const projectId = `proj_${slug}`;
  const at = nowIso();
  db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
    orgId,
    '测试组织',
    `test-org-${slug}`,
    'enterprise',
    at,
  );
  db.prepare(
    `INSERT INTO projects (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, orgId, slug, '测试项目', '', 'active', 'cn-shanghai', 'production', '{}', at, at);
  return { orgId, projectId };
}

export interface SeedWebhookInput {
  projectId: string;
  url: string;
  eventTypes: string[];
  enabled?: boolean;
  name?: string;
  secret?: string;
}

export function seedWebhook(db: DatabaseSync, input: SeedWebhookInput): { id: string; secret: string } {
  const id = newId('whk');
  const secret = input.secret ?? newWebhookSecret();
  const at = nowIso();
  db.prepare(
    `INSERT INTO webhooks
       (id, project_id, name, url, secret, event_types, enabled, description,
        created_by, created_at, updated_at, failure_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', 'usr_test', ?, ?, 0)`,
  ).run(
    id,
    input.projectId,
    input.name ?? '测试 Webhook',
    input.url,
    secret,
    JSON.stringify(input.eventTypes),
    input.enabled === false ? 0 : 1,
    at,
    at,
  );
  return { id, secret };
}

export interface SeedDeliveryInput {
  webhookId: string;
  projectId: string;
  eventType?: string;
  status?: string;
  createdAt?: string;
  latencyMs?: number;
  attempts?: number;
}

export function seedDelivery(db: DatabaseSync, input: SeedDeliveryInput): string {
  const id = newId('whd');
  const at = input.createdAt ?? nowIso();
  const eventId = newId('evt');
  const payload = JSON.stringify({
    id: eventId,
    type: input.eventType ?? 'memory.created',
    at,
    projectId: input.projectId,
    actor: '测试用户',
    data: { summary: '测试事件' },
  });
  db.prepare(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, project_id, event_type, event_id, payload, status,
        attempts, max_attempts, next_attempt_at, response_status, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 6, ?, 200, ?, ?)`,
  ).run(
    id,
    input.webhookId,
    input.projectId,
    input.eventType ?? 'memory.created',
    eventId,
    payload,
    input.status ?? 'success',
    input.attempts ?? 1,
    at,
    input.latencyMs ?? 12,
    at,
  );
  return id;
}

export function liveEvent(
  projectId: string,
  type: LiveEvent['type'] = 'memory.added',
  meta?: Record<string, unknown>,
): LiveEvent {
  return {
    id: newId('evt'),
    type,
    projectId,
    projectName: '测试项目',
    actor: '测试用户',
    summary: '测试事件',
    at: nowIso(),
    ...(meta ? { meta } : {}),
  };
}

export function countDeliveries(db: DatabaseSync, webhookId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM webhook_deliveries WHERE webhook_id = ?')
    .get(webhookId) as unknown as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

export function latestDelivery(db: DatabaseSync, webhookId: string): Record<string, unknown> | null {
  const row = db
    .prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(webhookId) as unknown as Record<string, unknown> | undefined;
  return row ?? null;
}

export interface CapturedRequest {
  headers: IncomingHttpHeaders;
  body: string;
}

export interface TestReceiver {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

export type ReceiverHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  index: number,
) => void;

/** 启动本地 HTTP 接收端，默认 200；handler 可按次数返回不同状态。 */
export async function startReceiver(handler?: ReceiverHandler): Promise<TestReceiver> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const index = requests.length;
      requests.push({ headers: req.headers, body });
      if (handler) {
        handler(req, res, index);
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface SeedUserInput {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: string;
  token: string;
}

/** 建用户 + 未过期会话（跳过登录流程，直接测路由权限）。 */
export function seedUserSession(db: DatabaseSync, input: SeedUserInput): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO users
       (id, org_id, email, name, role, avatar_color, password_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'violet', 'x', 'active', ?)`,
  ).run(input.id, input.orgId, input.email, input.name, input.role, at);
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(sha256(input.token), input.id, at, expiresAt);
}

export function addProjectMember(db: DatabaseSync, projectId: string, userId: string, role: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
  ).run(projectId, userId, role, nowIso());
}

export function seedApiKey(db: DatabaseSync, projectId: string, secret: string, scopes: string[]): string {
  const id = newId('key');
  db.prepare(
    `INSERT INTO api_keys
       (id, project_id, name, prefix, key_hash, scopes, created_by, created_at, rate_limit_per_min, allowed_ips)
     VALUES (?, ?, '测试 Key', ?, ?, ?, 'usr_test', ?, 600, '[]')`,
  ).run(id, projectId, secret.slice(0, 18), sha256(secret), JSON.stringify(scopes), nowIso());
  return id;
}
