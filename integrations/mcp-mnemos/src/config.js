/**
 * MCP server 配置：全部来自环境变量（零依赖、无配置文件）。
 *
 * - MNEMOS_BASE_URL  Mnemos 服务地址，默认 http://127.0.0.1:4380
 * - MNEMOS_API_KEY   API Key（mnemos_live_…），写操作必需
 * - MNEMOS_PARTITION 默认分区（id 或 slug）；多数工具必需
 * - MNEMOS_PERSON    默认人 external_id，默认 dsh-agent
 * - MNEMOS_TIMEOUT_MS 请求超时，默认 30000
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:4380';
export const DEFAULT_PERSON = 'dsh-agent';
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const baseUrl = (env.MNEMOS_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const apiKey = (env.MNEMOS_API_KEY || '').trim();
  const partition = (env.MNEMOS_PARTITION || '').trim();
  const person = (env.MNEMOS_PERSON || DEFAULT_PERSON).trim();
  const parsedTimeout = Number(env.MNEMOS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  return { baseUrl, apiKey, partition, person, timeoutMs };
}
