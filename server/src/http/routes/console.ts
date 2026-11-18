import type {
  ApiKey,
  MemoryScope,
  Partition,
  PartitionSettings,
  PersonType,
  PrivacyRuleInput,
  PrivacyRuleScope,
} from '../../../../shared/src/types.ts';
import { writeAudit } from '../../lib/audit.ts';
import { newApiKeySecret, newId, nowIso } from '../../lib/ids.ts';
import { listAudit, partitionUsage } from '../analytics.ts';
import { enforceQuota } from './shared.ts';
import { actorForUser, type RequestContext } from '../context.ts';
import {
  requireConsoleAuth,
  requireConsolePartition,
  requireConsoleRole,
} from '../middleware/auth.ts';
import { toApiKey, type ApiKeyRow } from '../mappers.ts';
import { errors } from '../respond.ts';
import type { Router } from '../router.ts';
import {
  apiKeyCreateSchema,
  apiKeyRotateSchema,
  auditQuerySchema,
  dreamRunSchema,
  entityGraphQuerySchema,
  entityListQuerySchema,
  memoryAddSchema,
  memoryFeedbackSchema,
  memoryListQuerySchema,
  memoryPatchSchema,
  memorySearchSchema,
  memoryDetailQuerySchema,
  partitionPatchSchema,
  partitionUpsertSchema,
  personBriefQuerySchema,
  personContextSchema,
  personDeleteQuerySchema,
  personFactsPutSchema,
  personListQuerySchema,
  personMergeSchema,
  personProfileQuerySchema,
  personUpdateSchema,
  personUpsertSchema,
  privacyGroupApplySchema,
  privacyGroupQuerySchema,
  privacyPreviewSchema,
  privacyRescanSchema,
  privacyRuleCreateSchema,
  privacyRulePatchSchema,
  privacyRuleQuerySchema,
  usageQuerySchema,
} from '../schemas.ts';

/**
 * 控制台 /api（camelCase，与 v1 同构）。
 *
 * 权限沿用组织角色：viewer 读、developer 写、admin 管理密钥/设置、owner 管理组织。
 * 列表统一 CursorPage { items, nextCursor, partitionStats }。
 */

function partitionFor(rc: RequestContext, minRole: 'viewer' | 'developer' | 'admin' | 'owner' = 'viewer'): Partition {
  const ref = rc.params.partition;
  if (!ref) throw errors.badRequest('缺少路径参数 partition');
  return requireConsolePartition(rc, ref, minRole);
}

function withStats(rc: RequestContext, partition: Partition): Partition {
  return { ...partition, stats: rc.app.engine.partitionStats(partition.id) };
}

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

function assertWritable(partition: Partition): void {
  if (partition.status === 'archived') throw errors.forbidden('分区已归档，无法写入');
}

function loadKey(rc: RequestContext, partitionId: string, keyId: string): ApiKeyRow | null {
  const row = rc.app.db
    .prepare("SELECT * FROM api_keys WHERE id = ? AND partition_id = ? AND kind = 'partition'")
    .get(keyId, partitionId) as unknown as ApiKeyRow | undefined;
  return row ?? null;
}

interface PrivacyRuleScopeRow {
  id: string;
  scope: string;
  partition_id: string;
}

function privacyRuleScopeRow(rc: RequestContext, id: string): PrivacyRuleScopeRow {
  const row = rc.app.db
    .prepare('SELECT id, scope, partition_id FROM privacy_rules WHERE id = ?')
    .get(id) as unknown as PrivacyRuleScopeRow | undefined;
  if (!row) throw errors.notFound('隐私规则不存在');
  return row;
}

/** global 规则仅 owner 可写；分区规则需要该分区 admin+。 */
function assertPrivacyRuleWrite(rc: RequestContext, row: PrivacyRuleScopeRow): void {
  if (row.scope === 'global') {
    requireConsoleRole(rc, 'owner');
    return;
  }
  assertWritable(requireConsolePartition(rc, row.partition_id, 'admin'));
}

function contextKeywordsFromBody(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    return value
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return undefined;
}

