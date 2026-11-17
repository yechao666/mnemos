/**
 * 中立记忆服务 v5 公开 API：`/v1/partitions/:partition/...`（`/v1/projects/:partition/...` 为兼容别名）。
 *
 * 契约：`docs/neutral-memory-model.md` 第 5 节。要点：
 *  - 鉴权：`project` key 只能访问自身分区；`org` key（kind=org）可访问/创建本组织任意分区；
 *  - `:partition` 支持内部 id 或 slug；JSON 一律 snake_case；
 *  - 记忆按「人（person）」组织，`scope` ∈ person/partition/session；
 *  - 写接口沿用旧 v1 的 `user_id`/`agent_id`/`visibility` 透传，P1 引擎已做 person/scope 映射。
 */

import { z } from 'zod';
import { DEFAULT_PROJECT_SETTINGS } from '../../../../shared/src/constants.ts';
import type { AddMemoryInput, Memory, MemoryDetail } from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { newId, nowIso } from '../../lib/ids.ts';
import { actorForApiKey, type RequestContext } from '../context.ts';
import { engineCall } from '../engine.ts';
import { withIdempotency } from '../idempotency.ts';
import { toProject, type ProjectRow } from '../mappers.ts';
import { requireKeyAuth, requireOrgKey } from '../middleware/auth.ts';
import { bindPartition } from '../partition-access.ts';
import { enforceProjectQuota } from '../quota.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import {
  booleanQuerySchema,
  chatMessageSchema,
  environmentSchema,
  memoryCategorySchema,
  memoryScopeSchema,
  memoryStatusSchema,
  personStatusSchema,
  personTypeSchema,
} from '../schemas.ts';
import {
  v1Brief,
  v1DreamRun,
  v1DreamStatus,
  v1Hit,
  v1History,
  v1Memory,
  v1Person,
  v1PersonContext,
  v1PersonPage,
  v1Partition,
} from '../v1-mappers.ts';

/* ------------------------------------------------------------------ */
/* 入参 schema（snake_case）                                           */
/* ------------------------------------------------------------------ */

const partitionCreateSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'slug 仅支持小写字母、数字与连字符，且以字母或数字开头'),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  region: z.string().trim().max(64).optional(),
  env: environmentSchema.optional(),
});

const personWriteSchema = z.object({
  type: personTypeSchema.optional(),
  display_name: z.string().trim().max(120).optional(),
  attributes: z.record(z.unknown()).optional(),
  status: personStatusSchema.optional(),
});

const personPatchSchema = z
  .object({
    display_name: z.string().trim().max(120).optional(),
    attributes: z.record(z.unknown()).optional(),
    status: personStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const v1PersonListQuerySchema = z.object({
  type: personTypeSchema.optional(),
  status: personStatusSchema.optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['recent', 'name', 'memories']).optional(),
});

const memoryAddSchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(50).optional(),
    text: z.string().min(1).max(20_000).optional(),
    /** 记忆主体：内部 id 或 external id（与 person_external_id 二选一） */
    person_id: z.string().trim().max(128).optional(),
    person_external_id: z.string().trim().max(128).optional(),
    /** 写入者（默认同 person） */
    actor_person_id: z.string().trim().max(128).optional(),
    scope: memoryScopeSchema.optional(),
    session_id: z.string().trim().max(128).optional(),
    category: memoryCategorySchema.optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
    infer: z.boolean().optional(),
    mode: z.enum(['additive', 'consolidate']).optional(),
    /* --- 旧字段透传（P1 引擎映射为 person/scope） --- */
    user_id: z.string().trim().max(128).optional(),
    agent_id: z.string().trim().max(128).optional(),
    run_id: z.string().trim().max(128).optional(),
    app_id: z.string().trim().max(128).optional(),
    task_id: z.string().trim().max(128).optional(),
    visibility: z.enum(['project', 'agent', 'task']).optional(),
  })
  .refine((value) => Boolean(value.text) || Boolean(value.messages && value.messages.length > 0), {
    message: 'messages 与 text 至少提供一个',
    path: ['messages'],
  });

const memoryListQuerySchema = z.object({
  person_id: z.string().trim().max(128).optional(),
  /** person_id 的别名，便于按「人的 ref」直接过滤 */
  person: z.string().trim().max(128).optional(),
  scope: memoryScopeSchema.optional(),
  category: memoryCategorySchema.optional(),
  status: memoryStatusSchema.optional(),
  q: z.string().trim().max(500).optional(),
  sort: z.enum(['recent', 'importance', 'accessed']).optional(),
  /** 默认 false：调用方视角只看分区共享 + 本人私有；控制台/审计视角传 true */
  include_private: booleanQuerySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

const memorySearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  person_id: z.string().trim().max(128).optional(),
  person: z.string().trim().max(128).optional(),
  scope: memoryScopeSchema.optional(),
  category: memoryCategorySchema.optional(),
  top_k: z.coerce.number().int().min(1).max(100).optional(),
  threshold: z.coerce.number().min(0).max(1).optional(),
  include_private: z.boolean().optional(),
});

