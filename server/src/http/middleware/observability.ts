import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../../contracts.ts';
import { newId } from '../../lib/ids.ts';
import { clientIp } from '../context.ts';

/**
 * 请求可观测性：
 *  - 生成/复用 X-Request-Id；
 *  - 结构化访问日志（method/path/status/latency/requestId/ip/actor）；
 *  - 指标计数与延迟直方图（route 使用路由模板，保持低基数）；
 *  - 慢请求（>1s）warn，5xx error；
 *  - 维护 in-flight 与 SSE 连接集合，供优雅停机 drain 使用。
 */

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SLOW_REQUEST_MS = 1_000;
const DRAIN_POLL_MS = 25;

export function resolveRequestId(req: IncomingMessage): string {
  const raw = req.headers['x-request-id'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value && REQUEST_ID_PATTERN.test(value)) return value;
  return newId('req');
}

export interface RequestTrace {
  /** 路由模板（如 /api/partitions/:partition/persons），未匹配时由调用方设为 unmatched/static。 */
  setRoute(route: string): void;
  setActor(actor: string | undefined): void;
  /** SSE 建立后调用：计入 sseClients 仪表，断连时由 close 事件回减。 */
  markSse(): void;
  readonly finished: boolean;
}

export interface Observability {
  begin(req: IncomingMessage, res: ServerResponse, requestId: string): RequestTrace;
  readonly inFlight: number;
  readonly sseClients: number;
  /** 关闭 SSE、等待 in-flight 归零（最多 env.shutdownTimeoutMs）。 */
  drain(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

export function createObservability(app: AppContext): Observability {
  const active = new Set<ServerResponse>();
  const sse = new Set<ServerResponse>();

  function begin(req: IncomingMessage, res: ServerResponse, requestId: string): RequestTrace {
    const startedAt = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const path = (rawUrl.split('?')[0] ?? '/').slice(0, 300);
    const ip = clientIp(req);
    const state: { route: string; actor?: string; sse: boolean; finished: boolean } = {
      route: 'unmatched',
      sse: false,
      finished: false,
    };

    active.add(res);

    const finalize = (): void => {
      if (state.finished) return;
      state.finished = true;
      active.delete(res);
      if (state.sse) {
        sse.delete(res);
        app.metrics.incGauge('sseClients', undefined, -1);
      }
      const status = res.statusCode || 0;
      const latencyMs = Date.now() - startedAt;
      app.metrics.counter('mnemos_http_requests_total', {
        method,
        route: state.route,
        status: String(status),
      });
      // SSE 的 latency 是连接存活时长，不纳入 HTTP 延迟分布，避免污染 p95/p99
      if (!state.sse) {
        app.metrics.histogram('mnemos_http_request_duration_milliseconds', latencyMs, {
          method,
          route: state.route,
        });
      }
      if (status === 429) app.metrics.counter('mnemos_rate_limited_total', { route: state.route });

      const fields = {
        method,
        path,
        status,
        latencyMs,
        requestId,
        ip,
        route: state.route,
        actor: state.actor,
        traceId: (res.getHeader('x-trace-id') as string | undefined) ?? undefined,
      };
      if (status >= 500) {
        app.logger.error('http.request.failed', fields);
      } else if (!state.sse && latencyMs > SLOW_REQUEST_MS) {
        // SSE 的 latency 是连接存活时长，不纳入慢请求告警。
        app.logger.warn('http.request.slow', fields);
      } else {
        app.logger.info('http.request', fields);
      }
    };

    res.once('finish', finalize);
    res.once('close', finalize);

    return {
      setRoute(route: string) {
        state.route = route || 'unmatched';
      },
      setActor(actor: string | undefined) {
        state.actor = actor;
      },
      markSse() {
        if (state.sse) return;
        state.sse = true;
        sse.add(res);
        app.metrics.incGauge('sseClients', undefined, 1);
      },
      get finished() {
        return state.finished;
      },
    };
  }

  async function drain(): Promise<void> {
    for (const res of [...sse]) {
      try {
        res.write(': shutdown\n\n');
        res.end();
      } catch {
        /* 已断开的客户端忽略 */
      }
    }

    const deadline = Date.now() + Math.max(1_000, app.env.shutdownTimeoutMs);
    while (active.size > 0 && Date.now() < deadline) {
      for (const res of active) {
        try {
          res.shouldKeepAlive = false;
        } catch {
          /* noop */
        }
      }
      await sleep(DRAIN_POLL_MS);
    }

    for (const res of active) {
      try {
        res.shouldKeepAlive = false;
        if (!res.headersSent) res.setHeader('connection', 'close');
      } catch {
        /* noop */
      }
    }
    if (active.size > 0) app.logger.warn('http.drain_timeout', { inFlight: active.size });
  }

  return {
    begin,
    get inFlight() {
      return active.size;
    },
    get sseClients() {
      return sse.size;
    },
    drain,
  };
}
