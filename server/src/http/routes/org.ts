import { ROLE_RANK, TONE_COLORS } from '../../../../shared/src/constants.ts';
import type { ConsoleAuth, RequestContext } from '../context.ts';
import type { OrgUser, Role } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { newId, nowIso, randomToken, sha256 } from '../../lib/ids.ts';
import { hashPassword } from '../../lib/password.ts';
import { actorForUser } from '../context.ts';
import { toUser, type UserRow } from '../mappers.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import { orgUserCreateSchema, orgUserUpdateSchema } from '../schemas.ts';

/**
 * 组织成员管理（控制台）。
 *  - 列表 / 创建 / 重置密码：admin+
 *  - 角色变更 / 禁用 / 删除：仅 owner
 *  - owner 唯一性：任何时刻至少保留一名启用的 owner
 */

interface OrgUserRow extends UserRow {
  project_count?: number;
  active_sessions?: number;
}

const USER_SELECT = `
  SELECT u.*,
    (SELECT COUNT(*) FROM project_members pm WHERE pm.user_id = u.id) AS project_count,
    (SELECT COUNT(*) FROM sessions s
      WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS active_sessions
  FROM users u`;

function toOrgUser(row: OrgUserRow): OrgUser {
  return {
    ...toUser(row),
    projectCount: Number(row.project_count ?? 0),
    activeSessions: Number(row.active_sessions ?? 0),
  };
}

function loadOrgUsers(rc: RequestContext, orgId: string): OrgUser[] {
  const rows = rc.app.db
    .prepare(`${USER_SELECT} WHERE u.org_id = ? ORDER BY u.created_at ASC`)
    .all(nowIso(), orgId) as unknown as OrgUserRow[];
  return rows.map(toOrgUser);
}

function loadOrgUser(rc: RequestContext, orgId: string, userId: string): OrgUserRow | null {
  const row = rc.app.db
    .prepare(`${USER_SELECT} WHERE u.id = ? AND u.org_id = ?`)
    .get(nowIso(), userId, orgId) as unknown as OrgUserRow | undefined;
  return row ?? null;
}

function requireOrgAdmin(rc: RequestContext): ConsoleAuth {
  const auth = requireConsoleAuth(rc);
  if (ROLE_RANK[auth.user.role] < ROLE_RANK.admin) {
    throw errors.forbidden('该操作需要组织管理员及以上角色');
  }
  return auth;
}

function requireOrgOwner(auth: ConsoleAuth, action: string): void {
  if (auth.user.role !== 'owner') throw errors.forbidden(`${action}仅组织所有者可执行`);
}

