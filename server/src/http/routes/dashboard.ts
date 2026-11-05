import type { DashboardSummary } from '../../../../shared/src/types.ts';
import type { RequestContext } from '../context.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import { dashboardSummary } from '../queries/projects.ts';
import type { Router } from '../router.ts';

export function registerDashboardRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/dashboard',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const summary: DashboardSummary = dashboardSummary(rc.app, auth.user, auth.org);
      rc.json(summary);
    },
  });
}
