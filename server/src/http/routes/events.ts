import { formatSseEvent } from '../live.ts';
import { requireConsoleAuth, visibleProjects } from '../middleware/auth.ts';
import type { RequestContext } from '../context.ts';
import type { Router } from '../router.ts';

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * SSE 实时事件流：`GET /api/events?token=<session>`
 * EventSource 无法设置请求头，因此允许 query token（仅此路由）。
 */
export function registerEventRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/events',
    auth: 'console',
    allowQueryToken: true,
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const allowedProjects = new Set(visibleProjects(rc.app, auth.user).map((project) => project.id));
      const res = rc.res;

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`: connected ${new Date().toISOString()}\n\n`);

      const unsubscribe = rc.app.bus.subscribe((event) => {
        if (event.projectId && !allowedProjects.has(event.projectId)) return;
        try {
          res.write(formatSseEvent(event));
        } catch {
          /* 客户端已断开，等待 close 清理 */
        }
      });

      const heartbeat = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          /* noop */
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      let closed = false;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      rc.req.on('close', cleanup);
      rc.req.on('error', cleanup);
      res.on('close', cleanup);
    },
  });
}
