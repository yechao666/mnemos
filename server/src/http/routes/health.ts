import { APP_VERSION } from '../../../../shared/src/constants.ts';
import type { RequestContext } from '../context.ts';
import type { Router } from '../router.ts';

interface HealthBody {
  ok: boolean;
  version: string;
  uptimeMs: number;
  schemaVersion: number;
  db: 'ok' | 'error';
  node: string;
}

function health(rc: RequestContext): HealthBody {
  let dbOk = true;
  let schemaVersion = 0;
  try {
    rc.app.db.prepare('SELECT 1 AS ok').get();
    const row = rc.app.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as unknown as
      | { value: string }
      | undefined;
    schemaVersion = row ? Number(row.value) : 0;
  } catch {
    dbOk = false;
  }
  return {
    ok: dbOk,
    version: APP_VERSION,
    uptimeMs: Date.now() - rc.app.startedAt,
    schemaVersion,
    db: dbOk ? 'ok' : 'error',
    node: process.version,
  };
}

export function registerHealthRoutes(router: Router): void {
  const handler = (rc: RequestContext) => {
    const body = health(rc);
    rc.json(body, body.ok ? 200 : 503);
  };
  router.add({ method: 'GET', path: '/health', auth: 'none', handler });
  router.add({ method: 'GET', path: '/api/health', auth: 'none', handler });
}