const memoryPatchSchema = z
  .object({
    content: z.string().min(1).max(20_000).optional(),
    category: memoryCategorySchema.optional(),
    importance: z.coerce.number().min(0).max(1).optional(),
    status: memoryStatusSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
    expires_at: z.string().trim().max(40).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const personBriefQuerySchema = z.object({
  force: booleanQuerySchema.optional(),
  max_chars: z.coerce.number().int().min(100).max(5000).optional(),
});

const personContextSchema = z.object({
  query: z.string().trim().max(2000).optional(),
  budget_tokens: z.coerce.number().int().min(60).max(32_000).optional(),
  include_partition: z.boolean().optional(),
});

const dreamRunSchema = z.object({
  person_id: z.string().trim().max(128).optional(),
  batch_size: z.coerce.number().int().min(1).max(200).optional(),
});

/* ------------------------------------------------------------------ */
/* 响应映射辅助                                                        */
/* ------------------------------------------------------------------ */

function v1MemoryDetail(detail: MemoryDetail): Record<string, unknown> {
  return {
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
  };
}

/** 记忆写入 body → 引擎 add 入参（category 只在 infer=false 时生效，这里做一次友好映射）。 */
function addInputFromBody(
  body: z.output<typeof memoryAddSchema>,
  projectId: string,
  actor: ReturnType<typeof actorForApiKey>,
): AddMemoryInput {
  const metadata = body.category ? { ...(body.metadata ?? {}), category: body.category } : body.metadata;
  // 显式给了 category 时默认原文入库（infer=false），否则交由引擎默认抽取逻辑。
  const infer = body.infer ?? (body.category ? false : undefined);
  return {
    projectId,
    messages: body.messages,
    text: body.text,
    personId: body.person_id,
    personExternalId: body.person_external_id,
    actorPersonId: body.actor_person_id,
    scope: body.scope,
    sessionId: body.session_id,
    userId: body.user_id,
    agentId: body.agent_id,
    runId: body.run_id,
    appId: body.app_id,
    taskId: body.task_id,
    visibility: body.visibility,
    metadata,
    tags: body.tags,
    infer,
    mode: body.mode,
    source: 'api',
    actor,
  };
}

/* ------------------------------------------------------------------ */
/* 路由注册                                                            */
/* ------------------------------------------------------------------ */

/** 在指定前缀下注册全部中立端点（供 /v1/partitions 与兼容别名 /v1/projects 复用）。 */
function registerPartitionRoutesAt(router: Router, base: string): void {
  /* ---------------------------- 分区 ---------------------------------- */

  router.add({
    method: 'POST',
    path: base,
    auth: 'apikey',
    scopes: ['admin'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const auth = requireOrgKey(rc);
      const org = auth.org;
      if (!org) throw errors.forbidden('组织级 API Key 缺少组织上下文，请重新创建');
      const input = await rc.body(partitionCreateSchema);
      const actor = actorForApiKey(rc, auth.key, auth.project);
      const existing = rc.app.db
        .prepare('SELECT * FROM projects WHERE org_id = ? AND slug = ?')
        .get(org.id, input.slug) as unknown as ProjectRow | undefined;

      if (existing) {
        // slug 幂等 upsert：只补全显式提供的展示字段，不覆盖未提供的配置。
        const sets: string[] = [];
        const args: string[] = [];
        if (input.name !== undefined) {
          sets.push('name = ?');
          args.push(input.name);
        }
        if (input.description !== undefined) {
          sets.push('description = ?');
          args.push(input.description);
        }
        if (input.region !== undefined) {
          sets.push('region = ?');
          args.push(input.region);
        }
        if (input.env !== undefined) {
          sets.push('env = ?');
          args.push(input.env);
        }
        if (sets.length > 0) {
          sets.push('updated_at = ?');
          args.push(nowIso());
          rc.app.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args, existing.id);
        }
        const row = rc.app.db
          .prepare('SELECT * FROM projects WHERE id = ?')
          .get(existing.id) as unknown as ProjectRow;
        const partition = toProject(row);
        rc.project = partition;
        rc.markUsage({ projectId: partition.id, operation: 'list', channel: 'api', orgId: org.id });
        rc.json({ partition: v1Partition(partition), created: false });
        return;
      }

      const id = newId('prj');
      const at = nowIso();
      rc.app.db
        .prepare(
          `INSERT INTO projects
             (id, org_id, slug, name, description, status, region, env, settings, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          org.id,
          input.slug,
          input.name ?? input.slug,
          input.description ?? '',
          input.region?.trim() || 'cn-shanghai',
          input.env ?? 'production',
          JSON.stringify({ ...DEFAULT_PROJECT_SETTINGS }),
          at,
          at,
        );
      const row = rc.app.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow;
      const partition = toProject(row);

      writeAudit(rc.app.db, {
        orgId: org.id,
        projectId: partition.id,
        actor,
        action: 'project.create',
        resourceType: 'project',
        resourceId: partition.id,
        detail: { name: partition.name, slug: partition.slug, source: 'v1_partition_upsert' },
      });
      rc.project = partition;
      rc.markUsage({ projectId: partition.id, operation: 'list', channel: 'api', orgId: org.id });
      rc.json({ partition: v1Partition(partition), created: true }, 201);
    },
  });

  router.add({
    method: 'GET',
    path: `${base}/:partition`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'get');
      rc.noteUsage(1);
      rc.json({ partition: v1Partition(partition) });
    },
  });

  /* ---------------------------- 人 ------------------------------------ */

  router.add({
    method: 'PUT',
    path: `${base}/:partition/persons/:externalId`,
    auth: 'apikey',
    scopes: ['memories:write'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const auth = requireKeyAuth(rc);
      const partition = bindPartition(rc, rc.params.partition ?? '', 'update');
      const externalId = (rc.params.externalId ?? '').trim();
      if (!externalId) throw errors.badRequest('缺少人的 externalId');
      const input = await rc.body(personWriteSchema);
      const person = await engineCall(rc, () =>
        rc.app.engine.upsertPerson(
          partition.id,
          {
            externalId,
            type: input.type,
            displayName: input.display_name,
            attributes: input.attributes,
            status: input.status,
          },
          actorForApiKey(rc, auth.key, partition),
        ),
      );
      rc.noteUsage(1);
      rc.json({ person: v1Person(person) });
    },
  });

  router.add({
    method: 'GET',
    path: `${base}/:partition/persons`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'list');
      const query = rc.query(v1PersonListQuerySchema);
      const page = await engineCall(rc, () =>
        rc.app.engine.persons({
          projectId: partition.id,
          type: query.type,
          status: query.status,
          q: query.q,
          page: query.page,
          pageSize: query.page_size,
          sort: query.sort,
        }),
      );
      rc.noteUsage(page.items.length);
      rc.json(v1PersonPage(page));
    },
  });

  router.add({
    method: 'GET',
    path: `${base}/:partition/persons/:personRef`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'get');
      const person = await engineCall(rc, () => rc.app.engine.person(partition.id, rc.params.personRef ?? ''));
      if (!person) {
        throw errors.notFound(
          '人不存在（:person 支持内部 id 或 external_id；external_id 命中 human/agent 多类型时请使用内部 id）',
        );
      }
      rc.noteUsage(1);
      rc.json({ person: v1Person(person) });
    },
  });

  router.add({
    method: 'PATCH',
    path: `${base}/:partition/persons/:personRef`,
    auth: 'apikey',
    scopes: ['memories:write'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const auth = requireKeyAuth(rc);
      const partition = bindPartition(rc, rc.params.partition ?? '', 'update');
      const input = await rc.body(personPatchSchema);
      const person = await engineCall(rc, () =>
        rc.app.engine.updatePerson(
          partition.id,
          rc.params.personRef ?? '',
          {
            displayName: input.display_name,
            attributes: input.attributes,
            status: input.status,
          },
          actorForApiKey(rc, auth.key, partition),
        ),
      );
      rc.noteUsage(1);
      rc.json({ person: v1Person(person) });
    },
  });

  /* ---------------------------- 记忆 ---------------------------------- */

  router.add({
    method: 'POST',
    path: `${base}/:partition/memories`,
    auth: 'apikey',
    scopes: ['memories:write'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const { key } = requireKeyAuth(rc);
      const partition = bindPartition(rc, rc.params.partition ?? '', 'add');
      const actor = actorForApiKey(rc, key, partition);
      await withIdempotency(rc, `POST ${base}/:partition/memories`, async () => {
        enforceProjectQuota(rc);
        const input = await rc.body(memoryAddSchema);
        const result = await engineCall(rc, () =>
          rc.app.engine.add(addInputFromBody(input, partition.id, actor)),
        );

        writeAudit(rc.app.db, {
          orgId: partition.orgId,
          projectId: partition.id,
          actor,
          action: 'memory.create',
          resourceType: 'memory',
          resourceId: result.results[0]?.id,
          detail: {
            channel: 'api',
            apiKeyId: key.id,
            personId: input.person_id ?? input.person_external_id ?? null,
            scope: input.scope ?? null,
            extracted: result.extracted,
            merged: result.merged,
            skipped: result.skipped,
            memoryIds: result.results.map((memory) => memory.id),
          },
        });
        rc.noteUsage(result.results.length);
        return {
          status: 200,
          body: {
            results: result.results.map(v1Memory),
            events: result.events,
            extracted: result.extracted,
            merged: result.merged,
            skipped: result.skipped,
            took_ms: result.tookMs,
          },
        };
      });
    },
  });

  router.add({
    method: 'GET',
    path: `${base}/:partition/memories`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'list');
      const query = rc.query(memoryListQuerySchema);
      const page = await engineCall(rc, () =>
        rc.app.engine.list({
          projectId: partition.id,
          personId: query.person_id ?? query.person,
          scope: query.scope,
          category: query.category,
          status: query.status,
          q: query.q,
          sort: query.sort,
          includePrivate: query.include_private === true,
          page: query.page,
          pageSize: query.page_size,
        }),
      );
      const results = page.items.map(v1Memory);
      rc.noteUsage(page.items.length);
      rc.json({
        results,
        items: results,
        count: page.total,
        total: page.total,
        page: page.page,
        page_size: page.pageSize,
        total_pages: page.totalPages,
      });
    },
  });

  router.add({
    method: 'POST',
    path: `${base}/:partition/memories/search`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'search');
      const input = await rc.body(memorySearchSchema);
      const response = await engineCall(rc, () =>
        rc.app.engine.search({
          projectId: partition.id,
          query: input.query,
          personId: input.person_id ?? input.person,
          scope: input.scope,
          includePrivate: input.include_private === true,
          topK: input.top_k ?? partition.settings.topK,
          threshold: input.threshold ?? partition.settings.threshold,
          filters: input.category ? { category: input.category } : undefined,
        }),
      );
      const results = response.results.map(v1Hit);
      rc.noteUsage(response.results.length);
      rc.json({
        results,
        count: response.total,
        total: response.total,
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
    method: 'GET',
    path: `${base}/:partition/memories/:id`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'get');
      const detail = await engineCall(rc, () => rc.app.engine.get(partition.id, rc.params.id ?? ''));
      if (!detail) throw errors.notFound('记忆不存在');
      rc.noteUsage(1);
      rc.json(v1MemoryDetail(detail));
    },
  });

  router.add({
    method: 'PATCH',
    path: `${base}/:partition/memories/:id`,
    auth: 'apikey',
    scopes: ['memories:write'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const auth = requireKeyAuth(rc);
      const partition = bindPartition(rc, rc.params.partition ?? '', 'update');
      const id = rc.params.id ?? '';
      const input = await rc.body(memoryPatchSchema);
      const memory: Memory = await engineCall(rc, () =>
        rc.app.engine.update(
          partition.id,
          id,
          {
            content: input.content,
            category: input.category,
            importance: input.importance,
            status: input.status,
            tags: input.tags,
            metadata: input.metadata,
            expiresAt: input.expires_at,
          },
          actorForApiKey(rc, auth.key, partition),
        ),
      );
      writeAudit(rc.app.db, {
        orgId: partition.orgId,
        projectId: partition.id,
        actor: actorForApiKey(rc, auth.key, partition),
        action: 'memory.update',
        resourceType: 'memory',
        resourceId: id,
        detail: { channel: 'api', apiKeyId: auth.key.id, fields: Object.keys(input) },
      });
      rc.noteUsage(1);
      rc.json(v1Memory(memory));
    },
  });

  router.add({
    method: 'DELETE',
    path: `${base}/:partition/memories/:id`,
    auth: 'apikey',
    scopes: ['memories:write'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const auth = requireKeyAuth(rc);
      const partition = bindPartition(rc, rc.params.partition ?? '', 'delete');
      const id = rc.params.id ?? '';
      await engineCall(rc, () => rc.app.engine.remove(partition.id, id, actorForApiKey(rc, auth.key, partition)));
      writeAudit(rc.app.db, {
        orgId: partition.orgId,
        projectId: partition.id,
        actor: actorForApiKey(rc, auth.key, partition),
        action: 'memory.delete',
        resourceType: 'memory',
        resourceId: id,
        detail: { channel: 'api', apiKeyId: auth.key.id },
      });
      rc.noteUsage(1);
      rc.json({ message: 'deleted', ok: true });
    },
  });

  /* ---------------------------- 简报 / 上下文 -------------------------- */

  router.add({
    method: 'GET',
    path: `${base}/:partition/persons/:personRef/brief`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'brief');
      const person = await engineCall(rc, () => rc.app.engine.person(partition.id, rc.params.personRef ?? ''));
      if (!person) throw errors.notFound('人不存在');
      const query = rc.query(personBriefQuerySchema);
      const brief = await engineCall(rc, () =>
        rc.app.engine.brief({
          projectId: partition.id,
          personId: person.id,
          maxChars: query.max_chars,
          includePrivate: true,
          force: query.force === true,
          allowLlm: true,
        }),
      );
      rc.noteUsage(brief.count);
      rc.json(v1Brief(brief));
    },
  });

  router.add({
    method: 'POST',
    path: `${base}/:partition/persons/:personRef/context`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'briefing');
      const person = await engineCall(rc, () => rc.app.engine.person(partition.id, rc.params.personRef ?? ''));
      if (!person) throw errors.notFound('人不存在');
      const input = await rc.body(personContextSchema);
      const context = await engineCall(rc, () =>
        rc.app.engine.personContext({
          projectId: partition.id,
          personRef: person.id,
          query: input.query,
          budgetTokens: input.budget_tokens,
          includePartition: input.include_partition,
        }),
      );
      rc.noteUsage(context.memories.length + context.shared.length, context.tokenEstimate);
      rc.json(v1PersonContext(context));
    },
  });

  /* ---------------------------- 做梦 ---------------------------------- */

  router.add({
    method: 'GET',
    path: `${base}/:partition/persons/:personRef/dream`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'dream');
      const status = await engineCall(rc, () =>
        rc.app.engine.personDreamStatus(partition.id, rc.params.personRef ?? ''),
      );
      rc.noteUsage(status.runs.length);
      rc.json(v1DreamStatus(status));
    },
  });

  router.add({
    method: 'POST',
    path: `${base}/:partition/persons/:personRef/dream/run`,
    auth: 'apikey',
    scopes: ['memories:write'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const auth = requireKeyAuth(rc);
      const partition = bindPartition(rc, rc.params.partition ?? '', 'dream');
      const person = await engineCall(rc, () => rc.app.engine.person(partition.id, rc.params.personRef ?? ''));
      if (!person) throw errors.notFound('人不存在');
      const result = await engineCall(rc, () =>
        rc.app.engine.dream(
          { projectId: partition.id, personId: person.id, trigger: 'manual' },
          actorForApiKey(rc, auth.key, partition),
        ),
      );
      if (result.run === null) throw errors.conflict('该人正在复盘总结，请稍后再试');
      rc.noteUsage(result.run.insightCount);
      rc.json({ run: v1DreamRun(result.run), status: v1DreamStatus(result.status) });
    },
  });

  router.add({
    method: 'GET',
    path: `${base}/:partition/dream`,
    auth: 'apikey',
    scopes: ['memories:read'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const partition = bindPartition(rc, rc.params.partition ?? '', 'dream');
      const status = await engineCall(rc, () => rc.app.engine.dreamStatus(partition.id));
      rc.noteUsage(status.runs.length);
      rc.json(v1DreamStatus(status));
    },
  });

  router.add({
    method: 'POST',
    path: `${base}/:partition/dream/run`,
    auth: 'apikey',
    scopes: ['memories:write'],
    allowOrgKey: true,
    handler: async (rc: RequestContext) => {
      const auth = requireKeyAuth(rc);
      const partition = bindPartition(rc, rc.params.partition ?? '', 'dream');
      const input = await rc.body(dreamRunSchema);
      const result = await engineCall(rc, () =>
        rc.app.engine.dream(
          {
            projectId: partition.id,
            personId: input.person_id,
            trigger: 'manual',
            batchSize: input.batch_size,
          },
          actorForApiKey(rc, auth.key, partition),
        ),
      );
      if (result.run === null) throw errors.conflict('该分区正在复盘总结，请稍后再试');
      rc.noteUsage(result.run.insightCount);
      rc.json({ run: v1DreamRun(result.run), status: v1DreamStatus(result.status) });
    },
  });
}

export function registerPartitionRoutes(router: Router): void {
  registerPartitionRoutesAt(router, '/v1/partitions');
  // 兼容层：旧调用方用 /v1/projects/:id 作为 /v1/partitions/:id 的别名。
  registerPartitionRoutesAt(router, '/v1/projects');
}
