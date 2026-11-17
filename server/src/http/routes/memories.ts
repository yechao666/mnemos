import type { Memory, Project, SearchFilters } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { estimateTokens } from '../../lib/usage.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { engineCall, memoryTokenCount } from '../engine.ts';
import { requireConsoleAuth, requireProjectAccess } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import {
  bulkMemorySchema,
  feedbackSchema,
  memoryListQuerySchema,
  updateMemorySchema,
} from '../schemas.ts';

function memoryProjectId(rc: RequestContext, memoryId: string): string {
  const row = rc.app.db.prepare('SELECT project_id FROM memories WHERE id = ?').get(memoryId) as unknown as
    | { project_id: string }
    | undefined;
  if (!row) throw errors.notFound('记忆不存在');
  return row.project_id;
}

export function registerMemoryRoutes(router: Router): void {
  // 批量操作必须先于 /api/memories/:id 注册，避免路径歧义。
  router.add({
    method: 'POST',
    path: '/api/memories/bulk',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const input = await rc.body(bulkMemorySchema);
      const ids = [...new Set(input.ids)];
      const placeholders = ids.map(() => '?').join(', ');
      const rows = rc.app.db
        .prepare(`SELECT id, project_id FROM memories WHERE id IN (${placeholders})`)
        .all(...ids) as unknown as Array<{ id: string; project_id: string }>;

      const groups = new Map<string, string[]>();
      for (const row of rows) {
        const group = groups.get(row.project_id) ?? [];
        group.push(row.id);
        groups.set(row.project_id, group);
      }

      // 先完成全部项目的权限校验，避免部分写入后才 403。
      const authorized: Array<{ project: Project; ids: string[] }> = [];
      for (const [projectId, groupIds] of groups) {
        authorized.push({ project: requireProjectAccess(rc, projectId, 'developer'), ids: groupIds });
      }

      let affected = 0;
      let firstProjectId: string | null = null;
      for (const entry of authorized) {
        const project = entry.project;
        firstProjectId ??= project.id;
        const result = await engineCall(rc, () =>
          rc.app.engine.bulk(project.id, { action: input.action, ids: entry.ids }, actorForUser(rc, auth.user)),
        );
        affected += result.affected;
        writeAudit(rc.app.db, {
          orgId: project.orgId,
          projectId: project.id,
          actor: actorForUser(rc, auth.user),
          action: 'memory.bulk',
          resourceType: 'memory',
          resourceId: project.id,
          detail: { action: input.action, ids: entry.ids, affected: result.affected },
        });
      }

      if (firstProjectId) {
        rc.markUsage({
          projectId: firstProjectId,
          operation: input.action === 'delete' ? 'delete' : 'update',
        });
        rc.noteUsage(affected);
      }
      rc.json({ affected });
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/memories',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(memoryListQuerySchema);
      const keyword = query.q?.trim() ?? '';

      if (keyword.length > 0) {
        const topK = Math.min(200, query.pageSize * query.page);
        const filters: SearchFilters = {};
        if (query.category) filters.category = query.category;
        if (query.status) filters.status = query.status;

        const search = await engineCall(rc, () =>
          rc.app.engine.search({
            projectId: project.id,
            query: keyword,
            personId: query.personId,
            scope: query.scope,
            userId: query.userId,
            writtenByAgentId: query.writtenByAgentId ?? query.agentId,
            runId: query.runId,
            taskId: query.taskId,
            visibility: query.visibility,
            // 控制台是观测窗口：默认包含 Agent 私有 / 任务记忆，可用 includePrivate=false 收紧。
            includePrivate: query.includePrivate ?? true,
            filters,
            topK,
          }),
        );
        const offset = (query.page - 1) * query.pageSize;
        const items = search.results.slice(offset, offset + query.pageSize);
        const total = search.total || search.results.length;

        rc.markUsage({ projectId: project.id, operation: 'search', orgId: project.orgId });
        rc.noteUsage(items.length, memoryTokenCount(items));
        rc.json({
          items,
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
          hits: search.results,
          tookMs: search.tookMs,
        });
        return;
      }

      const result = await engineCall(rc, () =>
        rc.app.engine.list({
          projectId: project.id,
          personId: query.personId,
          scope: query.scope,
          userId: query.userId,
          writtenByAgentId: query.writtenByAgentId ?? query.agentId,
          runId: query.runId,
          taskId: query.taskId,
          visibility: query.visibility,
          includePrivate: query.includePrivate ?? true,
          category: query.category,
          status: query.status,
          sort: query.sort,
          page: query.page,
          pageSize: query.pageSize,
        }),
      );
      rc.markUsage({ projectId: project.id, operation: 'list', orgId: project.orgId });
      rc.noteUsage(result.items.length, memoryTokenCount(result.items));
      rc.json(result);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/memories/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const memoryId = rc.params.id ?? '';
      const project = requireProjectAccess(rc, memoryProjectId(rc, memoryId), 'viewer');
      const detail = await engineCall(rc, () => rc.app.engine.get(project.id, memoryId));
      if (!detail) throw errors.notFound('记忆不存在');
      rc.markUsage({ projectId: project.id, operation: 'get', orgId: project.orgId });
      rc.noteUsage(1, estimateTokens(detail.memory.content));
      rc.json(detail);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/memories/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const memoryId = rc.params.id ?? '';
      const project = requireProjectAccess(rc, memoryProjectId(rc, memoryId), 'developer');
      const input = await rc.body(updateMemorySchema);
      const memory: Memory = await engineCall(rc, () =>
        rc.app.engine.update(project.id, memoryId, input, actorForUser(rc, auth.user)),
      );
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'memory.update',
        resourceType: 'memory',
        resourceId: memoryId,
        detail: { fields: Object.keys(input) },
      });
      rc.markUsage({ projectId: project.id, operation: 'update', orgId: project.orgId });
      rc.noteUsage(1, estimateTokens(memory.content));
      rc.json(memory);
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/memories/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const memoryId = rc.params.id ?? '';
      const project = requireProjectAccess(rc, memoryProjectId(rc, memoryId), 'developer');
      await engineCall(rc, () => rc.app.engine.remove(project.id, memoryId, actorForUser(rc, auth.user)));
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'memory.delete',
        resourceType: 'memory',
        resourceId: memoryId,
        detail: {},
      });
      rc.markUsage({ projectId: project.id, operation: 'delete', orgId: project.orgId });
      rc.noteUsage(1);
      rc.json({ ok: true });
    },
  });

  router.add({
    method: 'GET',
    path: '/api/memories/:id/history',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const memoryId = rc.params.id ?? '';
      const project = requireProjectAccess(rc, memoryProjectId(rc, memoryId), 'viewer');
      const history = await engineCall(rc, () => rc.app.engine.history(project.id, memoryId));
      rc.markUsage({ projectId: project.id, operation: 'get', orgId: project.orgId });
      rc.noteUsage(history.length);
      rc.json(history);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/memories/:id/feedback',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const memoryId = rc.params.id ?? '';
      const project = requireProjectAccess(rc, memoryProjectId(rc, memoryId), 'developer');
      const input = await rc.body(feedbackSchema);
      const memory = await engineCall(rc, () =>
        rc.app.engine.feedback(project.id, memoryId, input, actorForUser(rc, auth.user)),
      );
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'memory.feedback',
        resourceType: 'memory',
        resourceId: memoryId,
        detail: { helpful: input.helpful, query: input.query ?? null },
      });
      rc.markUsage({ projectId: project.id, operation: 'update', orgId: project.orgId });
      rc.noteUsage(1, estimateTokens(memory.content));
      rc.json(memory);
    },
  });

}