/** 目标用户之外仍处于启用状态的 owner 数量。 */
function otherActiveOwners(rc: RequestContext, orgId: string, excludeUserId: string): number {
  const row = rc.app.db
    .prepare(
      `SELECT COUNT(*) AS c FROM users
        WHERE org_id = ? AND role = 'owner' AND status <> 'disabled' AND id <> ?`,
    )
    .get(orgId, excludeUserId) as unknown as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

function avatarColorFor(email: string): string {
  const index = Number.parseInt(sha256(email).slice(0, 8), 16) % TONE_COLORS.length;
  return TONE_COLORS[index] ?? 'violet';
}

/** 16 位一次性临时密码（base64url：字母/数字/-/_）。 */
function temporaryPassword(): string {
  return randomToken(12);
}

function deleteSessions(rc: RequestContext, userId: string): void {
  rc.app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function registerOrgRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/org/users',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireOrgAdmin(rc);
      const users = loadOrgUsers(rc, auth.org.id);
      rc.json(users);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/org/users',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireOrgAdmin(rc);
      const input = await rc.body(orgUserCreateSchema);

      if (auth.user.role !== 'owner' && (input.role === 'owner' || input.role === 'admin')) {
        throw errors.forbidden('仅组织所有者可创建管理员或所有者账号');
      }

      const existing = rc.app.db
        .prepare('SELECT id FROM users WHERE lower(email) = lower(?)')
        .get(input.email) as unknown as { id: string } | undefined;
      if (existing) throw errors.conflict('该邮箱已被使用');

      const id = newId('usr');
      const createdAt = nowIso();
      const password = input.password ?? temporaryPassword();
      rc.app.db
        .prepare(
          `INSERT INTO users
             (id, org_id, email, name, role, title, avatar_color, password_hash,
              status, password_changed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          auth.org.id,
          input.email,
          input.name,
          input.role,
          input.title ?? null,
          avatarColorFor(input.email),
          hashPassword(password),
          createdAt,
          createdAt,
        );

      const row = loadOrgUser(rc, auth.org.id, id);
      if (!row) throw errors.internal('用户创建失败');
      const user = toOrgUser(row);

      writeAudit(rc.app.db, {
        orgId: auth.org.id,
        actor: actorForUser(rc, auth.user),
        action: 'user.create',
        resourceType: 'user',
        resourceId: user.id,
        detail: {
          email: user.email,
          name: user.name,
          role: user.role,
          title: user.title ?? null,
          generatedPassword: input.password === undefined,
        },
      });

      rc.json({ user, temporaryPassword: password }, 201);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/org/users/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireOrgAdmin(rc);
      const userId = rc.params.id ?? '';
      const input = await rc.body(orgUserUpdateSchema);
      const target = loadOrgUser(rc, auth.org.id, userId);
      if (!target) throw errors.notFound('用户不存在');

      const previousRole = target.role as Role;
      const previousStatus = target.status === 'disabled' ? 'disabled' : 'active';
      const roleChanged = input.role !== undefined && input.role !== previousRole;
      const statusChanged = input.status !== undefined && input.status !== previousStatus;

      if (roleChanged) {
        requireOrgOwner(auth, '修改成员角色');
        if (target.id === auth.user.id) throw errors.forbidden('不能修改自己的角色');
        if (previousRole === 'owner' && otherActiveOwners(rc, auth.org.id, target.id) === 0) {
          throw errors.conflict('至少需要保留一名启用的 owner');
        }
      }

      if (statusChanged) {
        requireOrgOwner(auth, '启用或禁用成员');
        if (target.id === auth.user.id && input.status === 'disabled') {
          throw errors.forbidden('不能禁用自己的账号');
        }
        if (input.status === 'disabled' && previousRole === 'owner' && otherActiveOwners(rc, auth.org.id, target.id) === 0) {
          throw errors.conflict('至少需要保留一名启用的 owner');
        }
      }

      const fields: string[] = [];
      const args: (string | null)[] = [];
      if (input.name !== undefined) {
        fields.push('name = ?');
        args.push(input.name);
      }
      if (input.title !== undefined) {
        fields.push('title = ?');
        args.push(input.title);
      }
      if (input.role !== undefined) {
        fields.push('role = ?');
        args.push(input.role);
      }
      if (input.status !== undefined) {
        fields.push('status = ?');
        args.push(input.status);
      }

      if (fields.length > 0) {
        rc.app.db
          .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`)
          .run(...args, target.id, auth.org.id);
      }
      if (input.status === 'disabled') deleteSessions(rc, target.id);

      const row = loadOrgUser(rc, auth.org.id, target.id);
      if (!row) throw errors.internal('用户更新失败');
      const user = toOrgUser(row);

      writeAudit(rc.app.db, {
        orgId: auth.org.id,
        actor: actorForUser(rc, auth.user),
        action: 'user.update',
        resourceType: 'user',
        resourceId: user.id,
        detail: {
          email: user.email,
          fields: Object.keys(input),
          role: { from: previousRole, to: user.role },
          status: { from: previousStatus, to: user.status },
          sessionsRevoked: input.status === 'disabled',
        },
      });

      rc.json(user);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/org/users/:id/reset-password',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireOrgAdmin(rc);
      const userId = rc.params.id ?? '';
      const target = loadOrgUser(rc, auth.org.id, userId);
      if (!target) throw errors.notFound('用户不存在');
      if ((target.role as Role) === 'owner' && auth.user.role !== 'owner') {
        throw errors.forbidden('仅组织所有者可重置 owner 的密码');
      }

      const password = temporaryPassword();
      rc.app.db
        .prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ? AND org_id = ?')
        .run(hashPassword(password), nowIso(), target.id, auth.org.id);
      deleteSessions(rc, target.id);

      writeAudit(rc.app.db, {
        orgId: auth.org.id,
        actor: actorForUser(rc, auth.user),
        action: 'user.reset_password',
        resourceType: 'user',
        resourceId: target.id,
        detail: { email: target.email, role: target.role },
      });

      rc.json({ userId: target.id, temporaryPassword: password });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/org/users/:id',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireOrgAdmin(rc);
      requireOrgOwner(auth, '删除成员');
      const userId = rc.params.id ?? '';
      const target = loadOrgUser(rc, auth.org.id, userId);
      if (!target) throw errors.notFound('用户不存在');
      if (target.id === auth.user.id) throw errors.forbidden('不能删除自己的账号');
      if ((target.role as Role) === 'owner' && otherActiveOwners(rc, auth.org.id, target.id) === 0) {
        throw errors.conflict('至少需要保留一名启用的 owner');
      }

      writeAudit(rc.app.db, {
        orgId: auth.org.id,
        actor: actorForUser(rc, auth.user),
        action: 'user.delete',
        resourceType: 'user',
        resourceId: target.id,
        detail: { email: target.email, role: target.role },
      });
      rc.app.db.prepare('DELETE FROM users WHERE id = ? AND org_id = ?').run(target.id, auth.org.id);
      rc.json({ ok: true });
    },
  });
}
