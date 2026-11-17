/**
 * MCP 工具与 resources 定义/实现。
 *
 * 工具：mnemos_search / mnemos_add / mnemos_brief / mnemos_context /
 *       mnemos_person / mnemos_profile / mnemos_status
 * 资源：mnemos://partition/<partition>/stats
 *       mnemos://person/<person>/brief
 *       mnemos://person/<person>/profile
 *
 * 所有 handler 都是 `async (args, ctx) => MCP result`；可预期的失败抛 `ToolError`
 * （server 会转成 `{content, isError:true}`），不会崩溃进程。
 */

import {
  MnemosHttpError,
  compact,
  partitionPath,
  personPath,
  seg,
} from './client.js';

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

const PERSON_PROP = {
  type: 'string',
  description: '人的 external_id；缺省 MNEMOS_PERSON（默认 dsh-agent）',
};

const PARTITION_PROP = {
  type: 'string',
  description: '分区（id 或 slug）；缺省 MNEMOS_PARTITION',
};

function resolvePartition(args, config) {
  const partition = (args && args.partition) || config.partition;
  if (!partition) {
    throw new ToolError('未配置分区：请设置环境变量 MNEMOS_PARTITION，或在参数里传 partition');
  }
  return partition;
}

function resolvePerson(args, config) {
  return (args && args.person) || config.person || 'dsh-agent';
}

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function textResult(text, metadata) {
  const content = [{ type: 'text', text: text || '(空)' }];
  if (metadata !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(metadata, null, 2) });
  }
  return { content };
}

