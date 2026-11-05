import type {
  LiveEvent,
  WebhookEventPayload,
  WebhookEventType,
} from '../../../shared/src/types.ts';

/**
 * 事件映射：
 *  - 控制台 LiveEvent → 对外 WebhookEventType；
 *  - `search.performed` 高频且噪音大，默认不对外（也不允许订阅）；
 *  - `project.created` 没有对应的对外事件，直接忽略。
 */

export interface WebhookEventMeta {
  type: WebhookEventType;
  label: string;
  description: string;
}

export const WEBHOOK_EVENT_TYPES: WebhookEventMeta[] = [
  {
    type: 'memory.created',
    label: '记忆创建',
    description: '新记忆写入项目（含 API 写入与 Agent 抽取结果）',
  },
  {
    type: 'memory.updated',
    label: '记忆更新',
    description: '记忆内容、分类、重要度或状态被修改',
  },
  {
    type: 'memory.deleted',
    label: '记忆删除',
    description: '记忆被删除、归档或批量清理',
  },
  {
    type: 'task.finished',
    label: '任务结束',
    description: '任务会话以 done/abandoned 结束时触发，携带沉淀记忆数',
  },
  {
    type: 'agent.registered',
    label: 'Agent 注册',
    description: '项目中注册了新的 Agent 身份',
  },
  {
    type: 'key.created',
    label: '密钥创建',
    description: '创建或轮换 API 密钥（不含密钥明文）',
  },
  {
    type: 'key.revoked',
    label: '密钥吊销',
    description: 'API 密钥被吊销',
  },
  {
    type: 'quota.exceeded',
    label: '配额超限',
    description: '项目月度写入配额被用尽',
  },
];

/** 对外可订阅事件集合（不含 search.performed）。 */
export const SUPPORTED_EVENT_TYPES: ReadonlySet<WebhookEventType> = new Set(
  WEBHOOK_EVENT_TYPES.map((item) => item.type),
);

export function isWebhookEventType(value: string): value is WebhookEventType {
  return SUPPORTED_EVENT_TYPES.has(value as WebhookEventType);
}

/** 解析 webhook.event_types JSON 列；未知/内部事件类型被过滤。 */
export function parseEventTypes(raw: string | null | undefined): WebhookEventType[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const result: WebhookEventType[] = [];
    for (const value of parsed) {
      if (typeof value === 'string' && isWebhookEventType(value) && !result.includes(value)) {
        result.push(value);
      }
    }
    return result;
  } catch {
    return [];
  }
}

/** 内部 LiveEvent → 对外事件类型；不映射的类型返回 null。 */
export function mapLiveEventType(type: LiveEvent['type']): WebhookEventType | null {
  switch (type) {
    case 'memory.added':
      return 'memory.created';
    case 'memory.updated':
      return 'memory.updated';
    case 'memory.deleted':
      return 'memory.deleted';
    case 'task.finished':
      return 'task.finished';
    case 'agent.registered':
      return 'agent.registered';
    case 'key.created':
      return 'key.created';
    case 'key.revoked':
      return 'key.revoked';
    case 'quota.exceeded':
      return 'quota.exceeded';
    // search.performed / project.created 不对外投递
    default:
      return null;
  }
}

/** 构造对外事件载荷（稳定最小结构；data 包含 summary 与事件 meta）。 */
export function buildEventPayload(
  event: LiveEvent,
  type: WebhookEventType,
  projectId: string,
  projectSlug: string | undefined,
): WebhookEventPayload {
  const data: Record<string, unknown> = { summary: event.summary };
  if (event.meta) {
    for (const [key, value] of Object.entries(event.meta)) data[key] = value;
  }
  return {
    id: event.id,
    type,
    at: event.at,
    projectId,
    ...(projectSlug ? { projectSlug } : {}),
    actor: event.actor,
    data,
  };
}

/** 控制台「发送测试」使用的合成事件类型，不属于可订阅事件。 */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

export interface WebhookTestEventPayload {
  id: string;
  type: typeof WEBHOOK_TEST_EVENT;
  at: string;
  projectId: string;
  projectSlug?: string;
  actor: string;
  data: Record<string, unknown>;
}

export function buildTestPayload(input: {
  id: string;
  at: string;
  projectId: string;
  projectSlug?: string;
  actor: string;
  webhookName: string;
}): WebhookTestEventPayload {
  return {
    id: input.id,
    type: WEBHOOK_TEST_EVENT,
    at: input.at,
    projectId: input.projectId,
    ...(input.projectSlug ? { projectSlug: input.projectSlug } : {}),
    actor: input.actor,
    data: {
      synthetic: true,
      webhookName: input.webhookName,
      message: '这是一条 Mnemos Webhook 测试事件，请在此端点上验证签名与解析逻辑。',
    },
  };
}
