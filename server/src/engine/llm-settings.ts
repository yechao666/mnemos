/**
 * v6.4 大模型设置（schema v10）：供应商 CRUD / 阶段配置 / 测试连接 / 用量 / 状态。
 *
 * - `api_key_cipher` 用 lib/crypto 的 AES-256-GCM 加密（MNEMOS_ENCRYPTION_KEY）；
 *   未配置密钥时明文存储并标记 `api_key_encrypted=0`。
 * - API 侧永不回显明文，只返回 `hasApiKey` + `apiKeyMasked`。
 * - 本模块只做数据与协议层，审计由 engine/service.ts 统一写。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  LlmProvider,
  LlmProviderInput,
  LlmProtocol,
  LlmStage,
  LlmStageConfig,
  LlmStageConfigInput,
  LlmStatus,
  LlmTestResult,
  LlmUsageSummary,
} from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { decryptField, encryptField, encryptionKeyFromEnv } from '../lib/crypto.ts';
import { isoDaysAgo, newId, nowIso } from '../lib/ids.ts';
import { engineErrors } from './errors.ts';

/** 阶段枚举（顺序即 UI 表格 / usage 排序）。 */
export const LLM_STAGES: LlmStage[] = ['brief', 'dream', 'profile', 'privacy', 'extract'];

/** 未配置阶段时的默认参数（GET /api/llm/stages 补全、upsert 缺省值）。 */
export const LLM_STAGE_DEFAULTS = {
  temperature: 0.2,
  maxTokens: 1024,
  timeoutMs: 20_000,
} as const;

const TEST_TIMEOUT_MS = 15_000;
const TEST_MAX_TOKENS = 8;
const TEST_DEFAULT_MODEL = 'gpt-4o-mini';

interface ProviderRow {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  default_model: string | null;
  api_key_cipher: string;
  api_key_encrypted: number;
  input_price: number;
  output_price: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface StageRow {
  stage: string;
  provider_id: string | null;
  model: string | null;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  system_prompt: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function isLlmStage(value: string): value is LlmStage {
  return (LLM_STAGES as string[]).includes(value);
}

function normalizeProtocol(value: unknown): LlmProtocol {
  if (value === undefined || value === null || value === '') return 'openai';
  if (value === 'openai' || value === 'anthropic') return value;
  throw engineErrors.validation('protocol 只支持 openai / anthropic');
}

function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw engineErrors.validation('供应商名称不能为空');
  if (name.length > 80) throw engineErrors.validation('供应商名称最长 80 字符');
  return name;
}

function normalizeBaseUrl(value: unknown): string {
  const baseUrl = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (!baseUrl) throw engineErrors.validation('baseUrl 不能为空');
  if (baseUrl.length > 500) throw engineErrors.validation('baseUrl 最长 500 字符');
  if (!/^https?:\/\//i.test(baseUrl)) throw engineErrors.validation('baseUrl 必须以 http:// 或 https:// 开头');
  return baseUrl;
}

function normalizeModel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw engineErrors.validation('model 必须是字符串');
  const model = value.trim();
  if (model.length > 200) throw engineErrors.validation('model 最长 200 字符');
  return model || undefined;
}

function normalizePrice(value: unknown, label: string): number {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) throw engineErrors.validation(`${label} 必须是非负数`);
  if (price > 1_000_000) throw engineErrors.validation(`${label} 过大`);
  return price;
}

function normalizeTemperature(value: unknown): number {
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw engineErrors.validation('temperature 必须在 0–2 之间');
  }
  return temperature;
}

function normalizeMaxTokens(value: unknown): number {
  const maxTokens = Number(value);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8_192) {
    throw engineErrors.validation('maxTokens 必须是 1–8192 的整数');
  }
  return maxTokens;
}

function normalizeTimeout(value: unknown): number {
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw engineErrors.validation('timeoutMs 必须是 1000–120000 的整数');
  }
  return timeoutMs;
}

function normalizeSystemPrompt(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw engineErrors.validation('systemPrompt 必须是字符串');
  if (value.length > 8_000) throw engineErrors.validation('systemPrompt 最长 8000 字符');
  return value.trim() || undefined;
}

/** 掩码：前 3 + … + 后 4；短 key 全遮，避免任何可还原信息。 */
function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function decryptApiKey(row: ProviderRow): string {
  const cipher = row.api_key_cipher ?? '';
  if (!cipher) return '';
  if (!row.api_key_encrypted) return cipher;
  try {
    return decryptField(cipher, encryptionKeyFromEnv());
  } catch {
    return '';
  }
}

