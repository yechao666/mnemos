import { z } from 'zod';
import { DEMO_ACCOUNTS } from '../../../../shared/src/constants.ts';
import type { AuthResponse } from '../../../../shared/src/types.ts';
import type { DatabaseSync } from 'node:sqlite';
import { writeAudit } from '../../lib/audit.ts';
import { nowIso, randomToken, sha256 } from '../../lib/ids.ts';
import { hashPassword, verifyPassword } from '../../lib/password.ts';
import { actorForUser } from '../context.ts';
import type { RequestContext } from '../context.ts';
import { toOrg, toUser, type OrgRow, type UserRow } from '../mappers.ts';
import { requireConsoleAuth, visibleProjects } from '../middleware/auth.ts';
import { HttpError, errors } from '../respond.ts';
import type { Router } from '../router.ts';
import type { Env } from '../../env.ts';

/**
 * 登录与会话：
 *  - 登录防爆破：DB 级失败计数 + 锁定（重启后仍生效），外加按 IP 的内存级限流；
 *  - 密码修改：校验旧密码、更新 hash，并踢掉该用户其它会话；
 *  - 所有失败/成功尝试写入审计与 metrics.authFailuresTotal。
 */

const loginSchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z
    .string()
    .min(10, '新密码至少 10 位')
    .max(256)
    .regex(/[A-Za-z]/, '新密码必须包含字母')
    .regex(/[0-9]/, '新密码必须包含数字'),
});

const LOGIN_RATE_WINDOW_MS = 60_000;
const LOGIN_RATE_LIMIT = 30;
const LOGIN_RATE_MAX_ENTRIES = 10_000;

const loginWindows = new Map<string, { windowStart: number; count: number }>();

export interface LoginGate {
  disabled: boolean;
  locked: boolean;
  /** 锁定剩余秒数（未锁定为 0） */
  retryAfter: number;
  lockedUntil?: string;
}

export interface LoginFailureResult {
  attempts: number;
  locked: boolean;
  lockedUntil?: string;
  remainingAttempts: number;
}

/** 登录前置判定：账号禁用 / 锁定（锁定基于 DB，进程重启后仍然生效）。 */
export function checkLoginGate(row: UserRow, _env: Env, now = Date.now()): LoginGate {
  const disabled = row.status === 'disabled';
  const lockedUntilMs = row.locked_until ? Date.parse(row.locked_until) : Number.NaN;
  if (Number.isFinite(lockedUntilMs) && lockedUntilMs > now) {
    return {
      disabled,
      locked: true,
      retryAfter: Math.max(1, Math.ceil((lockedUntilMs - now) / 1_000)),
      lockedUntil: row.locked_until ?? undefined,
    };
  }
  return { disabled, locked: false, retryAfter: 0, lockedUntil: row.locked_until ?? undefined };
}

/** 记录一次失败登录；达到阈值时写入 locked_until。返回剩余可尝试次数。 */
export function registerLoginFailure(
  db: DatabaseSync,
  row: UserRow,
  env: Env,
  now = Date.now(),
): LoginFailureResult {
  const maxAttempts = Math.max(1, env.loginMaxAttempts);
  const lockedUntilMs = row.locked_until ? Date.parse(row.locked_until) : Number.NaN;
  const previous =
    Number.isFinite(lockedUntilMs) && lockedUntilMs <= now ? 0 : Math.max(0, row.failed_login_attempts ?? 0);
  const attempts = previous + 1;
  const locked = attempts >= maxAttempts;
  const lockedUntil = locked ? new Date(now + Math.max(1, env.loginLockMinutes) * 60_000).toISOString() : null;
  db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?').run(
    attempts,
    lockedUntil,
    row.id,
  );
  return {
    attempts,
    locked,
    lockedUntil: lockedUntil ?? undefined,
    remainingAttempts: Math.max(0, maxAttempts - attempts),
  };
}

/** 登录成功：清零失败计数与锁定。 */
export function resetLoginState(db: DatabaseSync, userId: string, at = nowIso()): void {
  db.prepare(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, last_seen_at = ? WHERE id = ?',
  ).run(at, at, userId);
}

