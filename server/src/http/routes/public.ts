import { z } from 'zod';
import { APP_VERSION } from '../../../../shared/src/constants.ts';
import type {
  Agent,
  Briefing,
  Memory,
  MemoryHistoryEntry,
  SearchFilters,
  SearchHit,
  Task,
} from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { estimateTokens } from '../../lib/usage.ts';
import { actorForApiKey, type RequestContext } from '../context.ts';
import { engineCall, memoryTokenCount } from '../engine.ts';
import { withIdempotency } from '../idempotency.ts';
import { requireKeyAuth } from '../middleware/auth.ts';
import { computeProjectStats } from '../queries/stats.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';

/**
 * 公开 v1 API：mem0 风格 snake_case。
 * 项目作用域由 API Key 决定，所有写操作按 key 的 scopes 校验。
 */

const v1MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().min(1).max(20_000),
  name: z.string().trim().max(120).optional(),
});

const v1VisibilitySchema = z.enum(['project', 'agent', 'task']);
const v1TaskStatusSchema = z.enum(['open', 'active', 'done', 'abandoned']);

const v1AddSchema = z
  .object({
    messages: z.array(v1MessageSchema).min(1).max(50).optional(),
    text: z.string().min(1).max(20_000).optional(),
    user_id: z.string().trim().max(128).optional(),
    agent_id: z.string().trim().max(128).optional(),
    run_id: z.string().trim().max(128).optional(),
    app_id: z.string().trim().max(128).optional(),
    task_id: z.string().trim().max(128).optional(),
    visibility: v1VisibilitySchema.optional(),
    metadata: z.record(z.unknown()).optional(),
    infer: z.boolean().optional(),
    mode: z.enum(['additive', 'consolidate']).optional(),
  })
  .refine((value) => Boolean(value.text) || Boolean(value.messages && value.messages.length > 0), {
    message: 'messages 与 text 至少提供一个',
    path: ['messages'],
  });

