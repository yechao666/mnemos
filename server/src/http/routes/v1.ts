import { z } from 'zod';
import type { MemoryScope, PartitionInput, PartitionSettings, PersonType } from '../../../../shared/src/types.ts';
import type { RequestContext } from '../context.ts';
import { requireOrgKey } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import {
  booleanQuerySchema,
  cursorQuerySchema,
  memoryCategorySchema,
  memoryScopeSchema,
  memorySourceSchema,
  memoryStatusSchema,
  partitionStatusSchema,
  personSortSchema,
  personStatusSchema,
  personTypeSchema,
} from '../schemas.ts';
import {
  briefV1,
  contextV1,
  cursorV1,
  dreamResultV1,
  dreamStatusV1,
  memoryV1,
  partitionV1,
  personV1,
  statsV1,
} from '../serialize.ts';
import { actorOf, enforceQuota, markUsage, partitionOfPathForWrite, partitionRefOf } from './shared.ts';
import { requireApiKeyPartition } from '../middleware/auth.ts';

/**
 * 公开 v1 API（snake_case）：`/v1/partitions/:partition/...`。
 *
 * - 鉴权：org key 可访问/创建本组织任意分区；partition key 只能访问自身分区。
 * - `:partition` 支持内部 id 或 slug。
 * - 人 / 记忆列表统一游标分页 `{ items, next_cursor, partition_stats }`，不返回 total。
 * - 兼容插件：额外提供 POST /memories/search（返回 { results, took_ms }）。
 */

/* ------------------------------------------------------------------ */
/* 入参 schema（snake_case）                                           */
/* ------------------------------------------------------------------ */

const settingsV1Schema = z
  .object({
    default_scope: memoryScopeSchema.optional(),
    brief_max_chars: z.coerce.number().int().min(100).max(5000).optional(),
    brief_enabled: z.boolean().optional(),
    dream_enabled: z.boolean().optional(),
    dream_interval_minutes: z.coerce.number().int().min(1).max(43_200).optional(),
    retention_days: z.coerce.number().int().min(0).max(3650).optional(),
    monthly_quota: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    person_auto_create: z.boolean().optional(),
    locale: z.string().trim().min(2).max(20).optional(),
  })
  .passthrough();

function settingsFromV1(raw: unknown): Partial<PartitionSettings> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const out: Partial<PartitionSettings> = {};
  if (input.default_scope !== undefined) out.defaultScope = input.default_scope as PartitionSettings['defaultScope'];
  if (input.brief_max_chars !== undefined) out.briefMaxChars = Number(input.brief_max_chars);
  if (input.brief_enabled !== undefined) out.briefEnabled = Boolean(input.brief_enabled);
  if (input.dream_enabled !== undefined) out.dreamEnabled = Boolean(input.dream_enabled);
  if (input.dream_interval_minutes !== undefined) out.dreamIntervalMinutes = Number(input.dream_interval_minutes);
  if (input.retention_days !== undefined) out.retentionDays = Number(input.retention_days);
  if (input.monthly_quota !== undefined) out.monthlyQuota = Number(input.monthly_quota);
  if (input.person_auto_create !== undefined) out.personAutoCreate = Boolean(input.person_auto_create);
  if (input.locale !== undefined) out.locale = String(input.locale);
  return out;
}

const partitionUpsertV1Schema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'slug 仅支持小写字母、数字与连字符，且以字母或数字开头'),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  status: partitionStatusSchema.optional(),
  settings: settingsV1Schema.optional(),
});

const partitionPatchV1Schema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    status: partitionStatusSchema.optional(),
    settings: settingsV1Schema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const personWriteV1Schema = z.object({
  external_id: z.string().trim().min(1).max(128).optional(),
  type: personTypeSchema.optional(),
  display_name: z.string().trim().max(120).optional(),
  attributes: z.record(z.unknown()).optional(),
  status: personStatusSchema.optional(),
});

