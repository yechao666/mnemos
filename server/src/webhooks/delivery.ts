import { signPayload } from './signature.ts';
import { assertUrlSafeForDelivery } from './ssrf.ts';

/**
 * 单次投递协议实现。
 *
 * POST JSON + HMAC 签名；`redirect: 'manual'`（3xx 视为失败）；
 * 2xx 成功；超时/网络错误/非 2xx 失败；响应体截断 2KB。
 */

export const WEBHOOK_USER_AGENT = 'Mnemos-Webhook/1.0';
export const MAX_RESPONSE_BODY_BYTES = 2048;

export interface DeliveryAttemptInput {
  url: string;
  secret: string;
  eventType: string;
  deliveryId: string;
  projectId: string;
  /** 已序列化的 WebhookEventPayload。 */
  payload: string;
  timeoutMs: number;
  allowPrivate: boolean;
}

export interface DeliveryAttemptResult {
  ok: boolean;
  responseStatus?: number;
  responseBody?: string;
  latencyMs: number;
  error?: string;
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

function truncateBody(text: string, limit = MAX_RESPONSE_BODY_BYTES): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  return buffer.subarray(0, limit).toString('utf8');
}

/** 读取响应体并硬截断到 limit 字节（避免恶意端点用超长响应撑爆内存）。 */
async function readCappedText(response: FetchResponse, limit = MAX_RESPONSE_BODY_BYTES): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const remaining = limit - size;
      const slice = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      size += slice.length;
      if (value.length > remaining) {
        try {
          await reader.cancel();
        } catch {
          /* 已断开，忽略 */
        }
        break;
      }
    }
  } catch {
    /* 响应体读取失败按空体处理 */
  }
  return truncateBody(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'), limit);
}

function errorMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return `请求超时（${timeoutMs}ms）`;
    }
    return error.message;
  }
  return String(error);
}

/** 执行一次投递；永不抛出（失败以 result.error 返回）。 */
export async function attemptDelivery(input: DeliveryAttemptInput): Promise<DeliveryAttemptResult> {
  const startedAt = Date.now();

  let target: URL;
  try {
    target = await assertUrlSafeForDelivery(input.url, { allowPrivate: input.allowPrivate });
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': WEBHOOK_USER_AGENT,
    'x-mnemos-event': input.eventType,
    'x-mnemos-delivery': input.deliveryId,
    'x-mnemos-project': input.projectId,
    'x-mnemos-timestamp': String(timestamp),
    'x-mnemos-signature': signPayload(input.secret, input.payload, timestamp),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, input.timeoutMs));
  timer.unref?.();

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers,
      body: input.payload,
      redirect: 'manual',
      signal: controller.signal,
    });
    const responseBody = await readCappedText(response);
    const latencyMs = Date.now() - startedAt;
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      responseStatus: response.status,
      responseBody,
      latencyMs,
      ...(ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error, input.timeoutMs),
    };
  } finally {
    clearTimeout(timer);
  }
}
