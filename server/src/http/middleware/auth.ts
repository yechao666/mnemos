import type { DatabaseSync } from 'node:sqlite';
import { ROLE_RANK } from '../../../../shared/src/constants.ts';
import type { ApiScope, Org, Partition, Role, User } from '../../../../shared/src/types.ts';
import type { AppContext } from '../../contracts.ts';
import { findPartitionRow, loadStatsRow } from '../../engine/partition.ts';
import { sha256, nowIso } from '../../lib/ids.ts';
import type { ApiKeyAuth, ConsoleAuth, RequestContext } from '../context.ts';
import { headerOf } from '../context.ts';
import {
  parseJsonArray,
  toApiKey,
  toOrg,
  toPartition,
  toUser,
  type ApiKeyRow,
  type OrgRow,
  type UserRow,
} from '../mappers.ts';
import { HttpError, errors } from '../respond.ts';

export type { ApiKeyAuth, ConsoleAuth } from '../context.ts';

/**
 * 认证与授权（v6）：
 *  - 控制台：user_sessions.token_hash = sha256(Bearer token)
 *  - 公开 v1：api_keys.key_hash = sha256(mnemos_live_…)；partition key 只能访问自身分区，
 *    org key（kind=org）可访问 / 创建本组织任意分区
 *  - 分区访问：读 viewer+，写 developer+，密钥/设置 admin+（控制台按组织角色）
 */

const SESSION_LAST_SEEN_THROTTLE_MS = 60_000;
const KEY_LAST_USED_THROTTLE_MS = 30_000;
const RATE_WINDOW_MS = 60_000;

interface RateWindow {
  windowStart: number;
  count: number;
}

const rateWindows = new Map<string, RateWindow>();

function bumpMetric(app: AppContext, name: string, labels?: Record<string, string>, value = 1): void {
  const metrics = app.metrics;
  if (!metrics || typeof metrics.counter !== 'function') return;
  try {
    metrics.counter(name, labels, value);
  } catch {
    /* 指标失败不影响主流程 */
  }
}

/* ------------------------------------------------------------------ */
/* 客户端 IP / 白名单                                                  */
/* ------------------------------------------------------------------ */

const IPV4_RULE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

export interface Ipv4Rule {
  address: string;
  prefix: number;
}

