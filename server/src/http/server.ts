import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AppContext } from '../contracts.ts';
import { recordUsage } from '../lib/usage.ts';
import { assertQuota, evaluateProjectQuota } from '../platform/quota.ts';
import { createRequestContext, type RequestContext } from './context.ts';
import { assertScopes, authenticateApiKey, authenticateConsole, requireProjectAccess } from './middleware/auth.ts';
import { applyCors, handlePreflight } from './middleware/cors.ts';
import { createObservability, resolveRequestId, type Observability } from './middleware/observability.ts';
import { applySecurityHeaders } from './middleware/security.ts';
import { createRequestTimeout } from './middleware/timeout.ts';
import { buildOpenApiDocument } from './openapi.ts';
import { errors, normalizeError, sendError } from './respond.ts';
import { normalizePath, Router, type RouteMatch } from './router.ts';
import { registerRoutes } from './routes/index.ts';
import { serveStatic } from './static.ts';
import { currentTraceId, withSpan } from '../observability/otel.ts';

/**
 * HTTP 传输层入口：由 main.ts 调用，只返回 Server 实例，不监听端口。
 *
 * 处理顺序：安全响应头 → 请求可观测性（请求 ID / 访问日志 / 指标）
 * → CORS → 超时守护 → 路由匹配 → 认证/授权 → 配额 → handler
 * → 错误映射 → 用量记录。
 */

let activeObservability: Observability | null = null;
let activeServer: Server | null = null;

export function createHttpServer(ctx: AppContext): Server {
  const router = new Router();
  registerRoutes(router);

  // OpenAPI 文档：两处路径都返回，便于网关/前端按不同前缀访问。
  router.add({
    method: 'GET',
    path: '/openapi.json',
    auth: 'none',
    handler: (rc: RequestContext) => {
      rc.json(buildOpenApiDocument(rc.app));
    },
  });
  router.add({
    method: 'GET',
    path: '/api/openapi.json',
    auth: 'none',
    handler: (rc: RequestContext) => {
      rc.json(buildOpenApiDocument(rc.app));
    },
  });

  const observability = createObservability(ctx);
  activeObservability = observability;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(ctx, router, observability, req, res);
  });

  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    socket.end(
      'HTTP/1.1 400 Bad Request\r\ncontent-type: application/json; charset=utf-8\r\nconnection: close\r\n\r\n' +
        JSON.stringify({ error: { code: 'BAD_REQUEST', message: '请求格式不合法', requestId: '-' } }),
    );
  });

  activeServer = server;
  return server;
}

/**
 * 优雅停机辅助：关闭空闲 keep-alive、结束 SSE、等待 in-flight 请求
 * （最多 env.shutdownTimeoutMs）。由 main 在收到信号后调用。
 */
export async function drainConnections(): Promise<void> {
  const observability = activeObservability;
  if (!observability) return;
  try {
    activeServer?.closeIdleConnections();
  } catch {
    /* 旧版本 Node 无该方法时忽略 */
  }
  await observability.drain();
}

/** 当前 in-flight / SSE 连接数（运维排查与测试用）。 */
export function connectionStats(): { inFlight: number; sseClients: number } {
  return {
    inFlight: activeObservability?.inFlight ?? 0,
    sseClients: activeObservability?.sseClients ?? 0,
  };
}

function lookupProjectOrg(app: AppContext, projectId: string): string | undefined {
  try {
    const row = app.db.prepare('SELECT org_id FROM projects WHERE id = ?').get(projectId) as unknown as
      | { org_id: string }
      | undefined;
    return row?.org_id;
  } catch {
    return undefined;
  }
}

function recordRequestUsage(app: AppContext, rc: RequestContext, status: number, startedAt: number): void {
  const usage = rc.usage;
  if (!usage) return;
  const auth = rc.auth;
  const actor =
    auth?.kind === 'user'
      ? auth.user.name || auth.user.email
      : auth?.kind === 'api_key'
        ? `API Key · ${auth.key.name}`
        : 'system';
  const orgId = usage.orgId ?? lookupProjectOrg(app, usage.projectId);
  try {
    recordUsage(app.db, {
      orgId,
      projectId: usage.projectId,
      apiKeyId: auth?.kind === 'api_key' ? auth.key.id : usage.apiKeyId,
      channel: usage.channel,
      operation: usage.operation,
      method: rc.method,
      path: rc.pathname,
      status,
      latencyMs: Date.now() - startedAt,
      resultCount: usage.resultCount,
      memoryTokens: usage.memoryTokens,
      actor,
    });
  } catch (error) {
    app.logger.error('http.usage_record_failed', { requestId: rc.requestId, error });
  }
}

/** 月度写入配额：仅对 operation=add 的写请求在鉴权后、handler 前检查。 */
function enforceQuota(app: AppContext, rc: RequestContext, operation: string | undefined): void {
  if (!app.env.quotaEnforce) return;
  if (operation !== 'add' || !rc.project) return;
  const state = evaluateProjectQuota(app.db, rc.project);
  if (!state.exceeded) return;
  rc.res.setHeader('retry-after', String(state.retryAfter));
  app.metrics.counter('mnemos_quota_rejected_total');
  assertQuota(state);
}

