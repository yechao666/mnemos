/**
 * 控制台「人（Person）」维度路由。
 *
 * 人 = 记忆主体（App 用户 / 智能体 / 服务），与登录账号无关；
 * 由 v5 引擎 `svc.persons / person / upsertPerson / updatePerson / brief /
 * personContext / personDreamStatus / dream` 支撑。
 *
 * 角色：读取 viewer+，写入（建人 / 改人 / 人级复盘）admin+，
 * 与现有记忆/设置接口的角色分层保持一致。
 */

import type { PersonInput, Project } from '../../../../shared/src/types.ts';
import { estimateTokens } from '../../lib/usage.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { engineCall } from '../engine.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import {
  personBriefQuerySchema,
  personContextSchema,
  personListQuerySchema,
  personUpdateSchema,
  personUpsertSchema,
} from '../schemas.ts';

/** 读人；不存在返回 404（人级接口统一在进入引擎前做一次存在性判断，语义更明确）。 */
async function requirePerson(rc: RequestContext, projectId: string, personRef: string) {
  const person = await engineCall(rc, () => rc.app.engine.person(projectId, personRef));
  if (!person) {
    throw errors.notFound(
      '人不存在（ref 可为内部 id；external_id 命中 human/agent 多类型时请使用内部 id）',
    );
  }
  return person;
}

export function registerPersonRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/persons',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'list',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const query = rc.query(personListQuerySchema);
      const page = await engineCall(rc, () =>
        rc.app.engine.persons({
          projectId: project.id,
          type: query.type,
          status: query.status,
          q: query.q,
          page: query.page,
          pageSize: query.pageSize,
          sort: query.sort,
        }),
      );
      rc.noteUsage(page.items.length);
      rc.json(page);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/persons/:personRef',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'get',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const person = await requirePerson(rc, project.id, rc.params.personRef ?? '');
      rc.noteUsage(1);
      rc.json(person);
    },
  });

  router.add({
    method: 'PUT',
    path: '/api/projects/:id/persons/:externalId',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    operation: 'update',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const externalId = (rc.params.externalId ?? '').trim();
      if (!externalId) throw errors.badRequest('缺少人的 externalId');
      const input = await rc.body(personUpsertSchema);
      if (input.externalId && input.externalId !== externalId) {
        throw errors.badRequest('路径中的 externalId 与请求体不一致');
      }
      const person = await engineCall(rc, () =>
        rc.app.engine.upsertPerson(
          project.id,
          {
            externalId,
            type: input.type,
            displayName: input.displayName,
            attributes: input.attributes,
            status: input.status,
          } satisfies PersonInput,
          actorForUser(rc, auth.user),
        ),
      );
      rc.noteUsage(1);
      rc.json(person);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/projects/:id/persons/:personRef',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    operation: 'update',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const personRef = rc.params.personRef ?? '';
      await requirePerson(rc, project.id, personRef);
      const input = await rc.body(personUpdateSchema);
      const person = await engineCall(rc, () =>
        rc.app.engine.updatePerson(
          project.id,
          personRef,
          {
            displayName: input.displayName,
            attributes: input.attributes,
            status: input.status,
          },
          actorForUser(rc, auth.user),
        ),
      );
      rc.noteUsage(1);
      rc.json(person);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/persons/:personRef/brief',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'brief',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const person = await requirePerson(rc, project.id, rc.params.personRef ?? '');
      const query = rc.query(personBriefQuerySchema);
      const brief = await engineCall(rc, () =>
        rc.app.engine.brief({
          projectId: project.id,
          personId: person.id,
          maxChars: query.maxChars,
          // 控制台是人级审计视角：包含该人的私有记忆。
          includePrivate: true,
          force: query.force === true,
          allowLlm: true,
        }),
      );
      rc.noteUsage(brief.count, estimateTokens(brief.text));
      rc.json(brief);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/persons/:personRef/context',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'briefing',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const personRef = rc.params.personRef ?? '';
      const input = await rc.body(personContextSchema);
      const context = await engineCall(rc, () =>
        rc.app.engine.personContext({
          projectId: project.id,
          personRef,
          query: input.query,
          budgetTokens: input.budgetTokens,
          includePartition: input.includePartition,
        }),
      );
      rc.noteUsage(context.memories.length + context.shared.length, context.tokenEstimate);
      rc.json(context);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/projects/:id/persons/:personRef/dream',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'dream',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const status = await engineCall(rc, () =>
        rc.app.engine.personDreamStatus(project.id, rc.params.personRef ?? ''),
      );
      rc.noteUsage(status.runs.length);
      rc.json(status);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/persons/:personRef/dream/run',
    auth: 'console',
    project: { param: 'id', minRole: 'admin' },
    operation: 'dream',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const person = await requirePerson(rc, project.id, rc.params.personRef ?? '');
      const result = await engineCall(rc, () =>
        rc.app.engine.dream(
          { projectId: project.id, personId: person.id, trigger: 'manual' },
          actorForUser(rc, auth.user),
        ),
      );
      if (result.run === null) throw errors.conflict('该人正在复盘总结，请稍后再试');
      rc.noteUsage(result.run.insightCount);
      rc.json(result);
    },
  });
}