/** 解析 IPv4 或 CIDR（`a.b.c.d` / `a.b.c.d/n`）；非法返回 null。 */
export function parseIpv4Rule(value: string): Ipv4Rule | null {
  const match = IPV4_RULE.exec(value.trim());
  if (!match) return null;
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  const prefix = match[5] === undefined ? 32 : Number(match[5]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { address: octets.join('.'), prefix };
}

export function isValidIpRule(value: string): boolean {
  return parseIpv4Rule(value) !== null;
}

/** 归一化客户端 IP：去掉 IPv6 映射前缀、端口与方括号。 */
export function normalizeClientIp(value: string): string {
  let ip = value.trim();
  if (ip.startsWith('[')) {
    const closing = ip.indexOf(']');
    if (closing > 0) ip = ip.slice(1, closing);
  }
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  const portIndex = ip.indexOf(':');
  if (portIndex > 0 && ip.indexOf(':', portIndex + 1) === -1) ip = ip.slice(0, portIndex);
  return ip;
}

function ipv4ToInt(address: string): number {
  return address
    .split('.')
    .reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function bitsOf(prefix: number): number {
  if (prefix <= 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

/** 校验客户端 IP 是否命中白名单；空数组视为不限制。 */
export function isIpAllowed(clientIp: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const normalized = normalizeClientIp(clientIp);
  const clientRule = parseIpv4Rule(normalized);
  for (const rawRule of allowed) {
    const rule = parseIpv4Rule(rawRule);
    if (!rule) {
      if (rawRule.trim() === normalized) return true;
      continue;
    }
    if (!clientRule) continue;
    const mask = bitsOf(rule.prefix);
    if ((ipv4ToInt(clientRule.address) & mask) === (ipv4ToInt(rule.address) & mask)) return true;
  }
  return false;
}

/** 真实客户端 IP：trustProxy 时取 X-Forwarded-For 第一跳，否则用 socket 地址。 */
export function requestIp(app: AppContext, rc: RequestContext): string {
  if (app.env.trustProxy) {
    const forwarded = headerOf(rc.req, 'x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first) return first;
  }
  return rc.req.socket?.remoteAddress ?? rc.ip ?? '';
}

/* ------------------------------------------------------------------ */
/* 固定窗口限流                                                        */
/* ------------------------------------------------------------------ */

function setRateLimitHeaders(rc: RequestContext, limit: number, remaining: number, resetMs: number): void {
  rc.res.setHeader('X-RateLimit-Limit', String(limit));
  rc.res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  rc.res.setHeader('X-RateLimit-Reset', String(Math.floor(resetMs / 1000)));
}

function consumeRateLimit(rc: RequestContext, keyId: string, limitPerMin: number): void {
  const now = Date.now();
  const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const resetMs = windowStart + RATE_WINDOW_MS;
  const entry = rateWindows.get(keyId);
  const count = !entry || entry.windowStart !== windowStart ? 1 : entry.count + 1;
  if (rateWindows.size > 10_000) {
    for (const [id, item] of rateWindows) {
      if (item.windowStart !== windowStart) rateWindows.delete(id);
    }
  }
  rateWindows.set(keyId, { windowStart, count });

  setRateLimitHeaders(rc, limitPerMin, limitPerMin - count, resetMs);
  if (count > limitPerMin) {
    rc.res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetMs - now) / 1000))));
    throw errors.rateLimited(`超出该 API Key 的速率限制（${limitPerMin} 次/分钟）`);
  }
}

function recordAuthFailure(rc: RequestContext): void {
  bumpMetric(rc.app, 'mnemos_auth_failures_total');
}

/** 认证失败的统一计数包装：所有 401/403 分支都会被计数。 */
function withAuthFailureCounter<T>(rc: RequestContext, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) recordAuthFailure(rc);
    throw error;
  }
}

export function getBearerToken(req: RequestContext['req']): string | null {
  const header = headerOf(req, 'authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function tokenFrom(rc: RequestContext, allowQueryToken: boolean): string | null {
  const headerToken = getBearerToken(rc.req);
  if (headerToken) return headerToken;
  if (!allowQueryToken) return null;
  return rc.url.searchParams.get('token');
}

function loadOrg(db: DatabaseSync, orgId: string): Org | null {
  const row = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId) as unknown as OrgRow | undefined;
  return row ? toOrg(row) : null;
}

function firstOwnerUser(db: DatabaseSync): UserRow | null {
  const row = db
    .prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1")
    .get() as unknown as UserRow | undefined;
  if (row) return row;
  const fallback = db.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT 1').get() as unknown as
    | UserRow
    | undefined;
  return fallback ?? null;
}

export function authenticateConsole(rc: RequestContext, allowQueryToken = false): ConsoleAuth {
  return withAuthFailureCounter(rc, () => authenticateConsoleInner(rc, allowQueryToken));
}

