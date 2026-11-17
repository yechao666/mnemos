import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodTypeAny, z } from 'zod';
import type { Actor, ApiKey, Org, Project, User } from '../../../shared/src/types.ts';
import type { AppContext } from '../contracts.ts';
import { HttpError, errors, sendJson } from './respond.ts';

/** 请求体硬上限 1MB。 */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 导入接口单次可携带最多 1000 条记忆，请求体放宽到 8MB。 */
export const IMPORT_BODY_BYTES = 8 * 1024 * 1024;

const IMPORT_PATH_PATTERN = /^\/(?:v1\/import|api\/projects\/[^/]+\/import)$/;

/** 按路径返回请求体上限：导入接口 8MB，其余 1MB。 */
export function bodyLimitForPath(pathname: string): number {
  return IMPORT_PATH_PATTERN.test(pathname) ? IMPORT_BODY_BYTES : MAX_BODY_BYTES;
}

export interface UsageDraft {
  projectId: string;
  operation: string;
  channel: 'console' | 'api' | 'playground' | 'system';
  resultCount: number;
  memoryTokens: number;
  apiKeyId?: string;
  orgId?: string;
  actor?: string;
}

export interface ConsoleAuth {
  kind: 'user';
  user: User;
  org: Org;
  token: string;
}

export interface ApiKeyAuth {
  kind: 'api_key';
  key: ApiKey;
  /**
   * 钥匙绑定的分区：project key 即自身分区；org key 为创建时选定的锚点分区
   * （仅用于审计/用量兜底，实际访问的分区由 `/v1/partitions/:partition` 参数解析）。
   */
  project: Project;
  /** org key 所属组织；project key 为空 */
  org?: Org;
}

export type AuthState = ConsoleAuth | ApiKeyAuth | null;

export interface RequestContext {
  app: AppContext;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  params: Record<string, string>;
  requestId: string;
  ip: string;
  userAgent: string;
  auth: AuthState;
  /** 路由声明 project 元信息时预先载入并校验过的项目 */
  project: Project | null;
  usage: UsageDraft | null;
  /** 读取并解析 JSON 请求体（缓存，仅允许读一次） */
  readBody(): Promise<unknown>;
  /** zod 校验请求体 */
  body<T extends ZodTypeAny>(schema: T): Promise<z.output<T>>;
  /** zod 校验查询字符串 */
  query<T extends ZodTypeAny>(schema: T): z.output<T>;
  /** 输出 JSON 响应 */
  json(data: unknown, status?: number): void;
  /** 登记用量（项目级路由会自动登记，其它路由手动调用） */
  markUsage(draft: { projectId: string; operation: string; channel?: UsageDraft['channel']; orgId?: string }): void;
  /** 补充本次用量的结果数量与注入 token 数 */
  noteUsage(resultCount?: number, memoryTokens?: number): void;
}

export function headerOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = headerOf(req, 'x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? '';
}

/** 把 URLSearchParams 转为对象；空值忽略，重复键取首个。 */
export function queryObject(url: URL): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (value === '') continue;
    if (!(key in result)) result[key] = value;
  }
  return result;
}

export function parseWithSchema<T extends ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    throw errors.validation(details);
  }
  return parsed.data;
}

export interface CreateContextInput {
  app: AppContext;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  pathname: string;
  params: Record<string, string>;
  requestId: string;
}

export function createRequestContext(input: CreateContextInput): RequestContext {
  const { app, req, res, url, method, pathname, params, requestId } = input;
  let bodyPromise: Promise<unknown> | null = null;
  const bodyLimit = bodyLimitForPath(pathname);

  function payloadTooLarge(): HttpError {
    const megabytes = Math.round(bodyLimit / (1024 * 1024));
    return new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${megabytes}MB 上限`);
  }

  async function readBody(): Promise<unknown> {
    if (bodyPromise) return bodyPromise;
    bodyPromise = (async () => {
      const declared = Number(headerOf(req, 'content-length') ?? '0');
      if (Number.isFinite(declared) && declared > bodyLimit) throw payloadTooLarge();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > bodyLimit) throw payloadTooLarge();
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) return {};
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw errors.invalidJson();
      }
    })();
    return bodyPromise;
  }

  const context: RequestContext = {
    app,
    req,
    res,
    url,
    method,
    pathname,
    params,
    requestId,
    ip: clientIp(req),
    userAgent: headerOf(req, 'user-agent') ?? '',
    auth: null,
    project: null,
    usage: null,
    readBody,
    async body(schema) {
      return parseWithSchema(schema, await readBody());
    },
    query(schema) {
      return parseWithSchema(schema, queryObject(url));
    },
    json(data, status = 200) {
      sendJson(res, requestId, status, data);
    },
    markUsage(draft) {
      context.usage = {
        projectId: draft.projectId,
        operation: draft.operation,
        channel: draft.channel ?? 'console',
        resultCount: 0,
        memoryTokens: 0,
        orgId: draft.orgId,
      };
    },
    noteUsage(resultCount, memoryTokens) {
      if (!context.usage) return;
      if (resultCount !== undefined) context.usage.resultCount = resultCount;
      if (memoryTokens !== undefined) context.usage.memoryTokens = memoryTokens;
    },
  };

  return context;
}

/** 构造当前请求的审计/引擎 actor。 */
export function actorForUser(rc: RequestContext, user: User): Actor {
  return {
    type: 'user',
    id: user.id,
    label: user.name || user.email,
    ip: rc.ip || undefined,
    userAgent: rc.userAgent || undefined,
  };
}

export function actorForApiKey(rc: RequestContext, key: ApiKey, project: Project): Actor {
  return {
    type: 'api_key',
    id: key.id,
    label: `${key.name}（${project.name}）`,
    ip: rc.ip || undefined,
    userAgent: rc.userAgent || undefined,
  };
}
