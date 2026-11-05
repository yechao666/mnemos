import { z } from 'zod';
import type { Project, ProjectMember, Role } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { nowIso } from '../../lib/ids.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { toProjectMember, type ProjectMemberRow, type UserRow } from '../mappers.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import { roleSchema } from '../schemas.ts';

const addMemberSchema = z
  .object({
    email: z.string().trim().min(3).max(254).optional(),
    userId: z.string().trim().min(1).max(64).optional(),
    role: roleSchema,
  })
  .refine((value) => Boolean(value.email) || Boolean(value.userId), {
    message: '请提供 email 或 userId',
    path: ['email'],
  });

const updateMemberSchema = z.object({ role: roleSchema });

function loadMember(rc: RequestContext, projectId: string, userId: string): ProjectMemberRow | null {
  const row = rc.app.db
    .prepare(
      `SELECT pm.user_id, pm.role, pm.created_at AS joined_at, u.name, u.email, u.avatar_color
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ? AND pm.user_id = ?`,
    )
    .get(projectId, userId) as unknown as ProjectMemberRow | undefined;
  return row ?? null;
}

function listMembers(rc: RequestContext, projectId: string): ProjectMember[] {
  const rows = rc.app.db
    .prepare(
      `SELECT pm.user_id, pm.role, pm.created_at AS joined_at, u.name, u.email, u.avatar_color
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ?
        ORDER BY pm.created_at ASC`,
    )
    .all(projectId) as unknown as ProjectMemberRow[];
  return rows.map(toProjectMember);
}

function findUser(rc: RequestContext, project: Project, input: { email?: string; userId?: string }): UserRow {
  const row = input.userId
    ? (rc.app.db
        .prepare('SELECT * FROM users WHERE id = ? AND org_id = ?')
        .get(input.userId, project.orgId) as unknown as UserRow | undefined)
    : (rc.app.db
        .prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND org_id = ?')
        .get(input.email ?? '', project.orgId) as unknown as UserRow | undefined);
  if (!row) throw errors.notFound('该用户不存在或不属于当前组织');
  return row;
}

export function registerMemberRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/members',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    handler: (rc: RequestContext) => {
      const project = rc.project as Project;
      rc.json(listMembers(rc, project.id));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/members',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(addMemberSchema);
      const user = findUser(rc, project, input);
      const existing = loadMember(rc, project.id, user.id);
      const role: Role = input.role;

      rc.app.db
        .prepare(
          `INSERT INTO project_members (project_id, user_id, role, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
        )
        .run(project.id, user.id, role, nowIso());

      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: existing ? 'member.update' : 'member.add',
        resourceType: 'project_member',
        resourceId: user.id,
        detail: { email: user.email, role, previousRole: existing?.role },
      });

      rc.json(listMembers(rc, project.id));
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/projects/:id/members/:userId',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const userId = rc.params.userId ?? '';
      const existing = loadMember(rc, project.id, userId);
      if (!existing) throw errors.notFound('该用户不是项目成员');
      const input = await rc.body(updateMemberSchema);

      rc.app.db
        .prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?')
        .run(input.role, project.id, userId);

      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'member.update',
        resourceType: 'project_member',
        resourceId: userId,
        detail: { email: existing.email, role: input.role, previousRole: existing.role },
      });

      rc.json(listMembers(rc, project.id));
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/projects/:id/members/:userId',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const userId = rc.params.userId ?? '';
      const existing = loadMember(rc, project.id, userId);
      if (!existing) throw errors.notFound('该用户不是项目成员');

      rc.app.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(project.id, userId);
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'member.remove',
        resourceType: 'project_member',
        resourceId: userId,
        detail: { email: existing.email, role: existing.role },
      });
      rc.json({ ok: true });
    },
  });
}