const v1SearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  user_id: z.string().trim().max(128).optional(),
  agent_id: z.string().trim().max(128).optional(),
  run_id: z.string().trim().max(128).optional(),
  app_id: z.string().trim().max(128).optional(),
  task_id: z.string().trim().max(128).optional(),
  visibility: v1VisibilitySchema.optional(),
  top_k: z.coerce.number().int().min(1).max(100).optional(),
  threshold: z.coerce.number().min(0).max(1).optional(),
  filters: z
    .object({
      user_id: z.string().trim().max(128).optional(),
      agent_id: z.string().trim().max(128).optional(),
      run_id: z.string().trim().max(128).optional(),
      category: z
        .enum([
          'preference',
          'identity',
          'fact',
          'plan',
          'relationship',
          'event',
          'skill',
          'constraint',
          'context',
          'insight',
        ])
        .optional(),
      status: z.enum(['active', 'archived', 'deleted']).optional(),
      tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
      created_after: z.string().trim().max(40).optional(),
      created_before: z.string().trim().max(40).optional(),
      min_importance: z.coerce.number().min(0).max(1).optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const v1ListQuerySchema = z.object({
  user_id: z.string().trim().max(128).optional(),
  agent_id: z.string().trim().max(128).optional(),
  run_id: z.string().trim().max(128).optional(),
  app_id: z.string().trim().max(128).optional(),
  task_id: z.string().trim().max(128).optional(),
  visibility: v1VisibilitySchema.optional(),
  category: z
    .enum([
      'preference',
      'identity',
      'fact',
      'plan',
      'relationship',
      'event',
      'skill',
      'constraint',
      'context',
      'insight',
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

const v1UpdateSchema = z
  .object({
    text: z.string().min(1).max(20_000).optional(),
    content: z.string().min(1).max(20_000).optional(),
    category: z
      .enum([
        'preference',
        'identity',
        'fact',
        'plan',
        'relationship',
        'event',
        'skill',
        'constraint',
        'context',
        'insight',
      ])
      .optional(),
    importance: z.coerce.number().min(0).max(1).optional(),
  })
  .refine((value) => Boolean(value.text ?? value.content), { message: 'text 或 content 至少提供一个' });

const v1BatchSchema = z.object({
  action: z.enum(['delete', 'archive', 'restore']).default('delete'),
  ids: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  user_id: z.string().trim().max(128).optional(),
  agent_id: z.string().trim().max(128).optional(),
  run_id: z.string().trim().max(128).optional(),
  confirm: z.boolean().optional(),
});

const v1FeedbackSchema = z.object({
  helpful: z.boolean(),
  query: z.string().trim().max(2000).optional(),
});

const v1DeleteAllQuerySchema = z.object({
  user_id: z.string().trim().max(128).optional(),
  agent_id: z.string().trim().max(128).optional(),
  run_id: z.string().trim().max(128).optional(),
  confirm: z.string().trim().max(10).optional(),
});

const v1GraphQuerySchema = z.object({
  user_id: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(400).default(120),
});

/* --- Agent 原生：Agent / 任务 / 简报 ---------------------------------- */

const v1AgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(64).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  capabilities: z.array(z.string().trim().min(1).max(64)).max(30).optional(),
  status: z.enum(['active', 'idle', 'retired']).optional(),
});

const v1TaskCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  goal: z.string().trim().max(4000).optional(),
  owner_agent_id: z.string().trim().max(128).optional(),
  branch: z.string().trim().max(200).optional(),
  status: v1TaskStatusSchema.optional(),
});

const v1TaskListQuerySchema = z.object({
  status: v1TaskStatusSchema.optional(),
  agent_id: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const v1FinishTaskSchema = z.object({
  status: z.enum(['done', 'abandoned']).optional(),
  summary: z.string().trim().max(8000).optional(),
  decisions: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  lessons: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  notes: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
  agent_id: z.string().trim().max(128).optional(),
});

const v1ContextSchema = z.object({
  agent_id: z.string().trim().max(128).optional(),
  task_id: z.string().trim().max(128).optional(),
  query: z.string().trim().max(500).optional(),
  budget_tokens: z.coerce.number().int().min(60).max(8000).optional(),
});

const DELETE_CHUNK_SIZE = 200;

function v1Memory(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    memory: memory.content,
    user_id: memory.userId ?? null,
    agent_id: memory.agentId ?? null,
    run_id: memory.runId ?? null,
    app_id: memory.appId ?? null,
    task_id: memory.taskId ?? null,
    visibility: memory.visibility,
    category: memory.category,
    importance: memory.importance,
    confidence: memory.confidence,
    source: memory.source,
    status: memory.status,
    tags: memory.tags,
    metadata: memory.metadata,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    last_accessed_at: memory.lastAccessedAt ?? null,
    access_count: memory.accessCount,
    expires_at: memory.expiresAt ?? null,
  };
}

function v1Hit(hit: SearchHit): Record<string, unknown> {
  return {
    ...v1Memory(hit),
    score: hit.score,
    signals: hit.signals,
    matched_on: hit.matchedOn,
  };
}

function v1History(entry: MemoryHistoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    memory_id: entry.memoryId,
    event: entry.event,
    old_memory: entry.oldContent ?? null,
    new_memory: entry.newContent ?? null,
    actor: entry.actor,
    reason: entry.reason ?? null,
    created_at: entry.createdAt,
    meta: entry.meta,
  };
}

function v1Agent(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    project_id: agent.projectId,
    name: agent.name,
    role: agent.role,
    model: agent.model,
    description: agent.description,
    capabilities: agent.capabilities,
    status: agent.status,
    metadata: agent.metadata,
    created_at: agent.createdAt,
    last_active_at: agent.lastActiveAt ?? null,
    stats: {
      memories: agent.stats.memories,
      private_memories: agent.stats.privateMemories,
      tasks: agent.stats.tasks,
      last_task_at: agent.stats.lastTaskAt ?? null,
    },
  };
}

function v1Task(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    project_id: task.projectId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    owner_agent_id: task.ownerAgentId ?? null,
    owner_agent_name: task.ownerAgentName ?? null,
    branch: task.branch ?? null,
    summary: task.summary ?? null,
    metadata: task.metadata,
    created_at: task.createdAt,
    started_at: task.startedAt,
    ended_at: task.endedAt ?? null,
    memory_count: task.memoryCount,
    agent_count: task.agentCount,
  };
}

