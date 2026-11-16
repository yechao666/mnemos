import { APP_VERSION } from '../../../shared/src/constants.ts';
import type { AppContext } from '../contracts.ts';

/**
 * OpenAPI 3.1 文档生成器。
 *
 * 只输出纯 JSON（无函数 / 无 Date 实例），`JSON.parse(JSON.stringify(doc))` 恒成功。
 * `components.schemas` 与 `shared/src/types.ts` 的领域模型保持一致（camelCase）；
 * `/v1/*` 的 snake_case 适配在响应示例中通过 operation description 说明。
 */

type JsonObject = Record<string, unknown>;

const ERROR_CODES = [400, 401, 403, 404, 409, 422, 429, 500] as const;

const ERROR_DESCRIPTIONS: Record<(typeof ERROR_CODES)[number], string> = {
  400: '请求参数不合法（VALIDATION_ERROR / BAD_REQUEST / INVALID_JSON）',
  401: '未认证或凭证失效（UNAUTHORIZED / INVALID_API_KEY / API_KEY_REVOKED / KEY_EXPIRED / ACCOUNT_DISABLED）',
  403: '权限不足或来源 IP 不在白名单（FORBIDDEN / IP_NOT_ALLOWED）',
  404: '资源不存在（NOT_FOUND）',
  409: '状态或唯一性冲突（CONFLICT / IDEMPOTENCY_CONFLICT / IDEMPOTENCY_IN_PROGRESS / KEY_REVOKED）',
  422: '语义校验失败（UNPROCESSABLE）',
  429: '超出速率限制（RATE_LIMITED / QUOTA_EXCEEDED）',
  500: '服务器内部错误（INTERNAL_ERROR / ENGINE_ERROR）',
};

const CATEGORIES = [
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
];

const SOURCES = ['conversation', 'api', 'agent', 'import', 'playground', 'dream'];

const SCOPES = ['memories:read', 'memories:write', 'graph:read', 'admin'];

function ref(name: string): JsonObject {
  return { $ref: `#/components/schemas/${name}` };
}

function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  const schema: JsonObject = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function arrayOf(items: JsonObject, extra: JsonObject = {}): JsonObject {
  return { type: 'array', items, ...extra };
}

function jsonContent(schema: JsonObject): JsonObject {
  return { 'application/json': { schema } };
}

function jsonResponse(description: string, schema?: JsonObject): JsonObject {
  const response: JsonObject = { description };
  if (schema) response.content = jsonContent(schema);
  return response;
}

function errorResponse(status: (typeof ERROR_CODES)[number]): JsonObject {
  return jsonResponse(ERROR_DESCRIPTIONS[status], ref('Error'));
}

/** 成功响应 + 全部标准错误响应。 */
function withErrors(success: JsonObject): JsonObject {
  const responses: JsonObject = { ...success };
  for (const status of ERROR_CODES) responses[String(status)] = errorResponse(status);
  return responses;
}

function jsonBody(schema: JsonObject, required = true): JsonObject {
  return { required, content: jsonContent(schema) };
}

interface OperationInput {
  summary: string;
  description?: string;
  tags: string[];
  operationId: string;
  security?: JsonObject[];
  parameters?: JsonObject[];
  requestBody?: JsonObject;
  responses: JsonObject;
}

function operation(input: OperationInput): JsonObject {
  const result: JsonObject = {
    summary: input.summary,
    tags: input.tags,
    operationId: input.operationId,
    security: input.security ?? [],
    responses: input.responses,
  };
  if (input.description) result.description = input.description;
  if (input.parameters && input.parameters.length > 0) result.parameters = input.parameters;
  if (input.requestBody) result.requestBody = input.requestBody;
  return result;
}

function parameter(
  name: string,
  location: 'path' | 'query' | 'header',
  schema: JsonObject,
  description?: string,
  required = false,
): JsonObject {
  const result: JsonObject = {
    name,
    in: location,
    required: location === 'path' ? true : required,
    schema,
  };
  if (description) result.description = description;
  return result;
}

