import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DEFAULT_PROJECT_SETTINGS, ROLE_RANK } from '../../../../shared/src/constants.ts';
import type { Project, ProjectSettings } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { tx } from '../../db/index.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { publishLive } from '../live.ts';
import { toProject, type ProjectRow } from '../mappers.ts';
import { requireConsoleAuth, visibleProjects } from '../middleware/auth.ts';
import { queryAuditLogs } from '../queries/audit.ts';
import { projectHealth, projectOverview, projectSummaries, projectSummary } from '../queries/projects.ts';
import { usageAnalytics } from '../queries/usage.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import {
  auditQuerySchema,
  environmentSchema,
  projectSettingsPatchSchema,
  projectStatusSchema,
  usageQuerySchema,
} from '../schemas.ts';

type SettingsPatch = Partial<Omit<ProjectSettings, 'webhookUrl' | 'weights'>> & {
  webhookUrl?: string | null;
  weights?: Partial<ProjectSettings['weights']>;
};

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'slug 仅支持小写字母、数字与连字符，且以字母或数字开头')
    .optional(),
  description: z.string().trim().max(500).optional(),
  region: z.string().trim().max(64).optional(),
  env: environmentSchema.optional(),
  settings: projectSettingsPatchSchema.optional(),
});

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'slug 仅支持小写字母、数字与连字符，且以字母或数字开头')
      .optional(),
    description: z.string().trim().max(500).optional(),
    status: projectStatusSchema.optional(),
    region: z.string().trim().max(64).optional(),
    env: environmentSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (base.length > 0) return base;
  return `project-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueSlug(db: DatabaseSync, orgId: string, base: string, excludeId = ''): string {
  const normalized = base.slice(0, 48) || 'project';
  let slug = normalized;
  let suffix = 2;
  const exists = db.prepare('SELECT 1 AS x FROM projects WHERE org_id = ? AND slug = ? AND id <> ?');
  while (exists.get(orgId, slug, excludeId)) {
    slug = `${normalized}-${suffix}`;
    suffix += 1;
    if (suffix > 200) {
      slug = `${normalized}-${Date.now().toString(36)}`;
      break;
    }
  }
  return slug;
}

function mergeSettings(base: ProjectSettings, patch: SettingsPatch | undefined): ProjectSettings {
  if (!patch) return { ...base, weights: { ...base.weights } };
  const { weights, webhookUrl, ...rest } = patch;
  const merged: ProjectSettings = {
    ...base,
    ...rest,
    weights: { ...base.weights, ...(weights ?? {}) },
  };
  if (webhookUrl !== undefined) {
    if (webhookUrl === null) delete merged.webhookUrl;
    else merged.webhookUrl = webhookUrl;
  }
  return merged;
}

function reloadProject(db: DatabaseSync, projectId: string): Project {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as unknown as ProjectRow | undefined;
  if (!row) throw errors.notFound('项目不存在');
  return toProject(row);
}

export function registerProjectRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      rc.json(projectSummaries(rc.app, visibleProjects(rc.app, auth.user)));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      if (ROLE_RANK[auth.user.role] < ROLE_RANK.developer) {
        throw errors.forbidden('创建项目需要 developer 及以上角色');
      }
      const input = await rc.body(createProjectSchema);
      const id = newId('prj');
      const now = nowIso();
      const slug = uniqueSlug(rc.app.db, auth.user.orgId, input.slug ?? slugify(input.name));
      const settings = mergeSettings({ ...DEFAULT_PROJECT_SETTINGS }, input.settings);
      const region = input.region?.trim() || 'cn-shanghai';
      const env = input.env ?? 'production';

      // 项目 + 创建者成员关系在同一事务中写入。
      tx(rc.app.db, () => {
        rc.app.db
          .prepare(
            `INSERT INTO projects
               (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            auth.user.orgId,
            slug,
            input.name,
            input.description ?? '',
            region,
            env,
            JSON.stringify(settings),
            now,
            now,
          );

        // 创建者自动成为项目管理员（org owner/admin 本身即全项目可见，这里是 developer 创建后的兜底授权）。
        rc.app.db
          .prepare(
            `INSERT INTO project_members (project_id, user_id, role, created_at)
             VALUES (?, ?, 'admin', ?)
             ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
          )
          .run(id, auth.user.id, now);
      });

      const project = reloadProject(rc.app.db, id);
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'project.create',
        resourceType: 'project',
        resourceId: project.id,
        detail: { name: project.name, slug: project.slug, region, env },
      });
      publishLive(rc.app, {
        type: 'project.created',
        projectId: project.id,
        projectName: project.name,
        actor: auth.user.name,
        summary: `创建项目「${project.name}」`,
      });
      rc.json(projectSummary(rc.app, project), 201);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    handler: (rc: RequestContext) => {
      const project = rc.project as Project;
      const summary = projectSummary(rc.app, project);
      rc.json({ ...summary, health: projectHealth(rc.app, summary.stats, summary.keys) });
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/projects/:id',
    auth: 'console',
    project: { param: 'id', minRole: 'developer' },
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(updateProjectSchema);
      const now = nowIso();
      const sets: string[] = [];
      const args: Array<string | null> = [];

      if (input.name !== undefined) {
        sets.push('name = ?');
        args.push(input.name);
      }
      if (input.slug !== undefined) {
        sets.push('slug = ?');
        args.push(uniqueSlug(rc.app.db, project.orgId, input.slug, project.id));
      }
      if (input.description !== undefined) {
        sets.push('description = ?');
        args.push(input.description);
      }
      if (input.region !== undefined) {
        sets.push('region = ?');
        args.push(input.region);
      }
      if (input.env !== undefined) {
        sets.push('env = ?');
        args.push(input.env);
      }
      if (input.status !== undefined) {
        sets.push('status = ?');
        args.push(input.status);
        sets.push('archived_at = ?');
        args.push(input.status === 'archived' ? now : null);
      }
      sets.push('updated_at = ?');
      args.push(now);

      rc.app.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args, project.id);
      const updated = reloadProject(rc.app.db, project.id);

      writeAudit(rc.app.db, {
        orgId: updated.orgId,
        projectId: updated.id,
        actor: actorForUser(rc, auth.user),
        action: 'project.update',
        resourceType: 'project',
        resourceId: updated.id,
        detail: {
          fields: Object.entries(input)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key),
        },
      });
      rc.json(projectSummary(rc.app, updated));
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/projects/:id',
    auth: 'console',
    project: { param: 'id', minRole: 'owner' },
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const now = nowIso();
      rc.app.db
        .prepare("UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, project.id);
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'project.delete',
        resourceType: 'project',
        resourceId: project.id,
        detail: { name: project.name },
      });
      rc.json({ ok: true });
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/overview',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    handler: (rc: RequestContext) => {
      const project = rc.project as Project;
      rc.json(projectOverview(rc.app, project));
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/usage',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    handler: (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(usageQuerySchema);
      rc.json(usageAnalytics(rc.app.db, project.id, query.days));
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/audit',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(auditQuerySchema);
      rc.json(
        queryAuditLogs(rc.app.db, {
          projectId: project.id,
          page: query.page,
          pageSize: query.pageSize,
          action: query.action,
          actor: query.actor,
        }),
      );
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/projects/:id/settings',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const patch = await rc.body(projectSettingsPatchSchema);
      const settings = mergeSettings(project.settings, patch as SettingsPatch);
      const now = nowIso();
      rc.app.db
        .prepare('UPDATE projects SET settings = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(settings), now, project.id);
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'settings.update',
        resourceType: 'project_settings',
        resourceId: project.id,
        detail: { keys: Object.keys(patch) },
      });
      rc.json(projectSummary(rc.app, reloadProject(rc.app.db, project.id)));
    },
  });
}
