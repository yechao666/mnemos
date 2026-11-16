import { z } from 'zod';
import { PAGE_SIZE } from '../../../shared/src/constants.ts';
import { isValidIpRule } from './middleware/auth.ts';

/**
 * HTTP 入参 zod schema 集中定义。
 * 只做形状/范围校验，业务规则（权限、唯一性等）由路由处理。
 */

export const roleSchema = z.enum(['owner', 'admin', 'developer', 'viewer']);
export const scopeSchema = z.enum(['memories:read', 'memories:write', 'graph:read', 'admin']);
export const projectStatusSchema = z.enum(['active', 'paused', 'archived']);
export const memoryStatusSchema = z.enum(['active', 'archived', 'deleted']);
export const memoryVisibilitySchema = z.enum(['project', 'agent', 'task']);
export const taskStatusSchema = z.enum(['open', 'active', 'done', 'abandoned']);
export const agentStatusSchema = z.enum(['active', 'idle', 'retired']);
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
export const extractionModeSchema = z.enum(['additive', 'consolidate']);
export const memorySourceSchema = z.enum(['conversation', 'api', 'agent', 'import', 'playground', 'dream']);
export const memorySortSchema = z.enum(['recent', 'importance', 'accessed']);
export const environmentSchema = z.enum(['production', 'staging', 'sandbox']);

/** 查询字符串里的布尔值（兼容 true/false/1/0）。 */
export const booleanQuerySchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().min(1).max(20_000),
  name: z.string().trim().max(120).optional(),
});

export const weightsSchema = z.object({
  semantic: z.coerce.number().min(0).max(1),
  keyword: z.coerce.number().min(0).max(1),
  entity: z.coerce.number().min(0).max(1),
  recency: z.coerce.number().min(0).max(1),
});

/** 完整设置（PATCH 用 partial，创建项目时用 partial 后与默认值合并）。 */
export const projectSettingsSchema = z.object({
  extractionMode: extractionModeSchema,
  embeddingModel: z.string().trim().min(1).max(120),
  topK: z.coerce.number().int().min(1).max(50),
  threshold: z.coerce.number().min(0).max(1),
  retentionDays: z.coerce.number().int().min(1).max(3650),
  graphEnabled: z.boolean(),
  dedupeThreshold: z.coerce.number().min(0).max(1),
  weights: weightsSchema.partial(),
  monthlyQuota: z.coerce.number().int().min(0),
  webhookUrl: z.string().trim().max(500).nullable(),
  locale: z.string().trim().min(2).max(20),
  /* --- 记忆简报 / 做梦 --- */
  briefMaxChars: z.coerce.number().int().min(100).max(5000),
  briefEnabled: z.boolean(),
  dreamEnabled: z.boolean(),
  dreamIntervalMinutes: z.coerce.number().int().min(1).max(43_200),
  reportsEnabled: z.boolean(),
  weeklyReportDay: z.coerce.number().int().min(1).max(7),
  weeklyReportTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  monthlyReportDay: z.coerce.number().int().min(1).max(28),
  monthlyReportTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
});

export const projectSettingsPatchSchema = projectSettingsSchema.partial();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(PAGE_SIZE),
});

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(80).optional(),
  actor: z.string().trim().max(120).optional(),
});

export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const memoryListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(500).optional(),
  userId: z.string().trim().max(128).optional(),
  agentId: z.string().trim().max(128).optional(),
  writtenByAgentId: z.string().trim().max(128).optional(),
  runId: z.string().trim().max(128).optional(),
  taskId: z.string().trim().max(128).optional(),
  visibility: memoryVisibilitySchema.optional(),
  includePrivate: booleanQuerySchema.optional(),
  category: memoryCategorySchema.optional(),
  status: memoryStatusSchema.optional(),
  sort: memorySortSchema.optional(),
});

export const memoryFiltersSchema = z.object({
  status: memoryStatusSchema.optional(),
  category: memoryCategorySchema.optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  createdAfter: z.string().trim().max(40).optional(),
  createdBefore: z.string().trim().max(40).optional(),
  minImportance: z.coerce.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** 写入记忆（控制台 playground / 公开 v1 共用内部结构）。 */
export const addMemorySchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(50).optional(),
    text: z.string().min(1).max(20_000).optional(),
    userId: z.string().trim().max(128).optional(),
    agentId: z.string().trim().max(128).optional(),
    runId: z.string().trim().max(128).optional(),
    appId: z.string().trim().max(128).optional(),
    taskId: z.string().trim().max(128).optional(),
    visibility: memoryVisibilitySchema.optional(),
    metadata: z.record(z.unknown()).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    infer: z.boolean().optional(),
    mode: extractionModeSchema.optional(),
  })
  .refine((value) => Boolean(value.text) || Boolean(value.messages && value.messages.length > 0), {
    message: 'messages 与 text 至少提供一个',
    path: ['messages'],
  });