function toProvider(row: ProviderRow): LlmProvider {
  const key = decryptApiKey(row);
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: row.base_url,
    ...(row.default_model ? { defaultModel: row.default_model } : {}),
    hasApiKey: Boolean(row.api_key_cipher),
    ...(row.api_key_cipher ? { apiKeyMasked: maskApiKey(key) } : {}),
    inputPrice: row.input_price,
    outputPrice: row.output_price,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStageConfig(row: StageRow): LlmStageConfig {
  return {
    stage: row.stage as LlmStage,
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.model ? { model: row.model } : {}),
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    timeoutMs: row.timeout_ms,
    ...(row.system_prompt ? { systemPrompt: row.system_prompt } : {}),
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

function defaultStageConfig(stage: LlmStage): LlmStageConfig {
  return {
    stage,
    temperature: LLM_STAGE_DEFAULTS.temperature,
    maxTokens: LLM_STAGE_DEFAULTS.maxTokens,
    timeoutMs: LLM_STAGE_DEFAULTS.timeoutMs,
    enabled: true,
  };
}

function findProviderRow(db: DatabaseSync, id: string): ProviderRow | undefined {
  return db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id) as unknown as ProviderRow | undefined;
}

function assertProviderNameFree(db: DatabaseSync, name: string, excludeId?: string): void {
  const row = db
    .prepare('SELECT id FROM llm_providers WHERE name = ? AND id != ?')
    .get(name, excludeId ?? '') as unknown as { id: string } | undefined;
  if (row) throw engineErrors.conflict(`供应商名称「${name}」已存在`);
}

/* ------------------------------------------------------------------ */
/* 供应商 CRUD                                                         */
/* ------------------------------------------------------------------ */

export function listLlmProviders(db: DatabaseSync): LlmProvider[] {
  const rows = db
    .prepare('SELECT * FROM llm_providers ORDER BY created_at ASC, rowid ASC')
    .all() as unknown as ProviderRow[];
  return rows.map(toProvider);
}

export function createLlmProvider(db: DatabaseSync, input: LlmProviderInput): LlmProvider {
  const name = normalizeName(input.name);
  const protocol = normalizeProtocol(input.protocol);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const defaultModel = normalizeModel(input.defaultModel);
  const inputPrice = input.inputPrice === undefined ? 0 : normalizePrice(input.inputPrice, 'inputPrice');
  const outputPrice = input.outputPrice === undefined ? 0 : normalizePrice(input.outputPrice, 'outputPrice');
  assertProviderNameFree(db, name);

  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const encryptionKey = encryptionKeyFromEnv();
  const encrypted = apiKey !== '' && encryptionKey !== null;
  const cipher = apiKey === '' ? '' : encrypted ? encryptField(apiKey, encryptionKey) : apiKey;
  const at = nowIso();
  const id = newId('llm');
  db.prepare(
    `INSERT INTO llm_providers
       (id, name, protocol, base_url, default_model, api_key_cipher, api_key_encrypted,
        input_price, output_price, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    protocol,
    baseUrl,
    defaultModel ?? null,
    cipher,
    encrypted ? 1 : 0,
    inputPrice,
    outputPrice,
    input.enabled === false ? 0 : 1,
    at,
    at,
  );
  const row = findProviderRow(db, id);
  if (!row) throw new Error('供应商写入失败');
  return toProvider(row);
}

export function updateLlmProvider(db: DatabaseSync, id: string, input: Partial<LlmProviderInput>): LlmProvider {
  const current = findProviderRow(db, id);
  if (!current) throw engineErrors.notFound('供应商不存在');

  const name = input.name === undefined ? current.name : normalizeName(input.name);
  if (name !== current.name) assertProviderNameFree(db, name, id);
  const protocol = input.protocol === undefined ? current.protocol : normalizeProtocol(input.protocol);
  const baseUrl = input.baseUrl === undefined ? current.base_url : normalizeBaseUrl(input.baseUrl);
  const defaultModel =
    input.defaultModel === undefined ? current.default_model ?? undefined : normalizeModel(input.defaultModel);
  const inputPrice =
    input.inputPrice === undefined ? current.input_price : normalizePrice(input.inputPrice, 'inputPrice');
  const outputPrice =
    input.outputPrice === undefined ? current.output_price : normalizePrice(input.outputPrice, 'outputPrice');
  const enabled = input.enabled === undefined ? current.enabled === 1 : input.enabled !== false;

  let cipher = current.api_key_cipher;
  let encrypted = current.api_key_encrypted;
  if (input.clearApiKey === true) {
    cipher = '';
    encrypted = 0;
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim() !== '') {
    const apiKey = input.apiKey.trim();
    const encryptionKey = encryptionKeyFromEnv();
    encrypted = encryptionKey !== null ? 1 : 0;
    cipher = encryptionKey !== null ? encryptField(apiKey, encryptionKey) : apiKey;
  }

  db.prepare(
    `UPDATE llm_providers SET
       name = ?, protocol = ?, base_url = ?, default_model = ?, api_key_cipher = ?, api_key_encrypted = ?,
       input_price = ?, output_price = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    protocol,
    baseUrl,
    defaultModel ?? null,
    cipher,
    encrypted,
    inputPrice,
    outputPrice,
    enabled ? 1 : 0,
    nowIso(),
    id,
  );
  const row = findProviderRow(db, id);
  if (!row) throw new Error('供应商更新失败');
  return toProvider(row);
}

export function deleteLlmProvider(db: DatabaseSync, id: string): void {
  const row = findProviderRow(db, id);
  if (!row) throw engineErrors.notFound('供应商不存在');
  db.prepare('DELETE FROM llm_providers WHERE id = ?').run(id);
  // 阶段配置保留，但解除引用（避免删除后 select 指向幽灵 id）。
  db.prepare('UPDATE llm_stage_configs SET provider_id = NULL, updated_at = ? WHERE provider_id = ?').run(nowIso(), id);
}

/* ------------------------------------------------------------------ */
/* 阶段配置                                                            */
/* ------------------------------------------------------------------ */

export function listLlmStages(db: DatabaseSync): LlmStageConfig[] {
  const rows = db.prepare('SELECT * FROM llm_stage_configs').all() as unknown as StageRow[];
  const byStage = new Map(rows.map((row) => [row.stage, row]));
  return LLM_STAGES.map((stage) => {
    const row = byStage.get(stage);
    return row ? toStageConfig(row) : defaultStageConfig(stage);
  });
}

/** 读取原始阶段行（router 内部用；无行返回 undefined）。 */
export function findLlmStageRow(db: DatabaseSync, stage: LlmStage): StageRow | undefined {
  return db.prepare('SELECT * FROM llm_stage_configs WHERE stage = ?').get(stage) as unknown as StageRow | undefined;
}

export function upsertLlmStage(db: DatabaseSync, stage: LlmStage, input: LlmStageConfigInput): LlmStageConfig {
  if (!isLlmStage(stage)) throw engineErrors.validation(`未知阶段：${stage}`);
  const current = findLlmStageRow(db, stage);

  let providerId: string | null;
  if (input.providerId === undefined) providerId = current?.provider_id ?? null;
  else if (input.providerId === null || input.providerId === '') providerId = null;
  else {
    providerId = String(input.providerId);
    if (!findProviderRow(db, providerId)) throw engineErrors.notFound('供应商不存在');
  }

  const model = input.model === undefined ? current?.model ?? null : normalizeModel(input.model) ?? null;
  const temperature =
    input.temperature === undefined
      ? current?.temperature ?? LLM_STAGE_DEFAULTS.temperature
      : normalizeTemperature(input.temperature);
  const maxTokens =
    input.maxTokens === undefined
      ? current?.max_tokens ?? LLM_STAGE_DEFAULTS.maxTokens
      : normalizeMaxTokens(input.maxTokens);
  const timeoutMs =
    input.timeoutMs === undefined
      ? current?.timeout_ms ?? LLM_STAGE_DEFAULTS.timeoutMs
      : normalizeTimeout(input.timeoutMs);
  const systemPrompt =
    input.systemPrompt === undefined
      ? current?.system_prompt ?? null
      : normalizeSystemPrompt(input.systemPrompt) ?? null;
  const enabled = input.enabled === undefined ? (current ? current.enabled === 1 : true) : input.enabled !== false;
  const at = nowIso();

  db.prepare(
    `INSERT INTO llm_stage_configs
       (stage, provider_id, model, temperature, max_tokens, timeout_ms, system_prompt, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stage) DO UPDATE SET
       provider_id = excluded.provider_id,
       model = excluded.model,
       temperature = excluded.temperature,
       max_tokens = excluded.max_tokens,
       timeout_ms = excluded.timeout_ms,
       system_prompt = excluded.system_prompt,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  ).run(stage, providerId, model, temperature, maxTokens, timeoutMs, systemPrompt, enabled ? 1 : 0, at, at);

  const row = findLlmStageRow(db, stage);
  if (!row) throw new Error('阶段配置写入失败');
  return toStageConfig(row);
}

/* ------------------------------------------------------------------ */
/* 测试连接                                                            */
/* ------------------------------------------------------------------ */

interface TestEndpoint {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function testEndpointOf(provider: ProviderRow, apiKey: string): TestEndpoint | null {
  const model = (provider.default_model ?? '').trim() || TEST_DEFAULT_MODEL;
  const baseUrl = (provider.base_url ?? '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  if (provider.protocol === 'anthropic') {
    const url = baseUrl.endsWith('/messages')
      ? baseUrl
      : baseUrl.endsWith('/v1')
        ? `${baseUrl}/messages`
        : `${baseUrl}/v1/messages`;
    return {
      url,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: TEST_MAX_TOKENS,
        temperature: 0,
      }),
    };
  }
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  return {
    url,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: TEST_MAX_TOKENS,
      temperature: 0,
    }),
  };
}

/** 发一条最小请求验证供应商连通性；失败返回 ok=false + error，不抛错。 */
export async function testLlmProvider(db: DatabaseSync, id: string): Promise<LlmTestResult> {
  const provider = findProviderRow(db, id);
  if (!provider) throw engineErrors.notFound('供应商不存在');
  const model = (provider.default_model ?? '').trim() || TEST_DEFAULT_MODEL;
  const apiKey = decryptApiKey(provider);
  if (!apiKey) return { ok: false, model, error: '未配置 API Key（或无法解密，请检查 MNEMOS_ENCRYPTION_KEY）' };
  const endpoint = testEndpointOf(provider, apiKey);
  if (!endpoint) return { ok: false, model, error: 'baseUrl 为空' };

  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers,
      body: endpoint.body,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).trim().slice(0, 200);
      } catch {
        /* 忽略读取错误 */
      }
      return {
        ok: false,
        latencyMs,
        model,
        error: detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`,
      };
    }
    // 结构解析失败同样视为失败（说明端点/协议不匹配）。
    try {
      await response.json();
    } catch {
      return { ok: false, latencyMs, model, error: '响应不是合法 JSON（baseUrl/协议可能不匹配）' };
    }
    return { ok: true, latencyMs, model };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      latencyMs,
      model,
      error: name === 'TimeoutError' || name === 'AbortError' ? `请求超时（${TEST_TIMEOUT_MS}ms）` : message.slice(0, 300),
    };
  }
}