function logRequestFailure(
  app: AppContext,
  requestId: string,
  method: string,
  pathname: string,
  error: unknown,
): void {
  const httpError = normalizeError(error);
  const fields = {
    requestId,
    method,
    path: pathname,
    status: httpError.status,
    code: httpError.code,
    message: httpError.message,
    error,
  };
  if (httpError.status >= 500) app.logger.error('http.request.exception', fields);
  else app.logger.warn('http.request.rejected', fields);
}

async function dispatch(
  app: AppContext,
  router: Router,
  observability: Observability,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  applySecurityHeaders(res, app.env);

  const requestId = resolveRequestId(req);
  res.setHeader('x-request-id', requestId);
  applyCors(req, res);

  const tracker = observability.begin(req, res, requestId);
  const startedAt = Date.now();
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    handlePreflight(req, res);
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    tracker.setRoute('invalid-url');
    sendError(res, requestId, errors.badRequest('请求 URL 不合法'));
    return;
  }
  const pathname = normalizePath(url.pathname);
  const timeout = createRequestTimeout(app, req, res, requestId, pathname);
  let rc: RequestContext | null = null;

  try {
    const matched = router.match(method, pathname);
    if (matched === 'METHOD_MISMATCH') {
      // 避免把含 ID 的真实路径写进指标标签（高基数）。
      tracker.setRoute('method_mismatch');
      throw errors.methodNotAllowed(method, pathname);
    }

    const routeMatch: RouteMatch | null = matched;
    rc = createRequestContext({
      app,
      req,
      res,
      url,
      method,
      pathname,
      params: routeMatch?.params ?? {},
      requestId,
    });

    if (!routeMatch) {
      const isApi = pathname.startsWith('/api') || pathname.startsWith('/v1');
      if ((method === 'GET' || method === 'HEAD') && !isApi) {
        tracker.setRoute('static');
        await serveStatic(app, rc);
        return;
      }
      tracker.setRoute('unmatched');
      throw errors.notFound(`未找到路由：${method} ${pathname}`);
    }

    const meta = routeMatch.route;
    tracker.setRoute(meta.path);

    if (meta.auth === 'console') {
      rc.auth = authenticateConsole(rc, meta.allowQueryToken === true);
      if (rc.auth.kind === 'user') tracker.setActor(rc.auth.user.email || rc.auth.user.name);
    } else if (meta.auth === 'apikey') {
      const auth = authenticateApiKey(rc);
      rc.auth = auth;
      rc.project = auth.project;
      tracker.setActor(`API Key · ${auth.key.name}`);
      // org key 只能走自身声明了 allowOrgKey 的端点（/v1/partitions/*），
      // 否则会隐式落到创建时的锚点分区，语义不清。
      if (auth.key.kind === 'org' && meta.allowOrgKey !== true) {
        throw errors.forbidden(
          '组织级 API Key（kind=org）不能调用分区级旧端点，请使用 /v1/partitions/:partition/... 形式指定分区',
        );
      }
      if (meta.scopes && meta.scopes.length > 0) assertScopes(auth, meta.scopes);
    }

    if (meta.project) {
      const param = meta.project.param ?? 'id';
      const projectId = routeMatch.params[param];
      if (!projectId) throw errors.badRequest(`缺少路径参数 ${param}`);
      rc.project = requireProjectAccess(rc, projectId, meta.project.minRole ?? 'viewer');
    }

    if (meta.operation && rc.project) {
      rc.usage = {
        projectId: rc.project.id,
        operation: meta.operation,
        channel: meta.channel ?? 'console',
        resultCount: 0,
        memoryTokens: 0,
        orgId: rc.project.orgId,
      };
    }

    enforceQuota(app, rc, meta.operation);

    // 手动 server span：OTel 的 HttpInstrumentation 在 Node ESM 下无法自动挂钩
    // 已加载的 node:http，因此这里显式包裹 handler，保证开启 OTEL 时一定有链路。
    const context = rc;
    await withSpan(
      `${method} ${meta.path}`,
      {
        'http.method': method,
        'http.route': meta.path,
        'http.target': pathname,
        'mnemos.request_id': requestId,
        ...(context.project ? { 'mnemos.project_id': context.project.id } : {}),
        ...(meta.operation ? { 'mnemos.operation': meta.operation } : {}),
      },
      async () => {
        const traceId = currentTraceId();
        if (traceId && !res.headersSent) res.setHeader('x-trace-id', traceId);
        await meta.handler(context);
      },
    );
    if (!res.headersSent && !res.writableEnded) {
      throw errors.internal('路由处理器未返回响应');
    }
    if (pathname === '/api/events' && res.headersSent && !res.writableEnded) {
      tracker.markSse();
    }
  } catch (error) {
    logRequestFailure(app, requestId, method, pathname, error);
    sendError(res, requestId, error);
  } finally {
    timeout.clear();
    if (rc) recordRequestUsage(app, rc, res.statusCode, startedAt);
  }
}