/** 内存级 IP 限流：同一 IP 每分钟最多 30 次登录尝试。 */
export function assertLoginRateLimit(ip: string, now = Date.now()): void {
  const windowStart = Math.floor(now / LOGIN_RATE_WINDOW_MS) * LOGIN_RATE_WINDOW_MS;
  const entry = loginWindows.get(ip);
  if (!entry || entry.windowStart !== windowStart) {
    loginWindows.set(ip, { windowStart, count: 1 });
    if (loginWindows.size > LOGIN_RATE_MAX_ENTRIES) {
      for (const [key, value] of loginWindows) {
        if (value.windowStart < windowStart - LOGIN_RATE_WINDOW_MS * 2) loginWindows.delete(key);
      }
    }
    return;
  }
  entry.count += 1;
  if (entry.count > LOGIN_RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + LOGIN_RATE_WINDOW_MS - now) / 1_000));
    throw new HttpError(429, 'login_rate_limited', `登录尝试过于频繁，请在 ${retryAfter} 秒后重试`, {
      retryAfter,
    });
  }
}

/** 测试辅助：清空 IP 限流窗口。 */
export function resetLoginRateLimits(): void {
  loginWindows.clear();
}

function auditLoginFailure(
  rc: RequestContext,
  email: string,
  detail: Record<string, unknown>,
  userId?: string,
  orgId?: string,
): void {
  const actor = userId
    ? {
        type: 'user' as const,
        id: userId,
        label: email,
        ip: rc.ip || undefined,
        userAgent: rc.userAgent || undefined,
      }
    : {
        type: 'system' as const,
        id: 'auth',
        label: email,
        ip: rc.ip || undefined,
        userAgent: rc.userAgent || undefined,
      };
  writeAudit(rc.app.db, {
    orgId,
    actor,
    action: 'auth.login_failed',
    resourceType: 'session',
    resourceId: userId,
    detail: { ...detail, ip: rc.ip, userAgent: rc.userAgent },
  });
}

function recordAuthFailure(rc: RequestContext): void {
  rc.app.metrics.counter('mnemos_auth_failures_total');
  rc.app.metrics.counter('mnemos_auth_logins_total', { result: 'failure' });
}

function recordAuthSuccess(rc: RequestContext): void {
  rc.app.metrics.counter('mnemos_auth_logins_total', { result: 'success' });
}