const ID_PARAM = parameter('id', 'path', { type: 'string' }, '资源 ID');
const KEY_ID_PARAM = parameter('keyId', 'path', { type: 'string' }, 'API Key ID');
const IDEMPOTENCY_PARAM = parameter(
  'Idempotency-Key',
  'header',
  { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
  '幂等键；同 key + 同请求体在 24h 内回放首次响应（响应头 x-idempotent-replayed: true）',
);

const API_KEY_SECURITY: JsonObject[] = [{ bearerApiKey: [] }];
const SESSION_SECURITY: JsonObject[] = [{ bearerSession: [] }];

/* ------------------------------------------------------------------ */
/* 组件 schema                                                         */
/* ------------------------------------------------------------------ */

const memorySchema = objectSchema(
  {
    id: { type: 'string' },
    projectId: { type: 'string' },
    userId: { type: ['string', 'null'] },
    agentId: { type: ['string', 'null'] },
    runId: { type: ['string', 'null'] },
    appId: { type: ['string', 'null'] },
    taskId: { type: ['string', 'null'] },
    visibility: { type: 'string', enum: ['project', 'agent', 'task'] },
    content: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    importance: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    source: { type: 'string', enum: SOURCES },
    status: { type: 'string', enum: ['active', 'archived', 'deleted'] },
    tags: arrayOf({ type: 'string' }),
    metadata: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    lastAccessedAt: { type: ['string', 'null'], format: 'date-time' },
    accessCount: { type: 'integer', minimum: 0 },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
  },
  [
    'id',
    'projectId',
    'visibility',
    'content',
    'category',
    'importance',
    'confidence',
    'source',
    'status',
    'tags',
    'metadata',
    'createdAt',
    'updatedAt',
    'accessCount',
  ],
);

const searchHitSchema: JsonObject = {
  allOf: [
    ref('Memory'),
    objectSchema(
      {
        score: { type: 'number' },
        signals: objectSchema({
          semantic: { type: 'number' },
          keyword: { type: 'number' },
          entity: { type: 'number' },
          recency: { type: 'number' },
          importance: { type: 'number' },
        }),
        matchedOn: arrayOf({ type: 'string' }),
        entities: arrayOf({ type: 'string' }),
      },
      ['score', 'signals', 'matchedOn', 'entities'],
    ),
  ],
};

const agentSchema = objectSchema(
  {
    id: { type: 'string' },
    projectId: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    model: { type: 'string' },
    description: { type: 'string' },
    capabilities: arrayOf({ type: 'string' }),
    status: { type: 'string', enum: ['active', 'idle', 'retired'] },
    metadata: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
    lastActiveAt: { type: ['string', 'null'], format: 'date-time' },
    stats: objectSchema(
      {
        memories: { type: 'integer', minimum: 0 },
        privateMemories: { type: 'integer', minimum: 0 },
        tasks: { type: 'integer', minimum: 0 },
        lastTaskAt: { type: ['string', 'null'], format: 'date-time' },
      },
      ['memories', 'privateMemories', 'tasks'],
    ),
  },
  ['id', 'projectId', 'name', 'role', 'model', 'description', 'capabilities', 'status', 'metadata', 'createdAt', 'stats'],
);

const taskSchema = objectSchema(
  {
    id: { type: 'string' },
    projectId: { type: 'string' },
    title: { type: 'string' },
    goal: { type: 'string' },
    status: { type: 'string', enum: ['open', 'active', 'done', 'abandoned'] },
    ownerAgentId: { type: ['string', 'null'] },
    ownerAgentName: { type: ['string', 'null'] },
    branch: { type: ['string', 'null'] },
    summary: { type: ['string', 'null'] },
    metadata: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
    startedAt: { type: 'string', format: 'date-time' },
    endedAt: { type: ['string', 'null'], format: 'date-time' },
    memoryCount: { type: 'integer', minimum: 0 },
    agentCount: { type: 'integer', minimum: 0 },
  },
  [
    'id',
    'projectId',
    'title',
    'goal',
    'status',
    'metadata',
    'createdAt',
    'startedAt',
    'memoryCount',
    'agentCount',
  ],
);

const briefingSectionSchema = objectSchema(
  {
    key: {
      type: 'string',
      enum: ['project', 'conventions', 'decisions', 'experience', 'incidents', 'agent_notes', 'open_tasks'],
    },
    title: { type: 'string' },
    description: { type: 'string' },
    hits: arrayOf(ref('SearchHit')),
  },
  ['key', 'title', 'description', 'hits'],
);

const briefingBriefSchema = objectSchema(
  {
    text: { type: 'string', description: '记忆简报正文（Markdown）' },
    maxChars: { type: 'integer', minimum: 100, maximum: 5000 },
    count: { type: 'integer', minimum: 0, description: '纳入简报的记忆条数' },
  },
  ['text', 'maxChars', 'count'],
);

const briefingSchema = objectSchema(
  {
    project: objectSchema(
      {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
      },
      ['id', 'name', 'description'],
    ),
    agent: { anyOf: [ref('Agent'), { type: 'null' }] },
    task: { anyOf: [ref('Task'), { type: 'null' }] },
    sections: arrayOf(ref('BriefingSection')),
    prompt: { type: 'string', description: '可直接注入 Agent system prompt 的 Markdown' },
    tokenEstimate: { type: 'integer', minimum: 0 },
    citations: arrayOf({ type: 'string' }),
    builtAt: { type: 'string', format: 'date-time' },
    tookMs: { type: 'number', minimum: 0 },
    brief: {
      anyOf: [ref('BriefingBrief'), { type: 'null' }],
      description: '记忆简报快照；项目关闭 briefEnabled 或无可用记忆时省略',
    },
  },
  ['project', 'sections', 'prompt', 'tokenEstimate', 'citations', 'builtAt', 'tookMs'],
);

const memoryBriefItemSchema = objectSchema(
  {
    id: { type: 'string' },
    content: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    importance: { type: 'number', minimum: 0, maximum: 1 },
    updatedAt: { type: 'string', format: 'date-time' },
    taskId: { type: 'string' },
    agentId: { type: 'string' },
  },
  ['id', 'content', 'category', 'importance', 'updatedAt'],
);

const memoryBriefSchema = objectSchema(
  {
    projectId: { type: 'string' },
    text: { type: 'string', description: '简报正文；暂无可用记忆时为空串' },
    maxChars: { type: 'integer', minimum: 100, maximum: 5000 },
    count: { type: 'integer', minimum: 0 },
    model: { type: 'string', description: 'mnemos-condense（确定性压缩）或实际 LLM 模型名' },
    cached: { type: 'boolean' },
    generatedAt: { type: 'string', format: 'date-time' },
    recent: arrayOf(ref('MemoryBriefItem')),
  },
  ['projectId', 'text', 'maxChars', 'count', 'model', 'cached', 'generatedAt', 'recent'],
);

const memoryDreamRunSchema = objectSchema(
  {
    id: { type: 'string' },
    projectId: { type: 'string' },
    trigger: { type: 'string', enum: ['schedule', 'manual'] },
    status: { type: 'string', enum: ['running', 'completed', 'skipped', 'failed'] },
    inputCount: { type: 'integer', minimum: 0 },
    insightCount: { type: 'integer', minimum: 0 },
    summary: { type: ['string', 'null'] },
    error: { type: ['string', 'null'] },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: ['string', 'null'], format: 'date-time' },
  },
  ['id', 'projectId', 'trigger', 'status', 'inputCount', 'insightCount', 'startedAt'],
);

const memoryDreamSettingsSchema = objectSchema(
  {
    enabled: { type: 'boolean' },
    intervalMinutes: { type: 'integer', minimum: 1, maximum: 43200 },
    lastAt: { type: ['string', 'null'], format: 'date-time' },
  },
  ['enabled', 'intervalMinutes'],
);

const memoryDreamStatusSchema = objectSchema(
  {
    settings: ref('MemoryDreamSettings'),
    pendingCount: { type: 'integer', minimum: 0, description: '尚未复盘总结的活跃记忆数' },
    lastRun: { anyOf: [ref('MemoryDreamRun'), { type: 'null' }] },
    runs: arrayOf(ref('MemoryDreamRun'), { description: '最近 10 次运行（新 → 旧）' }),
  },
  ['settings', 'pendingCount', 'runs'],
);

