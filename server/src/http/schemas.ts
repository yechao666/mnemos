import { z } from 'zod';
import { CURSOR_LIMIT_DEFAULT, CURSOR_LIMIT_MAX } from '../../../shared/src/constants.ts';
import { isValidIpRule } from './middleware/auth.ts';

/**
 * HTTP 入参 zod schema 集中定义（控制台 /api 用 camelCase）。
 * 公开 v1（snake_case）在 routes/v1.ts 内定义对应 schema。
 * 只做形状/范围校验，业务规则（权限、唯一性等）由 handler / 引擎处理。
 */

export const roleSchema = z.enum(['owner', 'admin', 'developer', 'viewer']);
export const scopeSchema = z.enum(['memories:read', 'memories:write', 'admin']);
export const partitionStatusSchema = z.enum(['active', 'paused', 'archived']);
export const personTypeSchema = z.enum(['human', 'agent', 'service', 'other']);
export const personStatusSchema = z.enum(['active', 'archived', 'deleted']);
export const personSortSchema = z.enum(['recent', 'new', 'name']);
export const memoryScopeSchema = z.enum(['person', 'partition', 'session']);
export const memoryStatusSchema = z.enum(['active', 'archived', 'deleted']);
export const memorySourceSchema = z.enum(['api', 'conversation', 'agent', 'import', 'playground', 'dream']);
export const memoryCategorySchema = z.enum([
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
  'decision',
  'progress',
  'lesson',
  'risk',
  'change',
  'acceptance',
  'assumption',
  'dependency',
]);

/** 查询字符串里的布尔值（兼容 true/false/1/0）。 */
export const booleanQuerySchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const cursorQuerySchema = z.object({
  cursor: z.string().trim().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(CURSOR_LIMIT_MAX).default(CURSOR_LIMIT_DEFAULT),
});

export const retrievalModeSchema = z.enum(['hybrid', 'keyword', 'vector']);
export const retrievalWeightsSchema = z
  .object({
    vector: z.coerce.number().min(0).max(1),
    keyword: z.coerce.number().min(0).max(1),
    recency: z.coerce.number().min(0).max(1),
    importance: z.coerce.number().min(0).max(1),
    entity: z.coerce.number().min(0).max(1),
  })
  .partial();

export const partitionSettingsSchema = z
  .object({
    defaultScope: memoryScopeSchema,
    briefMaxChars: z.coerce.number().int().min(100).max(5000),
    briefEnabled: z.boolean(),
    dreamEnabled: z.boolean(),
    dreamIntervalMinutes: z.coerce.number().int().min(1).max(43_200),
    retentionDays: z.coerce.number().int().min(0).max(3650),
    monthlyQuota: z.coerce.number().int().min(0).max(1_000_000_000),
    personAutoCreate: z.boolean(),
    locale: z.string().trim().min(2).max(20),
    /* v6.1 */
    retrievalMode: retrievalModeSchema,
    retrievalWeights: retrievalWeightsSchema,
    embeddingModel: z.string().trim().min(1).max(80),
    mergeThreshold: z.coerce.number().min(0).max(1),
    dedupeThreshold: z.coerce.number().min(0).max(1),
    autoExtractEntities: z.boolean(),
    /* v6.1 P2 合规 */
    piiRedaction: z.enum(['off', 'basic']),
    /* v6.2 隐私规则 */
    privacyLlmEnabled: z.boolean(),
  })
  .partial();

export const partitionUpsertSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'slug 仅支持小写字母、数字与连字符，且以字母或数字开头'),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  status: partitionStatusSchema.optional(),
  settings: partitionSettingsSchema.optional(),
});

export const partitionPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    status: partitionStatusSchema.optional(),
    settings: partitionSettingsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

/** PUT /persons/:externalId 的请求体；路径上的 externalId 优先。 */
export const personUpsertSchema = z.object({
  externalId: z.string().trim().min(1).max(128).optional(),
  type: personTypeSchema.optional(),
  displayName: z.string().trim().max(120).optional(),
  attributes: z.record(z.unknown()).optional(),
  status: personStatusSchema.optional(),
  /** v6.1 P2：合规/同意标记（整体覆盖） */
  consent: z.record(z.unknown()).optional(),
});

