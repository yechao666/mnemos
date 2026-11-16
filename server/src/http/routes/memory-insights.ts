/**
 * 控制台记忆简报 / 复盘总结路由。
 *
 * - GET/PATCH /api/projects/:id/memory/brief —— 预览与配置记忆简报（字符上限）
 * - GET/PATCH /api/projects/:id/memory/dream —— 复盘总结状态与配置
 * - POST /api/projects/:id/memory/dream/run  —— 手动触发一次增量复盘总结
 *
 * 鉴权与项目角色由路由元信息（project.minRole）统一处理。
 */

import type { Project } from '../../../../shared/src/types.ts';
import { estimateTokens } from '../../lib/usage.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { engineCall } from '../engine.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import { briefQuerySchema, briefSettingsSchema, dreamSettingsSchema, reportQuerySchema } from '../schemas.ts';
import { buildMemoryReport } from '../../engine/reports.ts';

export function registerMemoryInsightRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/memory/brief',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'brief',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(briefQuerySchema);
      const brief = await engineCall(rc, () =>
        rc.app.engine.brief({
          projectId: project.id,
          agentId: query.agentId,
          maxChars: query.maxChars,
          // 不带 agentId = 控制台审计全量视角；带 agentId = 预览该 Agent 实际看到的简报（含其私有记忆）。
          includePrivate: query.agentId ? false : true,
          force: query.force === true,
          allowLlm: true,
        }),
      );
      rc.noteUsage(brief.count, estimateTokens(brief.text));
      rc.json(brief);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/projects/:id/memory/brief',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    operation: 'brief',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(briefSettingsSchema);
      const brief = await engineCall(rc, () =>
        rc.app.engine.updateBriefSettings(project.id, input.maxChars, actorForUser(rc, auth.user)),
      );
      rc.noteUsage(brief.count, estimateTokens(brief.text));
      rc.json(brief);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/memory/reports',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'report',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(reportQuerySchema);
      const report = buildMemoryReport(rc.app.db, project.id, query.period, query.anchor);
      rc.noteUsage(report.sections.reduce((sum, section) => sum + section.count, 0));
      rc.json(report);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/memory/dream',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'dream',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const status = await engineCall(rc, () => rc.app.engine.dreamStatus(project.id));
      rc.noteUsage(status.runs.length);
      rc.json(status);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/projects/:id/memory/dream',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    operation: 'dream',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(dreamSettingsSchema);
      const status = await engineCall(rc, () =>
        rc.app.engine.updateDreamSettings(project.id, input, actorForUser(rc, auth.user)),
      );
      rc.noteUsage(1);
      rc.json(status);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/memory/dream/run',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    operation: 'dream',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const result = await engineCall(rc, () =>
        rc.app.engine.dream({ projectId: project.id, trigger: 'manual' }, actorForUser(rc, auth.user)),
      );
      if (result.run === null) throw errors.conflict('该项目正在复盘总结，请稍后再试');
      rc.noteUsage(result.run.insightCount);
      rc.json(result);
    },
  });
}