function authenticateConsoleInner(rc: RequestContext, allowQueryToken: boolean): ConsoleAuth {
  const { app } = rc;
  const token = tokenFrom(rc, allowQueryToken);

  if (app.env.authDisabled) {
    const owner = firstOwnerUser(app.db);
    if (!owner) throw errors.unavailable('鉴权已关闭，但数据库中还没有任何用户');
    const org = loadOrg(app.db, owner.org_id);
    if (!org) throw errors.unavailable('鉴权已关闭，但用户所属组织不存在');
    return { kind: 'user', user: toUser(owner), org, token: token ?? 'auth-disabled' };
  }

  if (!token) throw errors.unauthorized('缺少 Authorization: Bearer 会话令牌');

  const row = app.db
    .prepare(
      'SELECT s.expires_at AS expires_at, u.* FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    )
    .get(sha256(token)) as unknown as (UserRow & { expires_at: string }) | undefined;

  if (!row) throw errors.unauthorized('会话令牌无效，请重新登录');

  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    app.db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(sha256(token));
    throw errors.unauthorized('会话已过期，请重新登录');
  }

  if (row.status === 'disabled') {
    app.db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(row.id);
    throw new HttpError(401, 'ACCOUNT_DISABLED', '账号已被禁用，请联系组织管理员');
  }

  const org = loadOrg(app.db, row.org_id);
  if (!org) throw errors.unauthorized('账号所属组织不存在');

  let lastSeenAt = row.last_seen_at;
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : 0;
  if (!lastSeenAt || !Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs > SESSION_LAST_SEEN_THROTTLE_MS) {
    lastSeenAt = nowIso();
    app.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, row.id);
  }

  return {
    kind: 'user',
    user: toUser({ ...row, last_seen_at: lastSeenAt }),
    org,
    token,
  };
}

export function authenticateApiKey(rc: RequestContext): ApiKeyAuth {
  return withAuthFailureCounter(rc, () => authenticateApiKeyInner(rc));
}

function authenticateApiKeyInner(rc: RequestContext): ApiKeyAuth {
  const { app } = rc;
  const token = getBearerToken(rc.req);

  if (!token) {
    throw errors.invalidApiKey('缺少 API Key：请在 Authorization 头中携带 Bearer mnemos_live_… 令牌');
  }
  if (!token.startsWith('mnemos_live_')) {
    throw errors.invalidApiKey('API Key 格式不正确，应以 mnemos_live_ 开头');
  }

  const row = app.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(token)) as unknown as
    | ApiKeyRow
    | undefined;

  if (!row) throw errors.invalidApiKey('API Key 不存在或已失效');
  if (row.revoked_at) throw errors.apiKeyRevoked();

  if (row.expires_at) {
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new HttpError(401, 'KEY_EXPIRED', '该 API Key 已过期，请在控制台轮换或创建新密钥');
    }
  }

  const allowedIps = parseJsonArray<string>(row.allowed_ips);
  if (allowedIps.length > 0) {
    const ip = requestIp(app, rc);
    if (!isIpAllowed(ip, allowedIps)) {
      throw new HttpError(403, 'IP_NOT_ALLOWED', `当前来源 IP（${normalizeClientIp(ip) || '未知'}）不在该 API Key 的白名单内`);
    }
  }

  const isOrgKey = row.kind === 'org';
  let org: Org | null = null;
  let partition: Partition | undefined;

  if (isOrgKey) {
    const orgId = (row.org_id ?? '').trim();
    if (!orgId) throw errors.invalidApiKey('组织级 API Key 缺少组织绑定，请重新创建');
    org = loadOrg(app.db, orgId);
    if (!org) throw errors.invalidApiKey('API Key 绑定的组织不存在');
  } else {
    const partitionId = (row.partition_id ?? '').trim();
    if (!partitionId) throw errors.invalidApiKey('分区级 API Key 缺少分区绑定，请重新创建');
    const partitionRow = app.db.prepare('SELECT * FROM partitions WHERE id = ?').get(partitionId) as unknown as
      | Parameters<typeof toPartition>[0]
      | undefined;
    if (!partitionRow) throw errors.invalidApiKey('API Key 绑定的分区不存在');
    partition = toPartition(partitionRow);
    org = loadOrg(app.db, partition.orgId);
    if (!org) throw errors.invalidApiKey('API Key 绑定的组织不存在');
    if (partition.status === 'archived') throw errors.forbidden('分区已归档，无法继续调用');
  }

  const lastUsedMs = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  let lastUsedAt = row.last_used_at;
  if (!row.last_used_at || !Number.isFinite(lastUsedMs) || Date.now() - lastUsedMs > KEY_LAST_USED_THROTTLE_MS) {
    lastUsedAt = nowIso();
    app.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(lastUsedAt, row.id);
  }

  const key = toApiKey({ ...row, last_used_at: lastUsedAt });
  consumeRateLimit(rc, key.id, Math.max(1, key.rateLimitPerMin));

  return { kind: 'api_key', key, org, partition };
}

