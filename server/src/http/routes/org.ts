import { ROLE_RANK } from '../../../../shared/src/constants.ts';
import type { ApiKey, OrgUser } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { newApiKeySecret, newId, nowIso, randomToken } from '../../lib/ids.ts';
import { hashPassword } from '../../lib/password.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { requireConsoleAuth, requireConsoleRole } from '../middleware/auth.ts';
import { toApiKey, toOrg, toUser, type ApiKeyRow, type OrgRow, type UserRow } from '../mappers.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import { apiKeyCreateSchema, orgUserCreateSchema, orgUserUpdateSchema } from '../schemas.ts';

/** 组织设置：账号、组织级 API Key（控制台 /api）。 */

function orgRow(rc: RequestContext): OrgRow {
  const auth = requireConsoleAuth(rc);
  const row = rc.app.db.prepare('SELECT * FROM orgs WHERE id = ?').get(auth.org.id) as unknown as
    | OrgRow
    | undefined;
  if (!row) throw errors.notFound('组织不存在');
  return row;
}

function activeSessions(db: RequestContext['app']['db'], userId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM user_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(userId, nowIso()) as unknown as { c: number };
  return row?.c ?? 0;
}

export function registerOrgRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/org',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const row = orgRow(rc);
      const counts = rc.app.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM users WHERE org_id = ?) AS users,
             (SELECT COUNT(*) FROM partitions WHERE org_id = ?) AS partitions`,
        )
        .get(auth.org.id, auth.org.id) as unknown as { users: number; partitions: number };
      rc.json({ org: toOrg(row), counts });
    },
  });

  router.add({
    method: 'GET',
    path: '/api/org/users',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleRole(rc, 'admin');
      const rows = rc.app.db
        .prepare('SELECT * FROM users WHERE org_id = ? ORDER BY created_at ASC')
        .all(auth.org.id) as unknown as UserRow[];
      const users: OrgUser[] = rows.map((row) => ({
        ...toUser(row),
        activeSessions: activeSessions(rc.app.db, row.id),
      }));
      rc.json(users);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/org/users',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleRole(rc, 'admin');
      const body = await rc.body(orgUserCreateSchema);
      if (body.role === 'owner' && auth.user.role !== 'owner') {
        throw errors.forbidden('只有组织所有者可以创建 owner 账号');
      }
      const existing = rc.app.db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(body.email);
      if (existing) throw errors.conflict('该邮箱已被使用');
      const id = newId('usr');
      const at = nowIso();
      const temporaryPassword = body.password ?? `${randomToken(9)}${Math.floor(Math.random() * 90 + 10)}`;
      rc.app.db
        .prepare(
          `INSERT INTO users
             (id, org_id, email, name, role, title, avatar_color, password_hash, status,
              password_changed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'violet', ?, 'active', ?, ?)`,
        )
        .run(
          id,
          auth.org.id,
          body.email,
          body.name,
          body.role,
          body.title ?? null,
          hashPassword(temporaryPassword),
          at,
          at,
        );
      writeAudit(rc.app.db, {
        orgId: auth.org.id,
        actor: actorForUser(rc, auth.user),
        action: 'org.user_create',
        resourceType: 'user',
        resourceId: id,
        detail: { email: body.email, role: body.role },
      });
      const row = rc.app.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow;
      rc.json({ user: toUser(row), temporaryPassword }, 201);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/org/users/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleRole(rc, 'admin');
      const target = rc.app.db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(
        rc.params.id ?? '',
        auth.org.id,
      ) as unknown as UserRow | undefined;
      if (!target) throw errors.notFound('账号不存在');
      const body = await rc.body(orgUserUpdateSchema);
      if (target.role === 'owner' && body.role && body.role !== 'owner' && auth.user.role !== 'owner') {
        throw errors.forbidden('只有组织所有者可以变更 owner 角色');
      }
      if (body.role === 'owner' && auth.user.role !== 'owner') {
        throw errors.forbidden('只有组织所有者可以授予 owner 角色');
      }
      if (target.id === auth.user.id && body.status === 'disabled') {
        throw errors.badRequest('不能禁用当前登录账号');
      }
      const role = body.role ?? target.role;
      const status = body.status ?? target.status ?? 'active';
      const name = body.name ?? target.name;
      const title = body.title !== undefined ? body.title : target.title;
      rc.app.db
        .prepare('UPDATE users SET role = ?, status = ?, name = ?, title = ? WHERE id = ?')
        .run(role, status, name, title, target.id);
      if (status === 'disabled') {
        rc.app.db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(target.id);
      }
      const row = rc.app.db.prepare('SELECT * FROM users WHERE id = ?').get(target.id) as unknown as UserRow;
      rc.json(toUser(row));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/org/users/:id/reset-password',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleRole(rc, 'admin');
      const target = rc.app.db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(
        rc.params.id ?? '',
        auth.org.id,
      ) as unknown as UserRow | undefined;
      if (!target) throw errors.notFound('账号不存在');
      if (ROLE_RANK[target.role as keyof typeof ROLE_RANK] > ROLE_RANK[auth.user.role]) {
        throw errors.forbidden('不能重置更高权限账号的密码');
      }
      const temporaryPassword = `${randomToken(9)}${Math.floor(Math.random() * 90 + 10)}`;
      rc.app.db
        .prepare(
          `UPDATE users SET password_hash = ?, password_changed_at = ?, failed_login_attempts = 0, locked_until = NULL
            WHERE id = ?`,
        )
        .run(hashPassword(temporaryPassword), nowIso(), target.id);
      rc.app.db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(target.id);
      writeAudit(rc.app.db, {
        orgId: auth.org.id,
        actor: actorForUser(rc, auth.user),
        action: 'org.user_reset_password',
        resourceType: 'user',
        resourceId: target.id,
        detail: { email: target.email },
      });
      rc.json({ userId: target.id, temporaryPassword });
    },
  });

  /* --- 组织级 API Key（owner） --- */
  router.add({
    method: 'GET',
    path: '/api/org/keys',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      if (auth.user.role !== 'owner') throw errors.forbidden('组织级 API Key 仅组织所有者可管理');
      const rows = rc.app.db
        .prepare(
          `SELECT * FROM api_keys WHERE org_id = ? AND kind = 'org'
            ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
        )
        .all(auth.org.id) as unknown as ApiKeyRow[];
      rc.json(rows.map(toApiKey) satisfies ApiKey[]);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/org/keys',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      if (auth.user.role !== 'owner') throw errors.forbidden('组织级 API Key 仅组织所有者可管理');
      const body = await rc.body(apiKeyCreateSchema);
      const { secret, prefix, hash } = newApiKeySecret();
      const id = newId('key');
      const at = nowIso();
      rc.app.db
        .prepare(
          `INSERT INTO api_keys
             (id, partition_id, org_id, kind, name, prefix, key_hash, scopes, created_by, created_at,
              rate_limit_per_min, expires_at, allowed_ips)
           VALUES (?, NULL, ?, 'org', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          auth.org.id,
          body.name,
          prefix,
          hash,
          JSON.stringify([...new Set(body.scopes)]),
          auth.user.id,
          at,
          body.rateLimitPerMin ?? 600,
          body.expiresAt ? new Date(Date.parse(body.expiresAt)).toISOString() : null,
          JSON.stringify([...new Set(body.allowedIps ?? [])]),
        );
      writeAudit(rc.app.db, {
        orgId: auth.org.id,
        actor: actorForUser(rc, auth.user),
        action: 'org.key_create',
        resourceType: 'api_key',
        resourceId: id,
        detail: { name: body.name, scopes: body.scopes },
      });
      const row = rc.app.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as unknown as ApiKeyRow;
      rc.json({ ...toApiKey(row), secret }, 201);
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/org/keys/:id',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      if (auth.user.role !== 'owner') throw errors.forbidden('组织级 API Key 仅组织所有者可管理');
      const row = rc.app.db
        .prepare("SELECT * FROM api_keys WHERE id = ? AND org_id = ? AND kind = 'org'")
        .get(rc.params.id ?? '', auth.org.id) as unknown as ApiKeyRow | undefined;
      if (!row) throw errors.notFound('API Key 不存在');
      if (!row.revoked_at) {
        rc.app.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(), row.id);
        writeAudit(rc.app.db, {
          orgId: auth.org.id,
          actor: actorForUser(rc, auth.user),
          action: 'org.key_revoke',
          resourceType: 'api_key',
          resourceId: row.id,
        });
      }
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });
}