export function registerAuthRoutes(router: Router): void {
  router.add({
    method: 'POST',
    path: '/api/auth/login',
    auth: 'none',
    handler: async (rc: RequestContext) => {
      const input = await rc.body(loginSchema);
      const email = input.email.toLowerCase();
      assertLoginRateLimit(rc.ip || 'unknown');

      const row = rc.app.db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email) as unknown as
        | UserRow
        | undefined;

      if (!row) {
        recordAuthFailure(rc);
        auditLoginFailure(rc, email, { reason: 'unknown_email' });
        throw errors.unauthorized('邮箱或密码不正确');
      }

      const gate = checkLoginGate(row, rc.app.env);
      if (gate.disabled) {
        recordAuthFailure(rc);
        auditLoginFailure(rc, email, { reason: 'account_disabled' }, row.id, row.org_id);
        throw new HttpError(403, 'account_disabled', '该账号已被禁用，请联系组织管理员');
      }
      if (gate.locked) {
        recordAuthFailure(rc);
        auditLoginFailure(rc, email, { reason: 'account_locked', retryAfter: gate.retryAfter }, row.id, row.org_id);
        rc.res.setHeader('retry-after', String(gate.retryAfter));
        throw new HttpError(423, 'account_locked', `账号已锁定，请在 ${gate.retryAfter} 秒后重试`, {
          retryAfter: gate.retryAfter,
          lockedUntil: gate.lockedUntil,
        });
      }

      if (!verifyPassword(input.password, row.password_hash)) {
        const failure = registerLoginFailure(rc.app.db, row, rc.app.env);
        recordAuthFailure(rc);
        auditLoginFailure(
          rc,
          email,
          {
            reason: 'invalid_password',
            attempts: failure.attempts,
            locked: failure.locked,
            lockedUntil: failure.lockedUntil,
          },
          row.id,
          row.org_id,
        );
        if (failure.locked) {
          const retryAfter = Math.max(1, Math.ceil(rc.app.env.loginLockMinutes * 60));
          rc.res.setHeader('retry-after', String(retryAfter));
        }
        throw new HttpError(401, 'UNAUTHORIZED', '邮箱或密码不正确', {
          remainingAttempts: failure.remainingAttempts,
          locked: failure.locked,
          lockedUntil: failure.lockedUntil,
        });
      }

      const orgRow = rc.app.db.prepare('SELECT * FROM orgs WHERE id = ?').get(row.org_id) as unknown as
        | OrgRow
        | undefined;
      if (!orgRow) throw errors.unauthorized('账号所属组织不存在');

      const token = randomToken(32);
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + Math.max(1, rc.app.env.sessionTtlHours) * 3_600_000).toISOString();

      rc.app.db
        .prepare(
          `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sha256(token), row.id, createdAt, expiresAt, rc.ip || null, rc.userAgent || null, createdAt);
      resetLoginState(rc.app.db, row.id, createdAt);

      const user = toUser({ ...row, last_seen_at: createdAt, last_login_at: createdAt, failed_login_attempts: 0, locked_until: null });
      recordAuthSuccess(rc);
      writeAudit(rc.app.db, {
        orgId: orgRow.id,
        actor: actorForUser(rc, user),
        action: 'auth.login',
        resourceType: 'session',
        resourceId: user.id,
        detail: { email: user.email, ip: rc.ip, userAgent: rc.userAgent },
      });

      const response: AuthResponse = {
        token,
        user,
        org: toOrg(orgRow),
      };
      rc.json(response);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/auth/password',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const input = await rc.body(passwordChangeSchema);
      const row = rc.app.db.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id) as unknown as
        | UserRow
        | undefined;
      if (!row) throw errors.unauthorized('账号不存在，请重新登录');

      if (!verifyPassword(input.currentPassword, row.password_hash)) {
        recordAuthFailure(rc);
        auditLoginFailure(rc, row.email, { reason: 'password_change_invalid_current' }, row.id, row.org_id);
        throw errors.badRequest('当前密码不正确');
      }
      if (input.newPassword === input.currentPassword) {
        throw errors.badRequest('新密码不能与当前密码相同');
      }

      const changedAt = nowIso();
      rc.app.db
        .prepare(
          `UPDATE users
              SET password_hash = ?, password_changed_at = ?, failed_login_attempts = 0, locked_until = NULL
            WHERE id = ?`,
        )
        .run(hashPassword(input.newPassword), changedAt, row.id);

      if (auth.token && auth.token !== 'auth-disabled') {
        rc.app.db
          .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
          .run(row.id, sha256(auth.token));
      } else {
        rc.app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      }

      writeAudit(rc.app.db, {
        orgId: row.org_id,
        actor: actorForUser(rc, auth.user),
        action: 'auth.password_changed',
        resourceType: 'user',
        resourceId: row.id,
        detail: { email: row.email, ip: rc.ip, userAgent: rc.userAgent },
      });

      rc.json({ ok: true, passwordChangedAt: changedAt });
    },
  });

  router.add({
    method: 'POST',
    path: '/api/auth/logout',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = rc.auth;
      if (auth && auth.kind === 'user' && auth.token !== 'auth-disabled') {
        rc.app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(auth.token));
        const user = auth.user;
        writeAudit(rc.app.db, {
          orgId: user.orgId,
          actor: actorForUser(rc, user),
          action: 'auth.logout',
          resourceType: 'session',
          resourceId: user.id,
          detail: { email: user.email },
        });
      }
      rc.json({ ok: true });
    },
  });

  router.add({
    method: 'GET',
    path: '/api/auth/me',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      rc.json({
        user: auth.user,
        org: auth.org,
        projects: visibleProjects(rc.app, auth.user),
      });
    },
  });

  router.add({
    method: 'GET',
    path: '/api/auth/demo-accounts',
    auth: 'none',
    handler: (rc: RequestContext) => {
      rc.json(DEMO_ACCOUNTS);
    },
  });
}
