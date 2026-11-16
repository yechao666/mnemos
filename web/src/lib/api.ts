import type {
  AddMemoryResult,
  Agent,
  AgentInput,
  BackupInfo,
  Briefing,
  CreateUserInput,
  FinishTaskInput,
  MaintenanceRun,
  OpsMaintenanceInput,
  OpsMaintenanceResult,
  OpsStatus,
  OrgUser,
  PasswordChangeInput,
  ProjectExport,
  ResetPasswordResult,
  Task,
  TaskInput,
  UpdateUserInput,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  WebhookInput,
  WebhookStats,
  WebhookTestResult,
  WebhookWithSecret,
  ApiKey,
  ApiKeyWithSecret,
  AuditLog,
  AuthResponse,
  BulkMemoryInput,
  ChatMessage,
  DashboardSummary,
  DemoAccount,
  ExtractionMode,
  GraphData,
  LiveEvent,
  Memory,
  MemoryBrief,
  MemoryCategory,
  MemoryDetail,
  MemoryDreamResult,
  MemoryDreamStatus,
  MemoryReport,
  MemoryHistoryEntry,
  MemoryStatus,
  Org,
  Paginated,
  Project,
  ProjectMember,
  ProjectOverview,
  ProjectSettings,
  ProjectSummary,
  Role,
  SearchHit,
  SearchResponse,
  UpdateMemoryInput,
  UsageAnalytics,
  User,
} from '@shared';

const TOKEN_KEY = 'mnemos.session';
const UNAUTHORIZED_EVENT = 'mnemos:unauthorized';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下忽略 */
  }
}

