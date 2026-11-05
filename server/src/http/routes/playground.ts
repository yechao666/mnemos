import type { Project } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { engineCall, memoryTokenCount } from '../engine.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import type { Router } from '../router.ts';
import { addMemorySchema, searchMemorySchema } from '../schemas.ts';

export function registerPlaygroundRoutes(router: Router): void {
  router.add({
    method: 'POST',
    path: '/api/projects/:id/playground/add',
    auth: 'console',
    project: { param: 'id', minRole: 'developer' },
    operation: 'add',
    channel: 'playground',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(addMemorySchema);
      const actor = actorForUser(rc, auth.user);

      const result = await engineCall(rc, () =>
        rc.app.engine.add({
          projectId: project.id,
          messages: input.messages,
          text: input.text,
          userId: input.userId,
          agentId: input.agentId,
          runId: input.runId,
          appId: input.appId,
          taskId: input.taskId,
          visibility: input.visibility,
          metadata: input.metadata,
          tags: input.tags,
          infer: input.infer,
          mode: input.mode,
          source: 'playground',
          actor,
        }),
      );

      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'memory.create',
        resourceType: 'memory',
        resourceId: result.results[0]?.id,
        detail: {
          channel: 'playground',
          extracted: result.extracted,
          merged: result.merged,
          skipped: result.skipped,
          memoryIds: result.results.map((memory) => memory.id),
        },
      });

      rc.noteUsage(result.results.length, memoryTokenCount(result.results));
      rc.json(result);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/playground/search',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'search',
    channel: 'playground',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const input = await rc.body(searchMemorySchema);
      const response = await engineCall(rc, () =>
        rc.app.engine.search({
          projectId: project.id,
          query: input.query,
          userId: input.userId,
          agentId: input.agentId,
          runId: input.runId,
          appId: input.appId,
          taskId: input.taskId,
          visibility: input.visibility,
          includePrivate: input.includePrivate,
          topK: input.topK ?? project.settings.topK,
          threshold: input.threshold ?? project.settings.threshold,
          filters: input.filters,
        }),
      );
      rc.noteUsage(response.results.length, memoryTokenCount(response.results));
      rc.json(response);
    },
  });
}
