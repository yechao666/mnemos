import type { Router } from '../router.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerConsoleRoutes } from './console.ts';
import { registerHealthRoutes } from './health.ts';
import { registerOpsRoutes } from './ops.ts';
import { registerOrgRoutes } from './org.ts';
import { registerV1Routes } from './v1.ts';

/** 注册全部 HTTP 路由：控制台 /api、公开 /v1、健康检查与运维。 */
export function registerRoutes(router: Router): void {
  registerAuthRoutes(router);
  registerHealthRoutes(router);
  registerConsoleRoutes(router);
  registerOrgRoutes(router);
  registerOpsRoutes(router);
  registerV1Routes(router);
}
