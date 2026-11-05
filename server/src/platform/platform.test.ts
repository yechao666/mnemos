/**
 * 生产平台层测试：日志、指标、备份、维护、登录锁定、配额。
 * 全部使用临时目录 + :memory:，不污染 data/。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { AddressInfo } from 'node:net';

import { createMemoryService } from '../engine/index.ts';
import { migrate } from '../db/index.ts';
import { loadEnv } from '../env.ts';
import { createHttpServer, drainConnections } from '../http/server.ts';
import { EventBus } from '../lib/bus.ts';
import { newApiKeySecret, nowIso } from '../lib/ids.ts';
import { createPlatform } from './index.ts';
import { createBackupController } from './backup.ts';
import { createLogger } from './logger.ts';
import { createMaintenanceController } from './maintenance.ts';
import { createMetrics } from './metrics.ts';
import { assertQuota, evaluateProjectQuota } from './quota.ts';
import { hashPassword } from '../lib/password.ts';
import { HttpError } from '../http/respond.ts';
import { toProject, type UserRow } from '../http/mappers.ts';
import {
  assertLoginRateLimit,
  checkLoginGate,
  registerLoginFailure,
  resetLoginRateLimits,
} from '../http/routes/auth.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mnemos-platform-'));
}

function testEnv(backupDir: string, overrides: Parameters<typeof loadEnv>[0] = {}): ReturnType<typeof loadEnv> {
  return loadEnv({
    nodeEnv: 'test',
    dataDir: backupDir,
    backupDir,
    dbPath: ':memory:',
    logLevel: 'error',
    logFormat: 'json',
    ...overrides,
  });
}

function silentLogger(env: ReturnType<typeof loadEnv>): ReturnType<typeof createLogger> {
  return createLogger(env, {}, { silent: true });
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

test('logger：JSON 输出、child 字段继承、敏感字段脱敏与错误序列化', () => {
  const dir = tempDir();
  try {
    const env = testEnv(dir, { logLevel: 'debug', logFormat: 'json' });
    const lines: string[] = [];
    const logger = createLogger(env, { service: 'mnemos' }, { silent: false, sink: (line) => lines.push(line) });
    logger.info('login.ok', {
      password: 'p@ssw0rd',
      apiKey: 'mnemos_live_secret',
      authorization: 'Bearer abc',
      token: 'tok',
      email: 'lin@example.com',
    });
    logger.child({ requestId: 'req_1' }).error('boom', { error: new Error('数据库损坏') });

    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(first['service'], 'mnemos');
    assert.equal(first['msg'], 'login.ok');
    assert.equal(first['level'], 'info');
    assert.equal(first['password'], '[REDACTED]');
    assert.equal(first['apiKey'], '[REDACTED]');
    assert.equal(first['authorization'], '[REDACTED]');
    assert.equal(first['token'], '[REDACTED]');
    assert.equal(first['email'], 'lin@example.com');

    const second = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
    assert.equal(second['requestId'], 'req_1');
    assert.equal(second['level'], 'error');
    const serialized = second['error'] as Record<string, unknown>;
    assert.equal(serialized['message'], '数据库损坏');
    assert.equal(typeof serialized['stack'], 'string');

    // level 过滤：logLevel=error 时 debug/info 不输出
    const quiet = createLogger(testEnv(dir, { logLevel: 'error' }), {}, { silent: false, sink: (line) => lines.push(line) });
    lines.length = 0;
    quiet.debug('hidden');
    quiet.info('hidden');
    assert.equal(lines.length, 0);
    quiet.error('kept');
    assert.equal(lines.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 指标                                                                */
/* ------------------------------------------------------------------ */

