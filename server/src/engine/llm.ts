/**
 * 可选的大模型文本调用（v6.4：供应商 + 按阶段路由）。
 *
 * 设计原则：LLM 只是「增强」，绝不阻断主流程——
 * 未配置 / 超时 / 非 2xx / 响应结构异常一律返回空串，不抛错。
 * 调用方拿到空串时回退到确定性算法（简报压缩、做梦规则归并）。
 *
 * 解析顺序（docs/llm-settings.md 第 2 节）：
 * 1. `llm_stage_configs` 里该 stage 的配置（enabled=1 + provider enabled=1 + 有 model/key）→ 用该供应商；
 * 2. 无阶段配置 / 配置不完整 → 回退环境变量 `MNEMOS_LLM_*`（v6.3 兼容，OpenAI 协议）；
 * 3. 都没有 → 返回 ''（调用方走确定性逻辑）。
 *
 * 存在阶段配置但 `enabled=0`、或供应商被显式禁用时，直接返回 ''（不静默改用 env key，
 * 避免运维禁用供应商后数据仍被发往环境变量里的模型）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { LlmProtocol, LlmStage } from '../../../shared/src/types.ts';
import type { LlmConfig } from '../env.ts';
import { decryptField, encryptionKeyFromEnv } from '../lib/crypto.ts';
import { newId, nowIso } from '../lib/ids.ts';

export interface LlmTextInput {
  prompt: string;
  system?: string;
  /** 期望的最大字符数；同时用于推导 max_tokens（无阶段配置时）。 */
  maxChars?: number;
  timeoutMs?: number;
}

/** v6.4：按阶段取模型文本的客户端（router 或测试 fake）。 */
export interface LlmClient {
  text(stage: LlmStage, input: LlmTextInput): Promise<string>;
  /** 可选：缓存指纹 / 展示用的模型标识（无阶段配置时返回 env fallback 模型）。 */
  modelOf?(stage: LlmStage): string;
}

/** 调用方兼容类型：新 router、旧的 env LlmConfig（测试 fake）或 null。 */
export type LlmLike = LlmClient | LlmConfig | null;

const DEFAULT_TIMEOUT_MS = 20_000;

interface StageRow {
  stage: string;
  provider_id: string | null;
  model: string | null;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  system_prompt: string | null;
  enabled: number;
}

interface ProviderRow {
  id: string;
  name: string;
  protocol: string;
  base_url: string;
  default_model: string | null;
  api_key_cipher: string;
  api_key_encrypted: number;
  enabled: number;
}

interface RawCallUsage {
  promptTokens: number;
  completionTokens: number;
}

interface ResolvedCall {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** 阶段级系统提示词（覆盖内置）；缺省用调用方传入的 input.system。 */
  systemPrompt?: string;
  providerId: string | null;
}

type Resolution =
  | { kind: 'use'; call: ResolvedCall }
  | { kind: 'fallback' }
  | { kind: 'skip' };

function endpointOf(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/** Anthropic：baseUrl 已带 /messages 或 /v1 时不重复拼。 */
function anthropicEndpointOf(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/messages')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function maxTokensOf(maxChars: number | undefined): number {
  const chars = maxChars && maxChars > 0 ? maxChars : 800;
  return Math.min(4_096, Math.max(256, Math.ceil(chars * 2)));
}

/** 解密供应商密钥：明文（encrypted=0）原样返回；密文解密失败返回 ''（视为不可用）。 */
export function decryptProviderApiKey(cipher: string, encrypted: number | boolean): string {
  if (!cipher) return '';
  if (!encrypted) return cipher;
  try {
    return decryptField(cipher, encryptionKeyFromEnv());
  } catch {
    return '';
  }
}

function usableFallback(fallback: LlmConfig | null): LlmConfig | null {
  if (!fallback || !fallback.baseUrl || !fallback.apiKey || !fallback.model) return null;
  return fallback;
}

export function isLlmClient(llm: LlmLike): llm is LlmClient {
  return Boolean(llm) && typeof (llm as LlmClient).text === 'function';
}

/** 用于简报缓存指纹 / 展示的模型标识：router 取当前 stage 解析结果，LlmConfig 取 model。 */
export function llmModelLabel(llm: LlmLike, stage: LlmStage): string {
  if (!llm) return '';
  if (isLlmClient(llm)) return llm.modelOf?.(stage) ?? '';
  return llm.model;
}

function recordCall(
  db: DatabaseSync,
  input: {
    stage: LlmStage;
    providerId: string | null;
    model: string;
    protocol: LlmProtocol;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    status: 'ok' | 'error' | 'timeout';
    error?: string;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO llm_calls
         (id, stage, provider_id, model, protocol, prompt_tokens, completion_tokens,
          duration_ms, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('llc'),
      input.stage,
      input.providerId,
      input.model,
      input.protocol,
      Math.max(0, Math.round(input.promptTokens)),
      Math.max(0, Math.round(input.completionTokens)),
      Math.max(0, Math.round(input.durationMs)),
      input.status,
      input.error ? input.error.slice(0, 500) : null,
      nowIso(),
    );
  } catch {
    /* 记录失败不影响主流程（例如测试中 DB 已关闭）。 */
  }
}

/* ------------------------------------------------------------------ */
/* 请求与响应解析                                                       */
/* ------------------------------------------------------------------ */

interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function buildWireRequest(call: ResolvedCall, input: LlmTextInput): WireRequest {
  const system = call.systemPrompt?.trim() || input.system;
  if (call.protocol === 'anthropic') {
    const body: Record<string, unknown> = {
      model: call.model,
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: call.maxTokens,
      temperature: call.temperature,
    };
    if (system) body.system = system;
    return {
      url: anthropicEndpointOf(call.baseUrl),
      headers: {
        'content-type': 'application/json',
        'x-api-key': call.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    };
  }
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: input.prompt });
  return {
    url: endpointOf(call.baseUrl),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${call.apiKey}`,
    },
    body: JSON.stringify({
      model: call.model,
      messages,
      temperature: call.temperature,
      max_tokens: call.maxTokens,
    }),
  };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (part && typeof part === 'object') {
        const typed = part as { type?: unknown; text?: unknown };
        if (typeof typed.text === 'string') parts.push(typed.text);
      }
    }
    return parts.join('');
  }
  return '';
}

function parseText(payload: unknown, protocol: LlmProtocol): string {
  if (!payload || typeof payload !== 'object') return '';
  if (protocol === 'anthropic') {
    const content = (payload as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const typed = block as { type?: unknown; text?: unknown };
        if (typeof typed.text === 'string' && (!typed.type || typed.type === 'text')) return typed.text.trim();
      }
      return '';
    }
    return typeof content === 'string' ? content.trim() : '';
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return textOfContent(first?.message?.content).trim();
}

function parseUsage(payload: unknown, protocol: LlmProtocol): RawCallUsage {
  const usage = payload && typeof payload === 'object' ? (payload as { usage?: Record<string, unknown> }).usage : undefined;
  if (!usage || typeof usage !== 'object') return { promptTokens: 0, completionTokens: 0 };
  const read = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  if (protocol === 'anthropic') {
    return { promptTokens: read(usage.input_tokens), completionTokens: read(usage.output_tokens) };
  }
  return { promptTokens: read(usage.prompt_tokens), completionTokens: read(usage.completion_tokens) };
}

async function invoke(db: DatabaseSync, stage: LlmStage, call: ResolvedCall, input: LlmTextInput): Promise<string> {
  const wire = buildWireRequest(call, input);
  const startedAt = Date.now();
  let durationMs = 0;
  try {
    const response = await fetch(wire.url, {
      method: 'POST',
      headers: wire.headers,
      body: wire.body,
      signal: AbortSignal.timeout(call.timeoutMs),
    });
    durationMs = Date.now() - startedAt;
    if (!response.ok) {
      recordCall(db, {
        stage,
        providerId: call.providerId,
        model: call.model,
        protocol: call.protocol,
        promptTokens: 0,
        completionTokens: 0,
        durationMs,
        status: 'error',
        error: `HTTP ${response.status}`,
      });
      return '';
    }
    const payload = (await response.json()) as unknown;
    const text = parseText(payload, call.protocol);
    const usage = parseUsage(payload, call.protocol);
    recordCall(db, {
      stage,
      providerId: call.providerId,
      model: call.model,
      protocol: call.protocol,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      durationMs,
      status: 'ok',
    });
    if (!text) return '';
    const maxChars = input.maxChars && input.maxChars > 0 ? input.maxChars : 0;
    return maxChars > 0 && text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch (error) {
    durationMs = Date.now() - startedAt;
    const name = error instanceof Error ? error.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    const message = error instanceof Error ? error.message : String(error);
    recordCall(db, {
      stage,
      providerId: call.providerId,
      model: call.model,
      protocol: call.protocol,
      promptTokens: 0,
      completionTokens: 0,
      durationMs,
      status: timedOut ? 'timeout' : 'error',
      error: timedOut ? `timeout ${call.timeoutMs}ms` : message || 'request failed',
    });
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function resolveStage(
  db: DatabaseSync,
  stage: LlmStage,
  fallback: LlmConfig | null,
): Resolution {
  const row = db.prepare('SELECT * FROM llm_stage_configs WHERE stage = ?').get(stage) as unknown as
    | StageRow
    | undefined;
  if (!row || row.enabled !== 1) {
    return row ? { kind: 'skip' } : { kind: 'fallback' };
  }
  const provider = row.provider_id
    ? (db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(row.provider_id) as unknown as
        | ProviderRow
        | undefined)
    : undefined;
  // 供应商被显式禁用：不调，也不改用 env（运维意图优先）。
  if (provider && provider.enabled !== 1) return { kind: 'skip' };
  const apiKey = provider ? decryptProviderApiKey(provider.api_key_cipher, provider.api_key_encrypted) : '';
  const model = (row.model ?? '').trim() || (provider?.default_model ?? '').trim();
  if (!provider || !provider.base_url || !apiKey || !model) {
    // 配置不完整（未选供应商 / 无 key / 无 model）：视为未配置，回退 env。
    return { kind: 'fallback' };
  }
  return {
    kind: 'use',
    call: {
      protocol: provider.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: provider.base_url,
      apiKey,
      model,
      temperature: Number.isFinite(row.temperature) ? row.temperature : 0.2,
      maxTokens: Number.isFinite(row.max_tokens) && row.max_tokens > 0 ? row.max_tokens : maxTokensOf(undefined),
      timeoutMs:
        Number.isFinite(row.timeout_ms) && row.timeout_ms > 0 ? row.timeout_ms : DEFAULT_TIMEOUT_MS,
      ...(row.system_prompt ? { systemPrompt: row.system_prompt } : {}),
      providerId: provider.id,
    },
  };
}

function fallbackCall(fallback: LlmConfig | null, input: LlmTextInput): ResolvedCall | null {
  const usable = usableFallback(fallback);
  if (!usable) return null;
  return {
    protocol: 'openai',
    baseUrl: usable.baseUrl,
    apiKey: usable.apiKey,
    model: usable.model,
    temperature: 0.2,
    maxTokens: maxTokensOf(input.maxChars),
    timeoutMs: input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS,
    providerId: null,
  };
}

function modelOf(db: DatabaseSync, stage: LlmStage, fallback: LlmConfig | null): string {
  try {
    const resolved = resolveStage(db, stage, fallback);
    if (resolved.kind === 'use') return resolved.call.model;
    const usable = usableFallback(fallback);
    if (resolved.kind === 'fallback' && usable) return usable.model;
  } catch {
    /* 读取配置失败时静默。 */
  }
  return '';
}

/**
 * 创建按阶段路由的 LLM 客户端：每次调用实时读取 stage/provider 配置（配置更新立即生效）。
 * 数据库不可用 / 记录失败时不影响主流程。
 */
export function createLlmRouter(db: DatabaseSync, fallback: LlmConfig | null): LlmClient {
  return {
    async text(stage: LlmStage, input: LlmTextInput): Promise<string> {
      let resolved: Resolution;
      try {
        resolved = resolveStage(db, stage, fallback);
      } catch {
        return '';
      }
      if (resolved.kind === 'skip') return '';
      const call = resolved.kind === 'use' ? resolved.call : fallbackCall(fallback, input);
      if (!call) return '';
      return invoke(db, stage, call, input);
    },
    modelOf(stage: LlmStage): string {
      return modelOf(db, stage, fallback);
    },
  };
}

/**
 * 调一次 LLM 并返回纯文本；任何失败都静默降级为 ''。
 * `maxChars` 只做输出裁剪，不改变请求语义。
 * 兼容旧调用：传 LlmConfig 时走 env fallback 的 OpenAI 协议（不写 llm_calls）。
 */
export async function llmText(llm: LlmConfig | null, input: LlmTextInput): Promise<string> {
  if (!llm || !llm.baseUrl || !llm.apiKey || !llm.model) return '';
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (input.system) messages.push({ role: 'system', content: input.system });
  messages.push({ role: 'user', content: input.prompt });

  try {
    const response = await fetch(endpointOf(llm.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokensOf(input.maxChars),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return '';
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return '';
    const text = content.trim();
    if (!text) return '';
    if (input.maxChars && text.length > input.maxChars) return text.slice(0, input.maxChars);
    return text;
  } catch {
    // 网络错误 / 超时 / JSON 解析失败：静默回退。
    return '';
  }
}

/**
 * 统一调用入口：LlmClient → text(stage)；LlmConfig（旧测试 fake）→ llmText；null → ''。
 * 调用方（brief/dream/profile/privacy）全部走这里，保证阶段路由与旧配置兼容。
 */
export async function callLlm(llm: LlmLike, stage: LlmStage, input: LlmTextInput): Promise<string> {
  if (!llm) return '';
  if (isLlmClient(llm)) return llm.text(stage, input);
  return llmText(llm, input);
}