/** 控制台请求体 → PrivacyRuleInput（camelCase 为主，兼容 snake_case）。 */
function privacyRuleInputFromBody(body: Record<string, unknown>): PrivacyRuleInput {
  return {
    code: body.code as string | undefined,
    name: body.name as string | undefined,
    kind: body.kind as PrivacyRuleInput['kind'] | undefined,
    pattern: body.pattern as string | undefined,
    flags: body.flags as string | undefined,
    instruction: body.instruction as string | undefined,
    entityType: (body.entityType ?? body.entity_type) as string | undefined,
    action: body.action as PrivacyRuleInput['action'] | undefined,
    maskMode: (body.maskMode ?? body.mask_mode) as PrivacyRuleInput['maskMode'] | undefined,
    maskKeepLast: (body.maskKeepLast ?? body.mask_keep_last) as number | undefined,
    maskKeepFirst: (body.maskKeepFirst ?? body.mask_keep_first) as number | undefined,
    enabled: body.enabled as boolean | undefined,
    priority: body.priority as number | undefined,
    groupKey: (body.groupKey ?? body.group_key) as string | undefined,
    validator: body.validator as string | undefined,
    contextKeywords: contextKeywordsFromBody(body.contextKeywords ?? body.context_keywords),
    caseSensitive: (body.caseSensitive ?? body.case_sensitive) as boolean | undefined,
    region: body.region as string | undefined,
    severity: body.severity as PrivacyRuleInput['severity'] | undefined,
  } as PrivacyRuleInput;
}

