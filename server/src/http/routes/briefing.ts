import type { Project } from '../../../../shared/src/types.ts';
import { type RequestContext } from '../context.ts';
import { engineCall } from '../engine.ts';
import type { Router } from '../router.ts';
import { briefingQuerySchema } from '../schemas.ts';

/** 控制台任务简报：人类查看「Agent 接入时会拿到什么」。 */
export function registerBriefingRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/briefing',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'briefing',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(briefingQuerySchema);
      const briefing = await engineCall(rc, () =>
        rc.app.engine.briefing({
          projectId: project.id,
          agentId: query.agentId,
          taskId: query.taskId,
          query: query.query,
          budgetTokens: query.budgetTokens,
          includePrivate: query.includePrivate ?? true,
        }),
      );
      const hits = briefing.sections.reduce((sum, section) => sum + section.hits.length, 0);
      rc.noteUsage(hits, briefing.tokenEstimate);
      rc.json(briefing);
    },
  });
}
