import type { Project } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import { engineCall } from '../engine.ts';
import { requireConsoleAuth } from '../middleware/auth.ts';
import type { Router } from '../router.ts';
import { agentCreateSchema, agentUpdateSchema } from '../schemas.ts';

/** 控制台 Agent 注册表：人类观测 / 管理 Agent 的窗口。 */
export function registerAgentRoutes(router: Router): void {
  router.add({
    method: 'GET',
    path: '/api/projects/:id/agents',
    auth: 'console',
    project: { param: 'id', minRole: 'viewer' },
    operation: 'agent',
    handler: async (rc: RequestContext) => {
      const project = rc.project as Project;
      const agents = await engineCall(rc, () => rc.app.engine.agents(project.id));
      rc.noteUsage(agents.length);
      rc.json(agents);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/projects/:id/agents',
    auth: 'console',
    project: { param: 'id', minRole: 'developer' },
    operation: 'agent',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const input = await rc.body(agentCreateSchema);
      const agent = await engineCall(rc, () => rc.app.engine.createAgent(project.id, input, actorForUser(rc, auth.user)));
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'agent.create',
        resourceType: 'agent',
        resourceId: agent.id,
        detail: { name: agent.name, role: agent.role, model: agent.model },
      });
      rc.noteUsage(1);
      rc.json(agent, 201);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/projects/:id/agents/:agentId',
    auth: 'console',
    project: { param: 'id', minRole: 'developer' },
    operation: 'agent',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const project = rc.project as Project;
      const agentId = rc.params.agentId ?? '';
      const input = await rc.body(agentUpdateSchema);
      const agent = await engineCall(rc, () =>
        rc.app.engine.updateAgent(project.id, agentId, input, actorForUser(rc, auth.user)),
      );
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor: actorForUser(rc, auth.user),
        action: 'agent.update',
        resourceType: 'agent',
        resourceId: agent.id,
        detail: { fields: Object.keys(input) },
      });
      rc.noteUsage(1);
      rc.json(agent);
    },
  });
}
