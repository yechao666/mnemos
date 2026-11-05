import { APP_VERSION } from '../../../../shared/src/constants.ts';
import type { RequestContext } from '../context.ts';
import type { Router } from '../router.ts';

interface HealthBody {
  ok: boolean;
  version: string;
  uptimeMs: number;
  db: 'ok' | 'error';
  engine: 'ok' | 'unavailable';
  node: string;
}

export function registerHealthRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/health',
    auth: 'none',
    handler: (rc: RequestContext) => {
      let dbOk = true;
      try {
        rc.app.db.prepare('SELECT 1 AS ok').get();
      } catch {
        dbOk = false;
      }
      const engineOk =
        typeof rc.app.engine?.add === 'function' && typeof rc.app.engine?.search === 'function';
      const body: HealthBody = {
        ok: dbOk && engineOk,
        version: APP_VERSION,
        uptimeMs: Date.now() - rc.app.startedAt,
        db: dbOk ? 'ok' : 'error',
        engine: engineOk ? 'ok' : 'unavailable',
        node: process.version,
      };
      rc.json(body, dbOk ? 200 : 503);
    },
  });
}