function humanError(error) {
  if (error instanceof MnemosHttpError) {
    const bits = [`Mnemos 请求失败（${error.status ?? 'network'} ${error.code}）`];
    if (error.message) bits.push(error.message);
    if (error.requestId) bits.push(`request_id=${error.requestId}`);
    if (error.details) bits.push(JSON.stringify(error.details));
    return bits.join('：');
  }
  if (error && error.name === 'MnemosNetworkError') {
    return `Mnemos 连接失败：${error.message}`;
  }
  return error?.message || String(error);
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

export const TOOL_DEFINITIONS = [
  {
    name: 'mnemos_search',
    description:
      '检索 Mnemos 记忆（默认按人 + 分区共享，hybrid=关键词+向量+时效+重要度），返回带 score 与 signals 的命中。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词（1–2000 字符）' },
        person: PERSON_PROP,
        all_people: { type: 'boolean', description: 'true 时不按人过滤（分区范围检索）' },
        scope: { type: 'string', enum: ['person', 'partition', 'session'], description: '可见范围过滤' },
        category: { type: 'string', description: '记忆分类过滤（如 preference/fact/decision）' },
        mode: { type: 'string', enum: ['hybrid', 'keyword', 'vector'], description: '检索模式，默认 hybrid' },
        top_k: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 8' },
        as_of: { type: 'string', description: 'ISO 时间：回看当时有效的事实（P1）' },
        include_superseded: { type: 'boolean', description: '是否包含已被取代的记忆（默认 false）' },
        partition: PARTITION_PROP,
      },
      required: ['query'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const partition = resolvePartition(args, ctx.config);
      const body = compact({
        query: args.query,
        person_external_id: args.all_people ? undefined : args.person || ctx.config.person,
        scope: args.scope,
        category: args.category,
        mode: args.mode,
        top_k: args.top_k,
        as_of: args.as_of,
        include_superseded: args.include_superseded,
      });
      const response = await ctx.client.post(`${partitionPath(partition)}/memories/search`, body);
      return jsonResult(response);
    },
  },
  {
    name: 'mnemos_add',
    description:
      '写入一条记忆（原文入库）。重复内容返回 NOOP、相似内容 MERGE、同 fact_key/supersedes_id 会取代旧记忆；未知人会自动建档。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆正文（与 text/messages 至少一个）' },
        text: { type: 'string', description: '记忆正文（content 的别名）' },
        messages: {
          type: 'array',
          description: '对话式写入 [{role,content}]；system 消息被忽略',
          items: {
            type: 'object',
            properties: { role: { type: 'string' }, content: { type: 'string' } },
            required: ['role', 'content'],
          },
        },
        person: PERSON_PROP,
        person_type: { type: 'string', enum: ['human', 'agent', 'service', 'other'], description: '未知人建档时的类型，默认 agent' },
        display_name: { type: 'string', description: '未知人建档时的展示名' },
        scope: { type: 'string', enum: ['person', 'partition', 'session'], description: '可见范围；缺省取分区设置' },
        session_id: { type: 'string', description: 'scope=session 时必填' },
        session_title: { type: 'string' },
        category: { type: 'string', description: '记忆分类（默认 fact）' },
        importance: { type: 'number', minimum: 0, maximum: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（≤20 个）' },
        metadata: { type: 'object', description: '自由 JSON 元数据' },
        expires_at: { type: 'string', description: '过期时间（ISO）' },
        supersedes_id: { type: 'string', description: '显式取代某条记忆（旧记忆 valid_to=now）' },
        fact_key: { type: 'string', description: '槽位键（如 preference.language）；同键旧记忆自动失效' },
        idempotency_key: { type: 'string', description: '写请求幂等键（24h 内相同 key+body 返回首次响应）' },
        partition: PARTITION_PROP,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const partition = resolvePartition(args, ctx.config);
      const person = resolvePerson(args, ctx.config);
      const body = compact({
        text: args.text,
        content: args.content,
        messages: args.messages,
        scope: args.scope,
        session_id: args.session_id,
        session_title: args.session_title,
        category: args.category,
        importance: args.importance,
        confidence: args.confidence,
        tags: args.tags,
        metadata: args.metadata,
        expires_at: args.expires_at,
        supersedes_id: args.supersedes_id,
        fact_key: args.fact_key,
      });
      if (!body.text && !body.content && !body.messages) {
        throw new ToolError('mnemos_add：content / text / messages 至少提供一个');
      }
      const path = `${personPath(partition, person)}/memories`;
      const options = args.idempotency_key
        ? { headers: { 'idempotency-key': String(args.idempotency_key) } }
        : {};
      try {
        return jsonResult(await ctx.client.post(path, body, options));
      } catch (error) {
        // v1 人级写入要求人已存在：404 时先懒建档再重试一次。
        if (error instanceof MnemosHttpError && error.status === 404) {
          await ctx.client.put(personPath(partition, person), {
            type: args.person_type || 'agent',
            display_name: args.display_name,
          });
          return jsonResult(await ctx.client.post(path, body, options));
        }
        throw error;
      }
    },
  },
  {
    name: 'mnemos_brief',
    description: '读取人的记忆简报（最近的本人记忆 + 相关分区共享，压缩成可注入提示词的文本）。',
    inputSchema: {
      type: 'object',
      properties: {
        person: PERSON_PROP,
        max_chars: { type: 'integer', minimum: 100, maximum: 5000, description: '字符上限' },
        force: { type: 'boolean', description: 'true 跳过缓存重算' },
        partition: PARTITION_PROP,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const partition = resolvePartition(args, ctx.config);
      const person = resolvePerson(args, ctx.config);
      const brief = await ctx.client.get(`${personPath(partition, person)}/brief`, {
        query: compact({ max_chars: args.max_chars, force: args.force }),
      });
      return textResult(brief?.text, {
        partition,
        person,
        count: brief?.count,
        max_chars: brief?.max_chars,
        model: brief?.model,
        cached: brief?.cached,
        generated_at: brief?.generated_at,
      });
    },
  },
  {
    name: 'mnemos_context',
    description: '装配人的上下文（资料 + 简报 + 相关记忆 + 分区共享知识），返回可直接注入提示词的 prompt。',
    inputSchema: {
      type: 'object',
      properties: {
        person: PERSON_PROP,
        query: { type: 'string', description: '可选检索词，用于挑选相关记忆' },
        budget_tokens: { type: 'integer', minimum: 60, maximum: 32000, description: 'token 预算，默认 2000' },
        include_partition: { type: 'boolean', description: '是否带分区共享知识（默认 true）' },
        partition: PARTITION_PROP,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const partition = resolvePartition(args, ctx.config);
      const person = resolvePerson(args, ctx.config);
      const context = await ctx.client.post(`${personPath(partition, person)}/context`, compact({
        query: args.query,
        budget_tokens: args.budget_tokens,
        include_partition: args.include_partition,
      }));
      return textResult(context?.prompt, {
        partition,
        person,
        token_estimate: context?.token_estimate,
        citations: context?.citations,
        memory_count: context?.memories?.length,
        shared_count: context?.shared?.length,
        built_at: context?.built_at,
      });
    },
  },
  {
    name: 'mnemos_person',
    description: '人的读取与管理：get 详情 / list 游标列表 / upsert 建档 / update 更新。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'list', 'upsert', 'update'], description: '操作' },
        person: { type: 'string', description: '人的 id 或 external_id（get/update 用）' },
        external_id: { type: 'string', description: 'upsert 的 external_id（缺省用 person）' },
        type: { type: 'string', enum: ['human', 'agent', 'service', 'other'] },
        display_name: { type: 'string' },
        attributes: { type: 'object' },
        status: { type: 'string', enum: ['active', 'archived', 'deleted'] },
        q: { type: 'string', description: 'list 搜索（external_id / 展示名）' },
        sort: { type: 'string', enum: ['recent', 'new', 'name'], description: 'list 排序，默认 recent' },
        cursor: { type: 'string', description: 'list 游标：传上一页 next_cursor' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        include_merged: { type: 'boolean', description: 'list 是否包含已合并到他人的源人' },
        partition: PARTITION_PROP,
      },
      required: ['action'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const partition = resolvePartition(args, ctx.config);
      const action = args.action;
      if (action === 'list') {
        const page = await ctx.client.get(`${partitionPath(partition)}/persons`, {
          query: compact({
            q: args.q,
            type: args.type,
            status: args.status,
            sort: args.sort,
            cursor: args.cursor,
            limit: args.limit,
            include_merged: args.include_merged,
          }),
        });
        return jsonResult(page);
      }
      if (action === 'get') {
        const person = args.person || ctx.config.person;
        if (!person) throw new ToolError('mnemos_person action=get 需要 person');
        return jsonResult(await ctx.client.get(personPath(partition, person)));
      }
      if (action === 'upsert') {
        const externalId = args.external_id || args.person;
        if (!externalId) throw new ToolError('mnemos_person action=upsert 需要 external_id 或 person');
        const person = await ctx.client.put(personPath(partition, externalId), compact({
          type: args.type,
          display_name: args.display_name,
          attributes: args.attributes,
          status: args.status,
        }));
        return jsonResult(person);
      }
      if (action === 'update') {
        const person = args.person;
        if (!person) throw new ToolError('mnemos_person action=update 需要 person');
        const body = compact({
          type: args.type,
          display_name: args.display_name,
          attributes: args.attributes,
          status: args.status,
        });
        if (!Object.keys(body).length) {
          throw new ToolError('mnemos_person action=update 至少提供一个待更新字段');
        }
        return jsonResult(await ctx.client.patch(personPath(partition, person), body));
      }
      throw new ToolError(`mnemos_person：不支持的 action ${action}`);
    },
  },
  {
    name: 'mnemos_profile',
    description:
      '读取人的结构化画像（P1：person_facts + 摘要）。服务端尚未上线该端点时返回明确错误。',
    inputSchema: {
      type: 'object',
      properties: {
        person: PERSON_PROP,
        force: { type: 'boolean', description: 'true 跳过画像缓存重算' },
        partition: PARTITION_PROP,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const partition = resolvePartition(args, ctx.config);
      const person = resolvePerson(args, ctx.config);
      try {
        const profile = await ctx.client.get(`${personPath(partition, person)}/profile`, {
          query: compact({ force: args.force }),
        });
        return jsonResult(profile);
      } catch (error) {
        if (error instanceof MnemosHttpError && error.status === 404) {
          throw new ToolError(
            `服务端未提供画像端点（P1）：GET ${personPath(partition, person)}/profile 返回 404`,
          );
        }
        throw error;
      }
    },
  },
  {
    name: 'mnemos_status',
    description:
      '连接自检：服务可达性、分区统计、默认人是否存在、API Key 是否配置（不打印密钥）。',
    inputSchema: {
      type: 'object',
      properties: {
        partition: PARTITION_PROP,
        person: PERSON_PROP,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const partition = args.partition || ctx.config.partition || null;
      const person = args.person || ctx.config.person || null;
      const out = {
        ok: true,
        base_url: ctx.config.baseUrl,
        partition,
        person,
        api_key_configured: Boolean(ctx.config.apiKey),
        health: null,
        partition_stats: null,
        person_info: null,
        errors: [],
      };
      const tasks = [
        ctx.client
          .health()
          .then((health) => {
            out.health = health;
          })
          .catch((error) => {
            out.ok = false;
            out.errors.push(`health：${humanError(error)}`);
          }),
      ];
      if (partition) {
        tasks.push(
          ctx.client
            .get(`${partitionPath(partition)}/stats`)
            .then((stats) => {
              out.partition_stats = stats;
            })
            .catch((error) => {
              out.ok = false;
              out.errors.push(`partition_stats：${humanError(error)}`);
            }),
        );
      }
      if (partition && person) {
        tasks.push(
          ctx.client
            .get(personPath(partition, person))
            .then((info) => {
              out.person_info = info;
            })
            .catch((error) => {
              out.errors.push(`person：${humanError(error)}`);
            }),
        );
      }
      await Promise.all(tasks);
      if (!partition) out.errors.push('未配置 MNEMOS_PARTITION：只做了服务可达性检查');
      return jsonResult(out);
    },
  },
];

export function findTool(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name) || null;
}

/** tools/list 只暴露协议字段，不泄露 handler。 */
export function listTools() {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export function toolErrorMessage(error) {
  return humanError(error);
}

/** resources/list：按配置里的分区/人生成具体资源（无分区则返回空列表）。 */
export function listResources(config) {
  if (!config.partition) return [];
  const partition = seg(config.partition);
  const person = seg(config.person || 'dsh-agent');
  return [
    {
      uri: `mnemos://partition/${partition}/stats`,
      name: `分区统计：${config.partition}`,
      description: '分区人/记忆/共享/会话计数（来自 partition_stats，O(1)）',
      mimeType: 'application/json',
    },
    {
      uri: `mnemos://person/${person}/brief`,
      name: `记忆简报：${config.person || 'dsh-agent'}`,
      description: '该人的记忆简报文本，可直接注入提示词',
      mimeType: 'text/plain',
    },
    {
      uri: `mnemos://person/${person}/profile`,
      name: `人物画像：${config.person || 'dsh-agent'}`,
      description: '该人的结构化画像（P1：facts + 摘要）',
      mimeType: 'application/json',
    },
  ];
}

/**
 * resources/read：解析 `mnemos://...` URI 并读取。
 * @returns {Promise<{contents: Array<{uri: string, mimeType: string, text: string}>}>}
 */
export async function readResource(uri, ctx) {
  if (typeof uri !== 'string' || !uri.startsWith('mnemos://')) {
    throw new ToolError(`不支持的资源 URI：${uri}`);
  }
  const parts = uri
    .slice('mnemos://'.length)
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));
  const [kind, ref, leaf] = parts;
  const partition = ctx.config.partition;

  if (kind === 'partition' && leaf === 'stats' && ref) {
    const stats = await ctx.client.get(`${partitionPath(ref)}/stats`);
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(stats, null, 2) }],
    };
  }

  if (kind === 'person' && ref && (leaf === 'brief' || leaf === 'profile')) {
    const activePartition = partition;
    if (!activePartition) {
      throw new ToolError('未配置 MNEMOS_PARTITION，无法读取人级资源');
    }
    if (leaf === 'brief') {
      const brief = await ctx.client.get(`${personPath(activePartition, ref)}/brief`);
      return {
        contents: [{ uri, mimeType: 'text/plain', text: brief?.text || '(空简报)' }],
      };
    }
    try {
      const profile = await ctx.client.get(`${personPath(activePartition, ref)}/profile`);
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(profile, null, 2) }],
      };
    } catch (error) {
      if (error instanceof MnemosHttpError && error.status === 404) {
        throw new ToolError(`服务端未提供画像端点（P1）：${uri} 返回 404`);
      }
      throw error;
    }
  }

  throw new ToolError(`未知资源 URI：${uri}`);
}