/** PATCH 人：type 与 externalId 不可改，只能更新展示名 / attributes / status / consent。 */
export const personUpdateSchema = z
  .object({
    displayName: z.string().trim().max(120).optional(),
    attributes: z.record(z.unknown()).optional(),
    status: personStatusSchema.optional(),
    /** v6.1 P2：合规/同意标记（整体覆盖） */
    consent: z.record(z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export const personListQuerySchema = cursorQuerySchema.extend({
  type: personTypeSchema.optional(),
  status: personStatusSchema.optional(),
  q: z.string().trim().max(200).optional(),
  sort: personSortSchema.optional(),
  /** v6.1 P1：包含已合并的人（排查用）；也接受 snake_case。 */
  includeMerged: booleanQuerySchema.optional(),
  include_merged: booleanQuerySchema.optional(),
});

/* --- v6.1 P1：画像 / 生命周期 --- */

const personFactInputSchema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(2000),
  confidence: z.coerce.number().min(0).max(1).optional(),
  sourceMemoryId: z.string().trim().max(128).optional(),
  source_memory_id: z.string().trim().max(128).optional(),
});

export const personFactsPutSchema = z.union([
  z.object({ facts: z.array(personFactInputSchema).min(1).max(100) }),
  personFactInputSchema,
]);

export const personMergeSchema = z
  .object({
    targetId: z.string().trim().min(1).max(128).optional(),
    target_id: z.string().trim().min(1).max(128).optional(),
    targetExternalId: z.string().trim().min(1).max(128).optional(),
    target_external_id: z.string().trim().min(1).max(128).optional(),
  })
  .refine(
    (value) =>
      Boolean(value.targetId ?? value.target_id ?? value.targetExternalId ?? value.target_external_id),
    { message: '必须提供 targetId / target_id / targetExternalId' },
  );

export const personProfileQuerySchema = z.object({
  force: booleanQuerySchema.optional(),
  refresh: booleanQuerySchema.optional(),
});

export const personDeleteQuerySchema = z.object({
  hard: booleanQuerySchema.optional(),
});

/** v6.1 P2：多模态附件（每记忆 ≤10、url ≤2000）。 */
export const memoryAttachmentSchema = z.object({
  kind: z.enum(['image', 'audio', 'video', 'file']),
  url: z.string().trim().min(1).max(2000),
  mime: z.string().trim().max(200).optional(),
  size: z.coerce.number().int().min(0).optional(),
  caption: z.string().trim().max(1000).optional(),
});

export const placeholdersSchema = z.record(z.string().max(4000));

export const memoryAddSchema = z.object({
  text: z.string().min(1).max(20_000).optional(),
  content: z.string().min(1).max(20_000).optional(),
  scope: memoryScopeSchema.optional(),
  sessionId: z.string().trim().max(128).optional(),
  sessionTitle: z.string().trim().max(200).optional(),
  category: memoryCategorySchema.optional(),
  importance: z.coerce.number().min(0).max(1).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  source: memorySourceSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
  expiresAt: z.string().trim().max(40).nullable().optional(),
  /* v6.1 写管线 */
  supersedesId: z.string().trim().max(128).optional(),
  factKey: z.string().trim().max(120).optional(),
  validFrom: z.string().trim().max(40).optional(),
  /* v6.1 P2 多模态附件 */
  attachments: z.array(memoryAttachmentSchema).max(10).optional(),
  /* v6.2 隐私占位符映射 */
  placeholders: placeholdersSchema.optional(),
}).refine((value) => Boolean(value.text ?? value.content), {
  message: 'text 不能为空',
  path: ['text'],
});

export const memoryPatchSchema = z
  .object({
    content: z.string().min(1).max(20_000).optional(),
    category: memoryCategorySchema.optional(),
    importance: z.coerce.number().min(0).max(1).optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    status: memoryStatusSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
    expiresAt: z.string().trim().max(40).nullable().optional(),
    /* v6.2 隐私占位符映射（整体覆盖；正文未使用的键忽略） */
    placeholders: placeholdersSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export const memorySearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  personId: z.string().trim().max(128).optional(),
  personExternalId: z.string().trim().max(128).optional(),
  scope: memoryScopeSchema.optional(),
  category: memoryCategorySchema.optional(),
  mode: retrievalModeSchema.optional(),
  topK: z.coerce.number().int().min(1).max(50).optional(),
  asOf: z.string().trim().max(40).optional(),
  includeSuperseded: z.boolean().optional(),
  includePrivate: z.boolean().optional(),
});

export const memoryFeedbackSchema = z.object({
  helpful: z.boolean(),
  query: z.string().trim().max(2000).optional(),
  reason: z.string().trim().max(500).optional(),
});

/* v6.1 P2：实体 / 关系图查询（控制台 camelCase） */
export const entityGraphQuerySchema = z.object({
  personId: z.string().trim().max(128).optional(),
  person_id: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const entityListQuerySchema = z.object({
  personId: z.string().trim().max(128).optional(),
  person_id: z.string().trim().max(128).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const memoryListQuerySchema = cursorQuerySchema.extend({
  personId: z.string().trim().max(128).optional(),
  scope: memoryScopeSchema.optional(),
  category: memoryCategorySchema.optional(),
  status: memoryStatusSchema.optional(),
  q: z.string().trim().max(500).optional(),
});

/** 人级简报查询：force 强制重算，maxChars 覆盖分区设置（不落库）。 */
export const personBriefQuerySchema = z.object({
  force: booleanQuerySchema.optional(),
  maxChars: z.coerce.number().int().min(100).max(5000).optional(),
});

/** 人的上下文生成入参。 */
export const personContextSchema = z.object({
  query: z.string().trim().max(2000).optional(),
  budgetTokens: z.coerce.number().int().min(60).max(32_000).optional(),
  includePartition: z.boolean().optional(),
});

export const dreamRunSchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const auditQuerySchema = cursorQuerySchema;

export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/* ------------------------------------------------------------------ */
/* v6.2：隐私规则 / 预览 / 重扫                                        */
/* ------------------------------------------------------------------ */

export const privacyRuleScopeSchema = z.enum(['global', 'partition']);
export const privacyRuleKindSchema = z.enum(['regex', 'prompt']);
export const privacyActionSchema = z.enum(['mask', 'placeholder']);
export const privacyMaskModeSchema = z.enum(['email', 'keepFirstLast', 'keepLast', 'full']);

export const privacySeveritySchema = z.enum(['low', 'medium', 'high']);

/** contextKeywords 接受数组，也兼容逗号分隔字符串（前端编辑器两种都常见）。 */
const privacyContextKeywordsSchema = z.union([
  z.array(z.string().trim().max(40)).max(20),
  z.string().trim().max(1000),
]);

export const privacyRuleInputSchema = z.object({
  code: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  kind: privacyRuleKindSchema.optional(),
  pattern: z.string().max(2000).optional(),
  flags: z.string().trim().max(8).optional(),
  instruction: z.string().trim().max(2000).optional(),
  entityType: z.string().trim().max(60).optional(),
  entity_type: z.string().trim().max(60).optional(),
  action: privacyActionSchema.optional(),
  maskMode: privacyMaskModeSchema.optional(),
  mask_mode: privacyMaskModeSchema.optional(),
  maskKeepLast: z.coerce.number().int().min(0).max(64).optional(),
  mask_keep_last: z.coerce.number().int().min(0).max(64).optional(),
  maskKeepFirst: z.coerce.number().int().min(0).max(64).optional(),
  mask_keep_first: z.coerce.number().int().min(0).max(64).optional(),
  enabled: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(1_000_000).optional(),
  /* v6.3：规则库分组 / 校验器 / 上下文关键词 / 大小写 / 区域 / 严重级别 */
  groupKey: z.string().trim().max(40).optional(),
  group_key: z.string().trim().max(40).optional(),
  validator: z.string().trim().max(40).optional(),
  contextKeywords: privacyContextKeywordsSchema.optional(),
  context_keywords: privacyContextKeywordsSchema.optional(),
  caseSensitive: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  region: z.string().trim().max(40).optional(),
  severity: privacySeveritySchema.optional(),
});

export const privacyRuleCreateSchema = privacyRuleInputSchema.extend({
  scope: privacyRuleScopeSchema,
  partitionId: z.string().trim().max(128).optional(),
  partition_id: z.string().trim().max(128).optional(),
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(1).max(80),
  kind: privacyRuleKindSchema,
});

export const privacyRulePatchSchema = privacyRuleInputSchema
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export const privacyRuleQuerySchema = z.object({
  scope: privacyRuleScopeSchema.default('global'),
  partition_id: z.string().trim().max(128).optional(),
  partitionId: z.string().trim().max(128).optional(),
  groupKey: z.string().trim().max(40).optional(),
  group_key: z.string().trim().max(40).optional(),
});

export const privacyGroupQuerySchema = z.object({
  partitionId: z.string().trim().max(128).optional(),
  partition_id: z.string().trim().max(128).optional(),
});

export const privacyGroupApplySchema = z.object({
  partitionId: z.string().trim().max(128).optional(),
  partition_id: z.string().trim().max(128).optional(),
  enabled: z.boolean().optional().default(true),
});

export const privacyPreviewSchema = z.object({
  partition_id: z.string().trim().max(128).optional(),
  partitionId: z.string().trim().max(128).optional(),
  text: z.string().min(1).max(20_000),
});

export const privacyRescanSchema = z.object({
  person_id: z.string().trim().max(128).optional(),
  personId: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** GET 记忆详情：reveal=placeholders/true 时解密占位符值。 */
export const memoryDetailQuerySchema = z.object({
  reveal: z.enum(['true', 'false', '1', '0', 'placeholders']).optional(),
});

/* ------------------------------------------------------------------ */
/* API Key 生命周期                                                     */
/* ------------------------------------------------------------------ */

export const allowedIpSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidIpRule, '仅支持合法 IPv4 或 CIDR，例如 203.0.113.7 或 10.0.0.0/8');

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(scopeSchema).min(1).max(3),
  rateLimitPerMin: z.coerce.number().int().min(1).max(100_000).optional(),
  expiresAt: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value)), 'expiresAt 必须是 ISO 8601 时间字符串')
    .refine((value) => Date.parse(value) > Date.now(), 'expiresAt 必须是未来时间')
    .optional(),
  allowedIps: z.array(allowedIpSchema).max(20).optional(),
});

export const apiKeyRotateSchema = z.object({
  graceHours: z.coerce.number().int().min(0).max(168).default(0),
});

/* ------------------------------------------------------------------ */
/* 组织成员管理                                                        */
/* ------------------------------------------------------------------ */

export const orgUserCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确').max(254),
  name: z.string().trim().min(1).max(80),
  role: roleSchema,
  title: z.string().trim().max(80).optional(),
  password: z.string().min(6).max(256).optional(),
});

export const orgUserUpdateSchema = z
  .object({
    role: roleSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
    title: z.string().trim().max(80).optional(),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });
