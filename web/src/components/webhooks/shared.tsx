import type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEventType,
  WebhookStats,
  WebhookTestResult,
} from '@shared';
import type { Tone } from '@ui';

/** 事件订阅页共用的元数据、状态映射与格式化工具。 */

export interface WebhookEventOption {
  type: WebhookEventType;
  label: string;
  description: string;
}

const EVENT_META: Record<WebhookEventType, { label: string; description: string }> = {
  'memory.created': {
    label: '记忆写入',
    description: '新的记忆条目被写入项目时触发，载荷包含记忆内容、分类与作用域。',
  },
  'memory.updated': {
    label: '记忆更新',
    description: '已有记忆被修改、合并或根据反馈调整时触发。',
  },
  'memory.deleted': {
    label: '记忆删除',
    description: '单条记忆被删除或批量清理导致记录失效时触发。',
  },
  'task.finished': {
    label: '任务完成',
    description: 'Agent 任务会话以完成或放弃状态结束时触发，载荷包含任务摘要与产出记忆。',
  },
  'agent.registered': {
    label: 'Agent 注册',
    description: '新的 Agent 在项目内注册或首次上报时触发。',
  },
  'key.created': {
    label: '密钥创建',
    description: '项目内新建 API 密钥时触发，载荷仅包含密钥前缀，不包含完整密钥。',
  },
  'key.revoked': {
    label: '密钥吊销',
    description: '项目内 API 密钥被吊销或轮换下线时触发。',
  },
  'quota.exceeded': {
    label: '配额超限',
    description: '项目用量达到或超过月度配额阈值时触发。',
  },
};

const EVENT_ORDER = Object.keys(EVENT_META) as WebhookEventType[];

/** 新建订阅时默认勾选的事件：覆盖写入、更新与任务完成三类核心场景。 */
export const DEFAULT_EVENT_TYPES: WebhookEventType[] = ['memory.created', 'memory.updated', 'task.finished'];

/** 控制台展示的签名请求头名称；后端调整时只需修改此处与示例文案。 */
export const SIGNATURE_HEADER = 'X-Mnemos-Signature';

/** 签名原文：`${t}.${原始请求体}`。 */
export const SIGNING_BASE = '`${t}.${rawBody}`';

export function isWebhookEventType(value: string): value is WebhookEventType {
  return value in EVENT_META;
}

/** 服务端返回的事件类型说明优先，缺失时回退到内置文案。 */
export function mergeEventOptions(remote: WebhookEventOption[] | null | undefined): WebhookEventOption[] {
  return EVENT_ORDER.map((type) => {
    const meta = EVENT_META[type];
    const found = remote?.find((option) => option.type === type);
    const label = found?.label?.trim();
    const description = found?.description?.trim();
    return {
      type,
      label: label ? label : meta.label,
      description: description ? description : meta.description,
    };
  });
}

export function eventLabel(type: string, options?: WebhookEventOption[]): string {
  if (type === 'webhook.test') return '测试投递';
  const found = options?.find((option) => option.type === type);
  if (found) return found.label;
  return isWebhookEventType(type) ? EVENT_META[type].label : type;
}

export function eventDescription(type: string, options?: WebhookEventOption[]): string {
  if (type === 'webhook.test') return '控制台手动触发的测试事件，仅用于验证地址与签名。';
  const found = options?.find((option) => option.type === type);
  if (found) return found.description;
  return isWebhookEventType(type) ? EVENT_META[type].description : '';
}

export function eventSummary(types: WebhookEventType[], options?: WebhookEventOption[]): string {
  if (types.length === 0) return '未选择事件';
  return types.map((type) => eventLabel(type, options)).join('、');
}

export const DELIVERY_STATUS_META: Record<WebhookDeliveryStatus, { label: string; tone: Tone }> = {
  pending: { label: '待投递', tone: 'slate' },
  delivering: { label: '投递中', tone: 'blue' },
  success: { label: '成功', tone: 'green' },
  failed: { label: '失败', tone: 'amber' },
  dead: { label: '死信', tone: 'red' },
};

export function deliveryStatusTone(status: WebhookDeliveryStatus): Tone {
  return DELIVERY_STATUS_META[status]?.tone ?? 'slate';
}

export function deliveryStatusLabel(status: WebhookDeliveryStatus): string {
  return DELIVERY_STATUS_META[status]?.label ?? status;
}

export function httpStatusTone(status: number | null | undefined): Tone {
  if (status === null || status === undefined) return 'slate';
  if (status >= 200 && status < 300) return 'green';
  if (status >= 400 && status < 500) return 'amber';
  if (status >= 500) return 'red';
  return 'slate';
}

export function testResultTone(result: WebhookTestResult): Tone {
  return deliveryStatusTone(result.status);
}

export function successRate(stats: WebhookStats | null): number | null {
  if (!stats) return null;
  const attempted = stats.success + stats.failed + stats.dead;
  if (attempted <= 0) return null;
  return (stats.success / attempted) * 100;
}

export function successRateTone(rate: number | null): Tone {
  if (rate === null) return 'slate';
  if (rate >= 99) return 'green';
  if (rate >= 90) return 'amber';
  return 'red';
}

/** 推送地址校验：必须是完整、可解析的 http(s) URL，且不内嵌凭据。 */
export function validateWebhookUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return '请输入推送地址';
  if (value.length > 2048) return '推送地址不能超过 2048 个字符';
  if (/\s/.test(value)) return '推送地址不能包含空格或换行';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '请输入合法的完整 URL，例如 https://example.com/hooks/mnemos';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '仅支持 http:// 或 https:// 地址';
  }
  if (!parsed.hostname) return 'URL 缺少主机名';
  if (parsed.username || parsed.password) return '请不要在 URL 中携带用户名或密码';
  return null;
}

export function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

export function truncateText(value: string, max = 4000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（已截断，完整内容共 ${value.length} 个字符）`;
}

/** 将字符串或对象格式化为可读 JSON；无法解析时原样返回。 */
export function formatBody(raw: unknown, max = 4000): { text: string; json: boolean } {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { text: raw, json: false };
    try {
      return { text: truncateText(JSON.stringify(JSON.parse(trimmed), null, 2), max), json: true };
    } catch {
      return { text: truncateText(raw, max), json: false };
    }
  }
  if (raw === null || raw === undefined) return { text: '', json: false };
  try {
    const text = JSON.stringify(raw, null, 2);
    return { text: truncateText(text ?? String(raw), max), json: text !== undefined };
  } catch {
    return { text: truncateText(String(raw), max), json: false };
  }
}

/**
 * 投递载荷不在共享契约的必填字段中；后端若保留原始请求体会以 payload/requestBody
 * 形式返回，这里兼容读取，缺失时由调用方展示替代说明。
 */
export function deliveryPayload(delivery: WebhookDelivery): { text: string; json: boolean } | null {
  const record = delivery as unknown as Record<string, unknown>;
  const value = record.payload ?? record.requestBody ?? record.body;
  if (value === null || value === undefined) return null;
  return formatBody(value);
}