const apiKeySchema = objectSchema(
  {
    id: { type: 'string' },
    projectId: { type: 'string' },
    name: { type: 'string' },
    prefix: { type: 'string' },
    scopes: arrayOf({ type: 'string', enum: SCOPES }),
    createdBy: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    allowedIps: arrayOf({ type: 'string', description: '精确 IPv4 或 CIDR' }),
    rotatedFrom: { type: ['string', 'null'] },
    rotatedAt: { type: ['string', 'null'], format: 'date-time' },
    rateLimitPerMin: { type: 'integer', minimum: 1 },
  },
  ['id', 'projectId', 'name', 'prefix', 'scopes', 'createdBy', 'createdAt', 'allowedIps', 'rateLimitPerMin'],
);

const apiKeyWithSecretSchema: JsonObject = {
  allOf: [
    ref('ApiKey'),
    objectSchema({ secret: { type: 'string', description: '明文密钥，仅创建/轮换响应中返回一次' } }, ['secret']),
  ],
};

const orgSchema = objectSchema(
  {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    plan: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  ['id', 'name', 'slug', 'plan', 'createdAt'],
);

const userProperties: JsonObject = {
  id: { type: 'string' },
  orgId: { type: 'string' },
  email: { type: 'string', format: 'email' },
  name: { type: 'string' },
  role: { type: 'string', enum: ['owner', 'admin', 'developer', 'viewer'] },
  title: { type: 'string' },
  avatarColor: { type: 'string' },
  status: { type: 'string', enum: ['active', 'disabled'] },
  createdAt: { type: 'string', format: 'date-time' },
  lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
  lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
  passwordChangedAt: { type: ['string', 'null'], format: 'date-time' },
};

const userRequired = ['id', 'orgId', 'email', 'name', 'role', 'avatarColor', 'status', 'createdAt'];

const userSchema = objectSchema(userProperties, userRequired);

const orgUserSchema = objectSchema(
  {
    ...userProperties,
    projectCount: { type: 'integer', minimum: 0 },
    activeSessions: { type: 'integer', minimum: 0 },
  },
  [...userRequired, 'projectCount', 'activeSessions'],
);

const projectExportSchema = objectSchema(
  {
    format: { type: 'string', const: 'mnemos-export/v1' },
    exportedAt: { type: 'string', format: 'date-time' },
    project: objectSchema(
      {
        id: { type: 'string' },
        slug: { type: 'string' },
        name: { type: 'string' },
      },
      ['id', 'slug', 'name'],
    ),
    agents: arrayOf(ref('Agent')),
    tasks: arrayOf(ref('Task')),
    memories: arrayOf(ref('Memory')),
  },
  ['format', 'exportedAt', 'project', 'agents', 'tasks', 'memories'],
);

const errorSchema = objectSchema(
  {
    error: objectSchema(
      {
        code: { type: 'string', description: '稳定错误码' },
        message: { type: 'string', description: '可直接展示的中文文案' },
        details: { description: '可选的结构化细节（校验问题列表等）' },
        requestId: { type: 'string' },
      },
      ['code', 'message', 'requestId'],
    ),
  },
  ['error'],
);

/* ------------------------------------------------------------------ */
/* 常用响应体                                                          */
/* ------------------------------------------------------------------ */

const memoryWriteResponse = jsonResponse(
  '写入结果',
  objectSchema(
    {
      results: arrayOf(ref('Memory')),
      events: arrayOf(
        objectSchema({
          type: { type: 'string', enum: ['ADD', 'UPDATE', 'DELETE', 'MERGE', 'NOOP'] },
          memoryId: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
          at: { type: 'string', format: 'date-time' },
        }),
      ),
      tookMs: { type: 'number' },
    },
    ['results', 'events', 'tookMs'],
  ),
);

const memoryListResponse = jsonResponse(
  '分页结果',
  objectSchema(
    {
      results: arrayOf(ref('Memory')),
      count: { type: 'integer', minimum: 0 },
      page: { type: 'integer', minimum: 1 },
      page_size: { type: 'integer', minimum: 1 },
    },
    ['results', 'count', 'page', 'page_size'],
  ),
);

const searchResponse = jsonResponse(
  '检索结果',
  objectSchema(
    {
      results: arrayOf(ref('SearchHit')),
      took_ms: { type: 'number' },
      signals: objectSchema({
        weights: objectSchema({
          semantic: { type: 'number' },
          keyword: { type: 'number' },
          entity: { type: 'number' },
          recency: { type: 'number' },
        }),
        strategy: { type: 'string' },
        query_terms: arrayOf({ type: 'string' }),
      }),
    },
    ['results', 'took_ms'],
  ),
);

const addMemoryBodySchema = objectSchema(
  {
    messages: arrayOf(
      objectSchema(
        {
          role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
          content: { type: 'string' },
          name: { type: 'string' },
        },
        ['role', 'content'],
      ),
      { minItems: 1, maxItems: 50 },
    ),
    text: { type: 'string', maxLength: 20_000 },
    user_id: { type: 'string' },
    agent_id: { type: 'string' },
    run_id: { type: 'string' },
    app_id: { type: 'string' },
    task_id: { type: 'string' },
    visibility: { type: 'string', enum: ['project', 'agent', 'task'] },
    metadata: { type: 'object', additionalProperties: true },
    infer: { type: 'boolean', description: 'false（默认）原文入库；true 走事实抽取' },
    mode: { type: 'string', enum: ['additive', 'consolidate'] },
  },
  ['messages'],
);

const importResultSchema = objectSchema(
  {
    imported: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    errors: arrayOf(
      objectSchema({ index: { type: 'integer', minimum: 0 }, message: { type: 'string' } }, ['index', 'message']),
    ),
  },
  ['imported', 'skipped', 'failed', 'errors'],
);

const importResponse = jsonResponse('导入结果', importResultSchema);

/* ------------------------------------------------------------------ */
/* 文档                                                                */
/* ------------------------------------------------------------------ */

export function buildOpenApiDocument(app: AppContext): Record<string, unknown> {
  const serverUrl = `http://${app.env.host}:${app.env.port}`;

  const paths: Record<string, JsonObject> = {
    /* ---------------------------- v1 memories ---------------------------- */
    '/v1/memories': {
      post: operation({
        summary: '写入记忆',
        description:
          '写入一条或多条记忆。`messages` 与 `text` 二选一。支持 Idempotency-Key：同 key + 同请求体在 24h 内回放首次响应。',
        tags: ['Memories'],
        operationId: 'createMemory',
        security: API_KEY_SECURITY,
        parameters: [IDEMPOTENCY_PARAM],
        requestBody: jsonBody(addMemoryBodySchema),
        responses: withErrors({ 200: memoryWriteResponse }),
      }),
      get: operation({
        summary: '分页列出记忆',
        tags: ['Memories'],
        operationId: 'listMemories',
        security: API_KEY_SECURITY,
        parameters: [
          parameter('user_id', 'query', { type: 'string' }),
          parameter('agent_id', 'query', { type: 'string' }, '调用方 Agent 身份（可见性判定）'),
          parameter('run_id', 'query', { type: 'string' }),
          parameter('task_id', 'query', { type: 'string' }),
          parameter('visibility', 'query', { type: 'string', enum: ['project', 'agent', 'task'] }),
          parameter('category', 'query', { type: 'string', enum: CATEGORIES }),
          parameter('page', 'query', { type: 'integer', minimum: 1, default: 1 }),
          parameter('page_size', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 20 }),
        ],
        responses: withErrors({ 200: memoryListResponse }),
      }),
      delete: operation({
        summary: '按作用域批量删除记忆',
        description: '必须提供 user_id / agent_id / run_id 之一，并带 confirm=true，避免误删整个项目。',
        tags: ['Memories'],
        operationId: 'deleteMemoriesByScope',
        security: API_KEY_SECURITY,
        parameters: [
          parameter('user_id', 'query', { type: 'string' }),
          parameter('agent_id', 'query', { type: 'string' }),
          parameter('run_id', 'query', { type: 'string' }),
          parameter('confirm', 'query', { type: 'string', enum: ['true'] }, '显式确认', true),
        ],
        responses: withErrors({
          200: jsonResponse(
            '删除结果',
            objectSchema({ message: { type: 'string' }, deleted: { type: 'integer' } }, ['message', 'deleted']),
          ),
        }),
      }),
    },
    '/v1/memories/search': {
      post: operation({
        summary: '混合检索记忆',
        description: '语义 + 关键词 BM25 + 实体 + 时效融合排序。',
        tags: ['Memories'],
        operationId: 'searchMemories',
        security: API_KEY_SECURITY,
        requestBody: jsonBody(
          objectSchema(
            {
              query: { type: 'string', maxLength: 2000 },
              user_id: { type: 'string' },
              agent_id: { type: 'string' },
              run_id: { type: 'string' },
              app_id: { type: 'string' },
              task_id: { type: 'string' },
              visibility: { type: 'string', enum: ['project', 'agent', 'task'] },
              top_k: { type: 'integer', minimum: 1, maximum: 100 },
              threshold: { type: 'number', minimum: 0, maximum: 1 },
              filters: objectSchema({
                status: { type: 'string', enum: ['active', 'archived', 'deleted'] },
                category: { type: 'string', enum: CATEGORIES },
                tags: arrayOf({ type: 'string' }, { maxItems: 20 }),
                created_after: { type: 'string', format: 'date-time' },
                created_before: { type: 'string', format: 'date-time' },
                min_importance: { type: 'number', minimum: 0, maximum: 1 },
                metadata: { type: 'object', additionalProperties: true },
              }),
            },
            ['query'],
          ),
        ),
        responses: withErrors({ 200: searchResponse }),
      }),
    },
    '/v1/memories/batch': {
      post: operation({
        summary: '批量删除 / 归档 / 恢复记忆',
        tags: ['Memories'],
        operationId: 'batchMemories',
        security: API_KEY_SECURITY,
        requestBody: jsonBody(
          objectSchema(
            {
              action: { type: 'string', enum: ['delete', 'archive', 'restore'], default: 'delete' },
              ids: arrayOf({ type: 'string' }, { maxItems: 500 }),
              user_id: { type: 'string' },
              agent_id: { type: 'string' },
              run_id: { type: 'string' },
              confirm: { type: 'boolean' },
            },
            ['action', 'confirm'],
          ),
        ),
        responses: withErrors({
          200: jsonResponse(
            '批量结果',
            objectSchema({ message: { type: 'string' }, affected: { type: 'integer' } }, ['message', 'affected']),
          ),
        }),
      }),
    },
    '/v1/memories/{id}': {
      get: operation({
        summary: '记忆详情（含历史、实体与关系）',
        tags: ['Memories'],
        operationId: 'getMemory',
        security: API_KEY_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({
          200: jsonResponse('记忆详情', ref('Memory')),
        }),
      }),
      put: operation({
        summary: '更新记忆正文 / 分类 / 重要度',
        tags: ['Memories'],
        operationId: 'updateMemory',
        security: API_KEY_SECURITY,
        parameters: [ID_PARAM],
        requestBody: jsonBody(
          objectSchema({
            text: { type: 'string' },
            content: { type: 'string' },
            category: { type: 'string', enum: CATEGORIES },
            importance: { type: 'number', minimum: 0, maximum: 1 },
          }),
        ),
        responses: withErrors({
          200: jsonResponse('更新结果', objectSchema({ message: { type: 'string' } }, ['message'])),
        }),
      }),
      delete: operation({
        summary: '软删除记忆（写历史）',
        tags: ['Memories'],
        operationId: 'deleteMemory',
        security: API_KEY_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({
          200: jsonResponse('删除结果', objectSchema({ message: { type: 'string' } }, ['message'])),
        }),
      }),
    },
    '/v1/memories/{id}/history': {
      get: operation({
        summary: '记忆变更历史',
        tags: ['Memories'],
        operationId: 'getMemoryHistory',
        security: API_KEY_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({
          200: jsonResponse(
            '历史记录',
            objectSchema({ results: arrayOf(objectSchema({})) }, ['results']),
          ),
        }),
      }),
    },
    '/v1/memories/{id}/feedback': {
      post: operation({
        summary: '记忆反馈（调整重要度）',
        tags: ['Memories'],
        operationId: 'feedbackMemory',
        security: API_KEY_SECURITY,
        parameters: [ID_PARAM],
        requestBody: jsonBody(
          objectSchema(
            {
              helpful: { type: 'boolean' },
              query: { type: 'string', maxLength: 2000 },
            },
            ['helpful'],
          ),
        ),
        responses: withErrors({ 200: jsonResponse('更新后的记忆', ref('Memory')) }),
      }),
    },

    /* ------------------------------ v1 agents ----------------------------- */
    '/v1/agents': {
      get: operation({
        summary: 'Agent 注册表',
        tags: ['Agents'],
        operationId: 'listAgents',
        security: API_KEY_SECURITY,
        responses: withErrors({
          200: jsonResponse(
            'Agent 列表',
            objectSchema({ results: arrayOf(ref('Agent')), count: { type: 'integer' } }, ['results', 'count']),
          ),
        }),
      }),
      post: operation({
        summary: '注册 Agent',
        tags: ['Agents'],
        operationId: 'createAgent',
        security: API_KEY_SECURITY,
        requestBody: jsonBody(
          objectSchema(
            {
              name: { type: 'string', maxLength: 120 },
              role: { type: 'string' },
              model: { type: 'string' },
              description: { type: 'string' },
              capabilities: arrayOf({ type: 'string' }, { maxItems: 30 }),
              status: { type: 'string', enum: ['active', 'idle', 'retired'] },
            },
            ['name'],
          ),
        ),
        responses: withErrors({ 200: jsonResponse('新建的 Agent', ref('Agent')) }),
      }),
    },

    /* ------------------------------ v1 tasks ------------------------------ */
    '/v1/tasks': {
      get: operation({
        summary: '任务会话列表',
        tags: ['Tasks'],
        operationId: 'listTasks',
        security: API_KEY_SECURITY,
        parameters: [
          parameter('status', 'query', { type: 'string', enum: ['open', 'active', 'done', 'abandoned'] }),
          parameter('agent_id', 'query', { type: 'string' }),
          parameter('limit', 'query', { type: 'integer', minimum: 1, maximum: 200 }),
        ],
        responses: withErrors({
          200: jsonResponse(
            '任务列表',
            objectSchema({ results: arrayOf(ref('Task')), count: { type: 'integer' } }, ['results', 'count']),
          ),
        }),
      }),
      post: operation({
        summary: '开始任务会话',
        description: '支持 Idempotency-Key。',
        tags: ['Tasks'],
        operationId: 'createTask',
        security: API_KEY_SECURITY,
        parameters: [IDEMPOTENCY_PARAM],
        requestBody: jsonBody(
          objectSchema(
            {
              title: { type: 'string', maxLength: 300 },
              goal: { type: 'string', maxLength: 4000 },
              owner_agent_id: { type: 'string' },
              branch: { type: 'string' },
              status: { type: 'string', enum: ['open', 'active', 'done', 'abandoned'] },
            },
            ['title'],
          ),
        ),
        responses: withErrors({ 200: jsonResponse('新建的任务', ref('Task')) }),
      }),
    },
    '/v1/tasks/{id}': {
      get: operation({
        summary: '任务详情',
        tags: ['Tasks'],
        operationId: 'getTask',
        security: API_KEY_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({ 200: jsonResponse('任务', ref('Task')) }),
      }),
    },
    '/v1/tasks/{id}/finish': {
      post: operation({
        summary: '结束任务并沉淀决策 / 经验 / 备注',
        description: '支持 Idempotency-Key；decisions → fact、lessons → constraint、notes → event。',
        tags: ['Tasks'],
        operationId: 'finishTask',
        security: API_KEY_SECURITY,
        parameters: [ID_PARAM, IDEMPOTENCY_PARAM],
        requestBody: jsonBody(
          objectSchema({
            status: { type: 'string', enum: ['done', 'abandoned'] },
            summary: { type: 'string', maxLength: 8000 },
            decisions: arrayOf({ type: 'string' }, { maxItems: 50 }),
            lessons: arrayOf({ type: 'string' }, { maxItems: 50 }),
            notes: arrayOf({ type: 'string' }, { maxItems: 50 }),
            agent_id: { type: 'string' },
          }),
        ),
        responses: withErrors({
          200: jsonResponse(
            '任务与沉淀的记忆',
            objectSchema({ task: ref('Task'), memories: arrayOf(ref('Memory')) }, ['task', 'memories']),
          ),
        }),
      }),
    },

    /* ----------------------------- v1 context ----------------------------- */
    '/v1/context': {
      post: operation({
        summary: '任务简报（可直接注入 system prompt）',
        tags: ['Context'],
        operationId: 'buildBriefing',
        security: API_KEY_SECURITY,
        requestBody: jsonBody(
          objectSchema({
            agent_id: { type: 'string' },
            task_id: { type: 'string' },
            query: { type: 'string', maxLength: 500 },
            budget_tokens: { type: 'integer', minimum: 60, maximum: 8000 },
          }),
        ),
        responses: withErrors({ 200: jsonResponse('任务简报', ref('Briefing')) }),
      }),
    },

    /* ------------------------------ v1 graph ------------------------------ */
    '/v1/graph': {
      get: operation({
        summary: '实体关系图谱',
        tags: ['Graph'],
        operationId: 'getGraph',
        security: API_KEY_SECURITY,
        parameters: [
          parameter('user_id', 'query', { type: 'string' }),
          parameter('limit', 'query', { type: 'integer', minimum: 1, maximum: 400, default: 120 }),
        ],
        responses: withErrors({
          200: jsonResponse(
            '图谱数据',
            objectSchema({
              nodes: arrayOf(
                objectSchema({
                  id: { type: 'string' },
                  label: { type: 'string' },
                  type: { type: 'string' },
                  weight: { type: 'number' },
                  memories: { type: 'integer' },
                }),
              ),
              edges: arrayOf(
                objectSchema({
                  id: { type: 'string' },
                  source: { type: 'string' },
                  target: { type: 'string' },
                  relation: { type: 'string' },
                  weight: { type: 'number' },
                }),
              ),
            }),
          ),
        }),
      }),
    },

    /* ------------------------------ v1 stats ------------------------------ */
    '/v1/stats': {
      get: operation({
        summary: '项目指标',
        tags: ['Stats'],
        operationId: 'getStats',
        security: API_KEY_SECURITY,
        responses: withErrors({
          200: jsonResponse(
            '项目指标',
            objectSchema({
              metrics: objectSchema({
                total_memories: { type: 'integer' },
                users: { type: 'integer' },
                agents: { type: 'integer' },
                entities: { type: 'integer' },
                relations: { type: 'integer' },
                searches_7d: { type: 'integer' },
                adds_7d: { type: 'integer' },
                tokens_saved: { type: 'integer' },
                storage_bytes: { type: 'integer' },
                quota_used_pct: { type: 'number' },
                recall_p50_ms: { type: 'number' },
                recall_p95_ms: { type: 'number' },
                hit_rate: { type: 'number' },
                growth_pct: { type: 'number' },
              }),
            }),
          ),
        }),
      }),
    },

    /* ----------------------------- v1 health ------------------------------ */
    '/v1/health': {
      get: operation({
        summary: '健康检查（无需认证）',
        tags: ['Stats'],
        operationId: 'health',
        responses: withErrors({
          200: jsonResponse(
            '健康状态',
            objectSchema(
              { ok: { type: 'boolean' }, version: { type: 'string' }, uptime_ms: { type: 'integer' } },
              ['ok', 'version', 'uptime_ms'],
            ),
          ),
        }),
      }),
    },

    /* -------------------------- v1 export / import ------------------------ */
    '/v1/export': {
      get: operation({
        summary: '导出项目全量数据',
        description: 'active + archived（不含 deleted），上限 50,000 条记忆；超出返回 413 export_too_large。',
        tags: ['Data'],
        operationId: 'exportProject',
        security: API_KEY_SECURITY,
        parameters: [
          parameter('format', 'query', { type: 'string', enum: ['json'], default: 'json' }),
        ],
        responses: withErrors({ 200: jsonResponse('项目导出文档', ref('ProjectExport')) }),
      }),
    },
    '/v1/import': {
      post: operation({
        summary: '导入记忆',
        description:
          '请求体为 ProjectExport 或 `{memories:[...]}`，单次最多 1000 条；重复内容按 consolidate 语义计入 skipped。请求体上限 8MB。',
        tags: ['Data'],
        operationId: 'importMemories',
        security: API_KEY_SECURITY,
        requestBody: jsonBody(
          objectSchema(
            {
              format: { type: 'string', const: 'mnemos-export/v1' },
              memories: arrayOf(ref('Memory'), { maxItems: 1000 }),
            },
            ['memories'],
          ),
        ),
        responses: withErrors({ 200: importResponse }),
      }),
    },

    /* ------------------------------- /api auth ---------------------------- */
    '/api/auth/login': {
      post: operation({
        summary: '控制台登录',
        tags: ['Auth'],
        operationId: 'login',
        requestBody: jsonBody(
          objectSchema({ email: { type: 'string', format: 'email' }, password: { type: 'string' } }, [
            'email',
            'password',
          ]),
        ),
        responses: withErrors({
          200: jsonResponse(
            '登录结果',
            objectSchema({ token: { type: 'string' }, user: ref('User'), org: ref('Org') }, ['token', 'user', 'org']),
          ),
        }),
      }),
    },
    '/api/auth/logout': {
      post: operation({
        summary: '注销当前会话',
        tags: ['Auth'],
        operationId: 'logout',
        security: SESSION_SECURITY,
        responses: withErrors({
          200: jsonResponse('注销结果', objectSchema({ ok: { type: 'boolean' } }, ['ok'])),
        }),
      }),
    },
    '/api/auth/me': {
      get: operation({
        summary: '当前用户、组织与可见项目',
        tags: ['Auth'],
        operationId: 'currentUser',
        security: SESSION_SECURITY,
        responses: withErrors({
          200: jsonResponse(
            '当前身份',
            objectSchema({
              user: ref('User'),
              org: ref('Org'),
              projects: arrayOf(objectSchema({ id: { type: 'string' }, name: { type: 'string' } })),
            }),
          ),
        }),
      }),
    },
    '/api/auth/demo-accounts': {
      get: operation({
        summary: '演示账号（仅 demo 模式）',
        tags: ['Auth'],
        operationId: 'demoAccounts',
        responses: withErrors({ 200: jsonResponse('演示账号列表', arrayOf(objectSchema({})) ) }),
      }),
    },

    /* -------------------------------- /api ops ---------------------------- */
    '/api/ops/status': {
      get: operation({
        summary: '运行状态（数据库 / 队列 / 指标）',
        tags: ['Ops'],
        operationId: 'opsStatus',
        security: SESSION_SECURITY,
        responses: withErrors({ 200: jsonResponse('运行状态', objectSchema({})) }),
      }),
    },
    '/api/ops/maintenance': {
      get: operation({
        summary: '维护历史（admin+）',
        tags: ['Ops'],
        operationId: 'listMaintenanceRuns',
        security: SESSION_SECURITY,
        parameters: [parameter('limit', 'query', { type: 'integer', minimum: 1, maximum: 100 })],
        responses: withErrors({ 200: jsonResponse('维护运行记录', arrayOf(objectSchema({}))) }),
      }),
      post: operation({
        summary: '执行维护任务',
        tags: ['Ops'],
        operationId: 'opsMaintenance',
        security: SESSION_SECURITY,
        requestBody: jsonBody(
          objectSchema({ dryRun: { type: 'boolean' }, vacuum: { type: 'boolean' } }, []),
          false,
        ),
        responses: withErrors({ 200: jsonResponse('维护结果', objectSchema({})) }),
      }),
    },
    '/api/ops/backups': {
      get: operation({
        summary: '备份列表',
        tags: ['Ops'],
        operationId: 'listBackups',
        security: SESSION_SECURITY,
        responses: withErrors({ 200: jsonResponse('备份列表', arrayOf(objectSchema({}))) }),
      }),
    },
    '/api/ops/backup': {
      post: operation({
        summary: '创建备份',
        tags: ['Ops'],
        operationId: 'createBackup',
        security: SESSION_SECURITY,
        requestBody: jsonBody(objectSchema({}), false),
        responses: withErrors({ 200: jsonResponse('备份信息', objectSchema({})) }),
      }),
    },

    /* -------------------------------- /api org ---------------------------- */
    '/api/org/users': {
      get: operation({
        summary: '组织成员列表（admin+）',
        tags: ['Org'],
        operationId: 'listOrgUsers',
        security: SESSION_SECURITY,
        responses: withErrors({ 200: jsonResponse('成员列表', arrayOf(ref('OrgUser'))) }),
      }),
      post: operation({
        summary: '创建成员（admin+；admin/owner 角色仅 owner）',
        description: '缺省密码时生成 16 位临时密码并在响应中返回一次。',
        tags: ['Org'],
        operationId: 'createOrgUser',
        security: SESSION_SECURITY,
        requestBody: jsonBody(
          objectSchema(
            {
              email: { type: 'string', format: 'email' },
              name: { type: 'string', maxLength: 80 },
              role: { type: 'string', enum: ['owner', 'admin', 'developer', 'viewer'] },
              title: { type: 'string', maxLength: 80 },
              password: { type: 'string', minLength: 8 },
            },
            ['email', 'name', 'role'],
          ),
        ),
        responses: withErrors({
          200: jsonResponse(
            '创建结果',
            objectSchema({ user: ref('OrgUser'), temporaryPassword: { type: 'string' } }, [
              'user',
              'temporaryPassword',
            ]),
          ),
        }),
      }),
    },
    '/api/org/users/{id}': {
      patch: operation({
        summary: '更新成员（角色/禁用仅 owner）',
        tags: ['Org'],
        operationId: 'updateOrgUser',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        requestBody: jsonBody(
          objectSchema({
            role: { type: 'string', enum: ['owner', 'admin', 'developer', 'viewer'] },
            status: { type: 'string', enum: ['active', 'disabled'] },
            title: { type: 'string', maxLength: 80 },
            name: { type: 'string', maxLength: 80 },
          }),
        ),
        responses: withErrors({ 200: jsonResponse('更新后的成员', ref('OrgUser')) }),
      }),
      delete: operation({
        summary: '删除成员（仅 owner）',
        tags: ['Org'],
        operationId: 'deleteOrgUser',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({
          200: jsonResponse('删除结果', objectSchema({ ok: { type: 'boolean' } }, ['ok'])),
        }),
      }),
    },
    '/api/org/users/{id}/reset-password': {
      post: operation({
        summary: '重置成员密码（admin+；owner 仅 owner）',
        tags: ['Org'],
        operationId: 'resetOrgUserPassword',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({
          200: jsonResponse(
            '重置结果',
            objectSchema({ userId: { type: 'string' }, temporaryPassword: { type: 'string' } }, [
              'userId',
              'temporaryPassword',
            ]),
          ),
        }),
      }),
    },

    /* ---------------------------- /api 记忆简报 / 复盘总结 -------------------- */
    '/api/projects/{id}/memory/brief': {
      get: operation({
        summary: '记忆简报预览（viewer+）',
        description:
          '取最近活跃记忆/洞见压缩成有字符上限的 Markdown；默认包含全部 Agent 私有记忆并允许 LLM 润色（失败自动回退确定性文本）。',
        tags: ['Memory Insights'],
        operationId: 'getMemoryBrief',
        security: SESSION_SECURITY,
        parameters: [
          ID_PARAM,
          parameter('force', 'query', { type: 'boolean' }, '忽略缓存重新生成'),
          parameter('agentId', 'query', { type: 'string' }, '按该 Agent 可见性生成（不传则仅项目共享记忆）'),
          parameter('maxChars', 'query', { type: 'integer', minimum: 100, maximum: 5000 }, '覆盖项目设置的字数上限'),
        ],
        responses: withErrors({ 200: jsonResponse('记忆简报', ref('MemoryBrief')) }),
      }),
      patch: operation({
        summary: '保存记忆简报字数上限（admin+）',
        description: '写入项目 settings.briefMaxChars（100–5000）后立即重新生成一次并返回最新简报。',
        tags: ['Memory Insights'],
        operationId: 'updateMemoryBriefSettings',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        requestBody: jsonBody(objectSchema({ maxChars: { type: 'integer', minimum: 100, maximum: 5000 } }, ['maxChars'])),
        responses: withErrors({ 200: jsonResponse('更新后的记忆简报', ref('MemoryBrief')) }),
      }),
    },
    '/api/projects/{id}/memory/dream': {
      get: operation({
        summary: '记忆复盘总结状态（viewer+）',
        tags: ['Memory Insights'],
        operationId: 'getMemoryDreamStatus',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({ 200: jsonResponse('复盘总结状态', ref('MemoryDreamStatus')) }),
      }),
      patch: operation({
        summary: '配置记忆复盘总结（admin+）',
        description: 'enabled / intervalMinutes 至少提供一个；写入项目 settings。',
        tags: ['Memory Insights'],
        operationId: 'updateMemoryDreamSettings',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        requestBody: jsonBody(
          objectSchema({
            enabled: { type: 'boolean' },
            intervalMinutes: { type: 'integer', minimum: 1, maximum: 43200 },
          }),
        ),
        responses: withErrors({ 200: jsonResponse('复盘总结状态', ref('MemoryDreamStatus')) }),
      }),
    },
    '/api/projects/{id}/memory/dream/run': {
      post: operation({
        summary: '手动触发一次增量复盘总结（admin+）',
        description: '该项目正在复盘总结时返回 409 CONFLICT；成功返回运行记录与最新状态。',
        tags: ['Memory Insights'],
        operationId: 'runMemoryDream',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({
          200: jsonResponse(
            '复盘总结结果',
            objectSchema(
              {
                run: ref('MemoryDreamRun'),
                status: ref('MemoryDreamStatus'),
              },
              ['run', 'status'],
            ),
          ),
        }),
      }),
    },

    /* ---------------------------- /api 项目数据 --------------------------- */
    '/api/projects/{id}/export': {
      get: operation({
        summary: '导出项目数据（viewer+）',
        tags: ['Data'],
        operationId: 'exportProjectConsole',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({ 200: jsonResponse('项目导出文档', ref('ProjectExport')) }),
      }),
    },
    '/api/projects/{id}/import': {
      post: operation({
        summary: '导入记忆（developer+）',
        description: '请求体为 ProjectExport 或 `{memories:[...]}`，单次最多 1000 条；上限 8MB。',
        tags: ['Data'],
        operationId: 'importProjectConsole',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        requestBody: jsonBody(
          objectSchema(
            {
              format: { type: 'string', const: 'mnemos-export/v1' },
              memories: arrayOf(ref('Memory'), { maxItems: 1000 }),
            },
            ['memories'],
          ),
        ),
        responses: withErrors({ 200: importResponse }),
      }),
    },

    /* ---------------------------- /api 密钥生命周期 ----------------------- */
    '/api/projects/{id}/keys': {
      get: operation({
        summary: 'API Key 列表（admin+）',
        tags: ['Keys'],
        operationId: 'listApiKeys',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        responses: withErrors({ 200: jsonResponse('密钥列表', arrayOf(ref('ApiKey'))) }),
      }),
      post: operation({
        summary: '创建 API Key（admin+）',
        description: '明文 secret 仅返回一次；可设置未来过期时间与 IP 白名单。',
        tags: ['Keys'],
        operationId: 'createApiKey',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM],
        requestBody: jsonBody(
          objectSchema(
            {
              name: { type: 'string', maxLength: 80 },
              scopes: arrayOf({ type: 'string', enum: SCOPES }, { minItems: 1, maxItems: 4 }),
              rateLimitPerMin: { type: 'integer', minimum: 1, maximum: 100000 },
              expiresAt: { type: 'string', format: 'date-time', description: '必须是未来时间' },
              allowedIps: arrayOf({ type: 'string', description: '精确 IPv4 或 CIDR' }, { maxItems: 20 }),
            },
            ['name', 'scopes'],
          ),
        ),
        responses: withErrors({ 201: jsonResponse('新密钥（含明文）', ref('ApiKeyWithSecret')) }),
      }),
    },
    '/api/projects/{id}/keys/{keyId}': {
      delete: operation({
        summary: '吊销 API Key（admin+）',
        tags: ['Keys'],
        operationId: 'revokeApiKey',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM, KEY_ID_PARAM],
        responses: withErrors({
          200: jsonResponse('吊销结果', objectSchema({ ok: { type: 'boolean' } }, ['ok'])),
        }),
      }),
    },
    '/api/projects/{id}/keys/{keyId}/rotate': {
      post: operation({
        summary: '轮换 API Key（admin+）',
        description:
          '生成同 scopes / 同限流 / 继承过期与 IP 白名单的新密钥；旧密钥在 graceHours=0 时立即吊销，否则保留至 now+graceHours。',
        tags: ['Keys'],
        operationId: 'rotateApiKey',
        security: SESSION_SECURITY,
        parameters: [ID_PARAM, KEY_ID_PARAM],
        requestBody: jsonBody(
          objectSchema(
            { graceHours: { type: 'integer', minimum: 0, maximum: 168, default: 0 } },
            [],
          ),
          false,
        ),
        responses: withErrors({
          201: jsonResponse('新密钥（含明文）', ref('ApiKeyWithSecret')),
        }),
      }),
    },
  };

  const schemas: Record<string, JsonObject> = {
    Memory: memorySchema,
    Agent: agentSchema,
    Task: taskSchema,
    Briefing: briefingSchema,
    BriefingSection: briefingSectionSchema,
    BriefingBrief: briefingBriefSchema,
    MemoryBrief: memoryBriefSchema,
    MemoryBriefItem: memoryBriefItemSchema,
    MemoryDreamRun: memoryDreamRunSchema,
    MemoryDreamSettings: memoryDreamSettingsSchema,
    MemoryDreamStatus: memoryDreamStatusSchema,
    SearchHit: searchHitSchema,
    Error: errorSchema,
    ApiKey: apiKeySchema,
    ApiKeyWithSecret: apiKeyWithSecretSchema,
    Org: orgSchema,
    User: userSchema,
    OrgUser: orgUserSchema,
    ProjectExport: projectExportSchema,
  };

  const securitySchemes: Record<string, JsonObject> = {
    bearerApiKey: {
      type: 'http',
      scheme: 'bearer',
      description: '项目级 API Key：`Authorization: Bearer mnemos_live_…`',
    },
    bearerSession: {
      type: 'http',
      scheme: 'bearer',
      description: '控制台会话令牌：`Authorization: Bearer <session token>`',
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Mnemos API',
      version: APP_VERSION,
      description:
        'Mnemos 企业级 AI 记忆基础设施 API。`/v1/*` 面向 Agent/SDK（API Key 鉴权、snake_case），`/api/*` 面向控制台（会话鉴权、camelCase）。',
      license: { name: 'Proprietary' },
    },
    servers: [{ url: serverUrl, description: '当前部署' }],
    tags: [
      { name: 'Memories', description: '记忆写入、检索、更新与删除' },
      { name: 'Agents', description: 'Agent 注册表' },
      { name: 'Tasks', description: '任务会话与结束沉淀' },
      { name: 'Context', description: '任务简报 / 上下文注入' },
      { name: 'Graph', description: '实体关系图谱' },
      { name: 'Stats', description: '项目指标与健康检查' },
      { name: 'Data', description: '项目导出与导入' },
      { name: 'Auth', description: '控制台登录与会话' },
      { name: 'Ops', description: '生产运维（维护、备份、状态）' },
      { name: 'Org', description: '组织成员管理' },
      { name: 'Keys', description: 'API Key 生命周期' },
    ],
    paths,
    components: { securitySchemes, schemas },
  };
}