function v1Briefing(briefing: Briefing): Record<string, unknown> {
  return {
    project: briefing.project,
    agent: briefing.agent ? v1Agent(briefing.agent) : null,
    task: briefing.task ? v1Task(briefing.task) : null,
    sections: briefing.sections.map((section) => ({
      key: section.key,
      title: section.title,
      description: section.description,
      hits: section.hits.map(v1Hit),
    })),
    prompt: briefing.prompt,
    token_estimate: briefing.tokenEstimate,
    citations: briefing.citations,
    built_at: briefing.builtAt,
    took_ms: briefing.tookMs,
    ...(briefing.brief ? { brief: briefing.brief } : {}),
  };
}

function toSearchFilters(input: z.output<typeof v1SearchSchema>['filters']): SearchFilters {
  if (!input) return {};
  const filters: SearchFilters = {};
  if (input.category) filters.category = input.category;
  if (input.status) filters.status = input.status;
  if (input.tags) filters.tags = input.tags;
  if (input.created_after) filters.createdAfter = input.created_after;
  if (input.created_before) filters.createdBefore = input.created_before;
  if (input.min_importance !== undefined) filters.minImportance = input.min_importance;
  if (input.metadata) filters.metadata = input.metadata;
  return filters;
}

export function registerPublicRoutes(router: Router): void {
  router.add({
    method: 'POST',
    path: '/v1/memories/search',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'search',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const input = await rc.body(v1SearchSchema);
      const filters = toSearchFilters(input.filters);

      const response = await engineCall(rc, () =>
        rc.app.engine.search({
          projectId: project.id,
          query: input.query,
          userId: input.filters?.user_id ?? input.user_id,
          agentId: input.filters?.agent_id ?? input.agent_id,
          runId: input.filters?.run_id ?? input.run_id,
          appId: input.app_id,
          taskId: input.task_id,
          visibility: input.visibility,
          topK: input.top_k ?? project.settings.topK,
          threshold: input.threshold ?? project.settings.threshold,
          filters,
        }),
      );

      rc.noteUsage(response.results.length, memoryTokenCount(response.results));
      rc.json({
        results: response.results.map(v1Hit),
        took_ms: response.tookMs,
        signals: {
          weights: response.weights,
          strategy: response.strategy,
          query_terms: response.queryTerms,
        },
      });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/memories',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'add',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      await withIdempotency(rc, 'POST /v1/memories', async () => {
        const input = await rc.body(v1AddSchema);
        const actor = actorForApiKey(rc, key, project);

        const result = await engineCall(rc, () =>
          rc.app.engine.add({
            projectId: project.id,
            messages: input.messages,
            text: input.text,
            userId: input.user_id,
            agentId: input.agent_id,
            runId: input.run_id,
            appId: input.app_id,
            taskId: input.task_id,
            visibility: input.visibility,
            metadata: input.metadata,
            infer: input.infer,
            mode: input.mode,
            source: 'api',
            actor,
          }),
        );

        writeAudit(rc.app.db, {
          orgId: project.orgId,
          projectId: project.id,
          actor,
          action: 'memory.create',
          resourceType: 'memory',
          resourceId: result.results[0]?.id,
          detail: {
            channel: 'api',
            apiKeyId: key.id,
            extracted: result.extracted,
            merged: result.merged,
            skipped: result.skipped,
            memoryIds: result.results.map((memory) => memory.id),
          },
        });

        rc.noteUsage(result.results.length, memoryTokenCount(result.results));
        return { status: 200, body: { results: result.results, events: result.events, tookMs: result.tookMs } };
      });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/memories',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'list',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const query = rc.query(v1ListQuerySchema);
      const page = await engineCall(rc, () =>
        rc.app.engine.list({
          projectId: project.id,
          userId: query.user_id,
          agentId: query.agent_id,
          runId: query.run_id,
          taskId: query.task_id,
          visibility: query.visibility,
          category: query.category,
          page: query.page,
          pageSize: query.page_size,
        }),
      );
      rc.noteUsage(page.items.length, memoryTokenCount(page.items));
      rc.json({
        results: page.items.map(v1Memory),
        count: page.total,
        page: page.page,
        page_size: page.pageSize,
      });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/memories/:id',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'get',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const id = rc.params.id;
      const detail = await engineCall(rc, () => rc.app.engine.get(project.id, id));
      if (!detail) throw errors.notFound('记忆不存在');
      rc.noteUsage(1, estimateTokens(detail.memory.content));
      rc.json({
        ...v1Memory(detail.memory),
        history: detail.history.map(v1History),
        entities: detail.entities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          mention_count: entity.mentionCount,
        })),
        relations: detail.relations.map((relation) => ({
          id: relation.id,
          source_entity_id: relation.sourceEntityId,
          target_entity_id: relation.targetEntityId,
          relation: relation.relation,
          memory_id: relation.memoryId ?? null,
          weight: relation.weight,
          created_at: relation.createdAt,
        })),
        neighbors: detail.neighbors.map((neighbor) => ({
          id: neighbor.id,
          name: neighbor.name,
          type: neighbor.type,
          mention_count: neighbor.mentionCount,
        })),
      });
    },
  });

  router.add({
    method: 'PUT',
    path: '/v1/memories/:id',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'update',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const id = rc.params.id;
      const input = await rc.body(v1UpdateSchema);
      const actor = actorForApiKey(rc, key, project);
      const content = (input.text ?? input.content) as string;
      await engineCall(rc, () =>
        rc.app.engine.update(project.id, id, { content, category: input.category, importance: input.importance }, actor),
      );
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'memory.update',
        resourceType: 'memory',
        resourceId: id,
        detail: { channel: 'api', apiKeyId: key.id, fields: Object.keys(input) },
      });
      rc.noteUsage(1, estimateTokens(content));
      rc.json({ message: 'updated' });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/v1/memories',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'delete',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const query = rc.query(v1DeleteAllQuerySchema);
      if (query.confirm !== 'true') {
        throw errors.badRequest('批量删除需要显式确认：confirm=true');
      }
      if (!query.user_id && !query.agent_id && !query.run_id) {
        throw errors.badRequest('请至少提供 user_id、agent_id 或 run_id 之一，避免误删整个项目的记忆');
      }

      const clauses = ["project_id = ?", "status <> 'deleted'"];
      const args: string[] = [project.id];
      if (query.user_id) {
        clauses.push('user_id = ?');
        args.push(query.user_id);
      }
      if (query.agent_id) {
        clauses.push('agent_id = ?');
        args.push(query.agent_id);
      }
      if (query.run_id) {
        clauses.push('run_id = ?');
        args.push(query.run_id);
      }

      const rows = rc.app.db
        .prepare(`SELECT id FROM memories WHERE ${clauses.join(' AND ')}`)
        .all(...args) as unknown as Array<{ id: string }>;

      const actor = actorForApiKey(rc, key, project);
      let deleted = 0;
      for (let offset = 0; offset < rows.length; offset += DELETE_CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + DELETE_CHUNK_SIZE).map((row) => row.id);
        const result = await engineCall(rc, () => rc.app.engine.bulk(project.id, { action: 'delete', ids: chunk }, actor));
        deleted += result.affected;
      }

      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'memory.bulk',
        resourceType: 'memory',
        resourceId: project.id,
        detail: {
          channel: 'api',
          apiKeyId: key.id,
          user_id: query.user_id ?? null,
          agent_id: query.agent_id ?? null,
          run_id: query.run_id ?? null,
          deleted,
        },
      });
      rc.noteUsage(deleted);
      rc.json({ message: 'deleted', deleted });
    },
  });

  // 兼容控制台 API 文档中的批量接口写法：POST /v1/memories/batch
  router.add({
    method: 'POST',
    path: '/v1/memories/batch',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'delete',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const input = await rc.body(v1BatchSchema);
      if (input.confirm !== true) throw errors.badRequest('批量操作需要显式确认：confirm=true');
      if (!input.ids?.length && !input.user_id && !input.agent_id && !input.run_id) {
        throw errors.badRequest('请提供 ids，或至少一个 user_id / agent_id / run_id 作为删除范围');
      }

      const clauses = ['project_id = ?', "status <> 'deleted'"];
      const args: string[] = [project.id];
      if (input.ids?.length) {
        clauses.push(`id IN (${input.ids.map(() => '?').join(', ')})`);
        args.push(...input.ids);
      }
      if (input.user_id) {
        clauses.push('user_id = ?');
        args.push(input.user_id);
      }
      if (input.agent_id) {
        clauses.push('agent_id = ?');
        args.push(input.agent_id);
      }
      if (input.run_id) {
        clauses.push('run_id = ?');
        args.push(input.run_id);
      }

      const rows = rc.app.db
        .prepare(`SELECT id FROM memories WHERE ${clauses.join(' AND ')}`)
        .all(...args) as unknown as Array<{ id: string }>;

      const actor = actorForApiKey(rc, key, project);
      let affected = 0;
      for (let offset = 0; offset < rows.length; offset += DELETE_CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + DELETE_CHUNK_SIZE).map((row) => row.id);
        const result = await engineCall(rc, () =>
          rc.app.engine.bulk(project.id, { action: input.action, ids: chunk }, actor),
        );
        affected += result.affected;
      }

      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'memory.bulk',
        resourceType: 'memory',
        resourceId: project.id,
        detail: {
          channel: 'api',
          apiKeyId: key.id,
          action: input.action,
          ids: input.ids ?? null,
          user_id: input.user_id ?? null,
          agent_id: input.agent_id ?? null,
          run_id: input.run_id ?? null,
          affected,
        },
      });
      if (rc.usage) rc.usage.operation = input.action === 'delete' ? 'delete' : 'update';
      rc.noteUsage(affected);
      rc.json({ message: input.action === 'delete' ? 'deleted' : 'updated', affected });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/v1/memories/:id',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'delete',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const id = rc.params.id;
      const actor = actorForApiKey(rc, key, project);
      await engineCall(rc, () => rc.app.engine.remove(project.id, id, actor));
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'memory.delete',
        resourceType: 'memory',
        resourceId: id,
        detail: { channel: 'api', apiKeyId: key.id },
      });
      rc.noteUsage(1);
      rc.json({ message: 'deleted' });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/memories/:id/history',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'get',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const id = rc.params.id;
      const entries = await engineCall(rc, () => rc.app.engine.history(project.id, id));
      rc.noteUsage(entries.length);
      rc.json({ results: entries.map(v1History) });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/memories/:id/feedback',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'update',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const id = rc.params.id;
      const input = await rc.body(v1FeedbackSchema);
      const actor = actorForApiKey(rc, key, project);
      const memory = await engineCall(rc, () => rc.app.engine.feedback(project.id, id, input, actor));
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'memory.feedback',
        resourceType: 'memory',
        resourceId: id,
        detail: { channel: 'api', apiKeyId: key.id, helpful: input.helpful },
      });
      rc.noteUsage(1, estimateTokens(memory.content));
      rc.json(v1Memory(memory));
    },
  });

  /* ------------------------------------------------------------------ */
  /* Agent 原生 v1：注册表 / 任务会话 / 任务简报                          */
  /* ------------------------------------------------------------------ */

  router.add({
    method: 'GET',
    path: '/v1/agents',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'agent',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const agents = await engineCall(rc, () => rc.app.engine.agents(project.id));
      rc.noteUsage(agents.length);
      rc.json({ results: agents.map(v1Agent), count: agents.length });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/agents',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'agent',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const input = await rc.body(v1AgentSchema);
      const actor = actorForApiKey(rc, key, project);
      const agent = await engineCall(rc, () => rc.app.engine.createAgent(project.id, input, actor));
      writeAudit(rc.app.db, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'agent.create',
        resourceType: 'agent',
        resourceId: agent.id,
        detail: { channel: 'api', apiKeyId: key.id, name: agent.name, role: agent.role, model: agent.model },
      });
      rc.noteUsage(1);
      rc.json(v1Agent(agent));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/tasks',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'task',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const query = rc.query(v1TaskListQuerySchema);
      const tasks = await engineCall(rc, () =>
        rc.app.engine.tasks(project.id, { status: query.status, agentId: query.agent_id, limit: query.limit }),
      );
      rc.noteUsage(tasks.length);
      rc.json({ results: tasks.map(v1Task), count: tasks.length });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/tasks',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'task',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      await withIdempotency(rc, 'POST /v1/tasks', async () => {
        const input = await rc.body(v1TaskCreateSchema);
        const actor = actorForApiKey(rc, key, project);
        const task = await engineCall(rc, () =>
          rc.app.engine.createTask(
            project.id,
            {
              title: input.title,
              goal: input.goal,
              ownerAgentId: input.owner_agent_id,
              branch: input.branch,
              status: input.status,
            },
            actor,
          ),
        );
        writeAudit(rc.app.db, {
          orgId: project.orgId,
          projectId: project.id,
          actor,
          action: 'task.create',
          resourceType: 'task',
          resourceId: task.id,
          detail: { channel: 'api', apiKeyId: key.id, title: task.title, status: task.status },
        });
        rc.noteUsage(1);
        return { status: 200, body: v1Task(task) };
      });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/tasks/:id',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'task',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const id = rc.params.id;
      const task = await engineCall(rc, () => rc.app.engine.task(project.id, id));
      if (!task) throw errors.notFound('任务不存在');
      rc.noteUsage(1);
      rc.json(v1Task(task));
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/tasks/:id/finish',
    auth: 'apikey',
    scopes: ['memories:write'],
    operation: 'task',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { key, project } = requireKeyAuth(rc);
      const id = rc.params.id;
      await withIdempotency(rc, `POST /v1/tasks/${id}/finish`, async () => {
        const input = await rc.body(v1FinishTaskSchema);
        const actor = actorForApiKey(rc, key, project);
        const result = await engineCall(rc, () =>
          rc.app.engine.finishTask(
            project.id,
            id,
            {
              status: input.status,
              summary: input.summary,
              decisions: input.decisions,
              lessons: input.lessons,
              notes: input.notes,
              agentId: input.agent_id,
            },
            actor,
          ),
        );
        writeAudit(rc.app.db, {
          orgId: project.orgId,
          projectId: project.id,
          actor,
          action: 'task.finish',
          resourceType: 'task',
          resourceId: result.task.id,
          detail: {
            channel: 'api',
            apiKeyId: key.id,
            status: result.task.status,
            memories: result.memories.length,
            memoryIds: result.memories.map((memory) => memory.id),
          },
        });
        rc.noteUsage(result.memories.length, memoryTokenCount(result.memories));
        return { status: 200, body: { task: v1Task(result.task), memories: result.memories.map(v1Memory) } };
      });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/context',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'briefing',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const input = await rc.body(v1ContextSchema);
      const briefing = await engineCall(rc, () =>
        rc.app.engine.briefing({
          projectId: project.id,
          agentId: input.agent_id,
          taskId: input.task_id,
          query: input.query,
          budgetTokens: input.budget_tokens,
        }),
      );
      const hits = briefing.sections.reduce((sum, section) => sum + section.hits.length, 0);
      rc.noteUsage(hits, briefing.tokenEstimate);
      rc.json(v1Briefing(briefing));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/graph',
    auth: 'apikey',
    scopes: ['graph:read'],
    operation: 'graph',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const query = rc.query(v1GraphQuerySchema);
      const data = await engineCall(rc, () => rc.app.engine.graph(project.id, query.limit));
      let nodes = data.nodes;
      let edges = data.edges;
      if (query.user_id) {
        const rows = rc.app.db
          .prepare(
            `SELECT DISTINCT me.entity_id AS id
               FROM memory_entities me
               JOIN memories m ON m.id = me.memory_id
              WHERE m.project_id = ? AND m.user_id = ?`,
          )
          .all(project.id, query.user_id) as unknown as Array<{ id: string }>;
        const allowed = new Set(rows.map((row) => row.id));
        nodes = nodes.filter((node) => allowed.has(node.id));
        edges = edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target));
      }
      rc.noteUsage(nodes.length);
      rc.json({ nodes, edges });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/stats',
    auth: 'apikey',
    scopes: ['admin'],
    operation: 'list',
    channel: 'api',
    handler: (rc: RequestContext) => {
      const { project } = requireKeyAuth(rc);
      const stats = computeProjectStats(rc.app.db, project);
      rc.noteUsage(0);
      rc.json({
        metrics: {
          total_memories: stats.memories,
          users: stats.users,
          agents: stats.agents,
          entities: stats.entities,
          relations: stats.relations,
          searches_7d: stats.searches7d,
          adds_7d: stats.adds7d,
          tokens_saved: stats.tokensSaved,
          storage_bytes: stats.storageBytes,
          quota_used_pct: stats.quotaUsedPct,
          recall_p50_ms: stats.recallP50Ms,
          recall_p95_ms: stats.recallP95Ms,
          hit_rate: stats.hitRate,
          growth_pct: stats.growthPct,
          last_activity_at: stats.lastActivityAt ?? null,
        },
      });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/health',
    auth: 'none',
    handler: (rc: RequestContext) => {
      rc.json({ ok: true, version: APP_VERSION, uptime_ms: Date.now() - rc.app.startedAt });
    },
  });
}
