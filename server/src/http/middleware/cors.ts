import type { IncomingMessage, ServerResponse } from 'node:http';
import { headerOf } from '../context.ts';

/**
 * CORS：仅回显本机来源（127.0.0.1 / localhost / ::1），避免把控制台令牌暴露给任意站点。
 */

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function allowedOrigin(req: IncomingMessage): string | null {
  const origin = headerOf(req, 'origin');
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return ALLOWED_HOSTNAMES.has(parsed.hostname) ? origin : null;
  } catch {
    return null;
  }
}

export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = allowedOrigin(req);
  if (!origin) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, X-Request-Id');
  res.setHeader('access-control-expose-headers', 'X-Request-Id');
  res.setHeader('access-control-max-age', '600');
}

/** 预检请求：始终 204；非白名单来源不附加 CORS 头，由浏览器拦截。 */
export function handlePreflight(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 204;
  res.setHeader('content-length', '0');
  if (allowedOrigin(req)) res.setHeader('access-control-max-age', '600');
  res.end();
}
