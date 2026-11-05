import type { ServerResponse } from 'node:http';
import type { Env } from '../../env.ts';

/**
 * 安全响应头：对所有响应（含静态资源、SSE、错误）统一生效。
 * CSP 按控制台同源部署设计：不加载外部脚本/字体，样式允许内联（组件库内联样式）。
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

export function applySecurityHeaders(res: ServerResponse, env: Env): void {
  if (res.headersSent) return;
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', PERMISSIONS_POLICY);
  res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  if (env.hstsEnabled) res.setHeader('strict-transport-security', HSTS_VALUE);
}
