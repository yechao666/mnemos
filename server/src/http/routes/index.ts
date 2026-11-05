import type { Router } from '../router.ts';
import { registerAgentRoutes } from './agents.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerBriefingRoutes } from './briefing.ts';
import { registerDashboardRoutes } from './dashboard.ts';
import { registerEventRoutes } from './events.ts';
import { registerExportRoutes } from './export.ts';
import { registerGraphRoutes } from './graph.ts';
import { registerHealthRoutes } from './health.ts';
import { registerKeyRoutes } from './keys.ts';
import { registerMemberRoutes } from './members.ts';
import { registerMemoryRoutes } from './memories.ts';
import { registerOpsRoutes } from './ops.ts';
import { registerOrgRoutes } from './org.ts';
import { registerPlaygroundRoutes } from './playground.ts';
import { registerProjectRoutes } from './projects.ts';
import { registerPublicRoutes } from './public.ts';
import { registerTaskRoutes } from './tasks.ts';
import { registerWebhookRoutes } from './webhooks.ts';

/** 注册全部 HTTP 路由（控制台 /api、公开 /v1、SSE、运维、健康检查）。 */
export function registerRoutes(router: Router): void {
  registerAuthRoutes(router);
  registerDashboardRoutes(router);
  registerProjectRoutes(router);
  registerMemberRoutes(router);
  registerKeyRoutes(router);
  registerMemoryRoutes(router);
  registerAgentRoutes(router);
  registerTaskRoutes(router);
  registerWebhookRoutes(router);
  registerBriefingRoutes(router);
  registerGraphRoutes(router);
  registerPlaygroundRoutes(router);
  registerEventRoutes(router);
  registerHealthRoutes(router);
  registerOpsRoutes(router);
  registerOrgRoutes(router);
  registerExportRoutes(router);
  registerPublicRoutes(router);
}
