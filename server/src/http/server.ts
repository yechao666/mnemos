import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AppContext } from '../contracts.ts';
import { recordUsage } from '../lib/usage.ts';
import { createRequestContext, type RequestContext } from './context.ts';
import { assertScopes, authenticateApiKey, authenticateConsole } from './middleware/auth.ts';
import { applyCors, handlePreflight } from './middleware/cors.ts';
import { createObservability, resolveRequestId, type Observability } from './middleware/observability.ts';
import { applySecurityHeaders } from './middleware/security.ts';
import { createRequestTimeout } from './middleware/timeout.ts';
import { errors, normalizeError, sendError } from './respond.ts';
import { normalizePath, Router, type RouteMatch } from './router.ts';
import { registerRoutes } from './routes/index.ts';
import { serveStatic } from './static.ts';
import { currentTraceId, withSpan } from '../observability/otel.ts';

/**
 * HTTP 传输层入口：由 main.ts 调用，只返回 Server 实例，不监听端口。
 *
 * 处理顺序：安全响应头 → 请求可观测性（请求 ID / 访问日志 / 指标）
 * → CORS → 超时守护 → 路由匹配 → 认证 → handler → 错误映射 → 用量记录。
 */

let activeObservability: Observability | null = null;
let activeServer: Server | null = null;

export function createHttpServer(ctx: AppContext): Server {
  const router = new Router();
  registerRoutes(router);

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

/** 优雅停机辅助：关闭空闲 keep-alive、结束 SSE、等待 in-flight 请求。 */
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

function lookupPartitionOrg(app: AppContext, partitionId: string): string | undefined {
  try {
    const row = app.db.prepare('SELECT org_id FROM partitions WHERE id = ?').get(partitionId) as unknown as
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
  const orgId = usage.orgId ?? lookupPartitionOrg(app, usage.partitionId);
  try {
    recordUsage(app.db, {
      orgId,
      partitionId: usage.partitionId,
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
      tracker.setActor(`API Key · ${auth.key.name}`);
      if (meta.scopes && meta.scopes.length > 0) assertScopes(auth, meta.scopes);
    }

    const context = rc;
    await withSpan(
      `${method} ${meta.path}`,
      {
        'http.method': method,
        'http.route': meta.path,
        'http.target': pathname,
        'mnemos.request_id': requestId,
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
  } catch (error) {
    logRequestFailure(app, requestId, method, pathname, error);
    sendError(res, requestId, error);
  } finally {
    timeout.clear();
    if (rc) recordRequestUsage(app, rc, res.statusCode, startedAt);
  }
}
