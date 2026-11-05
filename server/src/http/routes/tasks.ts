import type { Project } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { estimateTokens } from '../../lib/usage.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { engineCall } from '../engine.ts';
import { publishLive } from '../live.ts';
import { requireConsoleAuth, requireProjectAccess } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import { finishTaskSchema, taskCreateSchema, taskListQuerySchema, taskUpdateSchema } from '../schemas.ts';

function taskProjectId(rc: RequestContext, taskId: string): string {
  const row = rc.app.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as unknown as
    | { project_id: string }
    | undefined;
  if (!row) throw errors.notFound('任务不存在');
  return row.project_id;
}

/** 控制台任务会话：列表 / 创建 / 单条 / 更新 / 结束。 */
export function registerTaskRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/tasks',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'task',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(taskListQuerySchema);
      const tasks = await engineCall(rc, () =>
        rc.app.engine.tasks(project.id, { status: query.status, agentId: query.agentId, limit: query.limit }),
      );
      rc.noteUsage(tasks.length);
      rc.json(tasks);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/tasks',
    auth: 'console',
    project: { param: 'id', minRole: 'developer' },
    operation: 'task',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(taskCreateSchema);
      const task = await engineCall(rc, () => rc.app.engine.createTask(project.id, input, actorForUser(rc, auth.user)));
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'task.create',
        resourceType: 'task',
        resourceId: task.id,
        detail: { title: task.title, status: task.status, ownerAgentId: task.ownerAgentId ?? null },
      });
      rc.noteUsage(1);
      rc.json(task, 201);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/tasks/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const taskId = rc.params.id ?? '';
      const project = requireProjectAccess(rc, taskProjectId(rc, taskId), 'viewer');
      const task = await engineCall(rc, () => rc.app.engine.task(project.id, taskId));
      if (!task) throw errors.notFound('任务不存在');
      rc.markUsage({ projectId: project.id, operation: 'task', orgId: project.orgId });
      rc.noteUsage(1);
      rc.json(task);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/tasks/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const taskId = rc.params.id ?? '';
      const project = requireProjectAccess(rc, taskProjectId(rc, taskId), 'developer');
      const input = await rc.body(taskUpdateSchema);
      const task = await engineCall(rc, () =>
        rc.app.engine.updateTask(project.id, taskId, input, actorForUser(rc, auth.user)),
      );
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'task.update',
        resourceType: 'task',
        resourceId: task.id,
        detail: { fields: Object.keys(input) },
      });
      rc.markUsage({ projectId: project.id, operation: 'task', orgId: project.orgId });
      rc.noteUsage(1);
      rc.json(task);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/tasks/:id/finish',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const taskId = rc.params.id ?? '';
      const project = requireProjectAccess(rc, taskProjectId(rc, taskId), 'developer');
      const input = await rc.body(finishTaskSchema);
      const result = await engineCall(rc, () =>
        rc.app.engine.finishTask(project.id, taskId, input, actorForUser(rc, auth.user)),
      );
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'task.finish',
        resourceType: 'task',
        resourceId: result.task.id,
        detail: {
          status: result.task.status,
          memories: result.memories.length,
          memoryIds: result.memories.map((memory) => memory.id),
        },
      });
      publishLive(rc.app, {
        type: 'task.finished',
        projectId: project.id,
        projectName: project.name,
        actor: auth.user.name || auth.user.email,
        summary: `任务「${result.task.title}」已${result.task.status === 'done' ? '完成' : '结束'}，沉淀 ${result.memories.length} 条记忆`,
        meta: {
          taskId: result.task.id,
          status: result.task.status,
          memories: result.memories.length,
        },
      });
      rc.markUsage({ projectId: project.id, operation: 'task', orgId: project.orgId });
      rc.noteUsage(
        result.memories.length,
        result.memories.reduce((sum, memory) => sum + estimateTokens(memory.content), 0),
      );
      rc.json(result);
    },
  });
}
