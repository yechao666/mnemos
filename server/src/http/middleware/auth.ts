import type { DatabaseSync } from 'node:sqlite';
import { ROLE_RANK } from '../../../../shared/src/constants.ts';
import type { ApiScope, Org, Project, Role, User } from '../../../../shared/src/types.ts';
import type { AppContext } from '../../contracts.ts';
import { sha256, nowIso } from '../../lib/ids.ts';
import type { ApiKeyAuth, ConsoleAuth, RequestContext } from '../context.ts';
import { headerOf } from '../context.ts';
import {
  parseJsonArray,
  toApiKey,
  toOrg,
  toProject,
  toUser,
  type ApiKeyRow,
  type OrgRow,
  type ProjectRow,
  type UserRow,
} from '../mappers.ts';
import { HttpError, errors } from '../respond.ts';

/** T1 的 ops 路由直接从这里取会话认证类型；保持再导出避免跨层导入。 */
export type { ApiKeyAuth, ConsoleAuth } from '../context.ts';

/**
 * 认证与授权：
 *  - 控制台：sessions.token_hash = sha256(Bearer token)
 *  - 公开 v1：api_keys.key_hash = sha256(mnemos_live_…)，按 scopes 授权
 *  - MNEMOS_AUTH_DISABLED=1 时控制台放行（回退到首个 owner 用户）
 */

const SESSION_LAST_SEEN_THROTTLE_MS = 60_000;
const KEY_LAST_USED_THROTTLE_MS = 30_000;
const RATE_WINDOW_MS = 60_000;

interface RateWindow {
  windowStart: number;
  count: number;
}

const rateWindows = new Map<string, RateWindow>();

/** 指标按命名约定前缀 `mnemos_`，T1 的 /metrics 直接输出同名序列。 */
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

/** allowedIps 中每一项都必须是合法 IPv4 或 CIDR。 */
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
    // 429 的 rate_limited 计数由 observability 中间件统一完成，这里不重复累加。
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
    .prepare('SELECT s.expires_at AS expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(sha256(token)) as unknown as (UserRow & { expires_at: string }) | undefined;

  if (!row) throw errors.unauthorized('会话令牌无效，请重新登录');

  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    throw errors.unauthorized('会话已过期，请重新登录');
  }

  // 兜底：T1 的登录拦截之外，禁用账号的历史会话也不得继续使用。
  if (row.status === 'disabled') {
    app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    throw new HttpError(401, 'account_disabled', '账号已被禁用，请联系组织管理员');
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
      throw new HttpError(401, 'key_expired', '该 API Key 已过期，请在控制台轮换或创建新密钥');
    }
  }

  const allowedIps = parseJsonArray<string>(row.allowed_ips);
  if (allowedIps.length > 0) {
    const ip = requestIp(app, rc);
    if (!isIpAllowed(ip, allowedIps)) {
      throw new HttpError(403, 'ip_not_allowed', `当前来源 IP（${normalizeClientIp(ip) || '未知'}）不在该 API Key 的白名单内`);
    }
  }

  const projectRow = app.db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) as unknown as
    | ProjectRow
    | undefined;
  if (!projectRow) throw errors.invalidApiKey('API Key 绑定的项目不存在');

  const project = toProject(projectRow);
  if (project.status === 'archived') throw errors.forbidden('项目已归档，无法继续调用');

  const lastUsedMs = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  let lastUsedAt = row.last_used_at;
  if (!row.last_used_at || !Number.isFinite(lastUsedMs) || Date.now() - lastUsedMs > KEY_LAST_USED_THROTTLE_MS) {
    lastUsedAt = nowIso();
    app.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(lastUsedAt, row.id);
  }

  const key = toApiKey({ ...row, last_used_at: lastUsedAt });
  consumeRateLimit(rc, key.id, Math.max(1, key.rateLimitPerMin));

  return { kind: 'api_key', key, project };
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

/** 用户在项目中的有效角色：org owner/admin 天然拥有全部项目。 */
export function effectiveProjectRole(app: AppContext, user: User, projectId: string): Role | null {
  if (ROLE_RANK[user.role] >= ROLE_RANK.admin) return user.role;
  const row = app.db
    .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(projectId, user.id) as unknown as { role: string } | undefined;
  return row ? (row.role as Role) : null;
}

export function findProjectRow(app: AppContext, projectId: string): ProjectRow | null {
  const row = app.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as unknown as
    | ProjectRow
    | undefined;
  return row ?? null;
}

export function findProject(app: AppContext, projectId: string): Project | null {
  const row = findProjectRow(app, projectId);
  return row ? toProject(row) : null;
}

/** 校验并返回项目；api_key 认证时项目由 key 决定。 */
export function requireProjectAccess(rc: RequestContext, projectId: string, minRole: Role): Project {
  if (!rc.auth) throw errors.unauthorized();

  if (rc.auth.kind === 'api_key') {
    if (rc.auth.project.id !== projectId) throw errors.notFound('项目不存在');
    return rc.auth.project;
  }

  const row = findProjectRow(rc.app, projectId);
  if (!row || row.org_id !== rc.auth.user.orgId) throw errors.notFound('项目不存在');
  const project = toProject(row);
  const role = effectiveProjectRole(rc.app, rc.auth.user, project.id);
  if (!role) throw errors.forbidden('你不是该项目的成员');
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw errors.forbidden(`该操作需要 ${minRole} 及以上角色`);
  }
  return project;
}

/** 当前用户可见项目（org owner/admin 可见全部；其余仅作为成员的项目）。 */
export function visibleProjects(app: AppContext, user: User): Project[] {
  const rows =
    ROLE_RANK[user.role] >= ROLE_RANK.admin
      ? (app.db
          .prepare('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at ASC')
          .all(user.orgId) as unknown as ProjectRow[])
      : (app.db
          .prepare(
            `SELECT p.* FROM projects p
               JOIN project_members pm ON pm.project_id = p.id
              WHERE p.org_id = ? AND pm.user_id = ?
              ORDER BY p.created_at ASC`,
          )
          .all(user.orgId, user.id) as unknown as ProjectRow[]);
  return rows.map(toProject);
}
