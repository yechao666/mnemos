import type { WebhookDispatcher } from '../contracts.ts';
import type { EventBus } from '../lib/bus.ts';
import { createWebhookService, type WebhookServiceDeps } from './service.ts';

export interface WebhookDispatcherDeps extends WebhookServiceDeps {
  bus: EventBus;
}

/**
 * 投递 worker：
 *  - `start()` 订阅 EventBus 并按 env.webhookWorkerIntervalMs 起定时器（单轮防重入在 service 内）；
 *  - `webhooksEnabled=false` 时不订阅、不定时、tickNow 直接返回；
 *  - `stop()` 清理定时器与订阅，允许在测试/热重载中反复启停。
 */
export function createWebhookDispatcher(deps: WebhookDispatcherDeps): WebhookDispatcher {
  const { env, bus, logger } = deps;
  const service = createWebhookService(deps);

  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const runTick = (): void => {
    void service.tick().catch((error: unknown) => {
      logger.error('webhook.tick_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return {
    start(): void {
      if (!env.webhooksEnabled) {
        logger.info('webhook.dispatcher_skipped', { reason: 'webhooks_disabled' });
        return;
      }
      if (timer) return;

      unsubscribe = bus.subscribe((event) => {
        try {
          service.enqueue(event);
        } catch (error) {
          logger.error('webhook.enqueue_failed', {
            eventType: event.type,
            projectId: event.projectId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      timer = setInterval(runTick, env.webhookWorkerIntervalMs);
      timer.unref?.();
      logger.info('webhook.dispatcher_started', {
        intervalMs: env.webhookWorkerIntervalMs,
        maxAttempts: env.webhookMaxAttempts,
        allowPrivate: env.webhookAllowPrivate,
      });
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },

    async tickNow(): Promise<void> {
      if (!env.webhooksEnabled) return;
      await service.tick();
    },
  };
}