export const searchMemorySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  userId: z.string().trim().max(128).optional(),
  agentId: z.string().trim().max(128).optional(),
  runId: z.string().trim().max(128).optional(),
  appId: z.string().trim().max(128).optional(),
  taskId: z.string().trim().max(128).optional(),
  visibility: memoryVisibilitySchema.optional(),
  includePrivate: z.boolean().optional(),
  topK: z.coerce.number().int().min(1).max(100).optional(),
  threshold: z.coerce.number().min(0).max(1).optional(),
  filters: memoryFiltersSchema.optional(),
});

export const updateMemorySchema = z
  .object({
    content: z.string().min(1).max(20_000).optional(),
    category: memoryCategorySchema.optional(),
    importance: z.coerce.number().min(0).max(1).optional(),
    status: memoryStatusSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
    expiresAt: z.string().trim().max(40).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export const bulkMemorySchema = z.object({
  action: z.enum(['delete', 'archive', 'restore']),
  ids: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
});

export const feedbackSchema = z.object({
  helpful: z.boolean(),
  query: z.string().trim().max(2000).optional(),
});

/* ------------------------------------------------------------------ */
/* Agent 注册表 / 任务会话 / 任务简报                                  */
/* ------------------------------------------------------------------ */

export const agentCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(64).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  capabilities: z.array(z.string().trim().min(1).max(64)).max(30).optional(),
  status: agentStatusSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const agentUpdateSchema = agentCreateSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: '至少提供一个待更新字段',
});

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  goal: z.string().trim().max(4000).optional(),
  ownerAgentId: z.string().trim().max(128).optional(),
  branch: z.string().trim().max(200).optional(),
  status: taskStatusSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const taskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    goal: z.string().trim().max(4000).optional(),
    status: taskStatusSchema.optional(),
    branch: z.string().trim().max(200).optional(),
    ownerAgentId: z.string().trim().max(128).optional(),
    summary: z.string().trim().max(8000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  agentId: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const finishItemSchema = z.string().trim().min(1).max(2000);

export const finishTaskSchema = z.object({
  status: z.enum(['done', 'abandoned']).optional(),
  summary: z.string().trim().max(8000).optional(),
  decisions: z.array(finishItemSchema).max(50).optional(),
  lessons: z.array(finishItemSchema).max(50).optional(),
  progress: z.array(finishItemSchema).max(50).optional(),
  risks: z.array(finishItemSchema).max(50).optional(),
  changes: z.array(finishItemSchema).max(50).optional(),
  acceptance: z.array(finishItemSchema).max(50).optional(),
  assumptions: z.array(finishItemSchema).max(50).optional(),
  dependencies: z.array(finishItemSchema).max(50).optional(),
  notes: z.array(finishItemSchema).max(50).optional(),
  agentId: z.string().trim().max(128).optional(),
});

export const reportQuerySchema = z.object({
  period: z.enum(['week', 'month']).optional().default('week'),
  anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const briefingQuerySchema = z.object({
  agentId: z.string().trim().max(128).optional(),
  taskId: z.string().trim().max(128).optional(),
  query: z.string().trim().max(500).optional(),
  budgetTokens: z.coerce.number().int().min(60).max(8000).optional(),
  includePrivate: booleanQuerySchema.optional(),
});

/* ------------------------------------------------------------------ */
/* 记忆简报 / 做梦                                                      */
/* ------------------------------------------------------------------ */

export const briefQuerySchema = z.object({
  /** 忽略缓存重新生成 */
  force: booleanQuerySchema.optional(),
  agentId: z.string().trim().max(128).optional(),
  /** 不传时使用项目 settings.briefMaxChars */
  maxChars: z.coerce.number().int().optional(),
});

export const briefSettingsSchema = z.object({
  maxChars: z.coerce.number().int().min(100).max(5000),
});

export const dreamSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.coerce.number().int().min(1).max(43_200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

/* ------------------------------------------------------------------ */
/* API Key 生命周期                                                     */
/* ------------------------------------------------------------------ */

/** 白名单项：精确 IPv4 或 CIDR。 */
export const allowedIpSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidIpRule, '仅支持合法 IPv4 或 CIDR，例如 203.0.113.7 或 10.0.0.0/8');

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(scopeSchema).min(1).max(4),
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

/* ------------------------------------------------------------------ */
/* 导出 / 导入                                                         */
/* ------------------------------------------------------------------ */

export const exportQuerySchema = z.object({
  format: z.enum(['json']).default('json'),
});

/** 单条导入记录：兼容 ProjectExport（camelCase）与 mem0 风格的 text 字段。 */
export const importMemorySchema = z
  .object({
    content: z.string().trim().min(1).max(20_000).optional(),
    text: z.string().trim().min(1).max(20_000).optional(),
    userId: z.string().trim().max(128).optional(),
    agentId: z.string().trim().max(128).optional(),
    runId: z.string().trim().max(128).optional(),
    appId: z.string().trim().max(128).optional(),
    taskId: z.string().trim().max(128).optional(),
    visibility: memoryVisibilitySchema.optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** 导入请求体：ProjectExport 或 `{memories: [...]}`；条数上限在路由内校验。 */
export const importRequestSchema = z
  .object({
    format: z.string().trim().max(40).optional(),
    memories: z.array(z.unknown()),
  })
  .passthrough();
