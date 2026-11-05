import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook 签名协议：`x-mnemos-signature: t=<unix>,v1=<hex>`。
 *
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)，secret 为创建/轮换时下发的一次性
 * `whsec_…` 明文。调用方应校验时间戳容差（默认 5 分钟）并做常量时间比较。
 */

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const WEBHOOK_SIGNATURE_HEADER = 'x-mnemos-signature';
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** 生成 webhook secret：whsec_<base64url 32B>。明文仅在创建/轮换响应中出现一次。 */
export function newWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** 生成签名头：t 为 unix 秒（取整）。 */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const t = Math.floor(timestamp);
  const digest = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return `t=${t},v1=${digest}`;
}

export interface ParsedSignature {
  timestamp: number;
  signature: string;
}

/** 解析 `t=…,v1=…`；格式不合法返回 null。 */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && timestamp === null) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return null;
      timestamp = Math.floor(parsed);
    } else if (key === 'v1' && signature === null) {
      signature = value;
    }
  }
  if (timestamp === null || signature === null) return null;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return null;
  return { timestamp, signature };
}

export interface VerifySignatureOptions {
  /** 允许的时间偏移（秒），默认 300；传 0 表示只接受同一秒。 */
  toleranceSeconds?: number;
  /** 当前 unix 秒（测试可注入）。 */
  nowSeconds?: number;
}

/**
 * 校验签名头。篡改 body、secret 不匹配、时间戳超出容差、格式错误均返回 false。
 * 比较使用 timingSafeEqual，避免逐字节时序泄漏。
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  options: VerifySignatureOptions = {},
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const tolerance = options.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) return false;

  const expected = createHmac('sha256', secret).update(`${parsed.timestamp}.${body}`, 'utf8').digest();
  const provided = Buffer.from(parsed.signature, 'hex');
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/** 供文档/测试使用的示例：签名并返回可直接放进请求头的字符串。 */
export function signatureExample(secret: string, body: string, at: Date = new Date()): string {
  return signPayload(secret, body, Math.floor(at.getTime() / 1000));
}
