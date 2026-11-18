import { z } from 'zod';
import type { MemoryScope, PartitionInput, PartitionSettings, PersonType, PrivacyRule, PrivacyRuleInput } from '../../../../shared/src/types.ts';
import type { RequestContext } from '../context.ts';
import { requireOrgKey } from '../middleware/auth.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import {
  booleanQuerySchema,
  cursorQuerySchema,
  memoryFeedbackSchema,
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
  entityV1,
  graphV1,
  historyV1,
  memoryV1,
  partitionV1,
  personExportV1,
  personFactV1,
  personMergeResultV1,
  personProfileV1,
  personV1,
  searchResponseV1,
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
    /* v6.1 */
    retrieval_mode: z.enum(['hybrid', 'keyword', 'vector']).optional(),
    retrieval_weights: z
      .object({
        vector: z.coerce.number().min(0).max(1).optional(),
        keyword: z.coerce.number().min(0).max(1).optional(),
        recency: z.coerce.number().min(0).max(1).optional(),
        importance: z.coerce.number().min(0).max(1).optional(),
        entity: z.coerce.number().min(0).max(1).optional(),
      })
      .passthrough()
      .optional(),
    embedding_model: z.string().trim().min(1).max(80).optional(),
    merge_threshold: z.coerce.number().min(0).max(1).optional(),
    dedupe_threshold: z.coerce.number().min(0).max(1).optional(),
    auto_extract_entities: z.boolean().optional(),
    /* v6.1 P2 合规 */
    pii_redaction: z.enum(['off', 'basic']).optional(),
    /* v6.2 隐私规则 */
    privacy_llm_enabled: z.boolean().optional(),
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
  if (input.retrieval_mode !== undefined) out.retrievalMode = input.retrieval_mode as PartitionSettings['retrievalMode'];
  if (input.retrieval_weights !== undefined && typeof input.retrieval_weights === 'object') {
    out.retrievalWeights = input.retrieval_weights as PartitionSettings['retrievalWeights'];
  }
  if (input.embedding_model !== undefined) out.embeddingModel = String(input.embedding_model);
  if (input.merge_threshold !== undefined) out.mergeThreshold = Number(input.merge_threshold);
  if (input.dedupe_threshold !== undefined) out.dedupeThreshold = Number(input.dedupe_threshold);
  if (input.auto_extract_entities !== undefined) out.autoExtractEntities = Boolean(input.auto_extract_entities);
  if (input.pii_redaction !== undefined) out.piiRedaction = input.pii_redaction as PartitionSettings['piiRedaction'];
  if (input.privacy_llm_enabled !== undefined) out.privacyLlmEnabled = Boolean(input.privacy_llm_enabled);
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
  /** v6.1 P2：合规/同意标记（整体覆盖） */
  consent: z.record(z.unknown()).optional(),
});

const personPatchV1Schema = z
  .object({
    type: personTypeSchema.optional(),
    display_name: z.string().trim().max(120).optional(),
    attributes: z.record(z.unknown()).optional(),
    status: personStatusSchema.optional(),
    /** v6.1 P2：合规/同意标记（整体覆盖） */
    consent: z.record(z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const personListQueryV1Schema = cursorQuerySchema.extend({
  type: personTypeSchema.optional(),
  status: personStatusSchema.optional(),
  q: z.string().trim().max(200).optional(),
  sort: personSortSchema.optional(),
  include_merged: booleanQuerySchema.optional(),
  includeMerged: booleanQuerySchema.optional(),
});

/* --- v6.1 P1：画像 / 生命周期 --- */

const personFactInputV1Schema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(2000),
  confidence: z.coerce.number().min(0).max(1).optional(),
  source_memory_id: z.string().trim().max(128).optional(),
  sourceMemoryId: z.string().trim().max(128).optional(),
});

const personFactsPutV1Schema = z.union([
  z.object({ facts: z.array(personFactInputV1Schema).min(1).max(100) }),
  personFactInputV1Schema,
]);

const personMergeV1Schema = z
  .object({
    target_id: z.string().trim().min(1).max(128).optional(),
    targetId: z.string().trim().min(1).max(128).optional(),
    target_external_id: z.string().trim().min(1).max(128).optional(),
    targetExternalId: z.string().trim().min(1).max(128).optional(),
  })
  .refine(
    (value) => Boolean(value.target_id ?? value.targetId ?? value.target_external_id ?? value.targetExternalId),
    { message: '必须提供 target_id / target_external_id' },
  );

const personProfileQueryV1Schema = z.object({
  force: booleanQuerySchema.optional(),
  refresh: booleanQuerySchema.optional(),
});

const personDeleteQueryV1Schema = z.object({
  hard: booleanQuerySchema.optional(),
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
    /* v6.1 写管线 */
    supersedes_id: z.string().trim().max(128).optional(),
    fact_key: z.string().trim().max(120).optional(),
    valid_from: z.string().trim().max(40).optional(),
    infer: z.boolean().optional(),
    mode: z.enum(['additive', 'consolidate']).optional(),
    /* v6.1 P2：多模态附件（≤10，url≤2000） */
    attachments: z
      .array(
        z.object({
          kind: z.enum(['image', 'audio', 'video', 'file']),
          url: z.string().trim().min(1).max(2000),
          mime: z.string().trim().max(200).optional(),
          size: z.coerce.number().int().min(0).optional(),
          caption: z.string().trim().max(1000).optional(),
        }),
      )
      .max(10)
      .optional(),
    /* v6.2：占位符映射（正文用 {{key}}，敏感值放这里） */
    placeholders: z.record(z.string().max(4000)).optional(),
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
    /* v6.2：替换占位符映射（整体覆盖；正文未使用的键忽略） */
    placeholders: z.record(z.string().max(4000)).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

const memorySearchV1Schema = z.object({
  query: z.string().trim().min(1).max(2000),
  person_id: z.string().trim().max(128).optional(),
  person_external_id: z.string().trim().max(128).optional(),
  scope: memoryScopeSchema.optional(),
  category: memoryCategorySchema.optional(),
  mode: z.enum(['hybrid', 'keyword', 'vector']).optional(),
  top_k: z.coerce.number().int().min(1).max(50).optional(),
  as_of: z.string().trim().max(40).optional(),
  include_superseded: z.boolean().optional(),
  include_private: z.boolean().optional(),
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

/* v6.1 P2：实体 / 关系图查询 */
const entityGraphQueryV1Schema = z.object({
  person_id: z.string().trim().max(128).optional(),
  personId: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const entityListQueryV1Schema = z.object({
  person_id: z.string().trim().max(128).optional(),
  personId: z.string().trim().max(128).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/* v6.2：隐私规则（v1 只写分区作用域；global 由控制台 owner 维护） */
const privacyRuleInputV1Schema = z.object({
  code: z.string().trim().max(40).optional(),
  name: z.string().trim().max(80).optional(),
  kind: z.enum(['regex', 'prompt']).optional(),
  pattern: z.string().max(2000).optional(),
  flags: z.string().trim().max(8).optional(),
  instruction: z.string().trim().max(2000).optional(),
  entity_type: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(60).optional(),
  action: z.enum(['mask', 'placeholder']).optional(),
  mask_mode: z.enum(['email', 'keepFirstLast', 'keepLast', 'full']).optional(),
  maskMode: z.enum(['email', 'keepFirstLast', 'keepLast', 'full']).optional(),
  mask_keep_last: z.coerce.number().int().min(0).max(64).optional(),
  maskKeepLast: z.coerce.number().int().min(0).max(64).optional(),
  mask_keep_first: z.coerce.number().int().min(0).max(64).optional(),
  maskKeepFirst: z.coerce.number().int().min(0).max(64).optional(),
  enabled: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const privacyRuleCreateV1Schema = privacyRuleInputV1Schema.extend({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['regex', 'prompt']),
});

const memoryDetailQueryV1Schema = z.object({
  reveal: z.enum(['true', 'false', '1', '0', 'placeholders']).optional(),
});

function privacyRuleInputFromV1(body: z.output<typeof privacyRuleInputV1Schema>): PrivacyRuleInput {
  return {
    code: body.code,
    name: body.name as string,
    kind: body.kind as PrivacyRuleInput['kind'],
    pattern: body.pattern,
    flags: body.flags,
    instruction: body.instruction,
    entityType: body.entity_type ?? body.entityType,
    action: body.action,
    maskMode: body.mask_mode ?? body.maskMode,
    maskKeepLast: body.mask_keep_last ?? body.maskKeepLast,
    maskKeepFirst: body.mask_keep_first ?? body.maskKeepFirst,
    enabled: body.enabled,
    priority: body.priority,
  };
}

function privacyRuleV1From(rule: PrivacyRule): Record<string, unknown> {
  return {
    id: rule.id,
    scope: rule.scope,
    partition_id: rule.partitionId ?? null,
    code: rule.code,
    name: rule.name,
    kind: rule.kind,
    pattern: rule.pattern ?? null,
    flags: rule.flags,
    instruction: rule.instruction ?? null,
    entity_type: rule.entityType,
    action: rule.action,
    mask_mode: rule.maskMode,
    mask_keep_last: rule.maskKeepLast,
    mask_keep_first: rule.maskKeepFirst,
    enabled: rule.enabled,
    priority: rule.priority,
    builtin: rule.builtin,
    created_at: rule.createdAt,
    updated_at: rule.updatedAt,
  };
}

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
      const page = rc.app.engine.listPersons(partition.id, {
        ...query,
        includeMerged: query.include_merged === true || query.includeMerged === true,
      });
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
          consent: body.consent,
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
          consent: body.consent,
        },
        actorOf(rc),
      );
      rc.json(personV1(person));
    },
  });

  /* --- v6.1 P1：画像 / 生命周期 --- */
  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/persons/:person/profile',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const query = rc.query(personProfileQueryV1Schema);
      const ref = personRef(rc);
      const force = query.force === true || query.refresh === true;
      const profile = rc.app.engine.refreshPersonProfile
        ? await rc.app.engine.refreshPersonProfile(partition.id, ref, { force })
        : rc.app.engine.personProfile(partition.id, ref);
      markUsage(rc, partition, 'profile', 'api', profile.facts.length);
      rc.json(personProfileV1(profile));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/persons/:person/facts',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const facts = rc.app.engine.listPersonFacts(partition.id, personRef(rc));
      markUsage(rc, partition, 'facts.list', 'api', facts.length);
      rc.json({ items: facts.map(personFactV1) });
    },
  });

  router.add({
    method: 'PUT',
    path: '/v1/partitions/:partition/persons/:person/facts',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      assertWritable(partition);
      const body = await rc.body(personFactsPutV1Schema);
      const actor = actorOf(rc);
      const ref = personRef(rc);
      if ('facts' in body && Array.isArray(body.facts)) {
        const items = body.facts.map((input) =>
          rc.app.engine.upsertPersonFact(
            partition.id,
            ref,
            {
              key: input.key,
              value: input.value,
              confidence: input.confidence,
              sourceMemoryId: input.source_memory_id ?? input.sourceMemoryId,
            },
            actor,
          ),
        );
        rc.json({ items: items.map(personFactV1) });
        return;
      }
      const single = body as z.output<typeof personFactInputV1Schema>;
      const fact = rc.app.engine.upsertPersonFact(
        partition.id,
        ref,
        {
          key: single.key,
          value: single.value,
          confidence: single.confidence,
          sourceMemoryId: single.source_memory_id ?? single.sourceMemoryId,
        },
        actor,
      );
      rc.json({ fact: personFactV1(fact) });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/v1/partitions/:partition/persons/:person/facts/:factId',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const factId = rc.params.factId ?? '';
      if (!factId) throw errors.badRequest('缺少路径参数 factId');
      rc.app.engine.removePersonFact(partition.id, personRef(rc), factId, actorOf(rc));
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/persons/:person/merge',
    auth: 'apikey',
    scopes: ['admin'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      assertWritable(partition);
      const body = await rc.body(personMergeV1Schema);
      const targetRef =
        body.target_id ?? body.targetId ?? body.target_external_id ?? body.targetExternalId ?? '';
      const result = rc.app.engine.mergePersons(partition.id, personRef(rc), targetRef, actorOf(rc));
      markUsage(rc, partition, 'person.merge', 'api', result.movedMemories);
      rc.json(personMergeResultV1(result));
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/persons/:person/archive',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      assertWritable(partition);
      const person = rc.app.engine.archivePerson(partition.id, personRef(rc), actorOf(rc));
      rc.json(personV1(person));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/persons/:person/export',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const exported = rc.app.engine.exportPerson(partition.id, personRef(rc));
      markUsage(rc, partition, 'person.export', 'api', exported.memories.length);
      rc.json(personExportV1(exported));
    },
  });

  router.add({
    method: 'DELETE',
    path: '/v1/partitions/:partition/persons/:person',
    auth: 'apikey',
    scopes: ['admin'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const query = rc.query(personDeleteQueryV1Schema);
      let hard = query.hard === true;
      if (!hard) {
        // 兼容 DELETE body { hard: true }（部分客户端不方便拼 query）。
        const raw = await rc.readBody();
        if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).hard === true) hard = true;
      }
      rc.app.engine.deletePerson(partition.id, personRef(rc), { hard }, actorOf(rc));
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });

  /* --- v6.1 P2：实体 / 关系图 --- */
  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/graph',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const query = rc.query(entityGraphQueryV1Schema);
      const graph = rc.app.engine.entityGraph({
        partitionId: partition.id,
        personId: query.person_id ?? query.personId,
        limit: query.limit,
      });
      markUsage(rc, partition, 'graph', 'api', graph.stats.nodes);
      rc.json(graphV1(graph));
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/entities',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const query = rc.query(entityListQueryV1Schema);
      const result = rc.app.engine.listEntities({
        partitionId: partition.id,
        personId: query.person_id ?? query.personId,
        q: query.q,
        limit: query.limit,
      });
      markUsage(rc, partition, 'entities.list', 'api', result.items.length);
      rc.json({ items: result.items.map(entityV1), next_cursor: result.nextCursor });
    },
  });

  /* --- v6.2：隐私规则（v1 只写分区作用域） --- */
  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/privacy/rules',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const rules = rc.app.engine.listPrivacyRules(partition.id);
      markUsage(rc, partition, 'privacy.rules.list', 'api', rules.length);
      rc.json({ items: rules.map(privacyRuleV1From) });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/privacy/rules',
    auth: 'apikey',
    scopes: ['admin'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      assertWritable(partition);
      const body = await rc.body(privacyRuleCreateV1Schema);
      const rule = rc.app.engine.createPrivacyRule(
        'partition',
        partition.id,
        privacyRuleInputFromV1(body),
        actorOf(rc),
        partition.orgId,
      );
      markUsage(rc, partition, 'privacy.rule.create', 'api', 1);
      rc.json({ rule: privacyRuleV1From(rule) }, 201);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/v1/partitions/:partition/privacy/rules/:id',
    auth: 'apikey',
    scopes: ['admin'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      assertWritable(partition);
      const row = rc.app.db
        .prepare("SELECT id, scope, partition_id FROM privacy_rules WHERE id = ?")
        .get(rc.params.id ?? '') as unknown as { id: string; scope: string; partition_id: string } | undefined;
      if (!row || row.scope !== 'partition' || row.partition_id !== partition.id) {
        throw errors.notFound('隐私规则不存在');
      }
      const body = await rc.body(privacyRuleInputV1Schema);
      const rule = rc.app.engine.updatePrivacyRule(
        row.id,
        privacyRuleInputFromV1(body),
        actorOf(rc),
        partition.orgId,
      );
      rc.json({ rule: privacyRuleV1From(rule) });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/v1/partitions/:partition/privacy/rules/:id',
    auth: 'apikey',
    scopes: ['admin'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const row = rc.app.db
        .prepare("SELECT id, scope, partition_id FROM privacy_rules WHERE id = ?")
        .get(rc.params.id ?? '') as unknown as { id: string; scope: string; partition_id: string } | undefined;
      if (!row || row.scope !== 'partition' || row.partition_id !== partition.id) {
        throw errors.notFound('隐私规则不存在');
      }
      rc.app.engine.deletePrivacyRule(row.id, actorOf(rc), partition.orgId);
      rc.res.statusCode = 204;
      rc.res.end();
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
      const result = rc.app.engine.addMemoryResult({
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
        supersedesId: body.supersedes_id,
        factKey: body.fact_key,
        validFrom: body.valid_from,
        attachments: body.attachments,
        placeholders: body.placeholders,
        actor: actorOf(rc),
      });
      rc.markUsage({ partitionId: partition.id, operation: 'add', channel: 'api', orgId: partition.orgId });
      rc.noteUsage(1);
      rc.json(
        {
          memory: memoryV1(result.memory),
          event: result.event,
          superseded_id: result.supersededId ?? null,
          events: [{ type: result.event, memory_id: result.memory.id, at: result.memory.createdAt }],
        },
        result.event === 'ADD' ? 201 : 200,
      );
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
      const response = rc.app.engine.searchMemories({
        partitionId: partition.id,
        query: body.query,
        personId: body.person_id,
        personExternalId: body.person_external_id,
        scope: body.scope as MemoryScope | undefined,
        category: body.category,
        mode: body.mode,
        topK: body.top_k ?? 8,
        asOf: body.as_of,
        includeSuperseded: body.include_superseded,
        includePrivate: body.include_private,
      });
      markUsage(rc, partition, 'search', 'api', response.hits.length);
      // hits 为 v6.1 契约；results 为 v6 插件兼容字段。
      rc.json({
        ...searchResponseV1(response),
        results: response.hits.map(memoryV1),
        partition_stats: statsV1(rc.app.engine.partitionStats(partition.id)),
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
      const query = rc.query(memoryDetailQueryV1Schema);
      const reveal = query.reveal === 'true' || query.reveal === '1' || query.reveal === 'placeholders';
      const detail = rc.app.engine.getMemory(partition.id, rc.params.id ?? '');
      if (!detail) throw errors.notFound('记忆不存在');
      const placeholders = rc.app.engine.memoryPlaceholders(partition.id, detail.memory.id, reveal);
      markUsage(rc, partition, 'get', 'api', 1);
      rc.json({
        memory: memoryV1(detail.memory),
        person: detail.person ? personV1(detail.person) : null,
        placeholders: placeholders.map((item) => ({
          placeholder: item.placeholder,
          kind: item.kind ?? null,
          encrypted: item.encrypted,
          ...(item.value !== undefined ? { value: item.value } : {}),
        })),
      });
    },
  });

  router.add({
    method: 'GET',
    path: '/v1/partitions/:partition/memories/:id/history',
    auth: 'apikey',
    scopes: ['memories:read'],
    handler: (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      rc.json({ items: rc.app.engine.memoryHistory(partition.id, rc.params.id ?? '').map(historyV1) });
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/partitions/:partition/memories/:id/feedback',
    auth: 'apikey',
    scopes: ['memories:write'],
    handler: async (rc: RequestContext) => {
      const partition = partitionOfPathForWrite(rc);
      const body = await rc.body(memoryFeedbackSchema);
      const memory = rc.app.engine.feedback(
        partition.id,
        rc.params.id ?? '',
        { helpful: body.helpful, query: body.query, reason: body.reason },
        actorOf(rc),
      );
      rc.json({ memory: memoryV1(memory) });
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
          placeholders: body.placeholders,
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