test('metrics：Prometheus 文本包含 HELP/TYPE/标签，snapshot 汇总正确', () => {
  const metrics = createMetrics({ version: '1.1.0', startedAt: Date.now() - 1_000 });
  metrics.counter('mnemos_http_requests_total', { method: 'GET', route: '/api/health', status: '200' });
  metrics.counter('mnemos_http_requests_total', { method: 'POST', route: '/v1/memories', status: '500' });
  metrics.histogram('mnemos_http_request_duration_milliseconds', 42, { method: 'GET', route: '/api/health' });
  metrics.histogram('mnemos_http_request_duration_milliseconds', 900, { method: 'GET', route: '/api/health' });
  metrics.incGauge('sseClients', undefined, 1);
  metrics.incGauge('sseClients', undefined, 1);
  metrics.incGauge('sseClients', undefined, -1);
  metrics.counter('mnemos_rate_limited_total');
  metrics.counter('mnemos_auth_failures_total');
  metrics.counter('mnemos_auth_failures_total');

  const text = metrics.render();
  assert.match(text, /# HELP mnemos_http_requests_total/);
  assert.match(text, /# TYPE mnemos_http_requests_total counter/);
  assert.match(text, /mnemos_http_requests_total\{method="GET",route="\/api\/health",status="200"\} 1/);
  assert.match(text, /# TYPE mnemos_http_request_duration_milliseconds histogram/);
  assert.match(text, /mnemos_http_request_duration_milliseconds_bucket\{le="50",method="GET",route="\/api\/health"\} 1/);
  assert.match(text, /mnemos_http_request_duration_milliseconds_bucket\{le="1000",method="GET",route="\/api\/health"\} 2/);
  assert.match(text, /mnemos_http_request_duration_milliseconds_bucket\{le="\+Inf",method="GET",route="\/api\/health"\} 2/);
  assert.match(text, /mnemos_http_request_duration_milliseconds_count\{method="GET",route="\/api\/health"\} 2/);
  assert.match(text, /# TYPE mnemos_sse_clients gauge/);
  assert.match(text, /mnemos_sse_clients 1/);
  assert.match(text, /mnemos_build_info\{version="1\.1\.0"\} 1/);
  assert.match(text, /# TYPE mnemos_uptime_seconds gauge/);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requestsTotal, 2);
  assert.equal(snapshot.errorsTotal, 1);
  assert.equal(snapshot.sseClients, 1);
  assert.equal(snapshot.rateLimitedTotal, 1);
  assert.equal(snapshot.authFailuresTotal, 2);
  assert.equal(snapshot.latencyP50Ms, 471);
  assert.ok(snapshot.latencyP95Ms >= snapshot.latencyP50Ms);
});

/* ------------------------------------------------------------------ */
/* 备份                                                                */
/* ------------------------------------------------------------------ */

test('backup：创建/列表/滚动保留，pathOf 拒绝路径穿越', async () => {
  const dir = tempDir();
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const env = testEnv(join(dir, 'backups'));
    const controller = createBackupController({ db, env, logger: silentLogger(env) });

    // 预置 20 份旧备份，验证滚动保留 14 份
    mkdirSync(env.backupDir, { recursive: true });
    const old = new Date(Date.now() - 86_400_000).toISOString();
    for (let index = 0; index < 20; index += 1) {
      const stamp = `20260101-0000${String(index).padStart(2, '0')}`;
      const file = join(env.backupDir, `mnemos-${stamp}-manual.db`);
      writeFileSync(file, 'old');
      utimesSync(file, new Date(old), new Date(old));
    }

    const info = await controller.create('manual', '林薇');
    assert.match(info.file, /^mnemos-\d{8}-\d{6}-manual\.db$/);
    assert.equal(info.kind, 'manual');
    assert.ok(info.sizeBytes > 0);
    assert.ok(readFileSync(join(env.backupDir, info.file)).byteLength > 0);

    const listed = controller.list();
    assert.equal(listed.length, 14);
    assert.ok(listed.some((item) => item.file === info.file));
    // 倒序：最新的在最前
    assert.equal(listed[0]?.file, info.file);

    // 路径穿越与非法文件名一律返回 null
    assert.equal(controller.pathOf('../x'), null);
    assert.equal(controller.pathOf('..%2F..%2Fetc%2Fpasswd'), null);
    assert.equal(controller.pathOf('sub/dir.db'), null);
    assert.equal(controller.pathOf('/etc/passwd'), null);
    assert.equal(controller.pathOf('notes.txt'), null);
    assert.equal(controller.pathOf('mnemos-20260101-000000-manual.db.evil'), null);
    assert.equal(controller.pathOf('missing.db'), null);

    const resolved = controller.pathOf(info.file);
    assert.ok(resolved && resolved.endsWith(info.file));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 维护                                                                */
/* ------------------------------------------------------------------ */

interface MemorySeed {
  id: string;
  projectId: string;
  content: string;
  status?: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string | null;
}

function insertMemory(db: DatabaseSync, seed: MemorySeed): void {
  db.prepare(
    `INSERT INTO memories
       (id, project_id, content, normalized_hash, category, importance, confidence, source,
        status, tags, metadata, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'fact', 0.5, 0.8, 'api', ?, '[]', '{}', ?, ?, ?)`,
  ).run(
    seed.id,
    seed.projectId,
    seed.content,
    seed.id,
    seed.status ?? 'active',
    seed.createdAt,
    seed.updatedAt ?? seed.createdAt,
    seed.expiresAt ?? null,
  );
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

test('maintenance：dryRun 只统计，run 归档过期/超保留期记忆并清理幂等键', async () => {
  const dir = tempDir();
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const env = testEnv(dir);
    const at = new Date().toISOString();

    db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'org_t',
      '测试组织',
      'org-t',
      'enterprise',
      at,
    );
    db.prepare(
      `INSERT INTO projects (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'active', 'cn-shanghai', 'production', ?, ?, ?)`,
    ).run('proj_t', 'org_t', 'proj-t', '测试项目', JSON.stringify({ retentionDays: 30 }), at, at);
    db.prepare('INSERT INTO users (id, org_id, email, name, role, avatar_color, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'usr_t',
      'org_t',
      'user@example.com',
      '测试用户',
      'admin',
      'violet',
      hashPassword('passw0rd'),
      at,
    );

    // 40 天前的记忆（项目保留期 30 天）→ 应归档
    insertMemory(db, { id: 'mem_old', projectId: 'proj_t', content: '旧记忆', createdAt: daysAgo(40) });
    // 新记忆 → 保留
    insertMemory(db, { id: 'mem_new', projectId: 'proj_t', content: '新记忆', createdAt: daysAgo(1) });
    // TTL 过期 → 归档
    insertMemory(db, {
      id: 'mem_ttl',
      projectId: 'proj_t',
      content: '已过期记忆',
      createdAt: daysAgo(2),
      expiresAt: daysAgo(0.5),
    });
    // 软删除超过 30 天 → 物理删除（含词项）
    insertMemory(db, {
      id: 'mem_deleted',
      projectId: 'proj_t',
      content: '待清理记忆',
      status: 'deleted',
      createdAt: daysAgo(60),
      updatedAt: daysAgo(31),
    });
    db.prepare('INSERT INTO memory_terms (memory_id, project_id, term, tf) VALUES (?, ?, ?, ?)').run(
      'mem_deleted',
      'proj_t',
      '待清理',
      1,
    );
    // 软删除未满 30 天 → 保留
    insertMemory(db, {
      id: 'mem_deleted_recent',
      projectId: 'proj_t',
      content: '刚删除',
      status: 'deleted',
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
    });

    db.prepare(
      'INSERT INTO idempotency_keys (key, project_id, endpoint, request_hash, status_code, response, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('idem_old', 'proj_t', '/v1/memories', 'hash', 200, '{}', daysAgo(2), daysAgo(1));
    db.prepare(
      'INSERT INTO idempotency_keys (key, project_id, endpoint, request_hash, status_code, response, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('idem_live', 'proj_t', '/v1/memories', 'hash', 200, '{}', at, daysAgo(-1));
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      'sess_old',
      'usr_t',
      daysAgo(3),
      daysAgo(1),
    );
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      'sess_live',
      'usr_t',
      at,
      daysAgo(-1),
    );

    const controller = createMaintenanceController({
      db,
      env,
      logger: silentLogger(env),
      metrics: createMetrics(),
    });

    const statusOf = (id: string): string => {
      const row = db.prepare('SELECT status FROM memories WHERE id = ?').get(id) as unknown as
        | { status: string }
        | undefined;
      return row?.status ?? 'missing';
    };
    const count = (sql: string): number => {
      const row = db.prepare(sql).get() as unknown as Record<string, unknown> | undefined;
      return row ? Number(Object.values(row)[0] ?? 0) : 0;
    };

    const dry = await controller.run({ dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.expiredArchived, 2, 'TTL + 保留期各 1 条');
    assert.equal(dry.deletedPurged, 1);
    assert.equal(dry.idempotencyPurged, 1);
    assert.equal(dry.sessionsPurged, 1);
    assert.equal(dry.walCheckpointed, false);
    assert.equal(dry.vacuumed, false);
    // 数据未发生变化
    assert.equal(statusOf('mem_old'), 'active');
    assert.equal(statusOf('mem_ttl'), 'active');
    assert.equal(count("SELECT COUNT(*) AS c FROM memories WHERE id = 'mem_deleted'"), 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM idempotency_keys WHERE key = 'idem_old'"), 1);

    const scheduled = await controller.run({});
    assert.equal(scheduled.dryRun, false);
    assert.equal(scheduled.expiredArchived, 2);
    assert.equal(scheduled.deletedPurged, 1);
    assert.equal(scheduled.idempotencyPurged, 1);
    assert.equal(scheduled.sessionsPurged, 1);
    assert.equal(scheduled.walCheckpointed, true);
    assert.equal(scheduled.vacuumed, false);
    assert.ok(scheduled.durationMs >= 0);
    assert.ok(scheduled.runId.startsWith('mnt_'));

    assert.equal(statusOf('mem_old'), 'archived');
    assert.equal(statusOf('mem_ttl'), 'archived');
    assert.equal(statusOf('mem_new'), 'active');
    assert.equal(statusOf('mem_deleted'), 'missing');
    assert.equal(statusOf('mem_deleted_recent'), 'deleted');
    assert.equal(count("SELECT COUNT(*) AS c FROM memory_terms WHERE memory_id = 'mem_deleted'"), 0);
    assert.equal(count("SELECT COUNT(*) AS c FROM idempotency_keys"), 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM sessions"), 1);

    const history = controller.history();
    assert.equal(history.length, 2);
    assert.equal(history[0]?.kind, 'manual');
    assert.equal(history[0]?.status, 'success');
    assert.equal(history[1]?.kind, 'dry-run');
    assert.equal(history[0]?.summary['expiredByTtl'], 1);
    assert.equal(history[0]?.summary['archivedByRetention'], 1);

    assert.equal(controller.history(1).length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 登录防爆破                                                          */
/* ------------------------------------------------------------------ */

function seedUser(db: DatabaseSync, env: ReturnType<typeof loadEnv>, email = 'owner@example.com'): UserRow {
  const at = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'org_t',
    '测试组织',
    'org-t',
    'enterprise',
    at,
  );
  db.prepare(
    `INSERT INTO users (id, org_id, email, name, role, avatar_color, password_hash, status, created_at)
     VALUES (?, 'org_t', ?, '测试用户', 'owner', 'violet', ?, 'active', ?)`,
  ).run('usr_login', email, hashPassword('passw0rd123'), at);
  return db.prepare('SELECT * FROM users WHERE id = ?').get('usr_login') as unknown as UserRow;
}

test('login：连续失败达到阈值后写入 locked_until，过期后重新计数', () => {
  const dir = tempDir();
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const env = testEnv(dir, { loginMaxAttempts: 3, loginLockMinutes: 15 });
    const user = seedUser(db, env);

    assert.equal(checkLoginGate(user, env).locked, false);
    assert.equal(checkLoginGate(user, env).disabled, false);

    const fresh = (): UserRow => db.prepare('SELECT * FROM users WHERE id = ?').get('usr_login') as unknown as UserRow;

    const first = registerLoginFailure(db, fresh(), env);
    assert.equal(first.attempts, 1);
    assert.equal(first.locked, false);
    assert.equal(first.remainingAttempts, 2);

    const second = registerLoginFailure(db, fresh(), env);
    assert.equal(second.attempts, 2);
    assert.equal(second.remainingAttempts, 1);

    const third = registerLoginFailure(db, fresh(), env);
    assert.equal(third.attempts, 3);
    assert.equal(third.locked, true);
    assert.equal(third.remainingAttempts, 0);
    assert.ok(third.lockedUntil);

    const lockedRow = fresh();
    assert.ok(lockedRow.locked_until);
    const gate = checkLoginGate(lockedRow, env);
    assert.equal(gate.locked, true);
    assert.ok(gate.retryAfter > 800 && gate.retryAfter <= 900, `retryAfter=${gate.retryAfter}`);

    // 锁定过期后：门禁放行，失败计数从 0 重新累计
    db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(daysAgo(0.01), 'usr_login');
    const expiredRow = fresh();
    assert.equal(checkLoginGate(expiredRow, env).locked, false);
    const afterExpiry = registerLoginFailure(db, expiredRow, env);
    assert.equal(afterExpiry.attempts, 1);
    assert.equal(afterExpiry.locked, false);

    // 禁用账号
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run('usr_login');
    assert.equal(checkLoginGate(fresh(), env).disabled, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('login：同一 IP 每分钟超过 30 次尝试返回 login_rate_limited', () => {
  resetLoginRateLimits();
  const now = Date.now();
  for (let index = 1; index <= 30; index += 1) {
    assert.doesNotThrow(() => assertLoginRateLimit('203.0.113.9', now));
  }
  assert.throws(
    () => assertLoginRateLimit('203.0.113.9', now),
    (error: unknown) =>
      error instanceof HttpError && error.status === 429 && error.code === 'login_rate_limited',
  );
  // 窗口滚动后恢复
  assert.doesNotThrow(() => assertLoginRateLimit('203.0.113.9', now + 61_000));
  resetLoginRateLimits();
});

/* ------------------------------------------------------------------ */
/* 配额                                                                */
/* ------------------------------------------------------------------ */

test('quota：本月 token 达到 monthlyQuota 时抛出 429 quota_exceeded', () => {
  const dir = tempDir();
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const env = testEnv(dir);
    const at = new Date().toISOString();
    db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'org_q',
      '配额组织',
      'org-q',
      'enterprise',
      at,
    );
    db.prepare(
      `INSERT INTO projects (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at)
       VALUES (?, 'org_q', ?, ?, '', 'active', 'cn-shanghai', 'production', ?, ?, ?)`,
    ).run('proj_q', 'proj-q', '配额项目', JSON.stringify({ monthlyQuota: 1_000 }), at, at);
    const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj_q') as unknown as Parameters<
      typeof toProject
    >[0];
    const project = toProject(projectRow);

    let state = evaluateProjectQuota(db, project);
    assert.equal(state.exceeded, false);
    assert.equal(state.used, 0);
    assert.equal(state.limit, 1_000);
    assert.match(state.resetAt, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    assert.ok(state.retryAfter > 0);
    assert.doesNotThrow(() => assertQuota(state));

    const insertUsage = (id: string, tokens: number, createdAt: string): void => {
      db.prepare(
        `INSERT INTO usage_events (id, org_id, project_id, channel, operation, method, path, status, latency_ms, result_count, memory_tokens, actor, created_at)
         VALUES (?, 'org_q', 'proj_q', 'api', 'add', 'POST', '/v1/memories', 200, 5, 1, ?, 'tester', ?)`,
      ).run(id, tokens, createdAt);
    };
    insertUsage('use_1', 600, at);
    insertUsage('use_2', 400, at);

    state = evaluateProjectQuota(db, project);
    assert.equal(state.used, 1_000);
    assert.equal(state.exceeded, true);
    assert.equal(state.retryAfter, state.retryAfter | 0);

    assert.throws(
      () => assertQuota(state),
      (error: unknown) => {
        if (!(error instanceof HttpError)) return false;
        const details = error.details as { used: number; limit: number; resetAt: string };
        assert.equal(error.status, 429);
        assert.equal(error.code, 'quota_exceeded');
        assert.equal(details.used, 1_000);
        assert.equal(details.limit, 1_000);
        assert.match(details.resetAt, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
        return true;
      },
    );

    // 上月用量不计入本月
    insertUsage('use_last_month', 10_000, new Date(Date.now() - 60 * 86_400_000).toISOString());
    state = evaluateProjectQuota(db, project);
    assert.ok(state.used >= 1_000);
    assert.equal(state.exceeded, true);

    // 配额 <= 0 视为不限量
    db.prepare("UPDATE projects SET settings = ? WHERE id = 'proj_q'").run(JSON.stringify({ monthlyQuota: 0 }));
    const unlimited = toProject(
      db.prepare('SELECT * FROM projects WHERE id = ?').get('proj_q') as unknown as Parameters<typeof toProject>[0],
    );
    assert.equal(evaluateProjectQuota(db, unlimited).exceeded, false);
    assert.ok(env.quotaEnforce);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


/* ------------------------------------------------------------------ */
/* HTTP 集成：登录锁定 + 配额 429（临时 server）                        */
/* ------------------------------------------------------------------ */

test('HTTP：登录连续失败锁定后 423，配额耗尽的 add 返回 429，读请求放行', async () => {
  const dir = tempDir();
  const db = new DatabaseSync(':memory:');
  const env = testEnv(dir, { loginMaxAttempts: 3, loginLockMinutes: 15, quotaEnforce: true, metricsEnabled: true });
  const bus = new EventBus();
  const engine = createMemoryService(db, { bus });
  const platform = createPlatform({ db, env, bus }, { startMaintenance: false });
  const server = createHttpServer({
    db,
    engine,
    env,
    bus,
    startedAt: Date.now(),
    logger: platform.logger,
    metrics: platform.metrics,
    platform,
  });

  try {
    migrate(db);
    const at = nowIso();
    db.prepare('INSERT INTO orgs (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'org_h',
      '集成组织',
      'org-h',
      'enterprise',
      at,
    );
    db.prepare(
      `INSERT INTO users (id, org_id, email, name, role, avatar_color, password_hash, status, created_at)
       VALUES (?, 'org_h', ?, ?, 'owner', 'violet', ?, 'active', ?)`,
    ).run('usr_h', 'owner@http.test', 'Owner', hashPassword('passw0rd123'), at);
    db.prepare(
      `INSERT INTO projects (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at)
       VALUES (?, 'org_h', ?, ?, '', 'active', 'cn-shanghai', 'production', ?, ?, ?)`,
    ).run('proj_h', 'proj-h', '集成项目', JSON.stringify({ monthlyQuota: 100, retentionDays: 365 }), at, at);
    const apiKey = newApiKeySecret();
    db.prepare(
      `INSERT INTO api_keys (id, project_id, name, prefix, key_hash, scopes, created_by, created_at, rate_limit_per_min)
       VALUES (?, 'proj_h', 'integration', ?, ?, ?, 'usr_h', ?, 600)`,
    ).run('key_h', apiKey.prefix, apiKey.hash, JSON.stringify(['memories:read', 'memories:write']), at);
    db.prepare(
      `INSERT INTO usage_events (id, org_id, project_id, channel, operation, method, path, status, latency_ms, result_count, memory_tokens, actor, created_at)
       VALUES (?, 'org_h', 'proj_h', 'api', 'add', 'POST', '/v1/memories', 200, 2, 1, 150, 'seed', ?)`,
    ).run('use_h', at);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = (password: string): Promise<Response> =>
      fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@http.test', password }),
      });

    for (let index = 0; index < 3; index += 1) {
      const failed = await login('wrong-password');
      assert.equal(failed.status, 401);
    }
    const locked = await login('passw0rd123');
    const lockedBody = (await locked.json()) as { error?: { code?: string; details?: { retryAfter?: number } } };
    assert.equal(locked.status, 423);
    assert.equal(lockedBody.error?.code, 'account_locked');
    assert.ok((lockedBody.error?.details?.retryAfter ?? 0) > 0);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);

    db.prepare('UPDATE users SET locked_until = NULL, failed_login_attempts = 0 WHERE id = ?').run('usr_h');
    const ok = await login('passw0rd123');
    const okBody = (await ok.json()) as { token?: string };
    assert.equal(ok.status, 200);
    assert.ok(okBody.token);

    const apiAuth = { authorization: `Bearer ${apiKey.secret}` };
    const blocked = await fetch(`${base}/v1/memories`, {
      method: 'POST',
      headers: { ...apiAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '应被配额拦截' }),
    });
    const blockedBody = (await blocked.json()) as {
      error?: { code?: string; details?: { used?: number; limit?: number; resetAt?: string } };
    };
    assert.equal(blocked.status, 429);
    assert.equal(blockedBody.error?.code, 'quota_exceeded');
    assert.equal(blockedBody.error?.details?.used, 150);
    assert.equal(blockedBody.error?.details?.limit, 100);
    assert.ok(blockedBody.error?.details?.resetAt);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    const list = await fetch(`${base}/v1/memories?page=1&page_size=5`, { headers: apiAuth });
    assert.equal(list.status, 200, '读请求不应被配额阻断');

    const status = await fetch(`${base}/api/ops/status`, { headers: { authorization: `Bearer ${okBody.token}` } });
    const statusBody = (await status.json()) as {
      quotas?: { usedTokens?: number; monthlyQuota?: number }[];
      metrics?: { requestsTotal?: number };
    };
    assert.equal(status.status, 200);
    assert.equal(statusBody.quotas?.[0]?.monthlyQuota, 100);
    assert.ok((statusBody.quotas?.[0]?.usedTokens ?? 0) >= 100);
    assert.ok((statusBody.metrics?.requestsTotal ?? 0) >= 5);

    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /mnemos_http_requests_total/);
  } finally {
    await drainConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await platform.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
