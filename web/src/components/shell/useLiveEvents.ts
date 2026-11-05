import { useEffect, useState } from 'react';
import type { LiveEvent } from '@shared';
import type { IconName } from '@ui';
import { api } from '@lib/api.ts';

const MAX_EVENTS = 40;

/** 订阅服务端实时事件（SSE），保留最近若干条；不可用时静默降级为空列表。 */
export function useLiveEvents(): LiveEvent[] {
  const [events, setEvents] = useState<LiveEvent[]>([]);

  useEffect(() => {
    const unsubscribe = api.subscribeEvents((event) => {
      setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
    });
    return unsubscribe;
  }, []);

  return events;
}

export const LIVE_EVENT_LABELS: Record<LiveEvent['type'], string> = {
  'memory.added': '写入记忆',
  'memory.updated': '更新记忆',
  'memory.deleted': '删除记忆',
  'search.performed': '执行检索',
  'key.created': '创建密钥',
  'key.revoked': '吊销密钥',
  'project.created': '创建项目',
  'task.finished': '任务完成',
  'agent.registered': 'Agent 注册',
  'quota.exceeded': '配额超限',
};

export const LIVE_EVENT_ICONS: Record<LiveEvent['type'], IconName> = {
  'memory.added': 'brain',
  'memory.updated': 'pencil',
  'memory.deleted': 'trash',
  'search.performed': 'search',
  'key.created': 'key',
  'key.revoked': 'lock',
  'project.created': 'folder',
  'task.finished': 'checkCircle',
  'agent.registered': 'bot',
  'quota.exceeded': 'alert',
};

export function liveEventLabel(type: LiveEvent['type']): string {
  return LIVE_EVENT_LABELS[type] ?? type;
}
