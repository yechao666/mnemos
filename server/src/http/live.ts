import type { LiveEvent } from '../../../shared/src/types.ts';
import type { AppContext } from '../contracts.ts';
import { newId, nowIso } from '../lib/ids.ts';

/** 发布控制台实时事件（SSE）。记忆类事件由引擎在写入时发布，HTTP 层只发自身负责的事件。 */
export function publishLive(app: AppContext, input: Omit<LiveEvent, 'id' | 'at'>): void {
  const event: LiveEvent = { id: newId('evt'), at: nowIso(), ...input };
  app.bus.publish(event);
}

/**
 * SSE 帧：同一事件输出"具名事件"与默认 message 事件两帧。
 * 这样无论前端用 `es.onmessage`（解析 data 里的 type）还是
 * `es.addEventListener('memory.added', …)`，都能收到事件。
 */
export function formatSseEvent(event: LiveEvent): string {
  const data = JSON.stringify(event);
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\nid: ${event.id}\ndata: ${data}\n\n`;
}
