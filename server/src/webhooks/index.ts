/**
 * Webhook 事件订阅后端公开入口。
 *
 * main.ts: `createWebhookDispatcher({ db, env, bus, logger, metrics })`，随后 start/stop。
 * 路由层可直接使用 createWebhookService / 同目录的 store、mappers、signature 工具。
 */

export { createWebhookDispatcher } from './dispatcher.ts';
export type { WebhookDispatcherDeps } from './dispatcher.ts';
export {
  AUTO_DISABLE_FAILURES,
  DELIVERY_BATCH_SIZE,
  RETRY_BACKOFF_MS,
  createWebhookService,
  enqueueEvent,
  retryDelayMs,
  sendTestWebhook,
} from './service.ts';
export type { WebhookService, WebhookServiceDeps } from './service.ts';
export { WEBHOOK_EVENT_TYPES, SUPPORTED_EVENT_TYPES, parseEventTypes, mapLiveEventType } from './events.ts';
export { newWebhookSecret, signPayload, verifySignature } from './signature.ts';
export { assertUrlSafeForDelivery, assertWebhookUrl, parseWebhookUrl, WebhookUrlError } from './ssrf.ts';