const personPatchV1Schema = z
  .object({
    type: personTypeSchema.optional(),
    display_name: z.string().trim().max(120).optional(),
    attributes: z.record(z.unknown()).optional(),
    status: personStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const personListQueryV1Schema = cursorQuerySchema.extend({
  type: personTypeSchema.optional(),
  status: personStatusSchema.optional(),
  q: z.string().trim().max(200).optional(),
  sort: personSortSchema.optional(),
});

const chatMessageV1Schema = z.object({
  role: z.string().trim().max(20),
  content: z.string().min(1).max(20_000),
});

const memoryAddV1Schema = z
  .object({
    text: z.string().min(1).max(20_000).optional(),
    content: z.string().min(1).max(20_000).optional(),
    messages: z.array(chatMessageV1Schema).min(1).max(50).optional(),
    scope: memoryScopeSchema.optional(),
    session_id: z.string().trim().max(128).optional(),
    session_title: z.string().trim().max(200).optional(),
    category: memoryCategorySchema.optional(),
    importance: z.coerce.number().min(0).max(1).optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    source: memorySourceSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
    expires_at: z.string().trim().max(40).nullable().optional(),
    infer: z.boolean().optional(),
    mode: z.enum(['additive', 'consolidate']).optional(),
  })
  .refine((value) => Boolean(value.text ?? value.content) || Boolean(value.messages?.length), {
    message: 'messages 与 text 至少提供一个',
    path: ['text'],
  });

const memoryListQueryV1Schema = cursorQuerySchema.extend({
  person_id: z.string().trim().max(128).optional(),
  person_external_id: z.string().trim().max(128).optional(),
  scope: memoryScopeSchema.optional(),
  category: memoryCategorySchema.optional(),
  status: memoryStatusSchema.optional(),
  q: z.string().trim().max(500).optional(),
});

const memoryPatchV1Schema = z
  .object({
    content: z.string().min(1).max(20_000).optional(),
    category: memoryCategorySchema.optional(),
    importance: z.coerce.number().min(0).max(1).optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    status: memoryStatusSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
    expires_at: z.string().trim().max(40).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const memorySearchV1Schema = z.object({
  query: z.string().trim().min(1).max(2000),
  person_id: z.string().trim().max(128).optional(),
  scope: memoryScopeSchema.optional(),
  category: memoryCategorySchema.optional(),
  top_k: z.coerce.number().int().min(1).max(50).optional(),
});

const briefQueryV1Schema = z.object({
  force: booleanQuerySchema.optional(),
  max_chars: z.coerce.number().int().min(100).max(5000).optional(),
});

const contextV1Schema = z.object({
  query: z.string().trim().max(2000).optional(),
  budget_tokens: z.coerce.number().int().min(60).max(32_000).optional(),
  include_partition: z.boolean().optional(),
});

const dreamRunV1Schema = z.object({
  batch_size: z.coerce.number().int().min(1).max(200).optional(),
});

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function personRef(rc: RequestContext): string {
  const ref = rc.params.person;
  if (!ref) throw errors.badRequest('缺少路径参数 person');
  return ref;
}

function requirePerson(rc: RequestContext, partitionId: string) {
  const person = rc.app.engine.getPerson(partitionId, personRef(rc));
  if (!person) throw errors.notFound('人不存在');
  return person;
}

function contentFrom(input: { text?: string; content?: string; messages?: Array<{ role: string; content: string }> }): string {
  const direct = input.text ?? input.content;
  if (direct && direct.trim()) return direct.trim();
  return (input.messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n');
}

/** 分区写入校验：归档分区禁止写。 */
function assertWritable(partition: { status: string }): void {
  if (partition.status === 'archived') throw errors.forbidden('分区已归档，无法写入');
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

export function registerV1Routes(router: Router): void {
  /* --- 分区 --- */
  router.add({
    method: 'POST',
    path: '/v1/partitions',
    auth: 'apikey',
    scopes: ['admin'],
    operation: 'partition.upsert',
    channel: 'api',
    handler: async (rc: RequestContext) => {
      const auth = requireOrgKey(rc);
      const body = await rc.body(partitionUpsertV1Schema);
      const input: PartitionInput = {
        slug: body.slug,
        name: body.name,
        description: body.description,
        status: body.status,
        settings: settingsFromV1(body.settings),
      };
      const partition = rc.app.engine.upsertPartition(auth.org.id, input, actorOf(rc));
      rc.markUsage({ partitionId: partition.id, operation: 'partition.upsert', channel: 'api', orgId: auth.org.id });
      rc.json(partitionV1(partition), 200);
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions',
    auth: 'apikey',
    scopes: ['memories:read'],
    operation: 'partition.list',
    channel: 'api',
    handler: (rc: RequestContext) => {
      const auth = requireOrgKey(rc);
      rc.json(rc.app.engine.listPartitions(auth.org.id).map(partitionV1));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      rc.json(partitionV1(partition));
    },
  });

  router.add({
    method: 'PATCH',
    path: '/v1/partitions/:partition',
    auth: 'apikey',
    scopes: ['admin'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const body = await rc.body(partitionPatchV1Schema);
      const updated = rc.app.engine.updatePartition(
        partition.orgId,
        partition.id,
        {
          name: body.name,
          description: body.description,
          status: body.status,
          settings: settingsFromV1(body.settings),
        },
        actorOf(rc),
      );
      rc.json(partitionV1(updated));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/stats',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = requireApiKeyPartition(rc, partitionRefOf(rc));
      rc.json(statsV1(rc.app.engine.partitionStats(partition.id)));
    },
  });

  /* --- 人 --- */
  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/persons',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const query = rc.query(personListQueryV1Schema);
      const page = rc.app.engine.listPersons(partition.id, query);
      markUsage(rc, partition, query.q ? 'search' : 'list', 'api', page.items.length);
      rc.json(cursorV1(page, personV1));
    },
  });

  router.add({
    method: 'PUT',
    path: '/v1/partitions/:partition/persons/:externalId',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      assertWritable(partition);
      const externalId = rc.params.externalId ?? '';
      const body = await rc.body(personWriteV1Schema);
      const person = rc.app.engine.upsertPerson(
        partition.id,
        {
          externalId,
          type: body.type as PersonType | undefined,
          displayName: body.display_name,
          attributes: body.attributes,
          status: body.status,
        },
        actorOf(rc),
      );
      rc.json(personV1(person));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/persons/:person',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const person = requirePerson(rc, partition.id);
      markUsage(rc, partition, 'get', 'api', 1);
      rc.json(personV1(person));
    },
  });

  router.add({
    method: 'PATCH',
    path: '/v1/partitions/:partition/persons/:person',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      assertWritable(partition);
      const body = await rc.body(personPatchV1Schema);
      const person = rc.app.engine.updatePerson(
        partition.id,
        personRef(rc),
        {
          type: body.type as PersonType | undefined,
          displayName: body.display_name,
          attributes: body.attributes,
          status: body.status,
        },
        actorOf(rc),
      );
      rc.json(personV1(person));
    },
  });

  /* --- 记忆 --- */
  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/persons/:person/memories',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const person = requirePerson(rc, partition.id);
      const query = rc.query(memoryListQueryV1Schema);
      const page = rc.app.engine.listMemories({
        partitionId: partition.id,
        personId: person.id,
        scope: query.scope,
        category: query.category,
        status: query.status,
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
      });
      markUsage(rc, partition, query.q ? 'search' : 'list', 'api', page.items.length);
      rc.json(cursorV1(page, memoryV1));
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/persons/:person/memories',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      assertWritable(partition);
      enforceQuota(rc, partition);
      const person = requirePerson(rc, partition.id);
      const body = await rc.body(memoryAddV1Schema);
      const content = contentFrom(body);
      if (!content) throw errors.validation(undefined, 'text 不能为空');
      const memory = rc.app.engine.addMemory({
        partitionId: partition.id,
        personId: person.id,
        scope: body.scope as MemoryScope | undefined,
        sessionId: body.session_id,
        sessionTitle: body.session_title,
        category: body.category,
        content,
        importance: body.importance,
        confidence: body.confidence,
        source: body.source,
        tags: body.tags,
        metadata: body.metadata,
        expiresAt: body.expires_at,
        actor: actorOf(rc),
      });
      rc.markUsage({ partitionId: partition.id, operation: 'add', channel: 'api', orgId: partition.orgId });
      rc.noteUsage(1);
      rc.json({ memory: memoryV1(memory), events: [{ type: 'ADD', memory_id: memory.id, at: memory.createdAt }] }, 201);
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/memories',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const query = rc.query(memoryListQueryV1Schema);
      const page = rc.app.engine.listMemories({
        partitionId: partition.id,
        personId: query.person_id,
        personExternalId: query.person_external_id,
        scope: query.scope,
        category: query.category,
        status: query.status,
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
      });
      markUsage(rc, partition, query.q ? 'search' : 'list', 'api', page.items.length);
      rc.json(cursorV1(page, memoryV1));
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/memories/search',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const body = await rc.body(memorySearchV1Schema);
      const started = Date.now();
      const page = rc.app.engine.listMemories({
        partitionId: partition.id,
        personId: body.person_id,
        scope: body.scope,
        category: body.category,
        q: body.query,
        limit: body.top_k ?? 8,
      });
      markUsage(rc, partition, 'search', 'api', page.items.length);
      rc.json({
        results: page.items.map(memoryV1),
        took_ms: Date.now() - started,
        next_cursor: page.nextCursor,
        partition_stats: page.partitionStats ? statsV1(page.partitionStats) : undefined,
      });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/memories/:id',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const detail = rc.app.engine.getMemory(partition.id, rc.params.id ?? '');
      if (!detail) throw errors.notFound('记忆不存在');
      markUsage(rc, partition, 'get', 'api', 1);
      rc.json({ memory: memoryV1(detail.memory), person: detail.person ? personV1(detail.person) : null });
    },
  });

  router.add({
    method: 'PATCH',
    path: '/v1/partitions/:partition/memories/:id',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const body = await rc.body(memoryPatchV1Schema);
      const memory = rc.app.engine.updateMemory(
        partition.id,
        rc.params.id ?? '',
        {
          content: body.content,
          category: body.category,
          importance: body.importance,
          confidence: body.confidence,
          status: body.status,
          tags: body.tags,
          metadata: body.metadata,
          expiresAt: body.expires_at,
        },
        actorOf(rc),
      );
      rc.json({ memory: memoryV1(memory) });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/v1/partitions/:partition/memories/:id',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      rc.app.engine.removeMemory(partition.id, rc.params.id ?? '', actorOf(rc));
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });

  /* --- 简报 / 上下文 / 做梦 --- */
  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/persons/:person/brief',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const person = requirePerson(rc, partition.id);
      const query = rc.query(briefQueryV1Schema);
      const brief = await rc.app.engine.brief({
        partitionId: partition.id,
        personId: person.id,
        maxChars: query.max_chars,
        force: query.force,
      });
      markUsage(rc, partition, 'brief', 'api', brief.count);
      rc.json(briefV1(brief));
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/persons/:person/context',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const person = requirePerson(rc, partition.id);
      const body = await rc.body(contextV1Schema);
      const context = await rc.app.engine.context({
        partitionId: partition.id,
        personId: person.id,
        query: body.query,
        budgetTokens: body.budget_tokens,
        includePartition: body.include_partition,
      });
      markUsage(rc, partition, 'context', 'api', context.citations.length);
      rc.noteUsage(undefined, context.tokenEstimate);
      rc.json(contextV1(context));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/persons/:person/dream',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const person = requirePerson(rc, partition.id);
      rc.json(dreamStatusV1(rc.app.engine.dreamStatus({ partitionId: partition.id, personId: person.id })));
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/persons/:person/dream/run',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      enforceQuota(rc, partition);
      const person = requirePerson(rc, partition.id);
      const body = await rc.body(dreamRunV1Schema);
      const result = await rc.app.engine.dream(
        { partitionId: partition.id, personId: person.id, trigger: 'manual', batchSize: body.batch_size },
        actorOf(rc),
      );
      markUsage(rc, partition, 'dream', 'api', result.run?.inputCount ?? 0);
      rc.json(dreamResultV1(result));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/dream',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      rc.json(dreamStatusV1(rc.app.engine.dreamStatus({ partitionId: partition.id })));
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/dream/run',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      enforceQuota(rc, partition);
      const body = await rc.body(dreamRunV1Schema);
      const result = await rc.app.engine.dream(
        { partitionId: partition.id, trigger: 'manual', batchSize: body.batch_size },
        actorOf(rc),
      );
      markUsage(rc, partition, 'dream', 'api', result.run?.inputCount ?? 0);
      rc.json(dreamResultV1(result));
    },
  });
}