/* ------------------------------------------------------------------ */
/* 用量 / 状态                                                         */
/* ------------------------------------------------------------------ */

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** 按阶段聚合近 N 天调用（含失败调用；test 连接请求不落 llm_calls）。 */
export function llmUsage(db: DatabaseSync, days: number): LlmUsageSummary[] {
  const span = Math.min(90, Math.max(1, Math.trunc(Number.isFinite(days) ? days : 30)));
  const since = isoDaysAgo(span);
  const rows = db
    .prepare(
      `SELECT c.stage AS stage,
              COUNT(*) AS calls,
              COALESCE(SUM(c.prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(c.completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(c.prompt_tokens * COALESCE(p.input_price, 0)
                         + c.completion_tokens * COALESCE(p.output_price, 0)), 0) AS cost
         FROM llm_calls c
         LEFT JOIN llm_providers p ON p.id = c.provider_id
        WHERE c.created_at >= ?
        GROUP BY c.stage`,
    )
    .all(since) as unknown as Array<{
    stage: string;
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost: number;
  }>;

  const byStage = new Map(rows.map((row) => [row.stage, row]));
  const result: LlmUsageSummary[] = [];
  for (const stage of LLM_STAGES) {
    const row = byStage.get(stage);
    if (!row) continue;
    result.push({
      stage,
      calls: Number(row.calls) || 0,
      promptTokens: Number(row.prompt_tokens) || 0,
      completionTokens: Number(row.completion_tokens) || 0,
      estimatedCost: roundCost((Number(row.cost) || 0) / 1_000_000),
    });
  }
  return result;
}

export function llmStatus(db: DatabaseSync, fallback: LlmConfig | null): LlmStatus {
  const providers = db.prepare('SELECT COUNT(*) AS c FROM llm_providers').get() as unknown as { c: number };
  const stages = db.prepare('SELECT COUNT(*) AS c FROM llm_stage_configs').get() as unknown as { c: number };
  return {
    envFallbackConfigured: Boolean(fallback?.baseUrl && fallback?.apiKey && fallback?.model),
    providers: Number(providers?.c) || 0,
    stages: Number(stages?.c) || 0,
    encryptionConfigured: encryptionKeyFromEnv() !== null,
  };
}
