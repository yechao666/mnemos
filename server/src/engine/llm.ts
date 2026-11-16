/**
 * 可选的大模型文本调用（OpenAI 兼容 `POST {baseUrl}/chat/completions`）。
 *
 * 设计原则：LLM 只是「增强」，绝不阻断主流程——
 * 未配置 / 超时 / 非 2xx / 响应结构异常一律返回空串，不抛错。
 * 调用方拿到空串时回退到确定性算法（简报压缩、做梦规则归并）。
 */

import type { LlmConfig } from '../env.ts';

export interface LlmTextInput {
  prompt: string;
  system?: string;
  /** 期望的最大字符数；同时用于推导 max_tokens。 */
  maxChars?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function endpointOf(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function maxTokensOf(maxChars: number | undefined): number {
  const chars = maxChars && maxChars > 0 ? maxChars : 800;
  return Math.min(4_096, Math.max(256, Math.ceil(chars * 2)));
}

/**
 * 调一次 chat/completions 并返回纯文本；任何失败都静默降级为 ''。
 * `maxChars` 只做输出裁剪，不改变请求语义。
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