export function hasScope(scopes: ApiScope[], required: ApiScope): boolean {
  if (scopes.includes('admin')) return true;
  return scopes.includes(required);
}

export function assertScopes(auth: ApiKeyAuth, required: ApiScope[]): void {
  for (const scope of required) {
    if (scope === 'admin') {
      if (!auth.key.scopes.includes('admin')) throw errors.forbidden('该 API Key 缺少 admin 权限');
      continue;
    }
    if (!hasScope(auth.key.scopes, scope)) {
      throw errors.forbidden(`该 API Key 缺少权限：${scope}`);
    }
  }
}

export function requireConsoleAuth(rc: RequestContext): ConsoleAuth {
  if (!rc.auth || rc.auth.kind !== 'user') throw errors.unauthorized();
  return rc.auth;
}

export function requireKeyAuth(rc: RequestContext): ApiKeyAuth {
  if (!rc.auth || rc.auth.kind !== 'api_key') throw errors.invalidApiKey();
  return rc.auth;
}

export function requireConsoleRole(rc: RequestContext, minRole: Role): ConsoleAuth {
  const auth = requireConsoleAuth(rc);
  if (ROLE_RANK[auth.user.role] < ROLE_RANK[minRole]) {
    throw errors.forbidden(`该操作需要 ${minRole} 及以上角色`);
  }
  return auth;
}

/** 要求 org 级 API Key（如创建分区、组织级统计）。 */
export function requireOrgKey(rc: RequestContext): ApiKeyAuth {
  const auth = requireKeyAuth(rc);
  if (auth.key.kind !== 'org') {
    throw errors.forbidden('该操作需要组织级 API Key（kind=org）；分区 key 只能操作自身分区');
  }
  return auth;
}

/** 组织内可见分区（控制台：组织角色即分区权限）。 */
export function visiblePartitions(app: AppContext, user: User): Partition[] {
  const rows = app.db
    .prepare('SELECT * FROM partitions WHERE org_id = ? ORDER BY created_at ASC, id ASC')
    .all(user.orgId) as unknown as Parameters<typeof toPartition>[0][];
  return rows.map((row) => toPartition(row, loadStatsRow(app.db, row.id)));
}

/**
 * API Key 视角解析分区：`:partition` 支持内部 id 或 slug。
 *  - partition key：只能命中自身分区；
 *  - org key：可命中本组织任意分区。
 * 越权与不存在统一 404，避免探测其他组织的分区。
 */
export function requireApiKeyPartition(rc: RequestContext, ref: string): Partition {
  const auth = requireKeyAuth(rc);
  const row = findPartitionRow(rc.app.db, auth.org.id, ref);
  if (!row) throw errors.notFound('分区不存在');
  if (auth.key.kind !== 'org') {
    if (!auth.partition || row.id !== auth.partition.id) throw errors.notFound('分区不存在');
  }
  return toPartition(row);
}

/** 控制台视角解析分区：组织角色即分区角色。 */
export function requireConsolePartition(rc: RequestContext, ref: string, minRole: Role = 'viewer'): Partition {
  const auth = requireConsoleRole(rc, minRole);
  const row = findPartitionRow(rc.app.db, auth.org.id, ref);
  if (!row) throw errors.notFound('分区不存在');
  return toPartition(row);
}

/** 按当前认证类型解析分区。 */
export function resolvePartition(rc: RequestContext, ref: string, minRole: Role = 'viewer'): Partition {
  if (!rc.auth) throw errors.unauthorized();
  if (rc.auth.kind === 'api_key') return requireApiKeyPartition(rc, ref);
  return requireConsolePartition(rc, ref, minRole);
}