function qs(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    sp.set(key, String(value));
  }
  const text = sp.toString();
  return text ? `?${text}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, 'network_error', '无法连接 Mnemos 服务，请确认后端已启动。');
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      setToken(null);
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    const body = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? `http_${response.status}`,
      body?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      body?.error?.details,
    );
  }

  return payload as T;
}

export interface MemoryListParams {
  q?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  /** 归属过滤：只看该 Agent 写入的记忆 */
  writtenByAgentId?: string;
  /** 仅看某个任务写入的记忆 */
  taskId?: string;
  /** 可见性过滤：project / agent / task */
  visibility?: 'project' | 'agent' | 'task' | '';
  /** 控制台观测视角：包含其他 Agent 的私有记忆 */
  includePrivate?: boolean;
  category?: MemoryCategory | '';
  status?: MemoryStatus | '';
  page?: number;
  pageSize?: number;
  sort?: 'recent' | 'importance' | 'accessed';
}

export type MemoryListResponse = Paginated<Memory> & { hits?: SearchHit[]; tookMs?: number };

export interface PlaygroundAddInput {
  messages?: ChatMessage[];
  text?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  infer?: boolean;
  mode?: ExtractionMode;
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
    me: () => request<{ user: User; org: Org; projects: Project[] }>('/api/auth/me'),
    demoAccounts: () => request<DemoAccount[]>('/api/auth/demo-accounts'),
  },

  dashboard: () => request<DashboardSummary>('/api/dashboard'),

  projects: {
    list: () => request<ProjectSummary[]>('/api/projects'),
    create: (input: {
      name: string;
      slug?: string;
      description?: string;
      region?: string;
      env?: string;
      settings?: Partial<ProjectSettings>;
    }) => request<ProjectSummary>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
    get: (projectId: string) => request<ProjectSummary & { health?: ProjectOverview['health'] }>(`/api/projects/${projectId}`),
    update: (projectId: string, input: Partial<Pick<Project, 'name' | 'slug' | 'description' | 'status' | 'region' | 'env'>>) =>
      request<ProjectSummary>(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    remove: (projectId: string) => request<{ ok: boolean }>(`/api/projects/${projectId}`, { method: 'DELETE' }),
    overview: (projectId: string) => request<ProjectOverview>(`/api/projects/${projectId}/overview`),
    usage: (projectId: string, days = 30) =>
      request<UsageAnalytics>(`/api/projects/${projectId}/usage${qs({ days })}`),
    audit: (projectId: string, params: { page?: number; pageSize?: number; action?: string; actor?: string } = {}) =>
      request<Paginated<AuditLog>>(`/api/projects/${projectId}/audit${qs(params)}`),
    settings: {
      update: (projectId: string, settings: Partial<ProjectSettings>) =>
        request<ProjectSummary>(`/api/projects/${projectId}/settings`, {
          method: 'PATCH',
          body: JSON.stringify(settings),
        }),
    },
    members: {
      list: (projectId: string) => request<ProjectMember[]>(`/api/projects/${projectId}/members`),
      add: (projectId: string, input: { email?: string; userId?: string; role: Role }) =>
        request<ProjectMember[]>(`/api/projects/${projectId}/members`, { method: 'POST', body: JSON.stringify(input) }),
      update: (projectId: string, userId: string, role: Role) =>
        request<ProjectMember[]>(`/api/projects/${projectId}/members/${userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        }),
      remove: (projectId: string, userId: string) =>
        request<{ ok: boolean }>(`/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
    },
    keys: {
      list: (projectId: string) => request<ApiKey[]>(`/api/projects/${projectId}/keys`),
      create: (
        projectId: string,
        input: {
          name: string;
          scopes: ApiKey['scopes'];
          rateLimitPerMin?: number;
          expiresAt?: string;
          allowedIps?: string[];
        },
      ) => request<ApiKeyWithSecret>(`/api/projects/${projectId}/keys`, { method: 'POST', body: JSON.stringify(input) }),
      rotate: (projectId: string, keyId: string, graceHours = 0) =>
        request<ApiKeyWithSecret>(`/api/projects/${projectId}/keys/${keyId}/rotate`, {
          method: 'POST',
          body: JSON.stringify({ graceHours }),
        }),
      revoke: (projectId: string, keyId: string) =>
        request<{ ok: boolean }>(`/api/projects/${projectId}/keys/${keyId}`, { method: 'DELETE' }),
    },
  },

  memories: {
    list: (projectId: string, params: MemoryListParams = {}) =>
      request<MemoryListResponse>(`/api/projects/${projectId}/memories${qs({ ...params })}`),
    get: (id: string) => request<MemoryDetail>(`/api/memories/${id}`),
    update: (id: string, input: UpdateMemoryInput) =>
      request<Memory>(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    remove: (id: string) => request<{ ok: boolean }>(`/api/memories/${id}`, { method: 'DELETE' }),
    bulk: (input: BulkMemoryInput) =>
      request<{ affected: number }>('/api/memories/bulk', { method: 'POST', body: JSON.stringify(input) }),
    history: (id: string) => request<MemoryHistoryEntry[]>(`/api/memories/${id}/history`),
    feedback: (id: string, input: { helpful: boolean; query?: string }) =>
      request<Memory>(`/api/memories/${id}/feedback`, { method: 'POST', body: JSON.stringify(input) }),
  },

  /**
   * 记忆简报：最近活跃记忆/洞见压缩成的可注入文本。
   * 可能触发 LLM 润色（较慢），force=true 时忽略缓存重新生成。GET 需 viewer。
   */
  memoryBrief: (projectId: string, params: { force?: boolean; agentId?: string; maxChars?: number } = {}) =>
    request<MemoryBrief>(`/api/projects/${projectId}/memory/brief${qs(params)}`),

  /** 保存简报字数上限（需 admin；保存后立即重新生成）。 */
  updateMemoryBriefSettings: (projectId: string, maxChars: number) =>
    request<MemoryBrief>(`/api/projects/${projectId}/memory/brief`, {
      method: 'PATCH',
      body: JSON.stringify({ maxChars }),
    }),

  /** 项目周报/月报：按自然周或自然月聚合结构化项目记录。 */
  memoryReport: (projectId: string, params: { period?: 'week' | 'month'; anchor?: string } = {}) =>
    request<MemoryReport>(`/api/projects/${projectId}/memory/reports${qs(params)}`),

  /** 复盘总结（增量记忆巩固）状态：设置、待整理数量与最近运行记录。 */
  memoryDream: (projectId: string) => request<MemoryDreamStatus>(`/api/projects/${projectId}/memory/dream`),

  /** 更新复盘总结开关与周期（需 admin）。 */
  updateMemoryDream: (projectId: string, input: { enabled?: boolean; intervalMinutes?: number }) =>
    request<MemoryDreamStatus>(`/api/projects/${projectId}/memory/dream`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /** 立即执行一次复盘总结（需 admin）；该项目正在复盘总结时后端返回 409。 */
  runMemoryDream: (projectId: string) =>
    request<MemoryDreamResult>(`/api/projects/${projectId}/memory/dream/run`, {
      method: 'POST',
      body: '{}',
    }),

  agents: {
    list: (projectId: string) => request<Agent[]>(`/api/projects/${projectId}/agents`),
    create: (projectId: string, input: AgentInput) =>
      request<Agent>(`/api/projects/${projectId}/agents`, { method: 'POST', body: JSON.stringify(input) }),
    update: (projectId: string, agentId: string, input: Partial<AgentInput>) =>
      request<Agent>(`/api/projects/${projectId}/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
  },

  tasks: {
    list: (projectId: string, params: { status?: string; agentId?: string; limit?: number } = {}) =>
      request<Task[]>(`/api/projects/${projectId}/tasks${qs(params)}`),
    get: (taskId: string) => request<Task>(`/api/tasks/${taskId}`),
    create: (projectId: string, input: TaskInput) =>
      request<Task>(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(input) }),
    update: (taskId: string, input: Partial<TaskInput> & { summary?: string }) =>
      request<Task>(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    finish: (taskId: string, input: FinishTaskInput) =>
      request<{ task: Task; memories: Memory[] }>(`/api/tasks/${taskId}/finish`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },

  briefing: (projectId: string, params: { agentId?: string; taskId?: string; query?: string } = {}) =>
    request<Briefing>(`/api/projects/${projectId}/briefing${qs(params)}`),

  graph: (projectId: string, limit = 120) =>
    request<GraphData>(`/api/projects/${projectId}/graph${qs({ limit })}`),

  playground: {
    add: (projectId: string, input: PlaygroundAddInput) =>
      request<AddMemoryResult>(`/api/projects/${projectId}/playground/add`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    search: (projectId: string, input: { query: string; userId?: string; agentId?: string; topK?: number; threshold?: number }) =>
      request<SearchResponse>(`/api/projects/${projectId}/playground/search`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },

  /** 组织成员管理（admin+） */
  org: {
    users: {
      list: () => request<OrgUser[]>('/api/org/users'),
      create: (input: CreateUserInput) =>
        request<{ user: OrgUser; temporaryPassword: string }>('/api/org/users', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      update: (userId: string, input: UpdateUserInput) =>
        request<OrgUser>(`/api/org/users/${userId}`, { method: 'PATCH', body: JSON.stringify(input) }),
      resetPassword: (userId: string) =>
        request<ResetPasswordResult>(`/api/org/users/${userId}/reset-password`, { method: 'POST' }),
    },
  },

  /** 生产运维（admin+） */
  ops: {
    status: () => request<OpsStatus>('/api/ops/status'),
    maintenance: (input: OpsMaintenanceInput = {}) =>
      request<OpsMaintenanceResult>('/api/ops/maintenance', { method: 'POST', body: JSON.stringify(input) }),
    maintenanceHistory: (limit = 20) =>
      request<MaintenanceRun[]>(`/api/ops/maintenance?limit=${limit}`),
    backups: {
      list: () => request<BackupInfo[]>('/api/ops/backups'),
      create: () => request<BackupInfo>('/api/ops/backup', { method: 'POST', body: '{}' }),
      download: async (file: string): Promise<Blob> => {
        const token = getToken();
        const res = await fetch(`/api/ops/backups/${encodeURIComponent(file)}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new ApiError(res.status, 'download_failed', '备份下载失败');
        return res.blob();
      },
    },
  },

  authPassword: {
    change: (input: PasswordChangeInput) =>
      request<{ ok: boolean }>('/api/auth/password', { method: 'PATCH', body: JSON.stringify(input) }),
  },

  webhooks: {
    list: (projectId: string) => request<Webhook[]>(`/api/projects/${projectId}/webhooks`),
    stats: (projectId: string) => request<WebhookStats>(`/api/projects/${projectId}/webhooks/stats`),
    eventTypes: () =>
      request<{ type: WebhookEventType; label: string; description: string }[]>('/api/webhooks/event-types'),
    create: (projectId: string, input: WebhookInput) =>
      request<WebhookWithSecret>(`/api/projects/${projectId}/webhooks`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (webhookId: string, input: Partial<WebhookInput>) =>
      request<Webhook>(`/api/webhooks/${webhookId}`, { method: 'PATCH', body: JSON.stringify(input) }),
    remove: (webhookId: string) => request<{ ok: boolean }>(`/api/webhooks/${webhookId}`, { method: 'DELETE' }),
    rotateSecret: (webhookId: string) =>
      request<WebhookWithSecret>(`/api/webhooks/${webhookId}/rotate-secret`, { method: 'POST' }),
    test: (webhookId: string) =>
      request<WebhookTestResult>(`/api/webhooks/${webhookId}/test`, { method: 'POST' }),
    deliveries: (webhookId: string, params: { page?: number; pageSize?: number; status?: string } = {}) =>
      request<Paginated<WebhookDelivery>>(`/api/webhooks/${webhookId}/deliveries${qs(params)}`),
    delivery: (deliveryId: string) => request<WebhookDelivery>(`/api/webhooks/deliveries/${deliveryId}`),
    replay: (deliveryId: string) =>
      request<WebhookDelivery>(`/api/webhooks/deliveries/${deliveryId}/replay`, { method: 'POST' }),
  },

  exportProject: (projectId: string) => request<ProjectExport>(`/api/projects/${projectId}/export`),

  health: () => request<{ ok: boolean; version: string; uptimeMs: number }>('/api/health'),

  subscribeEvents(onEvent: (event: LiveEvent) => void): () => void {
    const token = getToken();
    if (!token) return () => undefined;
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data) as LiveEvent);
      } catch {
        /* 忽略无法解析的事件 */
      }
    };
    return () => source.close();
  },
};

export { UNAUTHORIZED_EVENT };
