/**
 * HTTP 路由级测试夹具：内存 SQLite + 真实 HTTP server（端口 0）+ 会话/API Key 预置。
 *
 * 只构造 HTTP 层真正会消费的 AppContext 字段（logger / metrics / platform 用轻量 fake），
 * 引擎与数据库全部走真实实现，保证路由行为与生产一致。
 */

import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiScope, Role } from '../../../shared/src/types.ts';
import type { AppContext, Logger, Metrics, Platform } from '../contracts.ts';
import { migrate } from '../db/index.ts';
import { createMemoryService } from '../engine/index.ts';
import { loadEnv } from '../env.ts';
import { newApiKeySecret, nowIso, sha256 } from '../lib/ids.ts';
import { createHttpServer } from './server.ts';

const AT = nowIso();
const FAR_FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function fakeLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

function fakeMetrics(): Metrics {
  return {
    counter: () => undefined,
    histogram: () => undefined,
    gauge: () => undefined,
    incGauge: () => undefined,
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
}

function fakePlatform(logger: Logger, metrics: Metrics): Platform {
  return {
    logger,
    metrics,
    maintenance: {
      start: () => undefined,
      stop: () => undefined,
      run: async () => ({}) as never,
      history: () => [],
    },
    backups: {
      create: async () => ({}) as never,
      list: () => [],
      pathOf: () => null,
    },
    shutdown: async () => undefined,
  };
}

export interface HttpFixture {
  db: DatabaseSync;
  app: AppContext;
  baseUrl: string;
  orgId: string;
  otherOrgId: string;
  /** alpha 分区 id / slug */
  partitionId: string;
  partitionSlug: string;
  betaId: string;
  /** 控制台会话令牌 */
  sessions: Record<'owner' | 'admin' | 'developer' | 'viewer', string>;
  /** alpha 分区 key（read+write+admin） */
  partitionKey: string;
  /** alpha 只读分区 key */
  partitionReadKey: string;
  /** 组织级 key（read+write+admin） */
  orgKey: string;
  /** 其他组织的 org key */
  foreignOrgKey: string;
  close(): Promise<void>;
}

function addSession(db: DatabaseSync, userId: string): string {
  const token = `session-${userId}`;
  db.prepare(
    `INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sha256(token), userId, AT, FAR_FUTURE, AT);
  return token;
}

function addKey(
  db: DatabaseSync,
  input: {
    partitionId?: string;
    orgId?: string;
    name: string;
    scopes: ApiScope[];
    kind?: 'partition' | 'org';
  },
): string {
  const { secret, prefix, hash } = newApiKeySecret();
  db.prepare(
    `INSERT INTO api_keys
       (id, partition_id, org_id, kind, name, prefix, key_hash, scopes, created_by, created_at,
        rate_limit_per_min)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'usr_owner', ?, 100000)`,
  ).run(
    `key_${prefix}`,
    input.partitionId ?? null,
    input.orgId ?? null,
    input.kind ?? 'partition',
    input.name,
    prefix,
    hash,
    JSON.stringify(input.scopes),
    AT,
  );
  return secret;
}

function addUser(db: DatabaseSync, id: string, orgId: string, role: Role, email: string): void {
  db.prepare(
    `INSERT INTO users
       (id, org_id, email, name, role, title, avatar_color, password_hash, status,
        password_changed_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'violet', 'hash', 'active', ?, ?)`,
  ).run(id, orgId, email, email, role, AT, AT);
}

function addPartition(db: DatabaseSync, id: string, orgId: string, slug: string, name: string): void {
  db.prepare(
    `INSERT INTO partitions
       (id, org_id, slug, name, description, status, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'active', '{}', ?, ?)`,
  ).run(id, orgId, slug, name, AT, AT);
}

function fakeEnv() {
  return loadEnv({
    host: '127.0.0.1',
    port: 0,
    authDisabled: false,
    quotaEnforce: false,
    demoMode: false,
    metricsEnabled: false,
    logLevel: 'error',
    requestTimeoutMs: 15_000,
    shutdownTimeoutMs: 1_000,
    dreamSchedulerEnabled: false,
    dreamTickMs: 60_000,
  });
}

export async function startServer(app: AppContext): Promise<{ server: Server; baseUrl: string }> {
  const server = createHttpServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 建立一份完整的 HTTP 测试夹具（调用方负责在 t.after 里 close）。 */
export async function setupHttpFixture(): Promise<HttpFixture> {
  const db = new DatabaseSync(':memory:');
  migrate(db);

  db.prepare("INSERT INTO orgs (id, name, slug, plan, created_at) VALUES ('org_test', '测试组织', 'test-org', 'enterprise', ?)").run(AT);
  db.prepare("INSERT INTO orgs (id, name, slug, plan, created_at) VALUES ('org_other', '其他组织', 'other-org', 'enterprise', ?)").run(AT);

  addUser(db, 'usr_owner', 'org_test', 'owner', 'owner@test.dev');
  addUser(db, 'usr_admin', 'org_test', 'admin', 'admin@test.dev');
  addUser(db, 'usr_developer', 'org_test', 'developer', 'developer@test.dev');
  addUser(db, 'usr_viewer', 'org_test', 'viewer', 'viewer@test.dev');

  addPartition(db, 'ptn_alpha', 'org_test', 'alpha', 'Alpha 分区');
  addPartition(db, 'ptn_beta', 'org_test', 'beta', 'Beta 分区');
  addPartition(db, 'ptn_foreign', 'org_other', 'foreign', '外部组织分区');

  const sessions = {
    owner: addSession(db, 'usr_owner'),
    admin: addSession(db, 'usr_admin'),
    developer: addSession(db, 'usr_developer'),
    viewer: addSession(db, 'usr_viewer'),
  };

  const partitionKey = addKey(db, {
    partitionId: 'ptn_alpha',
    name: 'alpha 分区 key',
    scopes: ['memories:read', 'memories:write', 'admin'],
  });
  const partitionReadKey = addKey(db, {
    partitionId: 'ptn_alpha',
    name: 'alpha 只读 key',
    scopes: ['memories:read'],
  });
  const orgKey = addKey(db, {
    orgId: 'org_test',
    name: '组织级 key',
    scopes: ['memories:read', 'memories:write', 'admin'],
    kind: 'org',
  });
  const foreignOrgKey = addKey(db, {
    orgId: 'org_other',
    name: '外部组织 key',
    scopes: ['memories:read', 'memories:write', 'admin'],
    kind: 'org',
  });

  const engine = createMemoryService(db);
  const logger = fakeLogger();
  const metrics = fakeMetrics();
  const env = fakeEnv();
  const platform = fakePlatform(logger, metrics);
  const app: AppContext = { db, engine, env, startedAt: Date.now(), logger, metrics, platform };

  const { server, baseUrl } = await startServer(app);
  return {
    db,
    app,
    baseUrl,
    orgId: 'org_test',
    otherOrgId: 'org_other',
    partitionId: 'ptn_alpha',
    partitionSlug: 'alpha',
    betaId: 'ptn_beta',
    sessions,
    partitionKey,
    partitionReadKey,
    orgKey,
    foreignOrgKey,
    async close() {
      await closeServer(server);
      db.close();
    },
  };
}

export interface HttpResult {
  status: number;
  json: unknown;
  headers: Headers;
}

/** 极简 JSON 请求：会话令牌用 session，API Key 用 key。 */
export async function request(
  baseUrl: string,
  method: string,
  path: string,
  options: {
    session?: string;
    key?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.session) headers.authorization = `Bearer ${options.session}`;
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = text;
    }
  }
  return { status: response.status, json, headers: response.headers };
}

/** 从 JSON 对象里按点路径取字段（测试断言用，避免层层 as）。 */
export function field(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
