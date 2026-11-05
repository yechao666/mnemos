import { z } from 'zod';
import type { Project } from '../../../../shared/src/types.ts';
import type { RequestContext } from '../context.ts';
import { engineCall } from '../engine.ts';
import type { Router } from '../router.ts';

const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(400).default(120),
});

export function registerGraphRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/graph',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'graph',
    channel: 'console',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(graphQuerySchema);
      const data = await engineCall(rc, () => rc.app.engine.graph(project.id, query.limit));
      rc.noteUsage(data.nodes.length);
      rc.json(data);
    },
  });
}