export function registerConsoleRoutes(router: Router): void {
  /* --- 分区 --- */
  router.add({
    method: 'GET',
    path: '/api/partitions',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      rc.json(rc.app.engine.listPartitions(auth.org.id));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleRole(rc, 'admin');
      const body = await rc.body(partitionUpsertSchema);
      const partition = rc.app.engine.upsertPartition(
        auth.org.id,
        { ...body, settings: body.settings as Partial<PartitionSettings> | undefined },
        actorForUser(rc, auth.user),
      );
      rc.json(withStats(rc, partition), 201);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      rc.json(withStats(rc, partition));
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/partitions/:partition',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'admin');
      const body = await rc.body(partitionPatchSchema);
      const updated = rc.app.engine.updatePartition(
        partition.orgId,
        partition.id,
        { ...body, settings: body.settings as Partial<PartitionSettings> | undefined },
        actorForUser(rc, requireConsoleAuth(rc).user),
      );
      rc.json(withStats(rc, updated));
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/stats',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      rc.json(rc.app.engine.partitionStats(partition.id));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/reconcile',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc, 'admin');
      rc.json(rc.app.engine.reconcileCounts(partition.id));
    },
  });

  /* --- 人 --- */
  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/persons',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const query = rc.query(personListQuerySchema);
      const page = rc.app.engine.listPersons(partition.id, {
        ...query,
        includeMerged: query.includeMerged === true || query.include_merged === true,
      });
      rc.markUsage({ partitionId: partition.id, operation: query.q ? 'search' : 'list', channel: 'console' });
      rc.noteUsage(page.items.length);
      rc.json(page);
    },
  });

  router.add({
    method: 'PUT',
    path: '/api/partitions/:partition/persons/:externalId',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      assertWritable(partition);
      const auth = requireConsoleAuth(rc);
      const externalId = rc.params.externalId ?? '';
      const body = await rc.body(personUpsertSchema);
      const person = rc.app.engine.upsertPerson(
        partition.id,
        {
          externalId,
          type: body.type as PersonType | undefined,
          displayName: body.displayName,
          attributes: body.attributes,
          status: body.status,
          consent: body.consent,
        },
        actorForUser(rc, auth.user),
      );
      rc.json(person);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/persons/:person',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const person = requirePerson(rc, partition.id);
      rc.json(person);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/partitions/:partition/persons/:person',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      assertWritable(partition);
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(personUpdateSchema);
      const person = rc.app.engine.updatePerson(
        partition.id,
        personRef(rc),
        {
          displayName: body.displayName,
          attributes: body.attributes,
          status: body.status,
          consent: body.consent,
        },
        actorForUser(rc, auth.user),
      );
      rc.json(person);
    },
  });

  /* --- v6.1 P1：画像 / 生命周期 --- */
  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/persons/:person/profile',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const query = rc.query(personProfileQuerySchema);
      const ref = personRef(rc);
      const force = query.force === true || query.refresh === true;
      const profile = rc.app.engine.refreshPersonProfile
        ? await rc.app.engine.refreshPersonProfile(partition.id, ref, { force })
        : rc.app.engine.personProfile(partition.id, ref);
      rc.markUsage({ partitionId: partition.id, operation: 'profile', channel: 'console' });
      rc.noteUsage(profile.facts.length);
      rc.json(profile);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/persons/:person/facts',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const facts = rc.app.engine.listPersonFacts(partition.id, personRef(rc));
      rc.json({ items: facts });
    },
  });

  router.add({
    method: 'PUT',
    path: '/api/partitions/:partition/persons/:person/facts',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      assertWritable(partition);
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(personFactsPutSchema);
      const actor = actorForUser(rc, auth.user);
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
              sourceMemoryId: input.sourceMemoryId ?? input.source_memory_id,
            },
            actor,
          ),
        );
        rc.json({ items });
        return;
      }
      const single = body as { key: string; value: string; confidence?: number; sourceMemoryId?: string; source_memory_id?: string };
      const fact = rc.app.engine.upsertPersonFact(
        partition.id,
        ref,
        {
          key: single.key,
          value: single.value,
          confidence: single.confidence,
          sourceMemoryId: single.sourceMemoryId ?? single.source_memory_id,
        },
        actor,
      );
      rc.json({ fact });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/partitions/:partition/persons/:person/facts/:factId',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      assertWritable(partition);
      const auth = requireConsoleAuth(rc);
      const factId = rc.params.factId ?? '';
      if (!factId) throw errors.badRequest('缺少路径参数 factId');
      rc.app.engine.removePersonFact(partition.id, personRef(rc), factId, actorForUser(rc, auth.user));
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/persons/:person/merge',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'admin');
      assertWritable(partition);
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(personMergeSchema);
      const targetRef =
        body.targetId ?? body.target_id ?? body.targetExternalId ?? body.target_external_id ?? '';
      const result = rc.app.engine.mergePersons(partition.id, personRef(rc), targetRef, actorForUser(rc, auth.user));
      rc.json(result);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/persons/:person/archive',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      assertWritable(partition);
      const auth = requireConsoleAuth(rc);
      const person = rc.app.engine.archivePerson(partition.id, personRef(rc), actorForUser(rc, auth.user));
      rc.json(person);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/persons/:person/export',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const exported = rc.app.engine.exportPerson(partition.id, personRef(rc));
      rc.markUsage({ partitionId: partition.id, operation: 'person.export', channel: 'console' });
      rc.noteUsage(exported.memories.length);
      rc.json({ ...exported, truncated: exported.truncated === true });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/partitions/:partition/persons/:person',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const query = rc.query(personDeleteQuerySchema);
      let hard = query.hard === true;
      if (!hard) {
        const raw = await rc.readBody();
        if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).hard === true) hard = true;
      }
      const partition = partitionFor(rc, hard ? 'owner' : 'admin');
      const auth = requireConsoleAuth(rc);
      rc.app.engine.deletePerson(partition.id, personRef(rc), { hard }, actorForUser(rc, auth.user));
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });

  /* --- v6.1 P2：实体 / 关系图 --- */
  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/graph',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const query = rc.query(entityGraphQuerySchema);
      const graph = rc.app.engine.entityGraph({
        partitionId: partition.id,
        personId: query.personId ?? query.person_id,
        limit: query.limit,
      });
      rc.markUsage({ partitionId: partition.id, operation: 'graph', channel: 'console' });
      rc.noteUsage(graph.stats.nodes);
      rc.json(graph);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/entities',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const query = rc.query(entityListQuerySchema);
      const result = rc.app.engine.listEntities({
        partitionId: partition.id,
        personId: query.personId ?? query.person_id,
        q: query.q,
        limit: query.limit,
      });
      rc.markUsage({ partitionId: partition.id, operation: 'entities.list', channel: 'console' });
      rc.noteUsage(result.items.length);
      rc.json({ items: result.items, nextCursor: result.nextCursor });
    },
  });

  /* --- 记忆 --- */
  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/persons/:person/memories',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const person = requirePerson(rc, partition.id);
      const query = rc.query(memoryListQuerySchema);
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
      rc.markUsage({ partitionId: partition.id, operation: query.q ? 'search' : 'list', channel: 'console' });
      rc.noteUsage(page.items.length);
      rc.json(page);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/persons/:person/memories',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      assertWritable(partition);
      enforceQuota(rc, partition);
      const auth = requireConsoleAuth(rc);
      const person = requirePerson(rc, partition.id);
      const body = await rc.body(memoryAddSchema);
      const content = (body.text ?? body.content ?? '').trim();
      if (!content) throw errors.validation(undefined, 'text 不能为空');
      const result = rc.app.engine.addMemoryResult({
        partitionId: partition.id,
        personId: person.id,
        scope: body.scope as MemoryScope | undefined,
        sessionId: body.sessionId,
        sessionTitle: body.sessionTitle,
        category: body.category,
        content,
        importance: body.importance,
        confidence: body.confidence,
        source: body.source,
        tags: body.tags,
        metadata: body.metadata,
        expiresAt: body.expiresAt,
        supersedesId: body.supersedesId,
        factKey: body.factKey,
        validFrom: body.validFrom,
        attachments: body.attachments,
        placeholders: body.placeholders,
        actor: actorForUser(rc, auth.user),
      });
      rc.markUsage({ partitionId: partition.id, operation: 'add', channel: 'console' });
      rc.noteUsage(1);
      rc.json({ memory: result.memory, event: result.event, supersededId: result.supersededId ?? null }, 201);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/memories',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const query = rc.query(memoryListQuerySchema);
      const page = rc.app.engine.listMemories({
        partitionId: partition.id,
        personId: query.personId,
        scope: query.scope,
        category: query.category,
        status: query.status,
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
      });
      rc.markUsage({ partitionId: partition.id, operation: query.q ? 'search' : 'list', channel: 'console' });
      rc.noteUsage(page.items.length);
      rc.json(page);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/memories/search',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const body = await rc.body(memorySearchSchema);
      const response = rc.app.engine.searchMemories({
        partitionId: partition.id,
        query: body.query,
        personId: body.personId,
        personExternalId: body.personExternalId,
        scope: body.scope as MemoryScope | undefined,
        category: body.category,
        mode: body.mode,
        topK: body.topK,
        asOf: body.asOf,
        includeSuperseded: body.includeSuperseded,
        includePrivate: body.includePrivate,
      });
      rc.markUsage({ partitionId: partition.id, operation: 'search', channel: 'console' });
      rc.noteUsage(response.hits.length);
      rc.json({ ...response, took_ms: response.tookMs });
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/memories/:id/history',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      rc.json(rc.app.engine.memoryHistory(partition.id, rc.params.id ?? ''));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/memories/:id/feedback',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(memoryFeedbackSchema);
      const memory = rc.app.engine.feedback(
        partition.id,
        rc.params.id ?? '',
        { helpful: body.helpful, query: body.query, reason: body.reason },
        actorForUser(rc, auth.user),
      );
      rc.json({ memory });
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/memories/:id',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const query = rc.query(memoryDetailQuerySchema);
      const reveal = query.reveal === 'true' || query.reveal === '1' || query.reveal === 'placeholders';
      const detail = rc.app.engine.getMemory(partition.id, rc.params.id ?? '');
      if (!detail) throw errors.notFound('记忆不存在');
      // v6.2：默认只返回 key/kind/encrypted；reveal=placeholders 解密真实值。
      detail.placeholders = rc.app.engine.memoryPlaceholders(partition.id, detail.memory.id, reveal);
      rc.json(detail);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/partitions/:partition/memories/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(memoryPatchSchema);
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
          expiresAt: body.expiresAt,
          placeholders: body.placeholders,
        },
        actorForUser(rc, auth.user),
      );
      rc.json({ memory });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/partitions/:partition/memories/:id',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      const auth = requireConsoleAuth(rc);
      rc.app.engine.removeMemory(partition.id, rc.params.id ?? '', actorForUser(rc, auth.user));
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });

  /* --- v6.2：隐私规则域 --- */
  router.add({
    method: 'GET',
    path: '/api/privacy/rules',
    auth: 'console',
    handler: (rc: RequestContext) => {
      requireConsoleAuth(rc);
      const query = rc.query(privacyRuleQuerySchema);
      const groupKey = query.groupKey ?? query.group_key;
      const byGroup = <T extends { groupKey: string }>(items: T[]): T[] =>
        groupKey ? items.filter((item) => item.groupKey === groupKey) : items;
      const scope = query.scope as PrivacyRuleScope;
      if (scope === 'global') {
        rc.json({ items: byGroup(rc.app.engine.listPrivacyRules()) });
        return;
      }
      const ref = query.partition_id ?? query.partitionId;
      if (!ref) throw errors.badRequest('scope=partition 时必须提供 partition_id');
      const partition = requireConsolePartition(rc, ref, 'viewer');
      // scope=partition 只返回分区自有规则；生效规则（含全局覆盖）由 preview / 扫描路径合并。
      const items = byGroup(
        rc.app.engine.listPrivacyRules(partition.id).filter((rule) => rule.scope === 'partition'),
      );
      rc.json({ items });
    },
  });

  /* --- v6.3：规则库分组（18 组 / 整组启停） --- */
  router.add({
    method: 'GET',
    path: '/api/privacy/groups',
    auth: 'console',
    handler: (rc: RequestContext) => {
      requireConsoleAuth(rc);
      const query = rc.query(privacyGroupQuerySchema);
      const ref = query.partitionId ?? query.partition_id;
      const partitionId = ref ? requireConsolePartition(rc, ref, 'viewer').id : undefined;
      rc.json({ items: rc.app.engine.listPrivacyRuleGroups(partitionId) });
    },
  });

  router.add({
    method: 'POST',
    path: '/api/privacy/groups/:key/apply',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(privacyGroupApplySchema);
      const ref = body.partitionId ?? body.partition_id;
      if (!ref) throw errors.badRequest('必须提供 partitionId（整组启停只作用于分区）');
      const partition = requireConsolePartition(rc, ref, 'admin');
      assertWritable(partition);
      const groupKey = rc.params.key ?? '';
      const items = rc.app.engine.applyPrivacyGroup(
        partition.id,
        groupKey,
        body.enabled !== false,
        actorForUser(rc, auth.user),
      );
      const group = rc.app.engine.listPrivacyRuleGroups(partition.id).find((item) => item.key === groupKey) ?? null;
      rc.json({ group, items });
    },
  });

  router.add({
    method: 'POST',
    path: '/api/privacy/rules',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const body = (await rc.body(privacyRuleCreateSchema)) as Record<string, unknown>;
      const scope = body.scope as PrivacyRuleScope;
      const partitionRef = (body.partitionId ?? body.partition_id) as string | undefined;
      let partitionId: string | null = null;
      if (scope === 'global') {
        requireConsoleRole(rc, 'owner');
      } else {
        if (!partitionRef) throw errors.badRequest('分区规则必须提供 partition_id');
        const partition = requireConsolePartition(rc, partitionRef, 'admin');
        assertWritable(partition);
        partitionId = partition.id;
      }
      const rule = rc.app.engine.createPrivacyRule(
        scope,
        partitionId,
        privacyRuleInputFromBody(body),
        actorForUser(rc, auth.user),
        auth.org.id,
      );
      rc.json({ rule }, 201);
    },
  });

  router.add({
    method: 'PATCH',
    path: '/api/privacy/rules/:id',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const row = privacyRuleScopeRow(rc, rc.params.id ?? '');
      assertPrivacyRuleWrite(rc, row);
      const body = (await rc.body(privacyRulePatchSchema)) as Record<string, unknown>;
      const rule = rc.app.engine.updatePrivacyRule(
        row.id,
        privacyRuleInputFromBody(body),
        actorForUser(rc, auth.user),
        auth.org.id,
      );
      rc.json({ rule });
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/privacy/rules/:id',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const auth = requireConsoleAuth(rc);
      const row = privacyRuleScopeRow(rc, rc.params.id ?? '');
      assertPrivacyRuleWrite(rc, row);
      rc.app.engine.deletePrivacyRule(row.id, actorForUser(rc, auth.user), auth.org.id);
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });

  router.add({
    method: 'POST',
    path: '/api/privacy/preview',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      requireConsoleAuth(rc);
      const body = await rc.body(privacyPreviewSchema);
      const ref = body.partition_id ?? body.partitionId;
      const partitionId = ref ? requireConsolePartition(rc, ref, 'viewer').id : null;
      rc.json(rc.app.engine.previewPrivacy(partitionId, body.text));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/privacy/rescan',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'admin');
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(privacyRescanSchema);
      const personRef = body.person_id ?? body.personId;
      let personId: string | undefined;
      if (personRef) {
        const person = rc.app.engine.getPerson(partition.id, personRef);
        if (!person) throw errors.notFound('人不存在');
        personId = person.id;
      }
      if (!rc.app.engine.rescanPrivacy) throw errors.internal('当前服务未启用隐私重扫');
      const result = await rc.app.engine.rescanPrivacy(
        partition.id,
        { personId, limit: body.limit },
        actorForUser(rc, auth.user),
      );
      rc.json(result);
    },
  });

  /* --- 简报 / 上下文 / 做梦 --- */
  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/persons/:person/brief',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const person = requirePerson(rc, partition.id);
      const query = rc.query(personBriefQuerySchema);
      const brief = await rc.app.engine.brief({
        partitionId: partition.id,
        personId: person.id,
        maxChars: query.maxChars,
        force: query.force,
      });
      rc.json(brief);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/persons/:person/context',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const person = requirePerson(rc, partition.id);
      const body = await rc.body(personContextSchema);
      const context = await rc.app.engine.context({
        partitionId: partition.id,
        personId: person.id,
        query: body.query,
        budgetTokens: body.budgetTokens,
        includePartition: body.includePartition,
      });
      rc.json(context);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/persons/:person/dream',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const person = requirePerson(rc, partition.id);
      rc.json(rc.app.engine.dreamStatus({ partitionId: partition.id, personId: person.id }));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/persons/:person/dream/run',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      const auth = requireConsoleAuth(rc);
      const person = requirePerson(rc, partition.id);
      const body = await rc.body(dreamRunSchema);
      const result = await rc.app.engine.dream(
        { partitionId: partition.id, personId: person.id, trigger: 'manual', batchSize: body.batchSize },
        actorForUser(rc, auth.user),
      );
      rc.json(result);
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/dream',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      rc.json(rc.app.engine.dreamStatus({ partitionId: partition.id }));
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/dream/run',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'developer');
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(dreamRunSchema);
      const result = await rc.app.engine.dream(
        { partitionId: partition.id, trigger: 'manual', batchSize: body.batchSize },
        actorForUser(rc, auth.user),
      );
      rc.json(result);
    },
  });

  /* --- 用量 / 审计 --- */
  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/usage',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const query = rc.query(usageQuerySchema);
      rc.json(partitionUsage(rc.app.db, partition.id, query.days));
    },
  });

  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/audit',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc);
      const query = rc.query(auditQuerySchema);
      rc.json(listAudit(rc.app.db, partition.id, query));
    },
  });

  /* --- 分区 key --- */
  router.add({
    method: 'GET',
    path: '/api/partitions/:partition/keys',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc, 'admin');
      const rows = rc.app.db
        .prepare(
          `SELECT * FROM api_keys
            WHERE partition_id = ? AND kind = 'partition'
            ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
        )
        .all(partition.id) as unknown as ApiKeyRow[];
      rc.json(rows.map(toApiKey) satisfies ApiKey[]);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/keys',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'admin');
      const auth = requireConsoleAuth(rc);
      const body = await rc.body(apiKeyCreateSchema);
      const { secret, prefix, hash } = newApiKeySecret();
      const id = newId('key');
      const at = nowIso();
      rc.app.db
        .prepare(
          `INSERT INTO api_keys
             (id, partition_id, org_id, kind, name, prefix, key_hash, scopes, created_by, created_at,
              rate_limit_per_min, expires_at, allowed_ips)
           VALUES (?, ?, ?, 'partition', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          partition.id,
          partition.orgId,
          body.name,
          prefix,
          hash,
          JSON.stringify([...new Set(body.scopes)]),
          auth.user.id,
          at,
          body.rateLimitPerMin ?? 600,
          body.expiresAt ? new Date(Date.parse(body.expiresAt)).toISOString() : null,
          JSON.stringify([...new Set(body.allowedIps ?? [])]),
        );
      writeAudit(rc.app.db, {
        orgId: partition.orgId,
        partitionId: partition.id,
        actor: actorForUser(rc, auth.user),
        action: 'key.create',
        resourceType: 'api_key',
        resourceId: id,
        detail: { name: body.name, scopes: body.scopes },
      });
      const row = loadKey(rc, partition.id, id);
      if (!row) throw errors.internal('API Key 写入失败');
      rc.json({ ...toApiKey(row), secret }, 201);
    },
  });

  router.add({
    method: 'POST',
    path: '/api/partitions/:partition/keys/:id/rotate',
    auth: 'console',
    handler: async (rc: RequestContext) => {
      const partition = partitionFor(rc, 'admin');
      const auth = requireConsoleAuth(rc);
      const old = loadKey(rc, partition.id, rc.params.id ?? '');
      if (!old) throw errors.notFound('API Key 不存在');
      if (old.revoked_at) throw errors.conflict('该 API Key 已被吊销');
      const body = await rc.body(apiKeyRotateSchema);
      const at = nowIso();
      const { secret, prefix, hash } = newApiKeySecret();
      const id = newId('key');
      rc.app.db
        .prepare(
          `INSERT INTO api_keys
             (id, partition_id, org_id, kind, name, prefix, key_hash, scopes, created_by, created_at,
              rate_limit_per_min, expires_at, allowed_ips, rotated_from)
           VALUES (?, ?, ?, 'partition', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          partition.id,
          partition.orgId,
          old.name,
          prefix,
          hash,
          old.scopes,
          auth.user.id,
          at,
          old.rate_limit_per_min,
          old.expires_at,
          old.allowed_ips,
          old.id,
        );
      // graceHours 仅做审计记录；v6 立即吊销旧 key（避免新旧并存造成越权窗口）。
      rc.app.db
        .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?')
        .run(at, old.id);
      writeAudit(rc.app.db, {
        orgId: partition.orgId,
        partitionId: partition.id,
        actor: actorForUser(rc, auth.user),
        action: 'key.rotate',
        resourceType: 'api_key',
        resourceId: id,
        detail: { rotatedFrom: old.id, graceHours: body.graceHours },
      });
      const row = loadKey(rc, partition.id, id);
      if (!row) throw errors.internal('API Key 写入失败');
      rc.json({ ...toApiKey(row), secret }, 201);
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/partitions/:partition/keys/:id',
    auth: 'console',
    handler: (rc: RequestContext) => {
      const partition = partitionFor(rc, 'admin');
      const auth = requireConsoleAuth(rc);
      const row = loadKey(rc, partition.id, rc.params.id ?? '');
      if (!row) throw errors.notFound('API Key 不存在');
      if (!row.revoked_at) {
        rc.app.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(), row.id);
        writeAudit(rc.app.db, {
          orgId: partition.orgId,
          partitionId: partition.id,
          actor: actorForUser(rc, auth.user),
          action: 'key.revoke',
          resourceType: 'api_key',
          resourceId: row.id,
        });
      }
      rc.res.statusCode = 204;
      rc.res.end();
    },
  });
}
